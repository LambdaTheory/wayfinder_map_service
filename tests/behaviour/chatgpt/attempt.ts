import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LocalMcpService, LocalServiceConfiguration } from '../../../src/mcp-service.ts';
import { attemptSchema, redact } from '../evidence.ts';
import type { AttemptRecord, Completeness, EventRecord, Field, GivenRules, Surface } from '../evidence.ts';
import { connectController } from '../runner/controller.ts';
import type { Controller } from '../runner/controller.ts';
import { receiptsFrom } from '../runner/normalize.ts';
import { checkoutRoot, freePort, newToken } from '../runner/service.ts';
import type { Scenario } from '../scenario.ts';
import { startRelay } from './relay.ts';
import type { Exchange, Relay } from './relay.ts';
// @ts-expect-error -- existing JS test helper
import { writeCanaryCheckout } from '../../helpers/canary-release.mjs';

type Tool = { name: string; description?: string; inputSchema: { properties?: Record<string, { description?: string }> } };
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
  versionSourceEvidence?: string;
  resources?: Surface;
  prompts?: Surface;
}
const unknown = (reason: string) => ({ known: false as const, reason });
const now = () => new Date().toISOString();
const safeWrite = (path: string, value: unknown, secrets: Record<string, string>) => writeFileSync(path, redact(JSON.stringify(value, null, 2), secrets), { mode: 0o600 });

/** Stateful controller for one manual Attempt. It never operates the app or supplies an answer for Kun. */
export class ChatGPTAttempt {
  readonly record: AttemptRecord;
  readonly dir: string;
  readonly scenario: Scenario;
  readonly servicePort: number;
  readonly databasePath: string;
  readonly secrets: Record<string, string>;
  relay!: Relay;
  private service!: LocalMcpService;
  private controller!: Controller;
  private serviceConfig!: LocalServiceConfiguration;
  private readonly tokens = { controller: newToken(), A: newToken(), B: newToken() };
  private readonly seedHeads = new Map<string, number>();
  private activeTurn: number | null = null;
  private completedTurns = 0;
  private phase: GivenRules['phase'] = 'initial';
  private tools: Tool[] = [];
  private exchanges: Exchange[] = [];
  private lastMessages = '';
  private stopped = false;
  private upgraded = false;

  private constructor(options: { dir: string; batchId: string; attemptId: string; scenario: Scenario; surface: string; model: string; commit: string; version: string }, port: number) {
    this.dir = options.dir; this.scenario = options.scenario; this.servicePort = port;
    this.databasePath = join(this.dir, 'maps.sqlite');
    this.secrets = { 'controller-token': this.tokens.controller, 'session-A-token': this.tokens.A, 'session-B-token': this.tokens.B };
    this.record = { schema: attemptSchema, attemptId: options.attemptId, batchId: options.batchId,
      subject: { kind: options.scenario.id.startsWith('U-') ? 'upgrade-check' : 'scenario', id: options.scenario.id, version: options.scenario.version },
      entry: 'chatgpt', combination: { harness: 'chatgpt', requestedModel: options.model, visibleModel: unknown('not captured from UI'), effort: unknown('not exposed') },
      client: { version: unknown('not captured from UI'), surface: { known: true, value: options.surface } },
      service: { commit: options.commit, series: 'release', version: options.version }, given: [],
      run: { startedAt: now(), endedAt: '', completeness: 'cancelled' }, controller: { clientId: `${options.attemptId}.controller` }, baitClientIds: [],
      sessions: [...new Set(options.scenario.turns.map(t => t.session))].map(label => ({ label, nativeId: unknown('not captured'), clientId: `${options.attemptId}.${label}`,
        mcpSessionIds: { known: true, value: [] }, turns: [] })), events: [], maps: [], receipts: [], usage: unknown('ChatGPT does not expose usage here'),
      raw: { path: `${options.attemptId}/raw`, files: [] }, missing: ['events.message', 'chatgpt.otherToolCalls', 'combination.visibleModel', 'client.version'] };
  }

