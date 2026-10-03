import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/sqlite-d1.mjs';
import { serverSettings, authorize, safeBrowserRequest } from '../server/security.mjs';
import { recurring } from '../server/loops.mjs';

const valid = { NORTHSTAR_ADMIN_USER: 'admin', NORTHSTAR_ADMIN_PASSWORD: 'a'.repeat(24), NORTHSTAR_AUTOMATION_TOKEN: 'b'.repeat(40), NORTHSTAR_DB_PATH: '/data/test.sqlite' };
test('D1 bindings, all/first/raw, changes and atomic rollback', async () => {
  const db = openDatabase(':memory:');
  try {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT UNIQUE)');
    assert.equal((await db.prepare('INSERT INTO t VALUES (?, ?)').bind(1, 'hello').run()).meta.changes, 1);
    assert.equal(await db.prepare('SELECT value FROM t WHERE id=?').bind(1).first('value'), 'hello');
    assert.equal(await db.prepare('SELECT value FROM t WHERE id=?').bind(2).first(), null);
    assert.deepEqual(await db.prepare('SELECT id,value FROM t').raw({ columnNames: true }), [['id', 'value'], [1, 'hello']]);
    await assert.rejects(db.batch([db.prepare('INSERT INTO t VALUES (2, ?)').bind('second'), db.prepare('INSERT INTO t VALUES (3, ?)').bind('hello')]));
    assert.equal(await db.prepare('SELECT COUNT(*) n FROM t').first('n'), 1);
    const result = await db.batch([db.prepare('INSERT INTO t VALUES (2, ?)').bind('second'), db.prepare('SELECT COUNT(*) n FROM t')]);
    assert.equal(result[1].results[0].n, 2);
  } finally { db.close(); }
});
test('SQLite persists across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northstar-server-test-'));
  try {
    let db = openDatabase(join(dir, 'terminal.sqlite'));
    await db.exec('CREATE TABLE test (value TEXT); INSERT INTO test VALUES (\'saved\')'); db.close();
    db = openDatabase(join(dir, 'terminal.sqlite'));
    assert.equal(await db.prepare('SELECT value FROM test').first('value'), 'saved'); db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Server refuses missing credentials, missing DB and insecure remote origin', () => {
  assert.throws(() => serverSettings({}));
  assert.throws(() => serverSettings({ ...valid, NORTHSTAR_DB_PATH: '' }));
  assert.throws(() => serverSettings({ ...valid, NORTHSTAR_PUBLIC_ORIGIN: 'http://example.com' }));
  assert.throws(() => serverSettings({ ...valid, NORTHSTAR_ADMIN_PASSWORD: 'replace_with_long_placeholder' }));
  assert.equal(serverSettings({ ...valid, NORTHSTAR_PUBLIC_ORIGIN: 'https://terminal.example.com' }).origin, 'https://terminal.example.com');
});
test('Auth covers forged loopback hosts, credentials and cross-origin requests', () => {
  const config = serverSettings(valid);
  assert.equal(authorize({ host: 'localhost', 'x-forwarded-for': '127.0.0.1' }, config), false);
  assert.equal(authorize({ authorization: 'Bearer wrong' }, config), false);
  assert.equal(authorize({ authorization: `Bearer ${config.token}` }, config), true);
  assert.equal(authorize({ authorization: 'Basic ' + Buffer.from(`admin:${config.password}`).toString('base64') }, config), true);
  assert.equal(safeBrowserRequest({ origin: 'https://evil.example' }, config), false);
  assert.equal(safeBrowserRequest({ 'sec-fetch-site': 'cross-site' }, config), false);
  assert.equal(safeBrowserRequest({ origin: config.origin }, config), true);
});
test('Slow scan does not block evaluation, each job remains serial', async () => {
  const abort = new AbortController();
  let release;
  const blocked = new Promise(r => { release = r; });
  let scans = 0, evaluations = 0;
  const scan = recurring(async () => { scans++; await blocked; }, 5, abort.signal);
  const evaluation = recurring(async () => { evaluations++; if (evaluations === 3) abort.abort(); }, 5, abort.signal);
  await evaluation;
  assert.equal(scans, 1); assert.equal(evaluations, 3);
  release(); await scan;
});
