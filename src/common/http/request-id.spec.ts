import { resolveRequestId } from './request-id.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('keeps a canonical UUID (lower-cased)', () => {
    const id = '0198A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B';
    expect(resolveRequestId(id)).toBe(id.toLowerCase());
  });

  it.each([
    undefined,
    '',
    'not-a-uuid',
    'x'.repeat(500),
    '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\nInjected: header',
    '<script>alert(1)</script>',
    ['0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'second'],
  ])('replaces an unsafe or missing value (%j)', (value) => {
    const id = resolveRequestId(value);
    expect(id).toMatch(UUID);
    expect(id).not.toBe(value);
  });
});