  static async start(options: {
    dir: string; batchId: string; attemptId: string; scenario: Scenario; surface: string; model: string; commit: string; version: string;
  }): Promise<ChatGPTAttempt> {
    const a = new ChatGPTAttempt(options, await freePort());
    mkdirSync(a.dir, { mode: 0o700 }); mkdirSync(join(a.dir, 'raw'), { mode: 0o700 });
    try {
      const { initializeSQLite } = await import(pathToFileURL(join(checkoutRoot, 'dist/sqlite-storage.js')).href) as { initializeSQLite(path: string): void };
      initializeSQLite(a.databasePath);
      const credentialsPath = join(a.dir, 'credentials.json');
      writeFileSync(credentialsPath, JSON.stringify({ credentials: a.record.sessions.map(s => ({ clientId: s.clientId, toolsOnly: true,
        tokenSha256: createHash('sha256').update(a.tokens[s.label as 'A' | 'B']).digest('hex') })) }), { mode: 0o600 });
      a.serviceConfig = { databasePath: a.databasePath, port: a.servicePort, token: a.tokens.controller,
        actorId: 'behaviour-chatgpt', clientId: a.record.controller.clientId, credentialsPath, allowedOrigins: [] };
      await a.startService(checkoutRoot);
      for (const map of a.scenario.seed.maps) a.seedHeads.set(map.mapId, await a.controller.seed(map));
      a.saveRaw('seed.json', { seed: a.scenario.seed, maps: await a.controller.exportCatalog() });
      a.relay = await startRelay(a.servicePort, a.tokens.A, e => a.observe(e));
      a.saveRaw('isolation.json', { databasePath: a.databasePath, servicePort: a.servicePort, relayPort: a.relay.port,
        freshDatabase: true, attached: false, reservedPorts: [18765, 18766], compatibilityMode: 'toolsOnly' });
      a.persist();
      return a;
    } catch (error) { await a.stop('launch-failed'); throw error; }
  }

  private async startService(root: string) {
    const { startLocalMcpService } = await import(pathToFileURL(join(root, 'dist/mcp-service.js')).href) as { startLocalMcpService(c: LocalServiceConfiguration): Promise<LocalMcpService> };
    this.service = await startLocalMcpService(this.serviceConfig);
    this.controller = await connectController(this.servicePort, this.tokens.controller);
    // Controller tooling is evidence of what the service serves, never evidence that ChatGPT's model saw it.
    const { toolsOnlyMapTools } = await import(pathToFileURL(join(root, 'dist/mcp-tools.js')).href) as { toolsOnlyMapTools: Tool[] };
    this.tools = toolsOnlyMapTools;
    this.saveRaw(`controller-tools-${this.phase}.json`, this.tools);
    this.record.given.push({ phase: this.phase, fromSeq: this.record.events.length, compatibilityMode: 'toolsOnly',
      rulesSource: { kind: 'tool-parameter', tool: 'map_apply', description: this.parameterDescription() },
      instructions: unknown('ChatGPT does not show server instructions to its model'), toolDescriptions: unknown('client snapshot not captured'),
      resources: 'undocumented', prompts: 'undocumented', extraContext: [] });
    this.record.missing.push(`given.${this.phase}.toolDescriptions`, `chatgpt.versionSourceEvidence.${this.phase}`);
  }

  private parameterDescription() {
    const description = this.tools.find(t => t.name === 'map_apply')?.inputSchema.properties?.version?.description;
    if (!description) throw new Error('Built tools lack the compatibility version parameter');
    return description;
  }

