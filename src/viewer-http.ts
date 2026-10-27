// Local Map viewer with an optional keyed answer-only entry. The MCP host routes every non-/mcp path here after its Host check.
import type { ViewerKey } from './viewer-key.js';
import { inspectViewerDesk, writeViewerDesk } from './viewer-desk.js';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MapId, Revision } from './types.js';
import type { MapIndex, SQLiteStorage } from './sqlite-storage.js';
import { validateId } from './values.js';
import { destinationHistory, fogAppearedAt, projectMap } from './viewer-projection.js';

// Same location relative to src/ (tests) and dist/ (operator build).
const assetRoot = new URL('../web/viewer/', import.meta.url);
const assets: Readonly<Record<string, string>> = {
  'desk.js': 'text/javascript; charset=utf-8',
  'index.html': 'text/html; charset=utf-8', 'viewer.js': 'text/javascript; charset=utf-8', 'viewer.css': 'text/css; charset=utf-8',
};
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export function viewerUrl(origin: string, mapId: string): string {
  return `${origin}/maps/${mapId}`;
}

export function requestTarget(url: string | undefined, host: string): URL | undefined {
  try { return new URL(url ?? '/', `http://${host}`); } catch { return undefined; }
}

export async function handleViewer(request: IncomingMessage, response: ServerResponse, storage: SQLiteStorage, host: string, key?: ViewerKey): Promise<void> {
  const target = requestTarget(request.url, host);
  if (target?.pathname === '/api/desk') {
    if (!key) return refuse(response, 404, 'not_found');
    return await answerRoute(request, response, storage, host, key);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return refuse(response, 405, 'method_not_allowed');
  }
  if (!target) return refuse(response, 400, 'invalid_target');
  const { pathname, searchParams } = target;
  const page = pathname === '/' || /^\/maps\/[^/]+$/.test(pathname);
  // A page holds no Map data, so links from other apps (Codex, Orca) may open it.
  // Data and scripts load only for this origin's own requests or a typed address.
  const navigation = page && request.headers['sec-fetch-mode'] === 'navigate';
  const site = request.headers['sec-fetch-site'];
  const origin = request.headers.origin;
  if (!navigation && ((origin !== undefined && origin !== `http://${host}`) || (site !== undefined && site !== 'same-origin' && site !== 'none'))) {
    return refuse(response, 403, 'cross_site_forbidden');
  }
  try {
    if (pathname === '/viewer/desk.js' && !key) return refuse(response, 404, 'not_found');
    if (page) return await sendAsset(response, 'index.html');
    if (pathname.startsWith('/viewer/') && Object.hasOwn(assets, pathname.slice('/viewer/'.length))) {
      return await sendAsset(response, pathname.slice('/viewer/'.length));
    }
    if (pathname === '/api/maps') return send(response, 200, { maps: listAllMaps(storage) });
    const match = /^\/api\/maps\/([^/]+)\/(view|history)$/.exec(pathname);
    if (!match) return refuse(response, 404, 'not_found');
    let mapId: string;
    try { mapId = decodeURIComponent(match[1]!); } catch { return refuse(response, 400, 'invalid_map_id'); }
    if (validateId(mapId, [])) return refuse(response, 400, 'invalid_map_id');
    if (match[2] === 'view') return await sendView(response, storage, mapId as MapId, searchParams.get('known'), key !== undefined);
    return await sendHistory(response, storage, mapId as MapId, searchParams.get('subject'));
  } catch {
    // Never expose storage diagnostics; the page shows itself as stale.
    return refuse(response, 503, 'storage_unavailable');
  }
}

async function sendView(response: ServerResponse, storage: SQLiteStorage, mapId: MapId, knownParameter: string | null, deskEnabled: boolean) {
  const known = knownParameter === null ? 0 : /^(0|[1-9][0-9]{0,15})$/.test(knownParameter) ? Number(knownParameter) : NaN;
  if (!Number.isSafeInteger(known)) return refuse(response, 400, 'invalid_known_revision');
  if (deskEnabled) {
    const current = inspectViewerDesk(storage, mapId);
    if (!current) return refuse(response, 404, 'map_not_found');
    const latest = current.revision;
    const previous = latest.revision > 1 ? await readRevision(storage, mapId, latest.revision - 1) : null;
    return send(response, 200, { ...projectMap(latest, previous), desk: current.desk });
  }
  const current = await storage.adapter.readCurrent(mapId);
  if (current.kind !== 'found') return refuse(response, 404, 'map_not_found');
  const head = current.value.currentRevision;
  if (head === known) {
    response.writeHead(204, securityHeaders);
    return void response.end();
  }
  const latest = await readRevision(storage, mapId, head);
  const previous = head > 1 ? await readRevision(storage, mapId, head - 1) : null;
  return send(response, 200, projectMap(latest, previous));
}

