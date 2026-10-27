// Operator configuration only. This module is deliberately separate from the pure core.
export { initializeSQLite, openSQLite, SQLiteFailure } from './sqlite-internal.js';
export type { ListedMaps, MapIndex, SQLiteStorage } from './sqlite-internal.js';
export type { DeskStorage, AnswerSubmission, ReopenSubmission, DeskWrite } from './desk-storage.js';
