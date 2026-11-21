// Runs Packr's Worker (src/index.js on top of core/) in Node against a real SQLite-backed D1 (Miniflare 4).
// Fake provider keys and the clock go in through the core's `deps` test seam, so there is no test-only setting anywhere
// in src/ or core/. Uses made-up users and trips from tests/fixtures; no real data is needed or used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../scripts/csv.mjs';
import { app, routes } from '../src/index.js';
import {
  ROOT, ALICE, BOB, CAROL, newDb, migrate, runSql, one, count, google, ms, idToken, tamper, otherKey, makeDeps, makeEnv, caller, signIn, GID,
} from './helpers.mjs';

const TRIPS_CSV = 'tests/fixtures/trips.csv';
const SEED = join(mkdtempSync(join(tmpdir(), 'packr-seed-')), 'seed.sql'); // a temp file, never import/seed.sql
let mf, db, env, call;

before(async () => {
  ({ mf, db } = await newDb());
  await migrate(db);
  execFileSync('node', ['scripts/make-import.mjs', 'tests/fixtures/users.csv', TRIPS_CSV, '--out', SEED], { cwd: ROOT });
  await runSql(db, readFileSync(SEED, 'utf8'));
  const mk = (n, e) => `('${'00000000-0000-4000-8000-00000000000' + n}', '${e}', ${Date.now()})`;
  await runSql(db, 'INSERT INTO users (id, email, created_at) VALUES ' +
    ['a@example.com', 'b@example.com', 'p@example.com', 'd1@example.com', 'd2@example.com', 'c@example.com'].map((e, i) => mk(i + 1, e)).join(', '));
  env = makeEnv(db);
  call = caller(app, env);
});
after(async () => { await mf.dispose(); });

