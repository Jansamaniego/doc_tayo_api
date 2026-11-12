// One-time (idempotent) database setup: creates the owner/runtime roles, the
// doc_tayo and doc_tayo_test databases, and grants. Run it with an ADMIN
// connection; the application never uses these credentials.
//
//   DB_ADMIN_URL=postgresql://postgres:***@localhost:5432/postgres npm run db:bootstrap
//
// Role passwords are taken from DATABASE_MIGRATION_URL / DATABASE_URL (.env) so
// the roles always match what the app and Prisma CLI will use.
import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch {
  // Rely on the process environment.
}

const admin = process.env.DB_ADMIN_URL;
const owner = process.env.DATABASE_MIGRATION_URL;
const app = process.env.DATABASE_URL;
if (!admin || !owner || !app) {
  console.error('Set DB_ADMIN_URL, DATABASE_MIGRATION_URL and DATABASE_URL.');
  process.exit(1);
}
const password = (url) => decodeURIComponent(new URL(url).password);

const result = spawnSync(
  'psql',
  [
    admin,
    '-v', 'ON_ERROR_STOP=1',
    '-v', `owner_password=${password(owner)}`,
    '-v', `app_password=${password(app)}`,
    '-f', 'scripts/db/bootstrap.sql',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
