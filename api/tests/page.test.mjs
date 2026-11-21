// Static check of web/index.html against what the Worker (src/ + core/) can actually send.
// The page reads only `error` (as e.code) and the HTTP status from a failed call; it never reads other error fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const page = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const sources = ['src', 'core'].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(ROOT, d, f), 'utf8'))).join('\n');
const emitted = new Set([...sources.matchAll(/'([a-z]+(?:_[a-z]+)+|forbidden|internal|unauthorized|not_found)'/g)].map((m) => m[1]));

test('every error code the page tests for is one the Worker can send', () => {
  const codes = [...page.matchAll(/e\.code===['"]([a-z_]+)['"]/g)].map((m) => m[1]);
  assert.ok(codes.length >= 4, 'the sign-in screen maps several codes');
  for (const c of codes) assert.ok(emitted.has(c), `the page tests for "${c}", but the Worker never sends it`);
});

test('the page has no leftovers from the pre-core Worker', () => {
  for (const old of ['account_conflict', 'missing_id_token']) assert.ok(!page.includes(old), `page still mentions ${old}`);
  assert.ok(!/status\s*===?\s*413/.test(page), 'a too-large save is 400 body_too_large now, not 413');
});

test('the page handles the codes a user can now meet', () => {
  // sign-in screen: account_already_linked, not_invited, invalid_token and email_not_verified have their own message
  for (const c of ['account_already_linked', 'not_invited', 'invalid_token', 'email_not_verified']) assert.ok(page.includes(`'${c}'`), c);
  // saving: 409 opens the "changed on another device" screen, 401 signs out, anything else (400 body_too_large, 413 too_large, 403, 5xx) shows "Save failed"
  assert.match(page, /if\(e\.status===409\)\{loaded\.current=false;setConflict\(true\)/);
  assert.match(page, /if\(e\.status===401\)\{setToken\(null\);setUser\(null\);return;\}/);
  assert.match(page, /const retryable=!e\.status\|\|e\.status>=500;/); // only network errors and 5xx are retried; 4xx never
  assert.match(page, /RETRY_WAITS=\[5000,15000,60000\]/);               // capped: three retries, then stop
  // the page never reads any error field except the code
  assert.ok(!/currentVersion/.test(page));
});

test('the CDN scripts are pinned to exact versions and carry an integrity hash', () => {
  const tags = [...page.matchAll(/<script src="(https:\/\/unpkg\.com\/[^"]+)"([^>]*)>/g)];
  assert.equal(tags.length, 3, 'react, react-dom and babel');
  for (const [, url, rest] of tags) {
    assert.match(url, /@\d+\.\d+\.\d+\//, `${url} must name an exact version`);
    assert.match(rest, /integrity="sha384-[A-Za-z0-9+/]+=*"/, `${url} needs an integrity hash`);
    assert.match(rest, /crossorigin="anonymous"/);
  }
});