test('route table: every route in it rejects a request with no session', async () => {
  assert.ok(routes.length >= 6);
  // Default deny: the only public routes are the health check and the two sign-in routes.
  const publicRoutes = routes.filter((r) => r.guard === 'public').map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(publicRoutes, ['GET /health', 'POST /auth/google', 'POST /auth/microsoft']);
  for (const r of routes.filter((x) => x.guard !== 'public')) {
    assert.equal(r.guard, 'user', `${r.method} ${r.path} must use the user guard`);
    const res = await call(r.path, { method: r.method, body: r.method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${r.method} ${r.path} must need a session`);
  }
});

test('private mode: unknown email is refused and no account is created', async () => {
  const r = await call('/auth/google', { method: 'POST', body: { idToken: google({ sub: 'g-stranger', email: 'stranger@example.com' }) } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'not_invited');
  assert.equal(await count(db, "SELECT count(*) AS n FROM users WHERE email = 'stranger@example.com'"), 0);
  assert.equal(await count(db, "SELECT count(*) AS n FROM identities WHERE subject = 'g-stranger'"), 0);
});

test('every non-public route rejects missing, junk and expired sessions', async () => {
  const guarded = [['GET', '/me'], ['PATCH', '/me'], ['DELETE', '/me'], ['GET', '/data'], ['PUT', '/data'], ['POST', '/auth/logout']];
  for (const [method, path] of guarded) {
    const body = method === 'GET' ? undefined : {};
    assert.equal((await call(path, { method, body })).status, 401, `${method} ${path} no token`);
    assert.equal((await call(path, { method, body, token: 'junk' })).status, 401, `${method} ${path} junk`);
  }
  // a real session row that has expired (times are ISO text, as the core writes them)
  const tok = 'expired-session-token-0123456789';
  const hash = createHash('sha256').update(tok).digest('hex');
  await runSql(db, `INSERT INTO sessions (token_hash, user_id, verified_email, created_at, expires_at)
                    VALUES ('${hash}', '${ALICE}', 1, '1970-01-01T00:00:00.000000Z', '1970-01-01T00:00:01.000000Z')`);
  assert.equal((await call('/me', { token: tok })).status, 401, 'expired session');
});

test('session lifetime follows the injected clock (30 days)', async () => {
  const t0 = Date.parse('2030-01-01T00:00:00Z');
  const c = caller(app, env, makeDeps(() => t0));
  const tok = idToken({ iss: 'https://accounts.google.com', aud: GID, sub: 'g-clock', email: 'c@example.com', email_verified: true }, { nowMs: t0 });
  const { token } = await signIn(c, tok);
  const at = (ms2) => caller(app, env, makeDeps(() => t0 + ms2));
  assert.equal((await at(29 * 86_400_000)('/me', { token })).status, 200, 'day 29: still valid');
  assert.equal((await at(31 * 86_400_000)('/me', { token })).status, 401, 'day 31: expired');
});

test('token checks: signature, audience, issuer, expiry, unverified email, nonce', async () => {
  const bad = [
    tamper(google({})),                                              // tampered signature
    idToken({ iss: 'https://accounts.google.com', aud: GID, sub: 'x', email: 'a@b.c', email_verified: true }, { key: otherKey }),
    google({ aud: 'someone-else' }),
    google({ iss: 'https://evil.example' }),
    google({ exp: Math.floor(Date.now() / 1000) - 3600 }),
  ];
  for (const t of bad) assert.equal((await call('/auth/google', { method: 'POST', body: { idToken: t } })).status, 401);
  // CHANGED from the old Worker: an unverified Google email used to be 401 invalid_token; the core answers 403 email_not_verified.
  const unverified = await call('/auth/google', { method: 'POST', body: { idToken: google({ email_verified: false }) } });
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json()).error, 'email_not_verified');
  assert.equal((await call('/auth/microsoft', { method: 'POST', body: { idToken: ms({ nonce: 'other' }), nonce: 'n1' } })).status, 401, 'ms nonce mismatch');
  assert.equal((await call('/auth/microsoft', { method: 'POST', body: { idToken: ms({ tid: 'some-work-tenant', iss: 'https://login.microsoftonline.com/some-work-tenant/v2.0' }), nonce: 'n1' } })).status, 401, 'work account');
  assert.equal((await call('/auth/google', { method: 'POST', body: {} })).status, 400);
});

test('imported users keep their ID when linked by verified email (Google and Microsoft)', async () => {
  const g = await signIn(call, google({ sub: 'g-alice', email: 'Alice@Example.com' }));
  assert.equal(g.user.id, ALICE);
  const again = await signIn(call, google({ sub: 'g-alice', email: 'alice@example.com' }));
  assert.equal(again.user.id, g.user.id, 'second sign-in finds it by sub');
  const m = await signIn(call, ms({ sub: 'm-bob', email: 'bob@example.com' }), 'microsoft', 'n1');
  assert.equal(m.user.id, BOB);
  assert.equal(await count(db, "SELECT count(*) AS n FROM identities WHERE user_id = ? AND provider = 'google' AND subject = 'g-alice'", ALICE), 1);
  assert.equal(await count(db, "SELECT count(*) AS n FROM identities WHERE user_id = ? AND provider = 'microsoft' AND subject = 'm-bob'", BOB), 1);
  // a different Google identity cannot hijack an already-linked account
  // CHANGED from the old Worker: 409 account_conflict is now 403 account_already_linked (the core's code).
  const r = await call('/auth/google', { method: 'POST', body: { idToken: google({ sub: 'g-attacker', email: 'alice@example.com' }) } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'account_already_linked');
});

test('sign-in reply keeps its shape: { token, user: { id, email, displayName } }', async () => {
  const r = await signIn(call, google({ sub: 'g-alice', email: 'alice@example.com' }));
  assert.deepEqual(Object.keys(r).sort(), ['token', 'user']);
  assert.deepEqual(Object.keys(r.user).sort(), ['displayName', 'email', 'id']);
  assert.equal(r.user.email, 'alice@example.com');
  const me = await (await call('/me', { token: r.token })).json();
  assert.deepEqual(Object.keys(me).sort(), ['displayName', 'email', 'id']);
});

test('import is rerunnable and counts match the export', async () => {
  const before = await count(db, 'SELECT count(*) AS n FROM identities');
  await runSql(db, readFileSync(SEED, 'utf8')); // second run must not fail
  const rows = parseCsv(readFileSync(join(ROOT, TRIPS_CSV), 'utf8'));
  assert.equal(await count(db, 'SELECT count(*) AS n FROM packr_trips WHERE id IN (' + rows.map((r) => `'${r.id}'`).join(',') + ')'), rows.length);
  assert.equal(await count(db, `SELECT count(*) AS n FROM users WHERE id IN ('${ALICE}','${BOB}','${CAROL}')`), 3);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM identities'), before, 're-importing must not touch sign-in links');
});

test('imported data is returned intact and identical to the Supabase export', async () => {
  const { token } = await signIn(call, google({ sub: 'g-alice', email: 'alice@example.com' }));
  const res = await (await call('/data', { token })).json();
  assert.ok(res.version >= 1);
  const rows = parseCsv(readFileSync(join(ROOT, TRIPS_CSV), 'utf8'));
  const src = JSON.parse(rows.find((r) => r.user_id === ALICE).data);
  assert.deepEqual(res.data, { trips: src.trips, templates: src.templates || [] });
});

test('data: create, update, stale edit rejected, own-data-only', async () => {
  const a = (await signIn(call, google({ sub: 'g-a', email: 'a@example.com' }))).token;
  const b = (await signIn(call, google({ sub: 'g-b', email: 'b@example.com' }))).token;
  assert.deepEqual(await (await call('/data', { token: a })).json(), { data: { trips: [], templates: [] }, version: 0 });
  assert.equal((await call('/data', { method: 'PUT', token: a, body: { data: { trips: [{ id: 't1' }] }, baseVersion: 0 } })).status, 200);
  // second create with baseVersion 0 must not overwrite
  const dup = await call('/data', { method: 'PUT', token: a, body: { data: { trips: [] }, baseVersion: 0 } });
  assert.equal(dup.status, 409);
  const up = await (await call('/data', { method: 'PUT', token: a, body: { data: { trips: [{ id: 't2' }], templates: [] }, baseVersion: 1 } })).json();
  assert.equal(up.version, 2);
  const stale = await call('/data', { method: 'PUT', token: a, body: { data: { trips: [] }, baseVersion: 1 } });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.currentVersion, 2);
  assert.equal(staleBody.error, 'version_conflict');
  assert.deepEqual(Object.keys(staleBody).sort(), ['currentVersion', 'error'], 'the 409 reply keeps exactly the fields the page can rely on');
  assert.deepEqual((await (await call('/data', { token: b })).json()).data.trips, [], 'user b sees none of a');
  // user_id in body is ignored
  await call('/data', { method: 'PUT', token: b, body: { user_id: 'someone', data: { trips: [{ id: 'b1' }] }, baseVersion: 0 } });
  assert.equal((await (await call('/data', { token: a })).json()).data.trips[0].id, 't2');
  assert.equal((await call('/data', { method: 'PUT', token: a, body: { data: 'x', baseVersion: 2 } })).status, 400);
  assert.equal((await call('/data', { method: 'PUT', token: a, body: { data: { trips: ['x'.repeat(1_100_000)] }, baseVersion: 2 } })).status, 413);
});

test('data: a save above the core\'s default 100,000-character limit works (PUT /data passes its own limit)', async () => {
  const { token } = await signIn(call, google({ sub: 'g-b', email: 'b@example.com' }));
  const cur = await (await call('/data', { token })).json();
  const big = { trips: [{ id: 'big', notes: 'y'.repeat(300_000) }] };
  const put = await call('/data', { method: 'PUT', token, body: { data: big, baseVersion: cur.version } });
  assert.equal(put.status, 200);
  const back = await (await call('/data', { token })).json();
  assert.equal(back.data.trips[0].notes.length, 300_000);
  // a body far past the route's limit is refused by the core while being read, and not stored: 400 body_too_large (not 413)
  const huge = await call('/data', { method: 'PUT', token, raw: JSON.stringify({ data: { trips: ['z'.repeat(2_000_000)] }, baseVersion: back.version }) });
  assert.equal(huge.status, 400);
  assert.equal((await huge.json()).error, 'body_too_large');
  assert.equal((await (await call('/data', { token })).json()).data.trips[0].notes.length, 300_000, 'the refused save changed nothing');
  // other routes keep the core's small cap
  const small = await call('/me', { method: 'PATCH', token, raw: JSON.stringify({ displayName: 'q'.repeat(150_000) }) });
  assert.equal(small.status, 400);
  assert.equal((await small.json()).error, 'body_too_large');
});

test('profile name update and logout', async () => {
  const { token } = await signIn(call, google({ sub: 'g-p', email: 'p@example.com' }));
  const r = await (await call('/me', { method: 'PATCH', token, body: { displayName: '  Pat  ' } })).json();
  assert.equal(r.displayName, 'Pat');
  assert.equal((await (await call('/me', { token })).json()).displayName, 'Pat', 'naming: users.display_name <-> displayName');
  assert.equal((await call('/me', { method: 'PATCH', token, body: { displayName: '' } })).status, 400);
  assert.equal((await call('/auth/logout', { method: 'POST', token })).status, 200);
  assert.equal((await call('/me', { token })).status, 401);
});

test('delete my account removes only the caller (including sign-in links and sessions) and invalidates the session', async () => {
  const a = await signIn(call, google({ sub: 'g-d1', email: 'd1@example.com' }));
  const b = await signIn(call, google({ sub: 'g-d2', email: 'd2@example.com' }));
  await call('/data', { method: 'PUT', token: a.token, body: { data: { trips: [{ id: 'x' }] }, baseVersion: 0 } });
  await call('/data', { method: 'PUT', token: b.token, body: { data: { trips: [{ id: 'y' }] }, baseVersion: 0 } });
  assert.equal(await count(db, 'SELECT count(*) AS n FROM identities WHERE user_id = ?', a.user.id), 1);
  assert.equal((await call('/me', { method: 'DELETE', token: a.token })).status, 200);
  assert.equal((await call('/me', { token: a.token })).status, 401);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM identities WHERE user_id = ?', a.user.id), 0, 'identities removed');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM sessions WHERE user_id = ?', a.user.id), 0, 'sessions removed');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM users WHERE id = ?', a.user.id), 0);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM identities WHERE user_id = ?', b.user.id), 1, 'other user untouched');
  assert.equal((await (await call('/data', { token: b.token })).json()).data.trips[0].id, 'y');
  const again = await call('/auth/google', { method: 'POST', body: { idToken: google({ sub: 'g-d1', email: 'd1@example.com' }) } });
  assert.equal(again.status, 403, 'deleted account cannot sign back in while private');
});

test('CORS and origin check: only listed origins are allowed', async () => {
  const ok = await call('/health', { headers: { origin: 'https://good.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://good.example');
  const no = await call('/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  assert.equal(no.status, 403, 'the core refuses an unlisted origin before any work');
  assert.equal((await no.json()).error, 'origin_not_allowed');
  const pre = await call('/data', { method: 'OPTIONS', headers: { origin: 'https://good.example' } });
  assert.equal(pre.status, 204);
  const star = caller(app, makeEnv(db, { ALLOWED_ORIGINS: '*' }));
  assert.equal((await star('/health', { headers: { origin: 'https://evil.example' } })).status, 403, '* is never accepted');
});

test('unknown paths are 404 without a token; Microsoft is off while MS_CLIENT_ID is empty', async () => {
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/trips/%')).status, 404, 'an undecodable path is a plain 404');
  const off = caller(app, makeEnv(db, { MS_CLIENT_ID: '' }));
  const r = await off('/auth/microsoft', { method: 'POST', body: { idToken: ms(), nonce: 'n1' } });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'provider_not_configured');
});

test('public sign-up mode (ALLOW_SIGNUPS = "true") creates a user; private mode is the default', async () => {
  const open = caller(app, makeEnv(db, { ALLOW_SIGNUPS: 'true' }));
  const r = await signIn(open, google({ sub: 'g-new-open', email: 'open@example.com', name: 'Open Person' }));
  assert.equal(r.user.email, 'open@example.com');
  assert.equal(r.user.displayName, 'Open Person');
  assert.equal(await count(db, "SELECT count(*) AS n FROM identities WHERE subject = 'g-new-open'"), 1);
  // core v2: open signups never create a user from an email the provider did not report as verified
  const usersBefore = await count(db, 'SELECT count(*) AS n FROM users');
  const sessBefore = await count(db, 'SELECT count(*) AS n FROM sessions');
  const unverified = await open('/auth/google', { method: 'POST', body: { idToken: google({ sub: 'g-unv', email: 'unverified@example.com', email_verified: false }) } });
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json()).error, 'email_not_verified');
  const msNew = await open('/auth/microsoft', { method: 'POST', body: { idToken: ms({ sub: 'm-new', email: 'ms-new@example.com' }), nonce: 'n1' } });
  assert.equal(msNew.status, 403, 'Microsoft never reports a verified email, so it cannot create a user in open mode');
  assert.equal((await msNew.json()).error, 'email_not_verified');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM users'), usersBefore, 'no user was created');
  assert.equal(await count(db, 'SELECT count(*) AS n FROM sessions'), sessBefore, 'no session was created');
  assert.equal(await count(db, "SELECT count(*) AS n FROM users WHERE email IN ('unverified@example.com','ms-new@example.com')"), 0);
  const msExisting = await signIn(open, ms({ sub: 'm-bob', email: 'bob@example.com' }), 'microsoft', 'n1');
  assert.equal(msExisting.user.id, BOB, 'Microsoft can still sign in a user that already exists');
  const noSetting = caller(app, makeEnv(db, { ALLOW_SIGNUPS: undefined }));
  assert.equal((await noSetting('/auth/google', { method: 'POST', body: { idToken: google({ sub: 'g-x2', email: 'x2@example.com' }) } })).status, 403);
});

test('no test-only hook exists in the Worker source, the core or the config', () => {
  const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'test' ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
  const files = [...walk('src'), ...walk('core'), 'wrangler.toml'];
  for (const f of files) assert.ok(!/TEST_JWKS/.test(readFileSync(join(ROOT, f), 'utf8')), `${f} must not mention TEST_JWKS`);
  assert.ok(!files.some((f) => /(^|[\\/])(jwt|providers)\.js$/.test(f) && f.startsWith('src')), 'src/jwt.js and src/providers.js are gone');
  // no workarounds for things the core now does: no own body reader, no hand-built error replies
  assert.ok(!files.includes(join('src', 'body.js')), 'src/body.js (own body reader) is gone');
  for (const f of files.filter((x) => x.startsWith('src'))) {
    const t = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/getReader\(/.test(t), `${f} must not read bodies itself; use readJson(req, maxChars)`);
    assert.ok(!/json\(\{ error:/.test(t), `${f} must not hand-build error replies; throw HttpError/bad/conflict with extra fields`);
  }
});
