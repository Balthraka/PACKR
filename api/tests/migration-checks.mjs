// Rehearses migrations/0002_core.sql and rollback/0002_rollback.sql on a LOCAL throwaway D1 (never remote):
// builds the pre-0002 schema, loads a seed, simulates the live state (linked users, an old-style session), applies 0002,
// checks it, signs in with the new code, then applies the rollback and checks that too.
// Used by tests/migration.test.mjs (made-up fixtures) and scripts/rehearse-0002.mjs (import/seed.sql). Prints counts only.
import assert from 'node:assert/strict';
import { app } from '../src/index.js';
import {
  newDb, migrate, runSql, readText, all, one, count, google, ms, makeDeps, makeEnv, caller, signIn,
} from './helpers.mjs';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const shape = async (db, table) => ({
  cols: (await all(db, `PRAGMA table_info(${table})`)).map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
  idx: (await all(db, `PRAGMA index_list(${table})`)).map((i) => [i.name, i.unique]).sort(),
  fks: (await all(db, `PRAGMA foreign_key_list(${table})`)).map((f) => [f.table, f.from, f.to, f.on_delete]),
});
const ddl = async (db, names) => (await all(db, `SELECT name, sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')}) ORDER BY name`, ...names))
  .map((r) => [r.name, norm(r.sql)]);
const ISO6 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/** @param {string} seedSql  the SQL that loads users and packr_trips (made by scripts/make-import.mjs) */
export async function rehearse(seedSql, log = () => {}) {
  const { mf, db } = await newDb();
  try {
    // ── before: the schema and data as they are live today ────────────────────────────────────────
    await migrate(db, '0001_init.sql');
    await runSql(db, seedSql);
    const users0 = await all(db, 'SELECT id FROM users ORDER BY id');
    assert.ok(users0.length >= 3, 'the seed needs at least three users (one linked to Google, one to Microsoft, one unlinked)');
    const [u1, u2, u3] = users0.map((u) => u.id);
    await runSql(db, `UPDATE users SET google_sub = 'rehearsal-google-1' WHERE id = '${u1}';
                      UPDATE users SET microsoft_sub = 'rehearsal-ms-2' WHERE id = '${u2}'`);
    // an old-style session (milliseconds), as in the live table
    await runSql(db, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('${'a'.repeat(64)}', '${u1}', ${Date.now() + 86_400_000})`);
    const usersBefore = await all(db, 'SELECT * FROM users ORDER BY id');
    const tripsBefore = await all(db, 'SELECT * FROM packr_trips ORDER BY id');
    const oldSessionsDdl = await ddl(db, ['sessions', 'idx_sessions_user']);
    const oldSessionsShape = await shape(db, 'sessions');
    log(`before: ${usersBefore.length} users, ${tripsBefore.length} trip rows, 1 old session`);

    // ── apply 0002 ──────────────────────────────────────────────────────────────────────────────
    await runSql(db, readText('migrations/0002_core.sql'));
    assert.deepEqual(await all(db, 'SELECT provider, subject, user_id FROM identities ORDER BY provider'), [
      { provider: 'google', subject: 'rehearsal-google-1', user_id: u1 },
      { provider: 'microsoft', subject: 'rehearsal-ms-2', user_id: u2 },
    ], 'identities are backfilled from google_sub / microsoft_sub');
    for (const r of await all(db, 'SELECT created_at FROM identities')) assert.match(r.created_at, ISO6, 'identities.created_at is ISO text with 6 fractional digits');
    assert.equal(await count(db, 'SELECT count(*) AS n FROM sessions'), 0, 'sessions are recreated empty (everyone signs in once)');
    assert.deepEqual(await all(db, 'SELECT * FROM users ORDER BY id'), usersBefore, 'users are untouched (old columns kept)');
    assert.deepEqual(await all(db, 'SELECT * FROM packr_trips ORDER BY id'), tripsBefore, 'trip data is untouched');
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), [], 'no broken foreign keys');
    // the new tables are exactly the ones in core/schema.sql
    const ref = await newDb();
    try {
      await runSql(ref.db, readText('core/schema.sql'));
      for (const t of ['sessions', 'identities']) assert.deepEqual(await shape(db, t), await shape(ref.db, t), `${t} matches core/schema.sql`);
    } finally { await ref.mf.dispose(); }
    log('after 0002: identities backfilled, sessions empty, users and trips unchanged, tables match core/schema.sql');

    // ── running it again must be safe ───────────────────────────────────────────────────────────
    await runSql(db, readText('migrations/0002_core.sql'));
    assert.equal(await count(db, 'SELECT count(*) AS n FROM identities'), 2, 'second run changes nothing');

    // ── the new code on the migrated database ────────────────────────────────────────────────────
    const call = caller(app, makeEnv(db), makeDeps());
    const r1 = await signIn(call, google({ sub: 'rehearsal-google-1', email: 'a-different-address@example.com' }));
    assert.equal(r1.user.id, u1, 'a backfilled Google identity signs in by sub, whatever email the token carries');
    const d1 = await (await call('/data', { token: r1.token })).json();
    const t1 = tripsBefore.find((t) => t.user_id === u1);
    if (t1) assert.deepEqual(d1.data, JSON.parse(t1.data), 'the user still gets exactly their saved trips');
    const r2 = await signIn(call, ms({ sub: 'rehearsal-ms-2', email: 'another@example.com' }), 'microsoft', 'n1');
    assert.equal(r2.user.id, u2, 'a backfilled Microsoft identity signs in by sub');
    const email3 = (await one(db, 'SELECT email FROM users WHERE id = ?', u3)).email;
    const r3 = await signIn(call, google({ sub: 'rehearsal-google-3', email: email3 }));
    assert.equal(r3.user.id, u3, 'an unlinked user links by verified email and keeps their ID');
    assert.equal(await count(db, 'SELECT count(*) AS n FROM identities'), 3);
    assert.equal(await count(db, 'SELECT count(*) AS n FROM sessions'), 3);
    log('after 0002: sign-in works by sub (Google, Microsoft) and by first-time email link; saved trips unchanged');

    // ── rollback ──────────────────────────────────────────────────────────────────────────────────
    await runSql(db, readText('rollback/0002_rollback.sql'));
    assert.equal(await one(db, "SELECT name FROM sqlite_master WHERE name = 'identities'"), null, 'identities is gone');
    assert.deepEqual(await ddl(db, ['sessions', 'idx_sessions_user']), oldSessionsDdl, 'sessions and its index are back to the 0001 definitions');
    assert.deepEqual(await shape(db, 'sessions'), oldSessionsShape, 'sessions has the old shape');
    assert.equal(await count(db, 'SELECT count(*) AS n FROM sessions'), 0);
    const usersAfter = await all(db, 'SELECT * FROM users ORDER BY id');
    assert.equal(usersAfter.find((u) => u.id === u3).google_sub, 'rehearsal-google-3', 'a link made after 0002 is copied back onto users');
    assert.deepEqual(usersAfter.filter((u) => u.id !== u3), usersBefore.filter((u) => u.id !== u3), 'other users are exactly as before');
    assert.deepEqual(await all(db, 'SELECT * FROM packr_trips ORDER BY id'), tripsBefore, 'trip data is untouched by the rollback');
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), [], 'no broken foreign keys after rollback');
    log('after rollback: old-shaped sessions restored, identities gone, links copied back, trips unchanged');
    return { users: usersBefore.length, trips: tripsBefore.length, db };
  } finally { await mf.dispose(); }
}
