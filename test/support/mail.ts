import type { INestApplication } from '@nestjs/common';
import {
  InMemoryMailTransport,
  MailTransport,
  type SentMail,
} from '@nestjs/mail';
import { OutboxRelay } from '@nestjs/outbox';

/** The in-memory transport createTestApp installs (every mail "sent" by the API). */
export const mailbox = (app: INestApplication): InMemoryMailTransport =>
  app.get(MailTransport) as InMemoryMailTransport;

/** Publishes everything committed to the outbox (the relay is off in tests). */
export const deliverMail = async (app: INestApplication): Promise<void> => {
  await app.get(OutboxRelay).runOnce();
};

/** The `token` in an emailed link's URL fragment (`#token=...`). */
export const tokenFromLink = (mail: SentMail, pathPart: string): string => {
  const url = mail.link(pathPart);
  return new URLSearchParams(url.hash.slice(1)).get('token')!;
};
