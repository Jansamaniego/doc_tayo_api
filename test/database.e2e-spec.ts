import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestApp } from './setup/create-test-app.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Database and startup (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  it('connects as the least-privilege runtime role', async () => {
    const [row] = await prisma.$queryRaw<
      {
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
      }[]
    >`SELECT current_user, rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    expect(row).toEqual({
      current_user: 'doctayo_app',
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
    });
  });

  it('cannot run DDL', async () => {
    await expect(
      prisma.$executeRaw`CREATE TABLE should_not_exist (id int)`,
    ).rejects.toThrow();
  });

  it('uses the configured schema', async () => {
    const [row] = await prisma.$queryRaw<
      { schema: string }[]
    >`SELECT current_schema() AS schema`;
    expect(row?.schema).toBe('public');
  });

  it('refuses to start when the configuration is invalid, naming only the variable', async () => {
    const secret = 'SECRET-PASSWORD-VALUE';
    await expect(
      createTestApp({ env: { DATABASE_URL: `mysql://user:${secret}@h/db` } }),
    ).rejects.toThrow(/DATABASE_URL/);
    await expect(
      createTestApp({ env: { DATABASE_URL: `mysql://user:${secret}@h/db` } }),
    ).rejects.not.toThrow(secret);
  });

  it('refuses to start when DATABASE_URL is missing', async () => {
    await expect(
      createTestApp({ env: { DATABASE_URL: undefined } }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('refuses to start when PostgreSQL is unreachable', async () => {
    await expect(
      createTestApp({
        env: {
          DATABASE_URL: 'postgresql://doctayo_app:x@127.0.0.1:1/doc_tayo_test',
        },
      }),
    ).rejects.toThrow();
  });
});
