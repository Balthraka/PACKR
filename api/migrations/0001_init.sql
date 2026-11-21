-- Packr D1 schema. No password column: sign-in is Google / Microsoft only.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- kept from Supabase auth.users.id for imported users
  email         TEXT NOT NULL UNIQUE,        -- stored lowercase
  display_name  TEXT,
  google_sub    TEXT UNIQUE,
  microsoft_sub TEXT UNIQUE,
  created_at    INTEGER NOT NULL             -- ms since epoch
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,               -- SHA-256 of the bearer token; raw token is never stored
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- One JSON blob per user, same shape as Supabase packr_trips.data ({trips, templates}).
CREATE TABLE packr_trips (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users(id),  -- UNIQUE also gives the user_id index
  data       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
