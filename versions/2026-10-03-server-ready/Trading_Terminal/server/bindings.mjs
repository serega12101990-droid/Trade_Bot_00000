import { openDatabase } from './sqlite-d1.mjs';

// Lazy: builds/imports must never open a real database or capture secrets.
const key = Symbol.for('northstar.server.database');
export const env = {
  get DB() {
    if (!process.env.NORTHSTAR_DB_PATH) throw new Error('NORTHSTAR_DB_PATH is required for server mode');
    return globalThis[key] ??= openDatabase(process.env.NORTHSTAR_DB_PATH);
  },
  get NORTHSTAR_AUTOMATION_TOKEN() { return process.env.NORTHSTAR_AUTOMATION_TOKEN ?? ''; },
  get ALPHA_VANTAGE_API_KEY() { return process.env.ALPHA_VANTAGE_API_KEY ?? ''; },
};
