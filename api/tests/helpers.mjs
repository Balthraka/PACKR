// Shared test helpers. Made-up data only: fixtures live in tests/fixtures.
// The Worker runs in plain Node here, with a real SQLite-backed D1 from Miniflare 4. The core's test seam (`deps`) is
// used to inject fake provider keys and the clock, so no test-only setting exists anywhere in src/ or core/.
import { Miniflare } from 'miniflare';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyCache } from '../core/index.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GID = 'test-google-client';
export const MID = 'test-ms-client';
export const MS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const CAROL = '33333333-3333-4333-8333-333333333333';

// ── database ───────────────────────────────────────────────────────────────
export async function newDb() {
  const mf = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("") } }',
    compatibilityDate: '2026-07-01', d1Databases: { DB: 'packr-test' },
  });
  return { mf, db: await mf.getD1Database('DB') };
}

/** Splits SQL text into statements: respects '...' strings (with '' escapes) and drops -- comments. */
export function splitSql(text) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      cur += ch;
      if (ch === "'") { if (text[i + 1] === "'") { cur += "'"; i++; } else q = false; }
    } else if (ch === "'") { q = true; cur += ch; }
    else if (ch === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; cur += '\n'; }
    else if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
export async function runSql(db, text) { for (const s of splitSql(text)) await db.prepare(s).run(); }
export const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8');
export const migrationNames = () => readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
/** Applies migrations in order; `upTo` is the last file name to apply (default: all). */
export async function migrate(db, upTo) {
  for (const f of migrationNames()) { await runSql(db, readText('migrations/' + f)); if (f === upTo) break; }
}
export const one = async (db, sql, ...b) => db.prepare(sql).bind(...b).first();
export const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
export const count = async (db, sql, ...b) => (await one(db, sql, ...b)).n;

// ── fake provider keys and ID tokens ───────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
export const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const b64u = (b) => Buffer.from(b).toString('base64url');

export function idToken(claims, { kid = 'k1', key = privateKey, nowMs = Date.now() } = {}) {
  const now = Math.floor(nowMs / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid }));
  const p = b64u(JSON.stringify({ iat: now, exp: now + 600, ...claims }));
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${b64u(sig)}`;
}
export const google = (o = {}) => idToken({ iss: 'https://accounts.google.com', aud: GID, sub: 'g-1', email: 'new@example.com', email_verified: true, name: 'New', ...o });
export const ms = (o = {}) => idToken({ iss: `https://login.microsoftonline.com/${MS_TENANT}/v2.0`, tid: MS_TENANT, aud: MID, sub: 'm-1', email: 'ms@example.com', nonce: 'n1', ...o });
export const tamper = (tok) => {
  const [h, p, s] = tok.split('.');
  const i = 100; // well inside the signature, so it changes real bits
  return [h, p, s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)].join('.');
};

// ── calling the Worker ─────────────────────────────────────────────────────
/** A fresh deps object: fake keys, a fresh key cache, and (optionally) a fixed clock. */
export const makeDeps = (now) => ({ fetchJwks: async () => ({ keys: [jwk] }), keyCache: new KeyCache(), ...(now ? { now } : {}) });
export const makeEnv = (db, extra = {}) => ({
  DB: db, GOOGLE_CLIENT_ID: GID, MS_CLIENT_ID: MID, ALLOWED_ORIGINS: 'https://good.example', ALLOW_SIGNUPS: 'false', ...extra,
});

/** Returns call(path, opts) bound to one app, env and deps. */
export function caller(app, env, deps = makeDeps()) {
  return (path, { method = 'GET', token, body, headers = {}, raw } = {}) =>
    app.handle(new Request('https://packr.test' + path, {
      method,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }), env, deps);
}
export const signIn = async (call, idTok, provider = 'google', nonce) =>
  (await call(`/auth/${provider}`, { method: 'POST', body: { idToken: idTok, nonce } })).json();
