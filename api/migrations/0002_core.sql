-- 0002: adopt the shared core/ (see core/schema.sql, core/README.md).
-- Written so that running it again after a partial failure is safe (it rebuilds both tables from scratch).
--
-- 1. sessions: the core stores times as ISO-8601 text and adds verified_email and created_at. The old table held
--    millisecond numbers, so it cannot be reused (the core compares expiry as text and every old session would look
--    expired). It is dropped and recreated EMPTY: every signed-in user has to sign in once more. No data is lost,
--    because sessions hold nothing but sign-in state.
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  token_hash     TEXT PRIMARY KEY,           -- SHA-256 hex of the bearer token; the token itself is never stored
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_email INTEGER NOT NULL DEFAULT 0, -- 1 only when the provider reported the email as verified (Google)
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 2. identities: one row per (provider, provider subject), replacing users.google_sub and users.microsoft_sub.
DROP TABLE IF EXISTS identities;
CREATE TABLE identities (
  provider    TEXT NOT NULL,                 -- 'google' | 'microsoft'
  subject     TEXT NOT NULL,                 -- the provider's stable `sub`
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_user ON identities(user_id);

-- 3. Backfill from the old columns. created_at uses the core's format (ISO, 6 fractional digits).
INSERT INTO identities (provider, subject, user_id, created_at)
  SELECT 'google', google_sub, id, strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z' FROM users WHERE google_sub IS NOT NULL;
INSERT INTO identities (provider, subject, user_id, created_at)
  SELECT 'microsoft', microsoft_sub, id, strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000Z' FROM users WHERE microsoft_sub IS NOT NULL;

-- Deliberately NOT changed:
--  * users.google_sub and users.microsoft_sub stay, unused, so nothing is lost and a rollback can restore them.
--  * users.created_at stays a number of milliseconds. The core only writes it (as ISO text) when it creates a user in
--    public sign-up mode (ALLOW_SIGNUPS = "true"); nothing in Packr reads it.
