import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { LocalMcpService, LocalServiceConfiguration } from '../../../src/mcp-service.ts';
import { attemptSchema, redact } from '../evidence.ts';
import type { AttemptRecord, Completeness, EventRecord, Field, GivenRules, Surface } from '../evidence.ts';
import { prepareDeskTurn } from '../runner/desk.ts';
import { connectController } from '../runner/controller.ts';
import type { Controller } from '../runner/controller.ts';
import { receiptsFrom } from '../runner/normalize.ts';
import { checkoutRoot, freePort, newToken } from '../runner/service.ts';
import { createControllerClient } from '../runner/controller-client.mjs';
import { clientProfiles } from '../clients.ts';
import { upgradeChecks } from '../upgrade-checks.ts';
import { observeIsolation } from './isolation.ts';
import type { Scenario } from '../scenario.ts';
import { startRelay } from './relay.ts';
import type { Exchange, RefusalReason, Relay, RelayRefusalEvent } from './relay.ts';
import { writeCanaryCheckout } from '../../helpers/canary-release.mjs';

import type { Tool } from '@modelcontextprotocol/client';
function versionDescription(tool: Tool): string | undefined {
  const field = tool.inputSchema.properties?.version;
  return field && typeof field === 'object' && 'description' in field && typeof field.description === 'string' ? field.description : undefined;
}
export interface Capture {
  /** Native messages, in order; null means before the first call, otherwise after the named relay call. */
  messages: { text: string; afterCall: string | null; order?: number }[];
  messagesComplete: boolean;
  /** Other native tools are not visible to the Wayfinder relay. Missing ones remain explicit. */
  otherToolsComplete?: boolean;
  otherToolCalls?: { callId: string; server: string; tool: string; arguments: unknown; result: Field<unknown>; failed: boolean; afterCall: string | null; order?: number }[];
  nativeId?: string;
  clientVersion?: string;
  visibleModel?: string;
  effort?: string;
  /** Exact tools exposed by the client, not a copy from controller-tools.json. */
  toolsShown?: Tool[];
  /** Exact raw/wire.json#rpc-N reference for the chat's pre-turn tools/list response. */
  toolsShownSource?: string;
  versionSourceEvidence?: string;
  resources?: Surface;
  prompts?: Surface;
}
const unknown = (reason: string) => ({ known: false as const, reason });
const now = () => new Date().toISOString();
const safeWrite = (path: string, value: unknown, secrets: Record<string, string>) => writeFileSync(path, redact(JSON.stringify(value, null, 2), secrets), { mode: 0o600 });
export interface RelayRefusalSummary {
  path: 'raw/relay-refusals.jsonl';
  total: number;
  byReason: Partial<Record<RefusalReason, number>>;
  byStatus: Record<string, number>;
  withinTurn: number;
  outsideTurn: number;
}
/** Driver diagnostics do not add events or affect the shared Scenario verdicts. */
export interface ChatGPTAttemptRecord extends AttemptRecord {
  diagnostics: { relayRefusals: RelayRefusalSummary };
}
const emptyRefusalSummary = (): RelayRefusalSummary => ({ path: 'raw/relay-refusals.jsonl', total: 0,
  byReason: {}, byStatus: {}, withinTurn: 0, outsideTurn: 0 });

/** Stateful controller for one manual Attempt. It never operates the app; only declared scripted desk verdicts are submitted by the Controller. */
export class ChatGPTAttempt {
  readonly record: ChatGPTAttemptRecord;
  readonly dir: string;
  readonly scenario: Scenario;
  readonly servicePort: number;
  readonly databasePath: string;
  readonly secrets: Record<string, string>;
  relay!: Relay;
  private service!: LocalMcpService;
  private controller!: Controller;
  private serviceConfig!: LocalServiceConfiguration;
  private readonly tokens = { controller: newToken(), observer: newToken(), A: newToken(), B: newToken() };
  private readonly seedHeads = new Map<string, number>();
  private activeTurn: number | null = null;
  private completedTurns = 0;
  private phase: GivenRules['phase'] = 'initial';
  private tools: Tool[] = [];
  private readonly isolation: ReturnType<typeof observeIsolation>[] = [];
  private exchanges: Exchange[] = [];
  private readonly snapshotBoundaries = new Map<string, number>();
  private wireSinceRestart = 0;
  private lastMessages = '';
  private stopped = false;
  private upgraded = false;

