# packr-api

Cloudflare Worker + D1 for Packr, plus a copy of the new frontend in `web/`.
Separate from every other app: own Worker, own D1 database, own users table. The sign-in and request layer is a copy of the shared `core/` (copied, not linked: there is no shared package or deployment).

## What is here
- `core/` – the shared sign-in and request layer (core v2), copied exactly from `splittrip-api` and never edited here. If it needs a change, the SplitTrip chat makes it and every app gets the same copy. Check that copies match with `node scripts/check-core.mjs . ..\splittrip-api` (exit 0 = identical; line endings are ignored). It does Google and Microsoft ID-token checks, sign-in and linking, private mode, bearer-token sessions (SHA-256 hash stored), the origin check, CORS and routing. `core/README.md` describes it. (`core/test/` is the core's own vitest suite; Packr does not run it.)
- `src/index.js` – Packr's route table (`Route[]`) and handlers only. Nothing in `src/` reads bodies or builds error replies: it uses the core's `readJson(req, maxChars)` and throws `conflict(code, extra)` (see "Body size" and "Error codes" below).
- `scripts/check-core.mjs` – compares the `core/` folders of two or more apps by hash (supplied by the planning chat, unchanged).
- `migrations/0001_init.sql` – `users`, `sessions`, `packr_trips` (one JSON blob per user, indexed by `user_id`).
- `migrations/0002_core.sql` – adopts `core/`: recreates `sessions` in the core's shape, creates `identities`, backfills it from `users.google_sub` / `users.microsoft_sub`. `rollback/0002_rollback.sql` undoes it (not in `migrations/`, so wrangler never runs it by itself).
- `scripts/make-import.mjs` – builds `import/seed.sql` from the Supabase exports, keeping user IDs and row IDs. `import/` is git-ignored because it holds real emails and trips.
- `tests/` – `npm test` runs four files, all on made-up data and never touching Cloudflare: `api.test.mjs` (the Worker in Node on a real local D1 from Miniflare 4, with fake provider keys and the clock passed through the core's `deps` seam), `migration.test.mjs` (0002 and the rollback on a copy of the live schema), `workerd.test.mjs` (the bundled Worker under `wrangler dev --local` with the real compatibility date) and `page.test.mjs` (a static check that every error code `web/index.html` tests for is one the Worker can send, that no pre-core leftovers remain, that the save-retry rules are in place, and that the CDN scripts are pinned with integrity hashes). `npm run rehearse` runs the same migration rehearsal on `import/seed.sql`, printing counts only.
- `web/index.html` – Packr with Supabase removed. Google and Microsoft buttons, API client, no keys. React and Babel load from unpkg at exact versions (18.3.1, 18.3.1, 7.29.15) with `integrity` hashes: if you change a version, recompute the hash (`openssl dgst -sha384 -binary <file> | openssl base64 -A` on the file from the npm package) or the browser will refuse the script and the page stays blank.
- Saving (in the page): changes save 3 seconds after the last edit, and at once when the page is hidden or closed. A failed save (no connection, or a 5xx) is retried after 5, 15 and 60 seconds, then the header shows "Not saved. Will retry" until the browser is back online or you edit again. 400, 401, 409 and other 4xx answers are never retried.

## API
| Route | Needs session | Replaces |
|---|---|---|
| `GET /health` | no | (health check) |
| `POST /auth/google`, `POST /auth/microsoft` `{idToken, nonce?}` | no | email + password sign-in |
| `GET /me`, `PATCH /me` `{displayName}` | yes | `auth.updateUser` display name |
| `GET /data`, `PUT /data` `{data, baseVersion}` | yes | `packr_trips` select / insert / update |
| `DELETE /me` | yes | `delete_my_account()` (deletes trips, then the user) |
| `POST /auth/logout` | yes | `signOut` |

Password change and "forgot password" no longer exist. There are no passwords.

## Rules from the brief, and where they are met
- Every query is scoped to the session user, which comes only from the core's `user` guard (`ctx.session`); unknown routes 404, and every route except `/health` and the two sign-in routes has the `user` guard. A test walks the route table and fails if that is not so.
- Index on `user_id`: the `UNIQUE` constraint on `packr_trips.user_id`.
- Stale edits rejected: `PUT /data` needs the version it was based on, otherwise 409.
- Own delete route (`DELETE /me` also removes the user's `identities` and `sessions` rows), own users table; no secrets in the frontend or the Worker (ID-token checks need none).
- Money: Packr stores weights, not money, so integer-cents does not apply here.
- Private mode: `ALLOW_SIGNUPS = "false"` (wrangler.toml). An email that is not already in `users` gets 403 `not_invited`. Set it to `"true"` only if Packr goes public.
- Old Supabase security rules, matched to code: the one policy "Users can manage own trips" (`auth.uid() = user_id`, all operations) is `WHERE user_id = <session user>` on every `packr_trips` query; the user ID comes only from the session.
- Browser storage key `packr_token` is unique to this app.

## Linking rules (as built)
- Google: needs `email_verified: true`.
- Microsoft: personal accounts only (Hotmail/Outlook/Live), because Microsoft sends no verified-email claim and work addresses can be set by a tenant admin.
- Microsoft linking relies on private mode: only emails already in `users` (the imported rows) can link. There is no separate allowlist.
- First sign-in links to the imported row with the same email and keeps its ID, and stores the provider's `sub` in `identities`; from then on the `sub` is used, not the email. If that user is already linked to a different identity for the same provider, sign-in is refused with 403 `account_already_linked` (it was 409 `account_conflict` before `core/`). An unverified Google email is 403 `email_not_verified` (it was 401). With open sign-ups (`ALLOW_SIGNUPS = "true"`, not used) the core also refuses to create a user from an unverified email, so Microsoft could then only sign in users that already exist.
- Imported users have no password column at all, so nothing can be reused.

## Setup
1. `npm install`
2. `npx wrangler login`, then `npx wrangler d1 create packr`; paste the `database_id` into `wrangler.toml`.
3. Google Cloud: OAuth client, type Web, add your Pages origin to Authorised JavaScript origins. Put the client ID in `GOOGLE_CLIENT_ID` (wrangler.toml) and in `web/index.html`.
4. Entra: app registration, "Personal Microsoft accounts only"; platform Single-page application; redirect URI = the exact Packr page URL; tick ID tokens under implicit grant. Put the client ID in `MS_CLIENT_ID` and in `web/index.html`.
5. `npx wrangler d1 migrations apply packr --remote` (applies 0001 and 0002), then `npx wrangler deploy`; put the `*.workers.dev` URL in `API_URL` in `web/index.html`.
6. Import (staging first): `npm run make-import -- <auth_users.csv> <packr_trips_rows.csv>` then `npx wrangler d1 execute packr --remote --file import/seed.sql`.
7. Test `web/index.html` yourself before anything else changes. Cutover is yours alone.

Backup before and after cutover: `npx wrangler d1 export packr --remote --output ..\packr-backup.sql` (outside this folder: backups hold real data; `.gitignore` also blocks `*.sql` at the top level and `*backup*.sql`), and keep the file somewhere other than Cloudflare.

To test with a throwaway user while private, add one by hand: `npx wrangler d1 execute packr --remote --command "INSERT INTO users (id,email,created_at) VALUES (lower(hex(randomblob(16))),'test@example.com',strftime('%s','now')*1000)"`, sign in with that Google/Microsoft account, then delete it with the in-app Delete Account.

The import can be run again safely: existing IDs are updated and sign-in links are kept.

Free plan allows 10 D1 databases and 100,000 Worker requests a day for the whole account, so this uses the single `packr` database and no staging database; use a throwaway user as above.

## Adopting `core/` on the live database (0002): read before deploying
Migration 0002 and the new Worker code go together. The new code cannot use the old `sessions` table and the old code cannot use the new one, so **sign-in is broken between the two commands**; run them one straight after the other. Everyone signed in is signed out once and signs in again (sessions hold nothing else). Nothing is dropped from `users` or `packr_trips`.

1. Backup, kept outside Cloudflare: `npx wrangler d1 export packr --remote --output ..\packr-backup-before-core.sql`
2. `npm test` (all three files must pass), then `npm run rehearse`.
3. `npx wrangler d1 migrations apply packr --remote`, then straight away `npx wrangler deploy`.
4. Check: `npx wrangler d1 execute packr --remote --command "SELECT provider, count(*) AS n FROM identities GROUP BY provider"` (one row per linked user), then sign in on the beta page.

Rollback (only if something is wrong): `npx wrangler d1 execute packr --remote --file=rollback/0002_rollback.sql`, then redeploy the previous Worker code (the last commit before `core/`) with `npx wrangler deploy`. The rollback copies any link made after 0002 back onto `users`, drops `identities`, and recreates `sessions` exactly as 0001 defined it (empty, so everyone signs in again). wrangler still lists 0002 as applied afterwards.

Notes:
- `users.google_sub` and `users.microsoft_sub` are kept, unused, so nothing is lost and the rollback can restore them. New links are written to `identities` only.
- `users.created_at` stays a number of milliseconds. The core writes it (as ISO text) only when it creates a user in public sign-up mode; nothing in Packr reads it.
- Body size: the core refuses any JSON body over 100,000 characters by default (`400 body_too_large`). Packr saves one blob per user of up to 1,000,000 characters, so `PUT /data` passes its own limit to the core's reader: `readJson(req, 1_200_000)` (the saved data plus the small envelope around it). Above that the reply is `400 body_too_large` (it was `413 too_large` when Packr had its own reader). A body that parses but whose data is over 1,000,000 characters is still `413 too_large`. All other routes keep the core's small default. The largest real saved blob today is under 46,000 characters. The page treats any failed save other than 409 and 401 as "Save failed", so the 400 and the 413 look the same to a user.
- There is no test-only setting: the old `TEST_JWKS` hook is gone, and a test fails if it reappears in `src/`, `core/` or `wrangler.toml`.
- `miniflare` is pinned to `4.20260730.0` (npm would otherwise pick a 5.x beta with a different options shape). The tests use it; deploying does not.
- `compatibility_date` is `2026-11-01` (the date SplitTrip is tested with).
- Error codes (what the page can receive): sign-in `400 invalid_token`, `403 not_invited`, `403 account_already_linked`, `403 email_not_verified`, `401 invalid_token`, `503 provider_not_configured` (Microsoft while `MS_CLIENT_ID` is empty); any route `401` (the page signs out), `403 origin_not_allowed`, `404`, `405`, `500 internal`; `PUT /data` `409 version_conflict` (reply `{ currentVersion, error }`, built by `conflict('version_conflict', { currentVersion })`), `400 body_too_large`, `400 invalid_data` / `invalid_base_version` / `invalid_json`, `413 too_large`. The page reads only the HTTP status and `error`. `tests/page.test.mjs` guards this.
