import { createHash, timingSafeEqual } from 'node:crypto';

const same = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
export function serverSettings(env = process.env) {
  const username = env.NORTHSTAR_ADMIN_USER ?? 'admin';
  const password = env.NORTHSTAR_ADMIN_PASSWORD ?? '';
  const token = env.NORTHSTAR_AUTOMATION_TOKEN ?? '';
  if (password.length < 20 || token.length < 32 || password === token || password.includes('replace_') || token.includes('replace_')) throw new Error('Set different random admin password (20+ chars) and automation token (32+ chars)');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(username)) throw new Error('Invalid admin username');
  if (!env.NORTHSTAR_DB_PATH) throw new Error('NORTHSTAR_DB_PATH is required');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const origin = new URL(env.NORTHSTAR_PUBLIC_ORIGIN ?? `http://localhost:${port}`);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use a plain public origin without credentials/path/query');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Non-loopback public origin requires HTTPS');
  return { username, password, token, port, origin: origin.origin, host: env.HOST ?? '127.0.0.1' };
}

export function authorize(headers, config) {
  const authorization = String(headers.authorization ?? '');
  if (same(authorization, `Bearer ${config.token}`)) return true;
  if (!authorization.startsWith('Basic ')) return false;
  const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  return same(credentials, `${config.username}:${config.password}`);
}

export function safeBrowserRequest(headers, config) {
  // Even GET endpoints can evaluate trades: reject cross-origin reads too.
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  if (headers.origin && headers.origin !== config.origin) return false;
  return true;
}
