import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { html, type Mailable } from '@nestjs/mail';
import { authConfig } from '../../../config/configuration.js';
import type { MailPayloads } from '../mail-queue.service.js';
import { layout, linkButton, oneLine } from './layout.js';

/** Links point at the FRONTEND; the token is in the fragment, which browsers never send to a server. */
abstract class LinkingMail {
  constructor(
    @Inject(authConfig.KEY)
    protected readonly auth: ConfigType<typeof authConfig>,
  ) {}

  protected link(path: string, token?: string): string {
    const base = `${this.auth.appPublicUrl}${path}`;
    return token ? `${base}#token=${encodeURIComponent(token)}` : base;
  }
}

@Injectable()
export class PasswordResetMail
  extends LinkingMail
  implements Mailable<MailPayloads['password_reset']>
{
  render({ token }: MailPayloads['password_reset']) {
    return {
      subject: 'Reset your DocTayo password',
      html: layout(
        'Reset your password',
        html`<p>
            We received a request to reset the password of your DocTayo account.
            This link works once and expires in 30 minutes.
          </p>
          ${linkButton(this.link('/reset-password', token), 'Choose a new password')}`,
      ),
    };
  }
}

@Injectable()
export class PasswordChangedMail
  extends LinkingMail
  implements Mailable<MailPayloads['password_changed']>
{
  render() {
    return {
      subject: 'Your DocTayo password was changed',
      html: layout(
        'Your password was changed',
        html`<p>
            The password of your DocTayo account was just changed, and you were
            signed out of your other devices.
          </p>
          <p>
            If this was not you, reset your password now and contact your clinic
            administrator.
          </p>
          ${linkButton(this.link('/forgot-password'), 'Reset my password')}`,
        'You are receiving this because of a security change on your account.',
      ),
    };
  }
}

@Injectable()
export class AccountSetupMail
  extends LinkingMail
  implements Mailable<MailPayloads['account_setup']>
{
  render({ token, clinicName, fullName }: MailPayloads['account_setup']) {
    return {
      subject: oneLine(`Set up your DocTayo account for ${clinicName}`),
      html: layout(
        'Welcome to DocTayo',
        html`<p>Hello ${fullName},</p>
          <p>
            ${clinicName} is ready. Choose a password to finish setting up your
            account. This link works once and expires in 7 days.
          </p>
          ${linkButton(this.link('/account-setup', token), 'Set up my account')}`,
      ),
    };
  }
}

@Injectable()
export class ClinicOwnerMail
  extends LinkingMail
  implements Mailable<MailPayloads['clinic_owner']>
{
  render({ clinicName, fullName }: MailPayloads['clinic_owner']) {
    return {
      subject: oneLine(`You are now an owner of ${clinicName}`),
      html: layout(
        'A new clinic was added to your account',
        html`<p>Hello ${fullName},</p>
          <p>
            You are now an owner of ${clinicName} on DocTayo. Sign in with your
            existing account to open it.
          </p>
          ${linkButton(this.link('/login'), 'Sign in')}`,
      ),
    };
  }
}

@Injectable()
export class InvitationMail
  extends LinkingMail
  implements Mailable<MailPayloads['invitation']>
{
  render({ token, clinicName, roleName }: MailPayloads['invitation']) {
    return {
      subject: oneLine(`${clinicName} invited you to DocTayo`),
      html: layout(
        `Join ${clinicName}`,
        html`<p>
            You have been invited to join ${clinicName} on DocTayo as
            ${roleName}. This invitation expires in 7 days.
          </p>
          ${linkButton(this.link('/accept-invitation', token), 'Accept the invitation')}`,
      ),
    };
  }
}
