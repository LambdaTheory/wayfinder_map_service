import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const capturesRoot = fileURLToPath(new URL('../captures/', import.meta.url));
export interface CaptureInventoryItem { id: string; status: 'paused-draft' | 'skeleton' | 'admitted'; path: string }

/** Paused intake is counted independently of executable Scenarios; F11's historical trace is an explicit legacy shape. */
export function captureInventory(root = capturesRoot): CaptureInventoryItem[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = entry.isDirectory() ? join(entry.name, 'capture.json') : entry.name;
    if (!relative.endsWith('.json')) return [];
    const record = JSON.parse(readFileSync(join(root, relative), 'utf8')) as {
      schema: string; scenarioId: string; library: { status: CaptureInventoryItem['status'] };
    };
    if (!['wayfinder-problem-capture/1', 'wayfinder-historical-capture-trace/1'].includes(record.schema)
      || !/^[A-Z][A-Za-z0-9]*$/.test(record.scenarioId)
      || !['paused-draft', 'skeleton', 'admitted'].includes(record.library?.status)) throw new Error(`Invalid capture inventory record: ${relative}`);
    return [{ id: record.scenarioId, status: record.library.status, path: relative }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}
