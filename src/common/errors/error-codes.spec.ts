import { readFileSync } from 'node:fs';
import { ERROR_CODES, FIELD_ERROR_CODES } from './error-codes.js';

const doc = readFileSync('docs/error-codes.md', 'utf8');

describe('docs/error-codes.md', () => {
  it.each(Object.keys(ERROR_CODES))('documents error code %s', (code) => {
    expect(doc).toContain(`\`${code}\``);
  });

  it.each(Object.keys(FIELD_ERROR_CODES))('documents field code %s', (code) => {
    expect(doc).toContain(`\`${code}\``);
  });

  it('documents no code that is missing from the catalog', () => {
    const documented = [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map(
      (m) => m[1],
    );
    const known = new Set([
      ...Object.keys(ERROR_CODES),
      ...Object.keys(FIELD_ERROR_CODES),
    ]);
    expect(documented.filter((code) => !known.has(code ?? ''))).toEqual([]);
  });
});
