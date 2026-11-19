import * as argon2 from 'argon2';
import { normalizePassword } from './password-policy.js';

export interface Argon2Params {
  memoryKib: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Argon2id hashing (OWASP baseline parameters come from configuration).
 * `verify` never throws: a malformed or foreign hash is simply "no match".
 */
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(private readonly params: Argon2Params) {}

  private get options(): argon2.HashOptions {
    return {
      type: argon2.argon2id,
      memoryCost: this.params.memoryKib,
      timeCost: this.params.timeCost,
      parallelism: this.params.parallelism,
    };
  }

  hash(password: string): Promise<string> {
    return argon2.hash(normalizePassword(password), this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, normalizePassword(password));
    } catch {
      return false;
    }
  }

  /** True when the hash was made with different parameters (or is unreadable). */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }

  /**
   * Burns the same CPU time as a real verification, for logins with an unknown
   * email, so response time does not reveal which accounts exist. Always false.
   */
  async verifyUnknown(password: string): Promise<false> {
    this.dummyHash ??= this.hash('timing-equalisation-only');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
