// Resets the TEST database (drops everything, re-applies migrations).
// Refuses to touch any database whose name does not end in `_test`.
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env.test');
} catch {
  // Rely on the process environment (CI).
}

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set.');
  process.exit(1);
}
const database = new URL(url).pathname.replace(/^\//, '');
if (!database.endsWith('_test')) {
  console.error(`Refusing to reset "${database}": name must end with _test.`);
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['prisma', 'migrate', 'reset', '--force'],
  { stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
