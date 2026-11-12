import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (path.includes('generated')) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles('src');
const isConfigOrSpec = (file: string) =>
  file.startsWith(join('src', 'config')) || file.endsWith('.spec.ts');

// oxlint has no no-restricted-syntax rule, so these are enforced here.
// This file must not contain the forbidden tokens literally, so patterns are
// assembled from parts.
const unsafeRaw = new RegExp(String.raw`\$(query|execute)Raw` + 'Unsafe');
const processEnv = new RegExp(String.raw`process\.` + 'env');
const consoleCall = new RegExp(
  String.raw`\bconsole\.(log|error|warn|debug|info)\b`,
);

describe('forbidden patterns in src/', () => {
  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('never uses unsafe raw SQL APIs', () => {
    const offenders = files.filter((f) =>
      unsafeRaw.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('reads process env only inside src/config', () => {
    const offenders = files.filter(
      (f) => !isConfigOrSpec(f) && processEnv.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('does not use console (use the Nest Logger)', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('.spec.ts') && consoleCall.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
