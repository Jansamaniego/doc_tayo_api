import { defineConfig } from 'prisma/config';

// Tooling file (outside src/): the Prisma CLI does not load .env on its own,
// so load it here. Real environment variables (CI, production) take priority.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Owner role. The CLI never uses the runtime URL (DATABASE_URL).
    url: process.env.DATABASE_MIGRATION_URL,
  },
});
