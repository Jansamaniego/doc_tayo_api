import { Injectable } from '@nestjs/common';
import { Outbox } from '@nestjs/outbox';

/** What each kind of email needs. Tokens are the raw emailed secrets. */
export interface MailPayloads {
  password_reset: { to: string; token: string };
  password_changed: { to: string };
  account_setup: {
    to: string;
    token: string;
    clinicName: string;
    fullName: string;
  };
  clinic_owner: { to: string; clinicName: string; fullName: string };
  invitation: {
    to: string;
    token: string;
    clinicName: string;
    roleName: string;
  };
}
export type MailKind = keyof MailPayloads;

export const mailTopic = (kind: MailKind): string => `mail.${kind}`;

/**
 * Queues an email in the SAME database transaction as the change that causes
 * it (transactional outbox), so an email is sent if and only if that change
 * committed. Nothing is ever sent from inside a request: a relay delivers
 * committed messages afterwards, with retries (plans/02-authentication.md §8.4).
 *
 * The payload is stored in `nest_outbox.messages` until delivered (and in the
 * dead-letter table if delivery keeps failing; the cleanup job purges those).
 */
@Injectable()
export class MailQueue {
  constructor(private readonly outbox: Outbox<object>) {}

  /** `tx` is the Prisma interactive-transaction client of the caller. */
  async enqueue<K extends MailKind>(
    tx: object,
    kind: K,
    payload: MailPayloads[K],
  ): Promise<void> {
    await this.outbox.add(tx, { topic: mailTopic(kind), payload });
  }

  /** Call AFTER the transaction committed: delivers now instead of at the next poll. */
  notify(): void {
    this.outbox.notify();
  }
}
