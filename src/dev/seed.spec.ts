import { assertDevelopmentOnly } from './seed.js';

describe('assertDevelopmentOnly', () => {
  it('refuses to seed in production', () => {
    expect(() => assertDevelopmentOnly('production')).toThrow(/production/i);
  });

  it.each(['development', 'test'])('allows %s', (env) => {
    expect(() => assertDevelopmentOnly(env)).not.toThrow();
  });
});
