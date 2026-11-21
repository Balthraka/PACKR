-- ROLLBACK of migrations/0002_core.sql. NOT in migrations/, so wrangler never applies it by itself.
-- Use it only together with redeploying the previous (pre-core) Worker code, because the old code cannot use the new
-- sessions table. Everyone is signed out once (sessions are recreated empty).
--
-- Run with:  npx wrangler d1 execute packr --remote --file=rollback/0002_rollback.sql
--
-- 1. Copy any sign-in link made after 0002 back onto users, only where the old column is still empty.
UPDATE users SET google_sub = (SELECT subject FROM identities WHERE identities.user_id = users.id AND identities.provider = 'google')
  WHERE google_sub IS NULL AND EXISTS (SELECT 1 FROM identities WHERE identities.user_id = users.id AND identities.provider = 'google');
UPDATE users SET microsoft_sub = (SELECT subject FROM identities WHERE identities.user_id = users.id AND identities.provider = 'microsoft')
  WHERE microsoft_sub IS NULL AND EXISTS (SELECT 1 FROM identities WHERE identities.user_id = users.id AND identities.provider = 'microsoft');

-- 2. Remove the core's tables.
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS sessions;

-- 3. Recreate sessions exactly as migrations/0001_init.sql defined it.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,               -- SHA-256 of the bearer token; raw token is never stored
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Afterwards wrangler still lists 0002 as applied. If you ever want to apply it again, first run:
--   npx wrangler d1 execute packr --remote --command "DELETE FROM d1_migrations WHERE name = '0002_core.sql'"
