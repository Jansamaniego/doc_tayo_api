import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  try {
    process.loadEnvFile('.env.test');
  } catch {
    // CI provides real environment variables.
  }
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!runtimeUrl || !migrationUrl) {
    throw new Error(
      'DATABASE_URL and DATABASE_MIGRATION_URL must be set for e2e tests.',
    );
  }
  for (const url of [runtimeUrl, migrationUrl]) {
    const database = new URL(url).pathname.replace(/^\//, '');
    if (!database.endsWith('_test')) {
      // Never run tests against development or production data.
      throw new Error(
        `Refusing to run e2e tests against database "${database}": name must end with _test.`,
      );
    }
  }
  // Apply committed migrations as the owner role (idempotent).
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });
}
