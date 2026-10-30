// Process-local browser capability. It is never an MCP credential or Map field.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertPrivate, assertPrivateFileParent } from './private-paths.js';

export function createViewerKey(path?: string) {
  const key = randomBytes(32).toString('base64url');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const digest = hash(key);
  let published = false;
  return {
    accepts(value: unknown): boolean { return typeof value === 'string' && timingSafeEqual(hash(value), digest); },
    publish() {
      if (path === undefined) return;
      // The launcher creates its private directory. Never follow a key-file symlink
      // or write a credential into a shared directory, even on first startup.
      if (process.platform === 'win32') assertPrivateFileParent(path);
      else {
        // Preserve the existing POSIX launcher contract; NTFS ACL checks are
        // additive and must not impose Windows path/mode rules on macOS.
        const parent = lstatSync(dirname(path));
        if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw Error('Private key directory required');
        try {
          const existing = lstatSync(path);
          if (!existing.isFile() || existing.uid !== parent.uid || (existing.mode & 0o077)) throw Error('Private key file required');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const temporary = `${path}.${randomBytes(12).toString('hex')}`;
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { writeFileSync(fd, key); } finally { closeSync(fd); }
        if (process.platform === 'win32') assertPrivate(temporary, false);
        renameSync(temporary, path); published = true;
      }
      finally { try { unlinkSync(temporary); } catch { /* Renamed or failed before publication. */ } }
    },
    remove() {
      if (!published || path === undefined) return;
      // Do not remove a later process's key if an operator restarted elsewhere.
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { if (fstatSync(fd).isFile() && readFileSync(fd, 'utf8') === key) unlinkSync(path); }
        finally { closeSync(fd); }
      } catch { /* A key file can be removed independently; the in-memory key dies on stop. */ }
    },
  };
}
export type ViewerKey = ReturnType<typeof createViewerKey>;