  private constructor(options: { dir: string; batchId: string; attemptId: string; scenario: Scenario; surface: string; model: string; commit: string; version: string }, port: number) {
    this.dir = options.dir; this.scenario = options.scenario; this.servicePort = port;
    this.databasePath = join(this.dir, 'maps.sqlite');
    this.secrets = { 'controller-token': this.tokens.controller, 'observer-token': this.tokens.observer, 'session-A-token': this.tokens.A, 'session-B-token': this.tokens.B };
    this.record = { schema: attemptSchema, attemptId: options.attemptId, batchId: options.batchId,
      subject: { kind: upgradeChecks.some(u => u.id === options.scenario.id) ? 'upgrade-check' : 'scenario', id: options.scenario.id, version: options.scenario.version },
      entry: 'chatgpt', combination: { harness: 'chatgpt', requestedModel: options.model, visibleModel: unknown('not captured from UI'), effort: unknown('not exposed') },
      client: { version: unknown('not captured from UI'), surface: { known: true, value: options.surface } },
      service: { commit: options.commit, series: 'release', version: options.version }, given: [],
      run: { startedAt: now(), endedAt: '', completeness: 'cancelled' }, controller: { clientId: `${options.attemptId}.controller` }, baitClientIds: [],
      sessions: [...new Set(options.scenario.turns.map(t => t.session))].map(label => ({ label, nativeId: unknown('not captured'), clientId: `${options.attemptId}.${label}`,
        mcpSessionIds: { known: true, value: [] }, turns: [] })), events: [], maps: [], receipts: [], usage: unknown('ChatGPT does not expose usage here'),
      raw: { path: `${options.attemptId}/raw`, files: [] }, missing: ['events.message', 'chatgpt.otherToolCalls', 'combination.visibleModel', 'client.version'],
      diagnostics: { relayRefusals: emptyRefusalSummary() } };
  }

  static async start(options: {
    dir: string; batchId: string; attemptId: string; scenario: Scenario; surface: string; model: string; commit: string; version: string;
  }): Promise<ChatGPTAttempt> {
    const a = new ChatGPTAttempt(options, await freePort());
    mkdirSync(a.dir, { mode: 0o700 }); mkdirSync(join(a.dir, 'raw'), { mode: 0o700 });
    try {
      writeFileSync(join(a.dir, a.record.diagnostics.relayRefusals.path), '', { mode: 0o600, flag: 'wx', flush: true });
      a.record.raw.files.push('relay-refusals.jsonl');
      const { initializeSQLite } = await import(pathToFileURL(join(checkoutRoot, 'dist/sqlite-storage.js')).href) as { initializeSQLite(path: string): void };
      const existedBefore = existsSync(a.databasePath);
      initializeSQLite(a.databasePath);
      a.saveRaw('database-creation.json', { existedBefore, existsAfter: existsSync(a.databasePath) });
      const credentialsPath = join(a.dir, 'credentials.json');
      writeFileSync(credentialsPath, JSON.stringify({ credentials: [...a.record.sessions.map(s => ({ clientId: s.clientId, toolsOnly: true,
        tokenSha256: createHash('sha256').update(a.tokens[s.label as 'A' | 'B']).digest('hex') })),
        { clientId: `${a.record.controller.clientId}.tools`, toolsOnly: true, tokenSha256: createHash('sha256').update(a.tokens.observer).digest('hex') }] }), { mode: 0o600 });
      a.serviceConfig = { databasePath: a.databasePath, port: a.servicePort, token: a.tokens.controller,
        actorId: 'behaviour-chatgpt', clientId: a.record.controller.clientId, credentialsPath, answerDeskKeyPath: join(a.dir, 'answer-desk-key'), allowedOrigins: [] };
      await a.startService(checkoutRoot);
      for (const map of a.scenario.seed.maps) a.seedHeads.set(map.mapId, await a.controller.seed(map));
      a.saveRaw('seed.json', { seed: a.scenario.seed, maps: await a.controller.exportCatalog() });
      a.relay = await startRelay(a.servicePort, a.tokens.A, e => a.observe(e), event => a.observeRefusal(event));
      a.measureIsolation();
      a.persist();
      return a;
    } catch (error) { await a.stop('launch-failed'); throw error; }
  }