  private observe(e: Exchange) {
    this.exchanges.push(e);
    this.saveRaw('wire.json', this.exchanges);
    if (this.activeTurn === null) return;
    if (e.request.method === 'resources/read') {
      this.record.events.push({ seq: this.record.events.length, at: e.at, actor: 'agent', session: this.scenario.turns[this.activeTurn]!.session,
        turn: this.activeTurn, kind: 'resource-read', uri: String((e.request.params as { uri?: unknown })?.uri ?? ''),
        ok: e.status < 400 && !!(e.response as { result?: unknown } | null)?.result });
      this.persist();
      return;
    }
    if (e.request.method !== 'tools/call') return;
    const params = e.request.params as { name: string; arguments?: unknown };
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

  async begin(proposalConfirmed = false): Promise<string> {
    if (this.activeTurn !== null || this.relay.inFlight) throw new Error('Finish the active turn first');
    const index = this.completedTurns;
    const turn = this.scenario.turns[index];
    if (!turn) throw new Error('All turns have been captured; use next');
    if (index > 0 && this.record.subject.kind === 'upgrade-check' && !this.upgraded) throw new Error('Run upgrade before the second turn');
    if (turn.answers && (!proposalConfirmed || !turn.answers.cue.test(this.lastMessages)))
      throw new Error(`Precondition unmet: confirm the actual proposal before sending a reply: ${turn.answers.proposal}`);
    this.activeTurn = index;
    this.relay.token = this.tokens[turn.session as 'A' | 'B'];
    const at = now();
    this.record.sessions.find(s => s.label === turn.session)!.turns.push({ index, input: turn.say, startedAt: at, endedAt: '', durationMs: 0 });
    this.record.events.push({ seq: this.record.events.length, at, actor: 'script-human', session: turn.session, turn: index, kind: 'message', role: 'user', text: turn.say });
    this.saveRaw(`before-turn-${index}.json`, await this.controller.exportCatalog());
    this.relay.active = true;
    this.persist();
    return turn.say;
  }

  async end(capture: Capture) {
    if (this.activeTurn === null || this.relay.inFlight) throw new Error('No active turn, or MCP requests still in flight');
    if (!capture || !Array.isArray(capture.messages) || typeof capture.messagesComplete !== 'boolean'
      || capture.messages.some(m => !m || typeof m.text !== 'string' || !m.text.trim() || !(m.afterCall === null || typeof m.afterCall === 'string'))
      || (capture.messagesComplete && !capture.messages.length))
      throw new Error('Capture needs messages with text/afterCall and messagesComplete');
    for (const key of ['nativeId', 'clientVersion', 'visibleModel', 'effort', 'versionSourceEvidence'] as const)
      if (capture[key] !== undefined && (typeof capture[key] !== 'string' || !capture[key]!.trim())) throw new Error(`Invalid capture ${key}`);
    for (const key of ['resources', 'prompts'] as const) if (capture[key] !== undefined && !['available', 'unavailable', 'undocumented'].includes(capture[key]!)) throw new Error(`Invalid capture ${key}`);
    if (capture.otherToolsComplete !== undefined && typeof capture.otherToolsComplete !== 'boolean') throw new Error('otherToolsComplete must be boolean');
    if (capture.otherToolCalls !== undefined && (!Array.isArray(capture.otherToolCalls) || capture.otherToolCalls.some(c => !c
      || typeof c.callId !== 'string' || typeof c.server !== 'string' || /wayfinder/i.test(c.server) || typeof c.tool !== 'string'
      || typeof c.failed !== 'boolean' || !(c.afterCall === null || typeof c.afterCall === 'string') || !c.result || typeof c.result.known !== 'boolean'
      || (!c.result.known && typeof c.result.reason !== 'string')))) throw new Error('Invalid non-Wayfinder native tool call');
    const timeline = [...capture.messages, ...capture.otherToolCalls ?? []];
    if (capture.otherToolCalls?.length && (timeline.some(e => !Number.isInteger(e.order)) || new Set(timeline.map(e => e.order)).size !== timeline.length))
      throw new Error('Mixed native messages/tools need distinct integer order values');
    if (capture.toolsShown && (!Array.isArray(capture.toolsShown) || capture.toolsShown.length !== 4
      || new Set(capture.toolsShown.map(t => t?.name)).size !== 4
      || capture.toolsShown.some(t => !['map_create', 'map_read', 'map_list', 'map_apply'].includes(t?.name)
        || typeof t.description !== 'string' || !t.inputSchema || (['map_create', 'map_apply'].includes(t.name) && typeof t.inputSchema.properties?.version?.description !== 'string'))))
      throw new Error('toolsShown must contain the four actual client tool definitions, including write version descriptions');
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
    if (capture.toolsShown) given.toolDescriptions = { known: true, value: Object.fromEntries(capture.toolsShown.map(t => [t.name, t.description ?? ''])) };
    this.record.missing = this.record.missing.filter(m => !(capture.toolsShown && m === `given.${this.phase}.toolDescriptions`)
      && !(capture.versionSourceEvidence && m === `chatgpt.versionSourceEvidence.${this.phase}`));
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
    this.record.events.push({ seq: this.record.events.length, at: now(), actor: 'controller', session: null, turn: null, kind: 'controller', action: 'restart-canary' });
    await this.startService(target);
    if (this.scenario.id === 'U-chatgpt-new-chat') this.relay.token = this.tokens.B;
    this.upgraded = true;
    this.persist();
  }

  operator(action: string) {
    if (!['refresh-tools', 'new-chat', 'plugin-mentioned'].includes(action)) throw new Error('Unknown operator action');
    if (this.activeTurn !== null) throw new Error('Record preparation actions before begin');
    this.record.events.push({ seq: this.record.events.length, at: now(), actor: 'controller', session: null, turn: null, kind: 'controller', action });
    if (action === 'new-chat' && this.upgraded && this.scenario.id === 'U-chatgpt-new-chat') {
      this.phase = 'after-refresh';
      this.record.given.push({ ...this.record.given.at(-1)!, phase: this.phase, fromSeq: this.record.events.length });
      this.record.missing.push(`given.${this.phase}.toolDescriptions`, `chatgpt.versionSourceEvidence.${this.phase}`);
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
      await this.relay?.stop();
      this.record.maps = (await this.controller.exportCatalog()).map(m => ({ ...m, seedHeadRevision: this.seedHeads.get(m.mapId) ?? null }));
    } catch { this.record.missing.push('maps'); }
    finally {
      await this.controller?.close().catch(() => undefined);
      try { await this.service?.stop(); }
      finally {
        rmSync(join(this.dir, 'credentials.json'), { force: true });
        this.record.run.endedAt = now();
        this.persist();
      }
    }
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
