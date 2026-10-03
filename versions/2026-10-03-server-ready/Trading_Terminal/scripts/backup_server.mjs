import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const source = process.env.NORTHSTAR_DB_PATH;
const destination = process.argv[2];
if (!source || !destination) throw new Error('Usage: NORTHSTAR_DB_PATH=... node scripts/backup_server.mjs /backups/new-file.sqlite');
if (!existsSync(source)) throw new Error('Source database does not exist');
if (existsSync(destination) || resolve(source) === resolve(destination)) throw new Error('Refusing to overwrite an existing file');
mkdirSync(dirname(resolve(destination)), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); } finally { db.close(); }
const copy = new DatabaseSync(destination, { readOnly: true });
try { if (copy.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Backup failed verification'); }
finally { copy.close(); }
console.log('Verified backup: ' + resolve(destination));