  private async startService(root: string) {
    const { startLocalMcpService } = await import(pathToFileURL(join(root, 'dist/mcp-service.js')).href) as { startLocalMcpService(c: LocalServiceConfiguration): Promise<LocalMcpService> };
    this.service = await startLocalMcpService(this.serviceConfig);
    this.secrets['answer-desk-key'] = readFileSync(this.serviceConfig.answerDeskKeyPath!, 'utf8');
    this.controller = await connectController(this.servicePort, this.tokens.controller);
    // Observe actual service metadata with a Controller credential in the same configured mode as ChatGPT.
    const observation = await createControllerClient(this.servicePort, this.tokens.observer);
    try { this.tools = (await observation.client.listTools()).tools as Tool[]; }
    finally { await observation.close(); }
    this.saveRaw(`controller-tools-${this.phase}.json`, this.tools);
    const compatibilityMode = this.parameterDescription().includes(this.controller.version) ? 'toolsOnly' : 'instructions';
    if (this.phase === 'initial') this.record.service.version = this.controller.version;
    this.record.given.push({ phase: this.phase, fromSeq: this.record.events.length, compatibilityMode, serviceVersion: this.controller.version,
      rulesSource: { kind: 'unknown', reason: 'no native client tool snapshot' },
      instructions: unknown('ChatGPT does not show server instructions to its model'), toolDescriptions: unknown('client snapshot not captured'),
      resources: clientProfiles.chatgpt.supports['resource-read'] === false ? 'unavailable' : 'undocumented', prompts: 'undocumented', extraContext: [] });
    this.record.missing.push(`given.${this.phase}.toolDescriptions`, `given.${this.phase}.rulesSource`);
  }

  private parameterDescription() {
    const tool = this.tools.find(t => t.name === 'map_apply');
    const description = tool && versionDescription(tool);
    if (!description) throw new Error('Built tools lack the compatibility version parameter');
    return description;
  }

  private observe(e: Exchange) {
    this.exchanges.push(e);
    this.saveRaw('wire.json', this.exchanges);
    if (this.activeTurn === null || e.httpMethod !== 'POST') return;
    if (e.request.method === 'resources/read') {
      this.record.events.push({ seq: this.record.events.length, at: e.at, actor: 'agent', session: this.scenario.turns[this.activeTurn]!.session,
        turn: this.activeTurn, kind: 'resource-read', uri: String((e.request.params as { uri?: unknown })?.uri ?? ''),
        ok: e.status < 400 && !!(e.response as { result?: unknown } | null)?.result });
      this.persist();
      return;
    }
    if (e.request.method !== 'tools/call') return;
    const params = e.request.params as { name: string; arguments?: unknown };
    if (!params || typeof params !== 'object' || typeof params.name !== 'string') return;
    const reply = e.response as { result?: { structuredContent?: unknown; isError?: boolean } } | null;
    const turn = this.scenario.turns[this.activeTurn]!;
    const session = this.record.sessions.find(s => s.label === turn.session)!;
    if (e.sessionId && session.mcpSessionIds.known && !session.mcpSessionIds.value.includes(e.sessionId)) session.mcpSessionIds.value.push(e.sessionId);
    this.record.events.push({ seq: this.record.events.length, at: e.at, actor: 'agent', session: turn.session, turn: this.activeTurn,
      kind: 'tool-call', callId: e.id, server: 'wayfinder', tool: params.name, arguments: params.arguments ?? {},
      result: reply?.result?.structuredContent === undefined ? unknown(`no structured result (HTTP ${e.status})`) : { known: true, value: reply.result.structuredContent },
      failed: e.status >= 400 || reply?.result?.isError === true, requestId: { known: true, value: String(e.request.id) } });
    this.persist();
  }

