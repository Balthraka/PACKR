// Migration 0002 and its rollback, rehearsed on a local throwaway D1 with the made-up fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { rehearse } from './migration-checks.mjs';

test('0002 migrates a copy of the live schema and data, signs in, and rolls back cleanly', async () => {
  const seed = join(mkdtempSync(join(tmpdir(), 'packr-mig-')), 'seed.sql');
  execFileSync('node', ['scripts/make-import.mjs', 'tests/fixtures/users.csv', 'tests/fixtures/trips.csv', '--out', seed], { cwd: ROOT });
  const r = await rehearse(readFileSync(seed, 'utf8'));
  assert.equal(r.users, 3);
});
