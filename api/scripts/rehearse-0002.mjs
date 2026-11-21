// Rehearses migration 0002 and its rollback on a LOCAL throwaway copy of the database built from import/seed.sql.
// Never touches Cloudflare. Prints counts only (no emails, no trip data).
// Usage: node scripts/rehearse-0002.mjs [path/to/seed.sql]      (default: import/seed.sql)
import { readFileSync } from 'node:fs';
import { rehearse } from '../tests/migration-checks.mjs';

const path = process.argv[2] || 'import/seed.sql';
const r = await rehearse(readFileSync(path, 'utf8'), (m) => console.log('  ' + m));
console.log(`PASS: migration 0002 and rollback rehearsed on ${r.users} users and ${r.trips} trip rows from ${path}`);