  private observeRefusal(event: RelayRefusalEvent) {
    // One bounded append per observation, flushed before response/failure handling.
    // Complete earlier lines survive an interrupted append; late bodies keep the same index.
    const summary = this.record.diagnostics.relayRefusals;
    appendFileSync(join(this.dir, summary.path), redact(JSON.stringify(event), this.secrets) + '\n', { mode: 0o600, flush: true });
    if (event.kind === 'body') return;
    const { refusal } = event;
    summary.total++;
    summary.byReason[refusal.reason] = (summary.byReason[refusal.reason] ?? 0) + 1;
    summary.byStatus[refusal.status] = (summary.byStatus[refusal.status] ?? 0) + 1;
    if (refusal.withinTurn) summary.withinTurn++; else summary.outsideTurn++;
  }

  async begin(proposalConfirmed = false): Promise<string> {
    if (this.activeTurn !== null || this.relay.inFlight) throw new Error('Finish the active turn first');
    const index = this.completedTurns;
    const turn = this.scenario.turns[index];
    if (!turn) throw new Error('All turns have been captured; use next');
    if (index > 0 && this.record.subject.kind === 'upgrade-check' && !this.upgraded) throw new Error('Run upgrade before the second turn');
    if (turn.answers && (!proposalConfirmed || !turn.answers.cue.test(this.lastMessages)))
      throw new Error(`Precondition unmet: confirm the actual proposal before sending a reply: ${turn.answers.proposal}`);
    const prompt = await prepareDeskTurn(this.servicePort, this.serviceConfig.answerDeskKeyPath!, turn, index,
      event => this.record.events.push({ ...event, seq: this.record.events.length }));
    this.activeTurn = index;
    const snapshotKey = `${this.phase}:${turn.session}`;
    if (!this.snapshotBoundaries.has(snapshotKey)) this.snapshotBoundaries.set(snapshotKey, this.exchanges.length);
    this.relay.token = this.tokens[turn.session as 'A' | 'B'];
    const at = now();
    this.record.sessions.find(s => s.label === turn.session)!.turns.push({ index, input: prompt, startedAt: at, endedAt: '', durationMs: 0 });
    this.record.events.push({ seq: this.record.events.length, at, actor: 'script-human', session: turn.session, turn: index, kind: 'message', role: 'user', text: prompt });
    this.saveRaw(`before-turn-${index}.json`, await this.controller.exportCatalog());
    this.measureIsolation();
    this.relay.active = true;
    this.persist();
    return prompt;
  }

