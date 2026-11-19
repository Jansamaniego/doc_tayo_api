import {
  normalizePassword,
  validatePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy.js';

const EMAIL = 'maria.santos@clinic.example';
const GOOD = 'correct horse battery staple';

describe('validatePassword', () => {
  it('accepts a long, uncommon passphrase with spaces', () => {
    expect(validatePassword(GOOD, { email: EMAIL })).toEqual([]);
  });

  it('has no composition rules (no digit, symbol or uppercase needed)', () => {
    expect(
      validatePassword('mountainsandriversflow', { email: EMAIL }),
    ).toEqual([]);
  });

  describe('length is counted in Unicode code points', () => {
    it('rejects 9 and accepts 10', () => {
      expect(validatePassword('a1b2c3d4e', { email: EMAIL })).toEqual([
        'TOO_SHORT',
      ]);
      expect(validatePassword('xq7vk2mz9w', { email: EMAIL })).toEqual([]);
    });

    it('accepts 128 and rejects 129', () => {
      const base = 'ab'.repeat(64); // 128
      expect(base.length).toBe(PASSWORD_MAX_LENGTH);
      expect(validatePassword(base, { email: EMAIL })).toEqual([]);
      expect(validatePassword(base + 'c', { email: EMAIL })).toEqual([
        'TOO_LONG',
      ]);
    });

    it('counts an emoji as one character, not two UTF-16 units', () => {
      const nine = '😀'.repeat(PASSWORD_MIN_LENGTH - 1);
      expect(nine.length).toBe(18); // UTF-16 units
      expect(validatePassword(nine, { email: EMAIL })).toEqual(['TOO_SHORT']);
      expect(
        validatePassword('😀'.repeat(PASSWORD_MIN_LENGTH), { email: EMAIL }),
      ).toEqual([]);
    });

    it('does not trim: inner and outer spaces count', () => {
      expect(validatePassword('   a b c   ', { email: EMAIL })).toEqual([]);
    });
  });

  describe('common passwords', () => {
    it.each(['password123', 'PassWord123', 'iloveyou123', '1234567890'])(
      'rejects %s (case-insensitive)',
      (password) => {
        expect(validatePassword(password, { email: EMAIL })).toEqual([
          'PASSWORD_TOO_COMMON',
        ]);
      },
    );

    it('normalises Unicode (NFKC) before checking: full-width characters', () => {
      expect(
        validatePassword('ｐａｓｓｗｏｒｄ１２３', { email: EMAIL }),
      ).toEqual(['PASSWORD_TOO_COMMON']);
    });
  });

  describe('email', () => {
    it('rejects a password containing the local part (case-insensitive)', () => {
      expect(
        validatePassword('ILOVE-Maria.Santos-2026', { email: EMAIL }),
      ).toEqual(['PASSWORD_CONTAINS_EMAIL']);
    });

    it('rejects a password equal to the whole email', () => {
      expect(validatePassword(EMAIL, { email: EMAIL })).toEqual([
        'PASSWORD_CONTAINS_EMAIL',
      ]);
    });

    it('ignores very short local parts (would block ordinary passwords)', () => {
      expect(
        validatePassword('jo-went-to-the-market', {
          email: 'jo@clinic.example',
        }),
      ).toEqual([]);
    });
  });

  it('reports every problem at once', () => {
    expect(
      validatePassword('maria', { email: 'maria@clinic.example' }),
    ).toEqual(['TOO_SHORT', 'PASSWORD_CONTAINS_EMAIL']);
  });
});

describe('normalizePassword', () => {
  it('applies NFKC and nothing else', () => {
    expect(normalizePassword('  ｐａｓｓ  ')).toBe('  pass  ');
    expect(normalizePassword('é')).toBe('é'); // composed form
  });
});
