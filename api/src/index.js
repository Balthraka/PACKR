// Packr Worker: the route table and the handlers only.
// Sign-in, sessions, the origin check, CORS and routing all come from ../core (shared with the other apps; never edited here).
import { createApp, login, logout, publicGuard, userGuard, bad, conflict, json, readJson, HttpError } from '../core/index.js';

const MAX_DATA_CHARS = 1_000_000; // D1 rows cap at 2 MB; stay well under
const MAX_BODY_CHARS = 1_200_000; // PUT /data only: the saved data plus the small { data, baseVersion } envelope. Other routes keep the core's 100,000.
const EMPTY = { trips: [], templates: [] };

// ── handlers (every one except the three public routes runs behind the core's `user` guard) ────────────────
// The signed-in user comes from ctx.session only, never from the request body or URL.

const getMe = async (c) => json({ id: c.session.userId, email: c.session.email, displayName: c.session.name });

// replaces supabase auth.updateUser({data:{display_name}})
const patchMe = async (c) => {
  const { displayName } = await readJson(c.req);
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100) throw bad('invalid_display_name');
  const v = displayName.trim();
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(v, c.session.userId).run();
  return json({ id: c.session.userId, email: c.session.email, displayName: v });
};

// Packr's own delete-my-data route. Mirrors delete_my_account(): the user's trips, then the user. Also removes the
// sign-in links (identities) and sessions, explicitly, rather than relying on foreign-key cascades.
const deleteMe = async (c) => {
  const id = c.session.userId;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM packr_trips WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM identities WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
};

const getData = async (c) => {
  const row = await c.env.DB.prepare('SELECT data, version FROM packr_trips WHERE user_id = ?').bind(c.session.userId).first();
  if (!row) return json({ data: EMPTY, version: 0 });
  return json({ data: JSON.parse(row.data), version: row.version });
};

// Stale edits are rejected: baseVersion must equal the stored version (0 = no row yet).
const putData = async (c) => {
  const userId = c.session.userId;
  const body = await readJson(c.req, MAX_BODY_CHARS); // over this: 400 body_too_large (from the core)
  const { data, baseVersion } = body;
  if (!Number.isInteger(baseVersion) || baseVersion < 0) throw bad('invalid_base_version');
  if (!data || typeof data !== 'object' || !Array.isArray(data.trips) ||
      (data.templates !== undefined && !Array.isArray(data.templates)))
    throw bad('invalid_data');
  const text = JSON.stringify({ trips: data.trips, templates: data.templates || [] });
  if (text.length > MAX_DATA_CHARS) throw new HttpError(413, 'too_large');

  const now = Date.now();
  let res;
  if (baseVersion === 0) {
    res = await c.env.DB.prepare(
      `INSERT INTO packr_trips (id, user_id, data, version, updated_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(crypto.randomUUID(), userId, text, now).run();
  } else {
    res = await c.env.DB.prepare(
      `UPDATE packr_trips SET data = ?, version = version + 1, updated_at = ?
       WHERE user_id = ? AND version = ?`,
    ).bind(text, now, userId, baseVersion).run();
  }
  if (!res.meta.changes) {
    const cur = await c.env.DB.prepare('SELECT version FROM packr_trips WHERE user_id = ?').bind(userId).first();
    throw conflict('version_conflict', { currentVersion: cur ? cur.version : 0 }); // 409 { currentVersion, error }
  }
  return json({ version: baseVersion + 1 });
};

// ── route table ───────────────────────────────────────────────────────────
// Default deny: the only `public` routes are /health and the two sign-in routes. A test walks this table.
// /auth/microsoft stays in the table; it answers 503 provider_not_configured while MS_CLIENT_ID is empty.
export const routes = [
  { method: 'GET',    path: '/health',         guard: 'public', handler: async () => json({ ok: true }) },
  { method: 'POST',   path: '/auth/google',    guard: 'public', handler: (c) => login('google', c) },
  { method: 'POST',   path: '/auth/microsoft', guard: 'public', handler: (c) => login('microsoft', c) },
  { method: 'POST',   path: '/auth/logout',    guard: 'user',   handler: logout },
  { method: 'GET',    path: '/me',             guard: 'user',   handler: getMe },
  { method: 'PATCH',  path: '/me',             guard: 'user',   handler: patchMe },
  { method: 'DELETE', path: '/me',             guard: 'user',   handler: deleteMe },
  { method: 'GET',    path: '/data',           guard: 'user',   handler: getData },
  { method: 'PUT',    path: '/data',           guard: 'user',   handler: putData },
];

export const app = createApp({
  routes,
  guards: { public: publicGuard, user: userGuard },
  naming: { column: 'display_name', field: 'displayName' },
});

export default { fetch: (req, env) => app.handle(req, env) };