  async end(capture: Capture) {
    if (this.activeTurn === null || this.relay.inFlight) throw new Error('No active turn, or MCP requests still in flight');
    if (!capture || !Array.isArray(capture.messages) || typeof capture.messagesComplete !== 'boolean'
      || capture.messages.some(m => !m || typeof m.text !== 'string' || !m.text.trim() || !(m.afterCall === null || typeof m.afterCall === 'string'))
      || (capture.messagesComplete && !capture.messages.length))
      throw new Error('Capture needs messages with text/afterCall and messagesComplete');
    for (const key of ['nativeId', 'clientVersion', 'visibleModel', 'effort', 'versionSourceEvidence', 'toolsShownSource'] as const)
      if (capture[key] !== undefined && (typeof capture[key] !== 'string' || !capture[key]!.trim())) throw new Error(`Invalid capture ${key}`);
    for (const key of ['resources', 'prompts'] as const) if (capture[key] !== undefined && !['available', 'unavailable', 'undocumented'].includes(capture[key]!)) throw new Error(`Invalid capture ${key}`);
    if (capture.resources !== undefined && capture.resources !== 'unavailable' && clientProfiles.chatgpt.supports['resource-read'] === false)
      throw new Error('ChatGPT profile has no Resource support; preserve contrary observations as raw evidence for a profile review');
    if (capture.otherToolsComplete !== undefined && typeof capture.otherToolsComplete !== 'boolean') throw new Error('otherToolsComplete must be boolean');
    if (capture.otherToolCalls !== undefined && (!Array.isArray(capture.otherToolCalls) || capture.otherToolCalls.some(c => !c
      || typeof c.callId !== 'string' || typeof c.server !== 'string' || /wayfinder/i.test(c.server) || typeof c.tool !== 'string'
      || typeof c.failed !== 'boolean' || !(c.afterCall === null || typeof c.afterCall === 'string') || !c.result || typeof c.result.known !== 'boolean'
      || (!c.result.known && typeof c.result.reason !== 'string')))) throw new Error('Invalid non-Wayfinder native tool call');
    const timeline = [...capture.messages, ...capture.otherToolCalls ?? []];
    if (capture.otherToolCalls?.length && (timeline.some(e => !Number.isInteger(e.order)) || new Set(timeline.map(e => e.order)).size !== timeline.length))
      throw new Error('Mixed native messages/tools need distinct integer order values');
    if (capture.toolsShown && (!Array.isArray(capture.toolsShown) || ![4, 5].includes(capture.toolsShown.length)
      || new Set(capture.toolsShown.map(t => t?.name)).size !== capture.toolsShown.length
      || ['map_create', 'map_read', 'map_list', 'map_apply'].some(name => !capture.toolsShown!.some(t => t?.name === name))
      || capture.toolsShown.some(t => !['map_create', 'map_read', 'map_list', 'map_apply', 'map_wait'].includes(t?.name)
        || typeof t.description !== 'string' || !t.inputSchema || (['map_create', 'map_apply'].includes(t.name) && versionDescription(t) === undefined))))
      throw new Error('toolsShown must contain the actual client tool definitions (four before 4.0.0, five thereafter), including write version descriptions');
    const index = this.activeTurn;
    const turn = this.scenario.turns[index]!;
    const calls = this.record.events.filter(e => e.turn === index && e.kind === 'tool-call');
    for (const message of [...capture.messages, ...capture.otherToolCalls ?? []]) if (message.afterCall !== null && !calls.some(e => e.kind === 'tool-call' && e.callId === message.afterCall))
      throw new Error(`Capture references an unknown call: ${message.afterCall}`);
    this.relay.active = false;
    this.saveRaw(`capture-${index}.json`, capture);
    // Insert native messages at their observed positions. Screenshots/prose alone cannot invent tool calls.
    const messagesAt = (afterCall: string | null): EventRecord[] => [
      ...(capture.otherToolCalls ?? []).filter(c => c.afterCall === afterCall).map((c): EventRecord => ({ seq: c.order ?? 0, at: now(), actor: 'agent', session: turn.session,
        turn: index, kind: 'tool-call', callId: `native-${c.callId}`, server: c.server, tool: c.tool, arguments: c.arguments, result: c.result,
        failed: c.failed, requestId: unknown('not exposed by ChatGPT') })),
      ...capture.messages.filter(m => m.afterCall === afterCall).map((m): EventRecord => ({
        seq: m.order ?? 0, at: now(), actor: 'agent', session: turn.session, turn: index, kind: 'message', role: 'assistant', text: m.text })),
    ].sort((a, b) => a.seq - b.seq);
    this.record.events = this.record.events.flatMap(e => e.turn !== index ? [e] : e.kind === 'message' && e.role === 'user' ? [e, ...messagesAt(null)]
      : e.kind === 'tool-call' ? [e, ...messagesAt(e.callId)] : [e]).map((e, seq) => ({ ...e, seq }));
    if (!capture.messagesComplete) this.record.missing.push(`turn-${index}.messages`);
    if (!capture.otherToolsComplete) this.record.missing.push(`turn-${index}.otherToolCalls`);
    const session = this.record.sessions.find(s => s.label === turn.session)!;
    if (capture.nativeId) session.nativeId = { known: true, value: capture.nativeId };
    const timing = session.turns.find(t => t.index === index)!;
    timing.endedAt = now(); timing.durationMs = Date.parse(timing.endedAt) - Date.parse(timing.startedAt);
    if (capture.clientVersion) this.record.client.version = { known: true, value: capture.clientVersion };
    if (capture.visibleModel) this.record.combination.visibleModel = { known: true, value: capture.visibleModel };
    if (capture.effort) this.record.combination.effort = { known: true, value: capture.effort };
    const given = this.record.given.at(-1)!;
    if (capture.toolsShown) {
      // The operator's declaration alone cannot establish which definitions this chat received.
      const callIds = new Set(calls.filter(e => e.kind === 'tool-call' && e.server === 'wayfinder').map(e => e.kind === 'tool-call' ? e.callId : ''));
      const callExchanges = this.exchanges.filter(e => e.httpMethod === 'POST' && callIds.has(e.id));
      const sessionIds = new Set(callExchanges.map(e => e.sessionId));
      const sessionless = callExchanges.length > 0 && callExchanges.every(e => e.sessionId === null);
      const sessionId = sessionIds.size === 1 ? [...sessionIds][0] : null;
      const boundary = this.snapshotBoundaries.get(`${this.phase}:${turn.session}`)!;
      const listed = sessionId ? this.exchanges.slice(this.wireSinceRestart, boundary).findLast(e => e.httpMethod === 'POST'
        && e.request.method === 'tools/list' && e.sessionId === sessionId) : undefined;
      const source = listed ? `raw/wire.json#${listed.id}` : null;
      const result = listed?.response as { result?: { tools?: unknown }; error?: unknown } | null | undefined;
      const verified = listed && listed.status === 200 && !result?.error && capture.toolsShownSource === source
        && isDeepStrictEqual(capture.toolsShown, result?.result?.tools);
      // Null is absence of identity, never a shared session. Modern tool snapshots need
      // a future native-chat binding; clientInfo alone is shared across chats.
      const reason = sessionless ? 'sessionless tool snapshot cannot yet be bound to this native chat; wire calls remain recorded'
        : !sessionId ? 'no unambiguous MCP session from this turn’s tool calls'
        : !listed ? 'no tools/list for this MCP session before its first turn in this phase'
          : capture.toolsShownSource !== source ? 'missing or incorrect reference to the last pre-turn tools/list'
            : 'toolsShown differs from the recorded tools/list result or that request failed';
      this.saveRaw(`tool-snapshot-${index}.json`, { verified: !!verified, reason: verified ? null : reason, source,
        suppliedSource: capture.toolsShownSource ?? null, sessionId: sessionId ?? null, phase: this.phase, session: turn.session,
        firstTurnWireBoundary: boundary, wireSinceRestart: this.wireSinceRestart });
      if (verified) {
        given.toolDescriptions = { known: true, value: Object.fromEntries(capture.toolsShown.map(t => [t.name, t.description ?? ''])) };
        given.rulesSource = { kind: 'tool-parameter', tool: 'map_apply', description: versionDescription(capture.toolsShown.find(t => t.name === 'map_apply')!)! };
        this.record.missing = this.record.missing.filter(m => m !== `given.${this.phase}.toolDescriptions` && m !== `given.${this.phase}.rulesSource`);
      } else {
        given.toolDescriptions = unknown(reason);
        given.rulesSource = { kind: 'unknown', reason };
        for (const field of ['toolDescriptions', 'rulesSource']) {
          const marker = `given.${this.phase}.${field}`;
          if (!this.record.missing.includes(marker)) this.record.missing.push(marker);
        }
      }
    }
    if (capture.resources) given.resources = capture.resources;
    if (capture.prompts) given.prompts = capture.prompts;
    this.lastMessages = capture.messages.map(m => m.text).join('\n');
    this.activeTurn = null;
    this.completedTurns++;
    this.record.missing = this.record.missing.filter(m => !(m === 'client.version' && this.record.client.version.known)
      && !(m === 'combination.visibleModel' && this.record.combination.visibleModel.known));
    if (this.completedTurns === this.scenario.turns.length && !this.record.missing.some(m => /^turn-\d+\.messages$/.test(m)))
      this.record.missing = this.record.missing.filter(m => m !== 'events.message');
    if (this.completedTurns === this.scenario.turns.length && !this.record.missing.some(m => /^turn-\d+\.otherToolCalls$/.test(m)))
      this.record.missing = this.record.missing.filter(m => m !== 'chatgpt.otherToolCalls');
    this.saveRaw(`after-turn-${index}.json`, await this.controller.exportCatalog());
    this.measureIsolation();
    this.persist();
  }

