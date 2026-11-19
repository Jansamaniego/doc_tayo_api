import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Modules allowed to use the unscoped PrismaService (plans/01-multitenancy.md
 * §7.4; Phase 3 adds auth, users, mail, maintenance: plans/02-authentication.md §11).
 */
const UNSCOPED_ALLOWED = new Set([
  'health',
  'tenancy',
  'tenants',
  'audit',
  'access-control',
  'auth',
  'users',
  'mail',
  'maintenance',
  // later phases: admin
]);

interface SourceFile {
  path: string;
  content: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'generated') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const moduleOf = (path: string): string | undefined => {
  const parts = path.split(/[\\/]/);
  const i = parts.indexOf('modules');
  return i >= 0 ? parts[i + 1] : undefined;
};

/** Domain modules (everything outside the allow-list) must not touch PrismaService. */
export function unscopedPrismaViolations(files: SourceFile[]): string[] {
  return files
    .filter((f) => {
      const mod = moduleOf(f.path);
      return mod !== undefined && !UNSCOPED_ALLOWED.has(mod);
    })
    .filter((f) =>
      /\bPrismaService\b|\/prisma\.service(\.js)?['"]/.test(f.content),
    )
    .map((f) => f.path);
}

/** Production code must never import test code or the test authenticator. */
export function testLeakViolations(files: SourceFile[]): string[] {
  return files
    .filter(
      (f) =>
        /from\s+['"][^'"]*\/test\//.test(f.content) ||
        /from\s+['"](\.\.\/)+test\//.test(f.content) ||
        /TestAuthenticator/.test(f.content),
    )
    .map((f) => f.path);
}

describe('architecture: Prisma access and test isolation', () => {
  const srcDir = join(process.cwd(), 'src');
  const files: SourceFile[] = walk(srcDir)
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'))
    .map((p) => ({
      path: relative(process.cwd(), p).split(sep).join('/'),
      content: readFileSync(p, 'utf8'),
    }));

  it('the members module (invitations) uses only the tenant client', () => {
    const members = files.filter((f) =>
      f.path.startsWith('src/modules/members/'),
    );
    expect(members.length).toBeGreaterThan(0);
    expect(unscopedPrismaViolations(members)).toEqual([]);
  });

  it('the Phase 2 deny-all authenticator is gone (JwtAuthenticator is the production binding)', () => {
    expect(files.some((f) => f.path.includes('deny-all'))).toBe(false);
    expect(files.some((f) => /DenyAllAuthenticator/.test(f.content))).toBe(
      false,
    );
  });

  it('scans real source files', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.path.startsWith('src/modules/branches/'))).toBe(
      true,
    );
  });

  it('domain modules (branches, ...) never use the unscoped PrismaService', () => {
    expect(unscopedPrismaViolations(files)).toEqual([]);
  });

  it('src/ never imports from test/ or references TestAuthenticator', () => {
    expect(testLeakViolations(files)).toEqual([]);
  });

  describe('self-test (the checks can actually fail)', () => {
    it('flags a domain module importing PrismaService', () => {
      const bad = [
        {
          path: 'src/modules/patients/patients.service.ts',
          content:
            "import { PrismaService } from '../../prisma/prisma.service.js';",
        },
      ];
      expect(unscopedPrismaViolations(bad)).toEqual([bad[0]!.path]);
    });

    it('allows an identity module to import PrismaService', () => {
      expect(
        unscopedPrismaViolations([
          {
            path: 'src/modules/tenants/x.ts',
            content: 'constructor(p: PrismaService)',
          },
        ]),
      ).toEqual([]);
    });

    it('flags test imports and TestAuthenticator in src', () => {
      const bad = [
        { path: 'src/a.ts', content: "import x from '../test/support/db.js';" },
        { path: 'src/b.ts', content: 'new TestAuthenticator()' },
      ];
      expect(testLeakViolations(bad)).toEqual(['src/a.ts', 'src/b.ts']);
    });
  });
});
