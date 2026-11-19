import { Injectable, Logger } from '@nestjs/common';
import { MailError, Mailer } from '@nestjs/mail';
import {
  NonRetryableMessageError,
  OnOutboxMessage,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import {
  AccountSetupMail,
  ClinicOwnerMail,
  InvitationMail,
  PasswordChangedMail,
  PasswordResetMail,
} from './mails/emails.js';
import type { MailPayloads } from './mail-queue.service.js';

/**
 * Sends the queued emails after their transaction committed. At-least-once:
 * a duplicate email is acceptable, a lost one is not. Logs only the message id
 * and type, never an address or a link.
 */
@Injectable()
export class MailOutboxHandler {
  private readonly logger = new Logger(MailOutboxHandler.name);

  constructor(
    private readonly mailer: Mailer,
    private readonly passwordReset: PasswordResetMail,
    private readonly passwordChanged: PasswordChangedMail,
    private readonly accountSetup: AccountSetupMail,
    private readonly clinicOwner: ClinicOwnerMail,
    private readonly invitation: InvitationMail,
  ) {}

  @OnOutboxMessage('mail.password_reset', { consumer: 'mail-password-reset' })
  resetPassword(p: MailPayloads['password_reset'], ctx: OutboxHandlerContext) {
    return this.send(PasswordResetMail, p.to, p, ctx);
  }

  @OnOutboxMessage('mail.password_changed', {
    consumer: 'mail-password-changed',
  })
  passwordWasChanged(
    p: MailPayloads['password_changed'],
    ctx: OutboxHandlerContext,
  ) {
    return this.send(PasswordChangedMail, p.to, p, ctx);
  }

  @OnOutboxMessage('mail.account_setup', { consumer: 'mail-account-setup' })
  setUpAccount(p: MailPayloads['account_setup'], ctx: OutboxHandlerContext) {
    return this.send(AccountSetupMail, p.to, p, ctx);
  }

  @OnOutboxMessage('mail.clinic_owner', { consumer: 'mail-clinic-owner' })
  clinicOwned(p: MailPayloads['clinic_owner'], ctx: OutboxHandlerContext) {
    return this.send(ClinicOwnerMail, p.to, p, ctx);
  }

  @OnOutboxMessage('mail.invitation', { consumer: 'mail-invitation' })
  invite(p: MailPayloads['invitation'], ctx: OutboxHandlerContext) {
    return this.send(InvitationMail, p.to, p, ctx);
  }

  private async send<T>(
    mail: new (...args: never[]) => {
      render(data: T): unknown;
    },
    to: string,
    data: T,
    { message, signal }: OutboxHandlerContext,
  ): Promise<void> {
    try {
      await this.mailer.send(mail as never, {
        to,
        data: data as never,
        // A redelivery keeps its Message-ID, so receivers can de-duplicate.
        idempotencyKey: message.id,
        signal,
        // The outbox retries with its own backoff and dead-letters what never succeeds.
        retry: false,
      });
      this.logger.log({
        message: 'email sent',
        id: message.id,
        type: message.topic,
      });
    } catch (error) {
      // A refused address or sender will not be accepted later.
      if (error instanceof MailError && error.permanent) {
        throw new NonRetryableMessageError(error.message, { cause: error });
      }
      throw error;
    }
  }
}
