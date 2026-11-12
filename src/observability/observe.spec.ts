import {
  buildObserveOptions,
  CAPTURED_HEADERS,
  REDACTED_KEYS,
} from './observe.js';

const config = { enabled: true, appKey: 'k', appSecret: 's' };

describe('buildObserveOptions', () => {
  it('turns on redaction with credential and patient-data keys', () => {
    const { redaction } = buildObserveOptions(config, 'production');
    expect(redaction?.enabled).toBe(true);
    expect(redaction?.useDefaultPatterns).toBe(true);
    for (const key of [
      'password',
      'refreshToken',
      'authorization',
      'cookie',
      'birthDate',
      'diagnosis',
    ]) {
      expect(redaction?.keys).toContain(key);
    }
    expect(REDACTED_KEYS.length).toBeGreaterThan(10);
  });

  it('never captures request bodies, auth headers or cookies', () => {
    const { http } = buildObserveOptions(config, 'production');
    expect(http!.capture).toMatchObject({ body: false });
    const headers = (http!.capture as { headers: string[] }).headers;
    expect(headers).not.toContain('authorization');
    expect(headers).not.toContain('cookie');
    expect(CAPTURED_HEADERS).toEqual(headers);
  });

  it('masks search-like query parameters', () => {
    const regex = buildObserveOptions(config, 'production').http!
      .queryParamsObfuscateRegex!;
    expect(regex.test('q')).toBe(true);
    expect(regex.test('email')).toBe(true);
    expect(regex.test('page')).toBe(false);
  });

  it('keeps log forwarding off and follows the enabled flag', () => {
    expect(buildObserveOptions(config, 'production').forwardLogs).toBe(false);
    expect(buildObserveOptions({ enabled: false }, 'test').enabled).toBe(false);
    expect(
      buildObserveOptions({ enabled: false }, 'test').shutdownFlushTimeout,
    ).toBe(0);
  });
});
