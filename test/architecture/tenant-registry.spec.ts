import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '../../src/generated/prisma/client.js';
import {
  TENANT_APPEND_ONLY_MODELS,
  TENANT_OWNED_MODELS,
} from '../../src/prisma/tenant-owned-models.js';

interface Field {
  name: string;
  type: string;
  attributes: string;
}
interface ModelDef {
  name: string;
  fields: Field[];
  block: string;
}

const schemaDir = join(process.cwd(), 'prisma', 'schema');
const source = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(join(schemaDir, f), 'utf8'))
  .join('\n');

const models: ModelDef[] = [
  ...source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm),
].map(([, name, block]) => ({
  name: name!,
  block: block!,
  fields: block!
    .split('\n')
    .map((line) => line.trim())
    .filter((l) => l && !l.startsWith('@@') && !l.startsWith('//'))
    .map((line) => {
      const [fieldName, type, ...rest] = line.split(/\s+/);
      return { name: fieldName!, type: type!, attributes: rest.join(' ') };
    }),
}));
const byName = new Map(models.map((m) => [m.name, m]));
const hasTenantId = (m: ModelDef) =>
  m.fields.some((f) => f.name === 'tenantId');
const ownedNames = new Set<string>(TENANT_OWNED_MODELS);
const appendOnlyNames = new Set<string>(TENANT_APPEND_ONLY_MODELS);

describe('tenant-owned model registry (schema <-> registry)', () => {
  it('finds the models', () => {
    expect(models.length).toBeGreaterThanOrEqual(9);
  });

  it('every registry entry is a real Prisma model', () => {
    const real = new Set(Object.values(Prisma.ModelName));
    for (const name of [...ownedNames, ...appendOnlyNames]) {
      expect(real.has(name as never), `${name} is not a Prisma model`).toBe(
        true,
      );
    }
  });

  it('every model with a tenantId field is registered (owned or append-only)', () => {
    const missing = models
      .filter(hasTenantId)
      .map((m) => m.name)
      .filter((n) => !ownedNames.has(n) && !appendOnlyNames.has(n));
    expect(missing).toEqual([]);
  });

  it('no registered model lacks a tenantId field', () => {
    const wrong = [...ownedNames, ...appendOnlyNames].filter(
      (n) => !byName.get(n) || !hasTenantId(byName.get(n)!),
    );
    expect(wrong).toEqual([]);
  });

  it('tenant-owned models have @@unique([tenantId, id])', () => {
    const missing = [...ownedNames].filter(
      (n) => !/@@unique\(\[tenantId, id\]\)/.test(byName.get(n)!.block),
    );
    expect(missing).toEqual([]);
  });

  it('every relation between tenant-owned models is composite on [tenantId, x] -> [tenantId, id]', () => {
    const offenders: string[] = [];
    for (const name of ownedNames) {
      for (const field of byName.get(name)!.fields) {
        const target = field.type.replace(/[?[\]]/g, '');
        if (!field.attributes.includes('@relation(')) continue;
        if (!field.attributes.includes('fields:')) continue; // the "many" side
        if (target === 'Tenant') continue; // plain FK to the tenant root
        if (!ownedNames.has(target)) continue; // global target (users, permissions)
        const ok =
          /fields:\s*\[tenantId,\s*\w+\]/.test(field.attributes) &&
          /references:\s*\[tenantId,\s*id\]/.test(field.attributes);
        if (!ok) offenders.push(`${name}.${field.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('relations from tenant-owned models use onDelete: Restrict', () => {
    const offenders: string[] = [];
    for (const name of ownedNames) {
      for (const field of byName.get(name)!.fields) {
        if (
          field.attributes.includes('fields:') &&
          !field.attributes.includes('onDelete: Restrict')
        ) {
          offenders.push(`${name}.${field.name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
