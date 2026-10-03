import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

test('Server daemon starts monitoring and heartbeat while scan requests are pending', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'northstar-daemon-test-'));
  const token = randomBytes(32).toString('hex');
  const seen = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === '/api/automation/scan') { seen.add('scan'); return; } // Deliberately hangs; no provider access.
    if (req.url === '/api/paper-trades?evaluate=1') seen.add('paper');
    if (body?.action === 'heartbeat') seen.add('heartbeat');
    const result = req.method === 'GET' && req.url === '/api/automation/status'
      ? { watchlist: [{ symbol: 'BTCUSDT', market: 'crypto' }] } : {};
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['scripts/server_automation.mjs'], { windowsHide: true, stdio: 'pipe', env: { ...process.env,
    NORTHSTAR_TERMINAL_URL: `http://127.0.0.1:${server.address().port}`, NORTHSTAR_AUTOMATION_TOKEN: token,
    NORTHSTAR_DB_PATH: join(directory, 'unused.sqlite'), NORTHSTAR_RUNTIME_DIR: directory } });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    for (let i = 0; i < 100 && seen.size < 3; i++) {
      if (child.exitCode !== null) throw new Error('Daemon exited: ' + errors);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.deepEqual([...seen].sort(), ['heartbeat', 'paper', 'scan']);
    const saved = JSON.parse(await readFile(join(directory, 'watchlist.json'), 'utf8'));
    assert.equal(saved[0].symbol, 'BTCUSDT');
    assert.equal(saved[0].signal, undefined);
  } finally {
    child.kill('SIGTERM'); await exited;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
