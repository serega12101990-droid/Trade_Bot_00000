import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Small D1-compatible adapter for the methods used by this application.
// Each batch runs synchronously in one SQLite transaction, with rollback.
export function openDatabase(filename) {
  const path = filename === ':memory:' ? filename : resolve(filename);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; this.owner = sqlite; }
    bind(...values) { return new Statement(this.sql, values.map(v => typeof v === 'boolean' ? Number(v) : v)); }
    execute() {
      const started = performance.now();
      const stmt = sqlite.prepare(this.sql);
      const columns = stmt.columns();
      const results = columns.length ? stmt.all(...this.values) : [];
      const result = columns.length ? { changes: 0, lastInsertRowid: 0 } : stmt.run(...this.values);
      return { success: true, results, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid), duration: performance.now() - started } };
    }
    async all() { return this.execute(); }
    async run() { return this.execute(); }
    async first(column) { const row = this.execute().results[0]; return row ? (column == null ? row : row[column] ?? null) : null; }
    async raw(options = {}) {
      const stmt = sqlite.prepare(this.sql);
      const columns = stmt.columns().map(c => c.name);
      stmt.setReturnArrays(true);
      const rows = stmt.all(...this.values);
      return options.columnNames ? [columns, ...rows] : rows;
    }
  }
  return {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      if (statements.some(s => !(s instanceof Statement) || s.owner !== sqlite)) throw new Error('Foreign statement in batch');
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    async exec(sql) { const start = performance.now(); sqlite.exec(sql); return { count: 1, duration: performance.now() - start }; },
    close() { sqlite.close(); },
  };
}
