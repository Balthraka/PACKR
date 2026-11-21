// Smoke test of the REAL bundled Worker under `wrangler dev --local` (workerd, with wrangler.toml's compatibility_date),
// on a throwaway local D1 built with wrangler's own migration runner (so 0001 and 0002 are applied exactly as on deploy),
// plus a check that wrangler also accepts the rollback file. Sign-in itself is covered in api.test.mjs (it needs fake
// provider keys, which only the core's `deps` seam may supply); here sessions are written straight into the local D1.
// Never touches Cloudflare. Made-up data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, ALICE } from './helpers.mjs';
import { routes } from '../src/index.js';

const PORT = 8798, BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'packr-d1-'));
const SEED = join(persist, 'seed.sql');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
const wr = (...a) => execFileSync('npx', ['wrangler', ...a, '--persist-to', persist], { cwd: ROOT, stdio: 'pipe', env });
const sql = (q) => JSON.parse(wr('d1', 'execute', 'packr', '--local', '--json', '--command', q).toString())[0].results;
const TOKEN = 'workerd-smoke-token-0123456789abcdef', EXPIRED = 'workerd-expired-token-0123456789abc';
const hash = (t) => createHash('sha256').update(t).digest('hex');
let proc;
const api = (path, { method = 'GET', token, body, raw, headers = {} } = {}) => fetch(BASE + path, {
  method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
});
// wrangler starts child processes (workerd), so the whole process group is stopped, not just `npx`.
const stop = async () => {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  proc = null;
};

before(async () => {
  wr('d1', 'migrations', 'apply', 'packr', '--local');   // 0001 then 0002, with wrangler's own runner
  execFileSync('node', ['scripts/make-import.mjs', 'tests/fixtures/users.csv', 'tests/fixtures/trips.csv', '--out', SEED], { cwd: ROOT });
  wr('d1', 'execute', 'packr', '--local', '--file', SEED);
  const row = (t, exp) => `('${hash(t)}', '${ALICE}', 1, '2030-01-01T00:00:00.000000Z', '${exp}')`;
  sql(`INSERT INTO sessions (token_hash, user_id, verified_email, created_at, expires_at) VALUES ${row(TOKEN, '2099-01-01T00:00:00.000000Z')}, ${row(EXPIRED, '2000-01-01T00:00:00.000000Z')}`);
  proc = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', persist,
    '--var', 'ALLOWED_ORIGINS:https://good.example'], { cwd: ROOT, stdio: 'ignore', env, detached: true });
  proc.unref();
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('worker did not start');
});
after(stop);

test('workerd: health, default deny on every non-public route, unknown paths', async () => {
  assert.equal((await api('/health')).status, 200);
  for (const r of routes.filter((x) => x.guard !== 'public')) {
    const res = await api(r.path, { method: r.method, body: r.method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${r.method} ${r.path}`);
    assert.equal((await api(r.path, { method: r.method, body: r.method === 'GET' ? undefined : {}, token: EXPIRED })).status, 401, `${r.method} ${r.path} expired`);
  }
  assert.equal((await api('/nope')).status, 404);
  assert.equal((await api('/trips/%')).status, 404);
  const ms = await api('/auth/microsoft', { method: 'POST', body: { idToken: 'x.y.z', nonce: 'n' } });
  assert.equal(ms.status, 503, 'Microsoft is off while MS_CLIENT_ID is empty');
});

test('workerd: origin check and CORS', async () => {
  const ok = await api('/health', { headers: { origin: 'https://good.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://good.example');
  const no = await api('/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(no.status, 403);
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  assert.equal((await api('/data', { method: 'OPTIONS', headers: { origin: 'https://good.example' } })).status, 204);
});

test('workerd: a session works for /me and /data, incl. a save above the core\'s default 100,000-character limit', async () => {
  const me = await (await api('/me', { token: TOKEN })).json();
  assert.equal(me.id, ALICE);
  const cur = await (await api('/data', { token: TOKEN })).json();
  assert.ok(cur.version >= 1);
  const put = await api('/data', { method: 'PUT', token: TOKEN, body: { data: { trips: [{ id: 'big', notes: 'y'.repeat(300_000) }] }, baseVersion: cur.version } });
  assert.equal(put.status, 200);
  assert.equal((await (await api('/data', { token: TOKEN })).json()).data.trips[0].notes.length, 300_000);
  const stale = await api('/data', { method: 'PUT', token: TOKEN, body: { data: { trips: [] }, baseVersion: cur.version } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).currentVersion, cur.version + 1);
  const huge = await api('/data', { method: 'PUT', token: TOKEN, raw: JSON.stringify({ data: { trips: ['z'.repeat(2_000_000)] }, baseVersion: cur.version + 1 }) });
  assert.equal(huge.status, 400);
  assert.equal((await huge.json()).error, 'body_too_large');
  assert.equal((await api('/me', { method: 'PATCH', token: TOKEN, raw: JSON.stringify({ displayName: 'q'.repeat(150_000) }) })).status, 400);
});

test('workerd: delete my account removes the user, trips, sessions and identities', async () => {
  sql(`INSERT INTO identities (provider, subject, user_id, created_at) VALUES ('google', 'smoke-sub', '${ALICE}', '2030-01-01T00:00:00.000000Z')`);
  assert.equal((await api('/me', { method: 'DELETE', token: TOKEN })).status, 200);
  assert.equal((await api('/me', { token: TOKEN })).status, 401);
  for (const q of [`SELECT count(*) AS n FROM users WHERE id = '${ALICE}'`, `SELECT count(*) AS n FROM packr_trips WHERE user_id = '${ALICE}'`,
    `SELECT count(*) AS n FROM sessions WHERE user_id = '${ALICE}'`, `SELECT count(*) AS n FROM identities WHERE user_id = '${ALICE}'`]) {
    assert.equal(sql(q)[0].n, 0, q);
  }
});

test('wrangler accepts the rollback file and restores the old sessions table', async () => {
  await stop();
  wr('d1', 'execute', 'packr', '--local', '--file', 'rollback/0002_rollback.sql');
  const cols = sql("SELECT group_concat(name) AS c FROM pragma_table_info('sessions')")[0].c;
  assert.equal(cols, 'token_hash,user_id,expires_at');
  assert.equal(sql("SELECT count(*) AS n FROM sqlite_master WHERE name = 'identities'")[0].n, 0);
});
