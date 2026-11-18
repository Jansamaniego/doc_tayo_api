import { Injectable } from '@nestjs/common';
import type { Authenticator, Principal } from './authenticator.js';

/** Production binding until Phase 3: nothing authenticates, so nothing opens. */
@Injectable()
export class DenyAllAuthenticator implements Authenticator {
  authenticate(): Promise<Principal | null> {
    return Promise.resolve(null);
  }
}
