import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('Production server: auth, API, CSRF, persistence and verified backup', { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-integration-'));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString('hex');
  const password = randomBytes(24).toString('hex');
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NORTHSTAR_ADMIN_USER: 'admin', NORTHSTAR_ADMIN_PASSWORD: password,
    NORTHSTAR_AUTOMATION_TOKEN: token, NORTHSTAR_DB_PATH: join(directory, 'terminal.sqlite'), NORTHSTAR_PUBLIC_ORIGIN: base, NORTHSTAR_AUTOMATION_ENABLED: '0' };
  let child;
  let output = '';
  const request = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(5000), ...options });
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  async function start() {
    child = spawn(process.execPath, ['scripts/server.mjs'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('Server exited: ' + output);
      try { if ((await request('/healthz')).ok) return; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Server did not become healthy: ' + output);
  }
  try {
    await start();
    assert.equal((await request('/')).status, 401);
    assert.equal((await request('/api/paper-trades', { headers: { Host: 'localhost', 'X-Forwarded-For': '127.0.0.1' } })).status, 401);
    assert.equal((await request('/data/terminal_snapshot.json')).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    const page = await request('/', { headers: { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') } });
    assert.equal(page.status, 200); assert.match(await page.text(), /Northstar Trading Terminal/);
    assert.equal((await request('/api/paper-trades', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const response = await request('/api/paper-trades?evaluate=0', { headers });
    assert.equal(response.status, 200, await response.clone().text());
    const account = await response.json(); assert.equal(account.summary.open, 0); assert.equal(account.account.balance, 10000);
    const db = new DatabaseSync(environment.NORTHSTAR_DB_PATH);
    db.prepare('UPDATE paper_accounts SET name=? WHERE id=?').run('restart-test', account.account.id); db.close();
    const backupFile = join(directory, 'verified.sqlite');
    const backup = spawn(process.execPath, ['scripts/backup_server.mjs', backupFile], { env: environment, stdio: 'pipe', windowsHide: true });
    assert.equal(await new Promise(resolve => backup.on('exit', resolve)), 0);
    const saved = new DatabaseSync(backupFile, { readOnly: true });
    assert.equal(saved.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(saved.prepare('SELECT name FROM paper_accounts').get().name, 'restart-test'); saved.close();
    await stop(); await start();
    const persisted = await (await request('/api/paper-trades?evaluate=0', { headers })).json();
    assert.equal(persisted.account.name, 'restart-test'); assert.equal(persisted.account.balance, 10000);
    assert.ok(!output.includes(token) && !output.includes(password), 'credentials must not be logged');
  } finally { await stop(); await rm(directory, { recursive: true, force: true }); }
});
