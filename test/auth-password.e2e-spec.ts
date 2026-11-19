import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import { vi } from 'vitest';
import request from 'supertest';
import { hashToken } from '../src/common/security/token.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { MailQueue } from '../src/modules/mail/mail-queue.service.js';
import { TenantOnboardingService } from '../src/modules/tenants/tenant-onboarding.service.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  refreshCookie,
  seedMembership,
  TEST_PASSWORD,
  type TestUser,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { deliverMail, mailbox, tokenFromLink } from './support/mail.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { DAY, MINUTE, TestClock } from './support/test-clock.js';

const API = '/api/v1';
const NEW_PASSWORD = 'a brand new passphrase 42';

describe('password flows and account setup (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let clock: TestClock;
  let throttle: ResettableThrottlerStorage;
  let user: TestUser;

  beforeAll(async () => {
    owner = createOwnerClient();
    clock = new TestClock();
    app = await createTestApp({ productionAuthenticator: true, clock });
    throttle = app.get(ThrottlerStorage) as ResettableThrottlerStorage;
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    throttle.reset();
    await resetTenancyData(owner);
    mailbox(app).clear();
    user = await createActiveUser(owner, 'doc@example.com');
  });
  afterEach(() => vi.restoreAllMocks());

  const http = () => request(app.getHttpServer());
  const forgot = (email: string) =>
    http().post(`${API}/auth/password/forgot`).send({ email });
  const reset = (token: string, newPassword: string) =>
    http().post(`${API}/auth/password/reset`).send({ token, newPassword });
  const loginAs = (email: string, password: string) =>
    http().post(`${API}/auth/login`).send({ email, password });
  const signIn = async (who: TestUser = user) => {
    const res = await loginAs(who.email, who.password).expect(200);
    return res.body.data.accessToken as string;
  };
  const requestReset = async (email = user.email) => {
    await forgot(email).expect(202);
    await deliverMail(app);
    const mail = mailbox(app).mails.at(-1)!;
    return tokenFromLink(mail, '/reset-password');
  };
  const tokens = (type: 'password_reset' | 'account_setup') =>
    owner.userToken.findMany({
      where: { type },
      orderBy: { createdAt: 'asc' },
    });

  describe('POST /auth/password/forgot', () => {
    it('emails a single-use reset link to an active user (after commit, via the outbox)', async () => {
      const res = await forgot(user.email).expect(202);
      expect(res.body).toEqual({ data: { accepted: true } });
      mailbox(app).assertNotSent(); // queued, not sent from the request
      await deliverMail(app);

      const mail = mailbox(app).assertSent({ to: user.email });
      expect(mail.subject).toMatch(/reset/i);
      const token = tokenFromLink(mail, '/reset-password');
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The link goes to the frontend, with the token in the FRAGMENT (never sent to servers).
      const url = mail.link('/reset-password');
      expect(url.origin).toBe('http://localhost:5173');
      expect(url.search).toBe('');

      const [row] = await tokens('password_reset');
      expect(row).toMatchObject({ userId: user.id, usedAt: null });
      expect(row!.tokenHash).toBe(hashToken(token));
      expect(row!.tokenHash).not.toBe(token);
      expect(row!.expiresAt.getTime() - clock.now().getTime()).toBe(
        30 * MINUTE,
      );
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.password_reset_requested' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'user',
        entityId: user.id,
        tenantId: null,
      });
    });

    it('answers every case identically and sends nothing for unknown, pending or deactivated accounts', async () => {
      await createActiveUser(owner, 'pending@example.com', {
        status: 'pending',
      });
      await createActiveUser(owner, 'gone@example.com', {
        status: 'deactivated',
      });
      const bodies = [];
      for (const email of [
        user.email,
        'nobody@example.com',
        'pending@example.com',
        'gone@example.com',
      ]) {
        const res = await forgot(email).expect(202);
        bodies.push(res.body);
      }
      for (const body of bodies)
        expect(body).toEqual({ data: { accepted: true } });
      await deliverMail(app);
      expect(mailbox(app).mails).toHaveLength(1);
      expect(mailbox(app).mails[0]!.to[0]!.address).toBe(user.email);
      expect(await owner.userToken.count()).toBe(1);
      expect(
        await owner.auditLog.count({
          where: { action: 'auth.password_reset_requested' },
        }),
      ).toBe(1);
    });

    it('normalises the email', async () => {
      await forgot('  DOC@Example.com ').expect(202);
      await deliverMail(app);
      expect(mailbox(app).mails).toHaveLength(1);
    });

    it('a second request invalidates the first link', async () => {
      const first = await requestReset();
      mailbox(app).clear();
      const second = await requestReset();
      expect(second).not.toBe(first);
      const stale = await reset(first, NEW_PASSWORD).expect(400);
      expect(stale.body.error.code).toBe('TOKEN_INVALID');
      await reset(second, NEW_PASSWORD).expect(204);
    });

    it('validates the body and is throttled (5 per 15 minutes per IP)', async () => {
      await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: 'nope' })
        .expect(400);
      await http().post(`${API}/auth/password/forgot`).send({}).expect(400);
      throttle.reset();
      for (let i = 0; i < 5; i++) await forgot(`u${i}@example.com`).expect(202);
      const res = await forgot('u6@example.com').expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('POST /auth/password/reset', () => {
    it('sets the new password, revokes every session, clears lockout and sends a notice', async () => {
      const sessionToken = await signIn();
      await owner.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 4,
          lockedUntil: new Date(clock.now().getTime() + 5 * MINUTE),
        },
      });
      const token = await requestReset();
      mailbox(app).clear();

      await reset(token, NEW_PASSWORD).expect(204);

      await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${sessionToken}`)
        .expect(401);
      const sessions = await owner.session.findMany();
      expect(sessions.every((s) => s.revokedReason === 'password_reset')).toBe(
        true,
      );
      await loginAs(user.email, user.password).expect(401);
      await loginAs(user.email, NEW_PASSWORD).expect(200);

      const stored = await owner.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
      expect(stored.passwordChangedAt!.getTime()).toBe(clock.now().getTime());
      const [row] = await tokens('password_reset');
      expect(row!.usedAt).not.toBeNull();

      await deliverMail(app);
      const notice = mailbox(app).assertSent({ to: user.email });
      expect(notice.subject).toMatch(/password.*changed/i);
      expect(notice.html).not.toContain(NEW_PASSWORD);
      expect(notice.html).not.toContain(token);
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.password_reset' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'user',
        entityId: user.id,
        tenantId: null,
      });
    });

    it('marks the email verified if it was not', async () => {
      await owner.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: null },
      });
      const token = await requestReset();
      await reset(token, NEW_PASSWORD).expect(204);
      expect(
        (await owner.user.findUniqueOrThrow({ where: { id: user.id } }))
          .emailVerifiedAt,
      ).not.toBeNull();
    });

    it('a token works once only', async () => {
      const token = await requestReset();
      await reset(token, NEW_PASSWORD).expect(204);
      const again = await reset(token, 'another passphrase 7788').expect(400);
      expect(again.body.error.code).toBe('TOKEN_INVALID');
      await loginAs(user.email, NEW_PASSWORD).expect(200);
    });

    it('expires after 30 minutes', async () => {
      const token = await requestReset();
      clock.advance(31 * MINUTE);
      const res = await reset(token, NEW_PASSWORD).expect(400);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it('unknown, garbage and wrong-type tokens are all TOKEN_INVALID', async () => {
      const setupToken = 'S'.repeat(43);
      await owner.userToken.create({
        data: {
          userId: user.id,
          type: 'account_setup',
          tokenHash: hashToken(setupToken),
          expiresAt: new Date(clock.now().getTime() + DAY),
        },
      });
      for (const token of ['A'.repeat(43), 'garbage', setupToken]) {
        const res = await reset(token, NEW_PASSWORD).expect(400);
        expect(res.body.error.code).toBe('TOKEN_INVALID');
      }
    });

    it('does not resurrect an account deactivated after the link was issued', async () => {
      const token = await requestReset();
      await owner.user.update({
        where: { id: user.id },
        data: { status: 'deactivated' },
      });
      const res = await reset(token, NEW_PASSWORD).expect(400);
      expect(res.body.error.code).toBe('TOKEN_INVALID');
    });

    it.each([
      ['too short', 'short1', 'TOO_SHORT'],
      ['too common', 'password123', 'PASSWORD_TOO_COMMON'],
      [
        'containing the email',
        'my doc@example.com pass',
        'PASSWORD_CONTAINS_EMAIL',
      ],
    ])(
      'rejects a password that is %s with field details, and keeps the link usable',
      async (_label, password, code) => {
        const token = await requestReset();
        const res = await reset(token, password).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: 'newPassword', code }),
          ]),
        );
        await reset(token, NEW_PASSWORD).expect(204); // the token was NOT consumed
      },
    );

    it('rejects unknown fields and a missing token', async () => {
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ newPassword: NEW_PASSWORD })
        .expect(400);
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token: 'x', newPassword: NEW_PASSWORD, status: 'active' })
        .expect(400);
    });

    it('is throttled (5 per 15 minutes per IP)', async () => {
      for (let i = 0; i < 5; i++)
        await reset('A'.repeat(43), NEW_PASSWORD).expect(400);
      const res = await reset('A'.repeat(43), NEW_PASSWORD).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /me/password (change)', () => {
    const change = (
      token: string,
      currentPassword: string,
      newPassword: string,
    ) =>
      http()
        .post(`${API}/me/password`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword, newPassword });

    it('needs authentication', async () => {
      await http()
        .post(`${API}/me/password`)
        .send({ currentPassword: 'a', newPassword: 'b' })
        .expect(401);
    });

    it('a wrong current password is a field error and changes nothing', async () => {
      const token = await signIn();
      const res = await change(token, 'not my password', NEW_PASSWORD).expect(
        400,
      );
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([
        expect.objectContaining({
          field: 'currentPassword',
          code: 'PASSWORD_INCORRECT',
        }),
      ]);
      await loginAs(user.email, user.password).expect(200);
      expect(
        await owner.auditLog.count({
          where: { action: 'auth.password_changed' },
        }),
      ).toBe(0);
    });

    it('changes the password, keeps THIS session, revokes the others and sends a notice', async () => {
      const current = await signIn();
      const other = await signIn();
      await change(current, user.password, NEW_PASSWORD).expect(204);

      await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${current}`)
        .expect(200);
      await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${other}`)
        .expect(401);
      const revoked = await owner.session.findMany({
        where: { revokedAt: { not: null } },
      });
      expect(revoked).toHaveLength(1);
      expect(revoked[0]!.revokedReason).toBe('password_changed');

      await loginAs(user.email, user.password).expect(401);
      await loginAs(user.email, NEW_PASSWORD).expect(200);
      await deliverMail(app);
      const notice = mailbox(app).assertSent({ to: user.email });
      expect(notice.subject).toMatch(/password.*changed/i);
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.password_changed' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
      });
    });

    it('applies the same policy to the new password', async () => {
      const token = await signIn();
      const res = await change(token, user.password, 'password123').expect(400);
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'newPassword',
            code: 'PASSWORD_TOO_COMMON',
          }),
        ]),
      );
    });

    it('is throttled per user (5 per 15 minutes), even for wrong passwords', async () => {
      const token = await signIn();
      for (let i = 0; i < 5; i++)
        await change(token, 'nope nope nope', NEW_PASSWORD).expect(400);
      const res = await change(token, user.password, NEW_PASSWORD).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // another user is not affected
      const other = await createActiveUser(owner, 'other@example.com');
      const otherToken = await signIn(other);
      await change(otherToken, 'nope nope nope', NEW_PASSWORD).expect(400);
    });
  });

  describe('account setup for onboarded owners', () => {
    const onboard = (
      ownerEmail = 'owner@clinic.example',
      slug = 'sunrise-clinic',
    ) =>
      app.get(TenantOnboardingService).onboard(
        {
          name: 'Sunrise Clinic',
          slug,
          ownerEmail,
          ownerFullName: 'Dr. Owner',
        },
        { userId: null },
      );
    const setup = (token: string, newPassword: string, fullName?: string) =>
      http()
        .post(`${API}/auth/account/setup`)
        .send({ token, newPassword, ...(fullName ? { fullName } : {}) });
    const setupToken = async () => {
      await deliverMail(app);
      return tokenFromLink(mailbox(app).mails.at(-1)!, '/account-setup');
    };

    it('onboarding emails a 7-day setup link to a NEW owner, in the same transaction', async () => {
      const result = await onboard();
      mailbox(app).assertNotSent();
      const [row] = await tokens('account_setup');
      expect(row).toMatchObject({ userId: result.ownerUserId, usedAt: null });
      expect(row!.expiresAt.getTime() - clock.now().getTime()).toBe(7 * DAY);
      const token = await setupToken();
      expect(row!.tokenHash).toBe(hashToken(token));
      const mail = mailbox(app).assertSent({ to: 'owner@clinic.example' });
      expect(mail.html).toContain('Sunrise Clinic');
    });

    it('setup activates the pending owner, who can then sign in and use the clinic', async () => {
      const result = await onboard();
      const token = await setupToken();
      await setup(token, NEW_PASSWORD, '  Dr. Owner Jr.  ').expect(204);

      const stored = await owner.user.findUniqueOrThrow({
        where: { id: result.ownerUserId },
      });
      expect(stored).toMatchObject({
        status: 'active',
        fullName: 'Dr. Owner Jr.',
      });
      expect(stored.emailVerifiedAt).not.toBeNull();
      expect(stored.passwordChangedAt).not.toBeNull();

      const login = await loginAs('owner@clinic.example', NEW_PASSWORD).expect(
        200,
      );
      expect(login.body.data.activeTenantId).toBe(result.tenantId);
      const tenant = await http()
        .get(`${API}/tenant`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);
      expect(tenant.body.data.id).toBe(result.tenantId);
      expect(refreshCookie(login)).toBeTruthy();
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.account_setup' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'user',
        entityId: result.ownerUserId,
        tenantId: null,
      });
    });

    it('a pending owner cannot sign in before setup', async () => {
      await onboard();
      await loginAs('owner@clinic.example', NEW_PASSWORD).expect(401);
    });

    it('a link works once, expires after 7 days, and a reset token is not a setup token', async () => {
      await onboard();
      const token = await setupToken();
      await setup(token, NEW_PASSWORD).expect(204);
      expect(
        (await setup(token, NEW_PASSWORD).expect(400)).body.error.code,
      ).toBe('TOKEN_INVALID');

      mailbox(app).clear();
      await onboard('second@clinic.example', 'second-clinic');
      const expiring = await setupToken();
      clock.advance(7 * DAY + MINUTE);
      expect(
        (await setup(expiring, NEW_PASSWORD).expect(400)).body.error.code,
      ).toBe('TOKEN_INVALID');

      const resetToken = await requestReset();
      expect(
        (await setup(resetToken, NEW_PASSWORD).expect(400)).body.error.code,
      ).toBe('TOKEN_INVALID');
    });

    it('applies the password policy without consuming the link; validates fullName', async () => {
      await onboard();
      const token = await setupToken();
      const weak = await setup(token, 'password123').expect(400);
      expect(weak.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'newPassword',
            code: 'PASSWORD_TOO_COMMON',
          }),
        ]),
      );
      const long = await setup(token, NEW_PASSWORD, 'x'.repeat(200)).expect(
        400,
      );
      expect(long.body.error.code).toBe('VALIDATION_FAILED');
      await setup(token, NEW_PASSWORD).expect(204);
    });

    it('an owner who already has an active account gets no setup link, only an ownership notice', async () => {
      const existing = await createActiveUser(owner, 'owner@clinic.example');
      const result = await onboard('owner@clinic.example');
      expect(result.ownerUserId).toBe(existing.id);
      expect(await owner.userToken.count()).toBe(0);
      await deliverMail(app);
      expect(mailbox(app).mails).toHaveLength(1);
      const mail = mailbox(app).mails[0]!;
      expect(mail.subject).toMatch(/Sunrise Clinic/);
      expect(mail.links.some((l) => l.includes('/account-setup'))).toBe(false);
    });

    it('a failure after the mail was queued rolls EVERYTHING back (no user, tenant, token or email)', async () => {
      const queue = app.get(MailQueue);
      const real = queue.enqueue.bind(queue);
      vi.spyOn(queue, 'enqueue').mockImplementation(async (...args) => {
        await real(...args);
        throw new Error('boom after enqueue');
      });
      await expect(onboard()).rejects.toThrow('boom after enqueue');
      await deliverMail(app);
      mailbox(app).assertNotSent();
      expect(
        await owner.user.count({ where: { email: 'owner@clinic.example' } }),
      ).toBe(0);
      expect(await owner.tenant.count()).toBe(0);
      expect(await owner.userToken.count()).toBe(0);
    });
  });

  it('never leaks the new password or tokens into the audit log', async () => {
    const token = await requestReset();
    await reset(token, NEW_PASSWORD).expect(204);
    await seedMembership(owner, user.id, 'x', ['owner']);
    const rows = JSON.stringify(await owner.auditLog.findMany());
    expect(rows).not.toContain(NEW_PASSWORD);
    expect(rows).not.toContain(token);
    expect(rows).not.toContain(TEST_PASSWORD);
  });
});