  async upgrade() {
    if (this.record.subject.kind !== 'upgrade-check' || this.completedTurns !== 1 || this.activeTurn !== null || this.upgraded)
      throw new Error('Upgrade is allowed once, after capturing turn 0 of an upgrade check');
    this.relay.active = false;
    const target = join(this.dir, 'canary');
    await writeCanaryCheckout(checkoutRoot, target);
    await this.controller.close(); await this.service.stop();
    this.phase = 'after-restart';
    this.wireSinceRestart = this.exchanges.length;
    this.record.events.push({ seq: this.record.events.length, at: now(), actor: 'controller', session: null, turn: null, kind: 'controller', action: 'restart-canary' });
    await this.startService(target);
    if (this.upgradeRecovery === 'new-chat') this.relay.token = this.tokens.B;
    this.measureIsolation();
    this.upgraded = true;
    this.persist();
  }

  operator(action: string) {
    if (!['refresh-tools', 'new-chat', 'plugin-mentioned'].includes(action)) throw new Error('Unknown operator action');
    if (this.activeTurn !== null) throw new Error('Record preparation actions before begin');
    this.record.events.push({ seq: this.record.events.length, at: now(), actor: 'controller', session: null, turn: null, kind: 'controller', action });
    if (action === 'new-chat' && this.upgraded && this.upgradeRecovery === 'new-chat') {
      this.phase = 'after-refresh';
      this.record.given.push({ ...this.record.given.at(-1)!, phase: this.phase, fromSeq: this.record.events.length });
      this.record.missing.push(`given.${this.phase}.toolDescriptions`, `given.${this.phase}.rulesSource`);
    }
    this.persist();
  }

