import { projectDesk } from './desk-domain.js';
import { emptyDesk } from './desk-types.js';
import { Server, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/server';
import { calculateFrontier, decodeApplyRequest, prepareApply, prepareCreate } from './index.js';
import type { CreateMapInput, InvalidInput, MapId, MutationAuthor } from './types.js';
import type { SQLiteStorage } from './sqlite-storage.js';
import { SQLiteFailure } from './sqlite-storage.js';
import { invalid, isPlainObject, validateAuthor, validateId, validateObject } from './values.js';
import { mapTools, toolsOnlyMapTools, answerDeskMapTools, toolsOnlyAnswerDeskMapTools } from './mcp-schemas.js';
import { workflowContract } from './workflow.generated.js';
import { viewerUrl } from './viewer-http.js';

export { mapTools, toolsOnlyMapTools, answerDeskMapTools, toolsOnlyAnswerDeskMapTools } from './mcp-schemas.js';
export { workflowContract } from './workflow.generated.js';
// viewerOrigin is set by the local HTTP host, which also serves the read-only viewer. toolsOnly marks a client that shows its
// model no server instructions; its write tools state the release instead.
export interface ToolAuthorConfiguration { readonly actorId: string; readonly clientId: string; readonly viewerOrigin?: string; readonly toolsOnly?: boolean; readonly answerDeskEnabled?: boolean }
// The HTTP host owns admission/draining, including work whose response is lost.
export type ToolCallControl = (call: () => Promise<CallToolResult>) => Promise<CallToolResult>;

// This advanced SDK seam deliberately retains M1's structured validation paths
// instead of the high-level SDK's generic text errors/duplicate-text convenience.
// Transport, admission, authentication and storage lifecycle belong to the host.
export function createMapMcpServer(storage: SQLiteStorage, configuration: ToolAuthorConfiguration, control?: ToolCallControl): Server {
  if (validateObject(configuration, [], ['actorId', 'clientId', 'viewerOrigin', 'toolsOnly', 'answerDeskEnabled'])
    || (configuration.answerDeskEnabled !== undefined && typeof configuration.answerDeskEnabled !== 'boolean')
    || (configuration.toolsOnly !== undefined && typeof configuration.toolsOnly !== 'boolean')
    || validateAuthor({ actorId: configuration.actorId, clientId: configuration.clientId, occurredAt: new Date().toISOString() })
    || (configuration.viewerOrigin !== undefined && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(configuration.viewerOrigin))) {
    throw new Error('Invalid MCP author configuration');
  }
  const identity = { actorId: configuration.actorId, clientId: configuration.clientId };
  const { viewerOrigin, answerDeskEnabled = false } = configuration;
  if (!answerDeskEnabled && storage.hasDeskHistory()) throw new Error('The configured private SQLite database has used Answer Desk; enable answerDeskEnabled.');
  const tools = answerDeskEnabled
    ? (configuration.toolsOnly ? toolsOnlyAnswerDeskMapTools : answerDeskMapTools)
    : (configuration.toolsOnly ? toolsOnlyMapTools : mapTools);
  const viewerLink = (mapId: string) => viewerOrigin === undefined ? {} : { viewerUrl: viewerUrl(viewerOrigin, mapId) };
  const author = (): MutationAuthor => ({ ...identity, occurredAt: new Date().toISOString() } as MutationAuthor);
  const server = new Server({ name: 'wayfinder-map', version: workflowContract.version }, {
    capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: workflowContract.instructions,
  });
  server.setRequestHandler('tools/list', () => ({ tools: structuredClone([...tools]) }));
  const stableResourceUri = 'wayfinder://workflow/exploration';
  const versionedResourceUri = `${stableResourceUri}/${workflowContract.version}`;
  const resources = [stableResourceUri, versionedResourceUri].map(uri => ({
    uri, name: 'Wayfinder exploration workflow', description: `Complete Wayfinder exploration workflow ${workflowContract.version}`,
    mimeType: 'text/markdown', _meta: { 'wayfinder/version': workflowContract.version },
  }));
  server.setRequestHandler('resources/list', () => ({ resources: structuredClone(resources) }));
  server.setRequestHandler('resources/read', request => {
    if (request.params.uri !== stableResourceUri && request.params.uri !== versionedResourceUri) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown workflow Resource');
    }
    return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: `version: ${workflowContract.version}\n\n${workflowContract.markdown}`,
      _meta: { 'wayfinder/version': workflowContract.version } }] };
  });
  const prompt = { name: 'start_wayfinder_exploration', description: `Start or resume Wayfinder workflow ${workflowContract.version}`,
    arguments: [{ name: 'mode', description: 'create or resume', required: true },
      { name: 'mapId', description: 'Optional stable Map ID', required: false }],
    _meta: { 'wayfinder/version': workflowContract.version } };
  server.setRequestHandler('prompts/list', () => ({ prompts: [structuredClone(prompt)] }));
  server.setRequestHandler('prompts/get', request => {
    if (request.params.name !== prompt.name) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown workflow Prompt');
    const args = request.params.arguments ?? {};
    if (Object.keys(args).some(key => !['mode', 'mapId'].includes(key)) || !['create', 'resume'].includes(args.mode ?? '')) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Prompt mode must be create or resume');
    }
    if (args.mapId !== undefined && validateId(args.mapId, ['mapId'])) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid stable Map ID');
    const selection = args.mapId === undefined ? '' : ` Stable Map ID: ${args.mapId}.`;
    return { description: prompt.description, messages: [{ role: 'user' as const, content: { type: 'text' as const,
      text: `${workflowContract.prompt}\n\nversion: ${workflowContract.version}. Mode: ${args.mode}.${selection}` } }] };
  });
  const callTool = async (request: CallToolRequest): Promise<CallToolResult> => {
    const tool = tools.find(tool => tool.name === request.params.name);
    if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown Map tool');
    // Legacy task marker only: modern SDK requests strip this deprecated field before dispatch.
    if ('task' in request.params && request.params.task !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task execution is not supported');
    const raw = request.params.arguments ?? {};
    // A write names the release whose rules the caller follows. After an upgrade, a caller still holding the old
    // rules (a client that reconnected without refreshing, or one resending its last call) is stopped before
    // anything is validated or written, and pointed at the current rules.
    if (tool.name === 'map_create' || tool.name === 'map_apply') {
      const claimed = isPlainObject(raw) ? raw.version : undefined;
      if (claimed !== workflowContract.version) {
        return envelope({ kind: 'rejected', code: 'version_mismatch',
          version: typeof claimed === 'string' && claimed.length <= 32 ? claimed : null, rules: stableResourceUri });
      }
    }
    // #111–#113 are staged capabilities until the coordinated #114 workflow release.
    // Enforce this before observing storage, including taking-read syntax reserved for #112.
    if (!answerDeskEnabled && isPlainObject(raw) && (
      (tool.name === 'map_read' && (Object.hasOwn(raw, 'claimantId') || Object.hasOwn(raw, 'version')))
      || (tool.name === 'map_apply' && (Object.hasOwn(raw, 'reopenRequestId') || (Array.isArray(raw.commands)
        && raw.commands.some(command => isPlainObject(command) && (Object.hasOwn(command, 'deskAnswer')
          || ['deskQuestion.post', 'deskQuestion.withdraw', 'reopenRequest.close'].includes(command.kind as string))))))
    )) return envelope({ kind: 'rejected', code: 'answer_desk_disabled' });
    const properties = tool.inputSchema.properties ?? {};
    const shape = validateObject(raw, [], Object.keys(properties));
    if (shape) return inputFailure(shape);
    if (!isPlainObject(raw)) return inputFailure(invalid([], 'Plain tool arguments required'));
    if (Object.hasOwn(raw, 'includeSnapshot') && typeof raw.includeSnapshot !== 'boolean') {
      return inputFailure(invalid(['includeSnapshot'], 'Boolean required'));
    }
    // Validate all submitted shape before observing storage/performing semantics.
    let create: ReturnType<typeof prepareCreate> | undefined;
    let apply: ReturnType<typeof decodeApplyRequest> | undefined;
    if (tool.name === 'map_create') {
      const { mapId, includeSnapshot: _snapshot, version: _version, ...fields } = raw;
      create = prepareCreate({ ...fields, id: mapId, author: author() } as CreateMapInput);
      if (create.kind === 'error') return inputFailure({ ...create.error, path: create.error.path.map((part, i) => i === 0 && part === 'id' ? 'mapId' : part) });
    } else if (tool.name === 'map_apply') {
      const { includeSnapshot: _snapshot, version: _version, ...fields } = raw;
      apply = decodeApplyRequest({ ...fields, author: author() });
      if (apply.kind === 'error') return inputFailure(apply.error);
      if (apply.value.commands.length > 100) return inputFailure(invalid(['commands'], 'At most 100 commands required'));
    } else if (tool.name === 'map_read') {
      const error = validateId(raw.mapId, ['mapId']);
      if (error) return inputFailure(error);
      if (Object.hasOwn(raw, 'revision') && (!Number.isSafeInteger(raw.revision) || (raw.revision as number) <= 0)) {
        return inputFailure(invalid(['revision'], 'Positive safe integer required'));
      }
    } else {
      if (Object.hasOwn(raw, 'limit') && (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 100)) {
        return inputFailure(invalid(['limit'], 'Integer from 1 through 100 required'));
      }
      if (Object.hasOwn(raw, 'afterMapId')) {
        const error = validateId(raw.afterMapId, ['afterMapId']);
        if (error) return inputFailure(error);
      }
    }
    try {
      if (tool.name === 'map_list') return envelope(storage.listMaps(raw));
      if (tool.name === 'map_read') {
        const mapId = raw.mapId as MapId;
        const revision = raw.revision as number | undefined;
        if (revision === undefined) {
          const current = storage.desk.inspect(mapId);
          if (current.kind !== 'found') return envelope(current);
          return envelope({ kind: 'found', revision: current.revision, frontier: calculateFrontier(current.revision.state), ...(answerDeskEnabled ? current.desk : {}), ...viewerLink(mapId) });
        }
        const read = await storage.adapter.readRevision(mapId, revision);
        return read.kind === 'found' ? envelope({ kind: 'found', revision: read.value, frontier: calculateFrontier(read.value.state),
          ...(answerDeskEnabled ? projectDesk(read.value.state, emptyDesk, true) : {}), ...viewerLink(mapId) }) : envelope(read);
      }
      let prepared;
      if (create?.kind === 'ok') prepared = create.value;
      else if (apply?.kind === 'ok') {
        const current = await storage.adapter.readCurrent(apply.value.mapId);
        if (current.kind !== 'found') return envelope(current);
        const result = prepareApply(current.value, apply.value, storage.desk.read(apply.value.mapId));
        if (result.kind !== 'prepared') return envelope(result);
        prepared = result.change;
      } else throw new Error('Unreachable tool preparation');
      const commit = await storage.adapter.commit(prepared);
      if (commit.kind !== 'committed') return envelope(commit);
      // The link accompanies creation and reads, not every advance.
      const link = create ? viewerLink(commit.revision.mapId) : {};
      if (raw.includeSnapshot === true) return envelope({ ...commit, ...link });
      return envelope({ kind: 'committed', mapId: commit.revision.mapId, revision: commit.revision.revision, changes: commit.revision.changes, ...link });
    } catch (error) {
      // Never expose exception text/cause/stack, SQL, paths or submitted bodies.
      // An unclassified failure cannot establish publication or connection health.
      return envelope({ kind: 'infrastructure_error', code: error instanceof SQLiteFailure ? error.code : 'storage_failure',
        outcome: error instanceof SQLiteFailure ? error.outcome : 'unknown', requiresRestart: error instanceof SQLiteFailure ? error.requiresRestart : true });
    }
  };
  server.setRequestHandler('tools/call', request => control ? control(() => callTool(request)) : callTool(request));
  return server;
}

function inputFailure(error: InvalidInput): CallToolResult {
  return envelope({ kind: 'rejected', rejection: { stage: 'input', error } });
}
function envelope<T extends { readonly kind: string }>(result: T): CallToolResult {
  return { content: [], structuredContent: structuredClone(result) as Record<string, unknown>,
    ...(result.kind === 'infrastructure_error' ? { isError: true } : {}) };
}
