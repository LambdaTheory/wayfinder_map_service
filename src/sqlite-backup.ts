import { backupSQLite } from './sqlite-storage.js';

// Explicit operator maintenance, not a business/MCP tool. Arguments and causes
// can contain private paths, so diagnostics deliberately never print them.
const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
  console.error('Usage: npm run --silent backup -- <absolute-source> <fresh-absolute-destination>');
  process.exitCode = 1;
} else {
  try {
    backupSQLite(source, destination);
    console.log('SQLite backup completed');
  } catch {
    console.error('SQLite backup failed; no confirmed backup. Inspect any fresh output before use.');
    process.exitCode = 1;
  }
}