  async stop(completeness?: Completeness) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.relay) this.relay.active = false;
    const allTurns = this.completedTurns === this.scenario.turns.length;
    this.record.run.completeness = completeness === 'complete' && !allTurns ? 'cancelled' : completeness ?? (allTurns ? 'complete' : 'cancelled');
    try {
      if (this.relay) this.measureIsolation();
      await this.relay?.stop();
      this.record.maps = (await this.controller.exportCatalog()).map(m => ({ ...m, seedHeadRevision: this.seedHeads.get(m.mapId) ?? null }));
    } catch { this.record.missing.push('maps'); }
    finally {
      await this.controller?.close().catch(() => undefined);
      try { await this.service?.stop(); }
      finally {
        try {
          if (existsSync(`${this.databasePath}.calls.jsonl`)) this.saveRaw('service-calls.json', readFileSync(`${this.databasePath}.calls.jsonl`, 'utf8'));
        } finally {
          rmSync(join(this.dir, 'credentials.json'), { force: true });
          rmSync(join(this.dir, 'answer-desk-key'), { force: true });
          this.record.run.endedAt = now();
          this.persist();
        }
      }
    }
  }

  private get upgradeRecovery() { return upgradeChecks.find(u => u.id === this.scenario.id)?.chatgpt?.recovery; }

  failure(action: string, detail: string) {
    this.relay.active = false;
    this.record.run.detail = detail;
    this.record.events.push({ seq: this.record.events.length, at: now(), actor: 'controller', session: null, turn: null, kind: 'controller', action, detail });
    this.persist();
  }

  private measureIsolation() {
    const observed = observeIsolation(this.databasePath, this.servicePort, this.relay.port);
    this.isolation.push(observed);
    this.saveRaw('isolation.json', { ...observed, observations: this.isolation });
  }

  private saveRaw(name: string, value: unknown) {
    if (!this.record.raw.files.includes(name)) this.record.raw.files.push(name);
    safeWrite(join(this.dir, 'raw', name), value, this.secrets);
  }
  private persist() {
    this.record.receipts = receiptsFrom(this.record.events);
    safeWrite(join(this.dir, 'attempt.json'), this.record, this.secrets);
  }
}