// Only on request from the details panel: polling never reads history.
async function sendHistory(response: ServerResponse, storage: SQLiteStorage, mapId: MapId, subject: string | null) {
  const fogId = subject?.startsWith('fog:') ? subject.slice('fog:'.length) : undefined;
  if (subject !== 'destination' && (fogId === undefined || validateId(fogId, []))) return refuse(response, 400, 'invalid_subject');
  const current = await storage.adapter.readCurrent(mapId);
  if (current.kind !== 'found') return refuse(response, 404, 'map_not_found');
  const head = current.value.currentRevision;
  const revisions: Revision[] = [];
  if (fogId !== undefined) {
    // Only the Fog item's current run matters: walk back from the head until it is absent.
    for (let revision = head; revision >= 1; revision--) {
      const read = await readRevision(storage, mapId, revision);
      if (!read.state.fog.some(item => item.id === fogId)) break;
      revisions.unshift(read);
      await yieldEvery(head - revision);
    }
    return send(response, 200, { appearedAt: fogAppearedAt(revisions, fogId) });
  }
  for (let revision = 1; revision <= head; revision++) {
    revisions.push(await readRevision(storage, mapId, revision));
    await yieldEvery(revision);
  }
  return send(response, 200, destinationHistory(revisions));
}

// Storage reads are synchronous; yield so a long history never holds /mcp commits or polls.
async function yieldEvery(count: number) {
  if (count % 25 === 0) await new Promise(resolve => setImmediate(resolve));
}

async function readRevision(storage: SQLiteStorage, mapId: MapId, revision: number): Promise<Revision> {
  const read = await storage.adapter.readRevision(mapId, revision);
  // Revisions are immutable and contiguous; absence is a storage fault.
  if (read.kind !== 'found') throw new Error('Revision history unavailable');
  return read.value;
}

function listAllMaps(storage: SQLiteStorage): MapIndex[] {
  const maps: MapIndex[] = [];
  let afterMapId: MapId | undefined;
  do {
    const page = storage.listMaps({ limit: 100, ...(afterMapId === undefined ? {} : { afterMapId }) });
    if (page.kind !== 'listed') throw new Error('Map catalog unavailable');
    maps.push(...page.maps);
    afterMapId = page.nextAfterMapId ?? undefined;
  } while (afterMapId !== undefined);
  return maps;
}

async function sendAsset(response: ServerResponse, name: string) {
  const body = await readFile(new URL(name, assetRoot));
  response.writeHead(200, { ...securityHeaders, 'Content-Type': assets[name]!, 'Content-Length': body.length });
  response.end(body);
}

function send(response: ServerResponse, status: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

function refuse(response: ServerResponse, status: number, error: string) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ error }));
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, Connection: 'close' });
  response.end(body);
}

// The single write route has no query syntax, CORS preflight, or cookie authority.
async function answerRoute(request: IncomingMessage, response: ServerResponse, storage: SQLiteStorage, host: string, key: ViewerKey) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return refuse(response, 405, 'method_not_allowed');
  }
  if (request.url !== '/api/desk') return refuse(response, 404, 'not_found');
  if (request.headers.origin !== `http://${host}` || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin')) {
    return refuse(response, 403, 'cross_site_forbidden');
  }
  if (!key.accepts(request.headers['x-wayfinder-key'])) return refuse(response, 403, 'key_required');
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) return refuse(response, 415, 'json_required');
  const limit = 1_048_576;
  if (Number(request.headers['content-length']) > limit) return refuse(response, 413, 'request_too_large');
  let input: unknown;
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > limit) return refuse(response, 413, 'request_too_large');
      chunks.push(chunk);
    }
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return refuse(response, 400, 'invalid_json'); }
  try {
    const result = writeViewerDesk(storage, input);
    if (result.kind === 'updated') return send(response, 200, result);
    return refuse(response, result.kind === 'not_found' ? 404 : result.code === 'invalid_input' ? 400 : 409, result.code);
  } catch { return refuse(response, 503, 'storage_unavailable'); }
}
