import { PasswordHasher } from './password-hasher.js';

// Cheap parameters keep the suite fast; production parameters are tested by
// env.validation.spec.ts (production refuses lowered values).
const FAST = { memoryKib: 1024, timeCost: 1, parallelism: 1 };

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(FAST);

  it('produces an Argon2id PHC string with the configured parameters', async () => {
    const hash = await hasher.hash('a long enough passphrase');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it('never repeats a hash for the same password (random salt)', async () => {
    const [a, b] = await Promise.all([
      hasher.hash('same password here'),
      hasher.hash('same password here'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('right password 123');
    await expect(hasher.verify(hash, 'right password 123')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'wrong password 123')).resolves.toBe(
      false,
    );
  });

  it('normalises (NFKC) on hash and verify, so equivalent input matches', async () => {
    const hash = await hasher.hash('ｐａｓｓｗｏｒｄ-ｏｋ-１２');
    await expect(hasher.verify(hash, 'password-ok-12')).resolves.toBe(true);
  });

  it('returns false (never throws) for a malformed or foreign hash', async () => {
    await expect(hasher.verify('not-a-hash', 'whatever12345')).resolves.toBe(
      false,
    );
    await expect(hasher.verify('', 'whatever12345')).resolves.toBe(false);
  });

  it('detects when a hash was made with older parameters', async () => {
    const old = new PasswordHasher({
      memoryKib: 1024,
      timeCost: 1,
      parallelism: 1,
    });
    const hash = await old.hash('migrate me please');
    expect(hasher.needsRehash(hash)).toBe(false);
    const stronger = new PasswordHasher({
      memoryKib: 2048,
      timeCost: 2,
      parallelism: 1,
    });
    expect(stronger.needsRehash(hash)).toBe(true);
    expect(stronger.needsRehash('garbage')).toBe(true);
  });

  it('verifyUnknown runs a real verification and always answers false', async () => {
    const started = process.hrtime.bigint();
    await expect(hasher.verifyUnknown('whatever password')).resolves.toBe(
      false,
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // A real Argon2 verify takes measurable time even with cheap parameters.
    expect(elapsedMs).toBeGreaterThan(0.5);
  });
});
