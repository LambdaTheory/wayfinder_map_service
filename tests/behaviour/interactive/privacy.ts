import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { leaks, redact } from '../evidence.ts';

/** Scrub recognizable login material in captured output without opening any login file or keychain. */
export function privateText(text: string, secrets: Record<string, string>, home = homedir()): string {
  const scrubbed = redact(text, secrets)
    .replace(/(Bearer\s+)(?!<)[^\s"\\]+/gi, '$1<credential>')
    .replace(/\bsk-(?:ant-oat01-|ant-api03-|proj-)?[A-Za-z0-9_-]{12,}\b/g, '<credential>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<credential>')
    .replace(/((?:access_token|refresh_token|id_token|api_key)["\\:\s=]+)([^"\\\s,}]+)/gi,
      (match, prefix: string, value: string) => value.startsWith('<') ? match : `${prefix}<credential>`)
    .split(home).join('~');
  if (leaks(scrubbed, secrets).length) throw new Error('credential survived redaction; record withheld');
  return scrubbed;
}
export function writePrivate(path: string, value: unknown, secrets: Record<string, string>): void {
  writeFileSync(path, privateText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), secrets), { mode: 0o600 });
}
