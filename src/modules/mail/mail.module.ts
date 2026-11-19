import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  FileMailTransport,
  InMemoryMailTransport,
  LogMailTransport,
  MailModule as NestMailModule,
  SmtpTransport,
  type MailTransport,
} from '@nestjs/mail';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromPrisma, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { mailConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailOutboxHandler } from './mail-outbox.handler.js';
import { MailQueue } from './mail-queue.service.js';
import {
  AccountSetupMail,
  ClinicOwnerMail,
  InvitationMail,
  PasswordChangedMail,
  PasswordResetMail,
} from './mails/emails.js';

const DEFAULT_FROM = 'DocTayo <no-reply@doctayo.local>';

/** Picks the transport from MAIL_TRANSPORT (validated at startup; production requires smtp). */
function buildTransport(mail: ConfigType<typeof mailConfig>): MailTransport {
  switch (mail.transport) {
    case 'smtp':
      return new SmtpTransport({ url: mail.smtpUrl!, pool: true });
    case 'file':
      return new FileMailTransport({ directory: 'var/mail' });
    case 'memory':
      return new InMemoryMailTransport();
    case 'log':
      return new LogMailTransport();
  }
}

/**
 * Email through the transactional outbox. The outbox tables are created by our
 * Prisma migration (the store runs with `migrate: false`); see
 * plans/02-authentication.md §4.4 and docs/adr/0013-mail-and-outbox.md.
 */
@Module({
  imports: [
    NestMailModule.forRootAsync({
      inject: [mailConfig.KEY],
      useFactory: (mail: ConfigType<typeof mailConfig>) => ({
        transport: buildTransport(mail),
        from: mail.from ?? DEFAULT_FROM,
      }),
    }),
    OutboxModule.forRootAsync({
      inject: [mailConfig.KEY],
      useFactory: (mail: ConfigType<typeof mailConfig>) => ({
        relay: { enabled: mail.outboxRelay, pollInterval: '1s' },
        // A mail server that is down for a while must not lose an email.
        retry: { attempts: 10, backoff: { delay: '10s', maxDelay: '10m' } },
      }),
    }),
  ],
  providers: [
    {
      provide: PostgresOutboxStore,
      inject: [PrismaService, OutboxStorage],
      useFactory: (prisma: PrismaService, storage: OutboxStorage) =>
        new PostgresOutboxStore(
          { executor: fromPrisma(prisma), migrate: false },
          storage,
        ),
    },
    MailQueue,
    PasswordResetMail,
    PasswordChangedMail,
    AccountSetupMail,
    ClinicOwnerMail,
    InvitationMail,
    MailOutboxHandler,
  ],
  exports: [MailQueue],
})
export class MailModule {}
