import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { MailQueue } from '../src/modules/mail/mail-queue.service.js';
import { TenantOnboardingService } from '../src/modules/tenants/tenant-onboarding.service.js';
import { captureOutput } from './setup/capture-output.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  refreshCookie,
  seedMembership,
  setPasswords,
  type TestUser,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { deliverMail, mailbox, tokenFromLink } from './support/mail.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { seedClinic } from './support/tenancy-fixtures.js';
import { TestClock } from './support/test-clock.js';

const API = '/api/v1';
const ORIGIN = 'http://localhost:5173';
const NEW_PASSWORD = 'a brand new passphrase 42';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('authentication security and hygiene (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let throttle: ResettableThrottlerStorage;
  let user: TestUser;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp({
      productionAuthenticator: true,
      clock: new TestClock(),
      // Most verbose logging: if a secret can reach a log, it will here.
      env: { LOG_LEVEL: 'verbose', LOG_FORMAT: 'json' },
    });
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
  const login = (email = user.email, password = user.password) =>
    http().post(`${API}/auth/login`).send({ email, password });

  describe('no secret ever reaches the logs', () => {
    it('across login, refresh, switch-tenant, password change/reset, setup, invitations and logout', async () => {
      const secrets: string[] = [];
      const capture = captureOutput();
      try {
        const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
        await seedMembership(owner, user.id, 'clinic-b', ['receptionist']);

        // login (success + failure) and refresh
        await login(user.email, 'a wrong password 12345').expect(401);
        const signedIn = await login().expect(200);
        const access = signedIn.body.data.accessToken as string;
        const cookie = refreshCookie(signedIn)!;
        secrets.push(user.password, 'a wrong password 12345', access, cookie);
        const refreshed = await http()
          .post(`${API}/auth/refresh`)
          .set('Origin', ORIGIN)
          .set('Cookie', `dt_refresh=${cookie}`)
          .expect(200);
        const access2 = refreshed.body.data.accessToken as string;
        secrets.push(access2, refreshCookie(refreshed)!);

        // switch-tenant, change password (a failure first, then success)
        await http()
          .post(`${API}/auth/switch-tenant`)
          .set('Authorization', `Bearer ${access2}`)
          .send({ tenantId: a.tenantId })
          .expect(200);
        await http()
          .post(`${API}/me/password`)
          .set('Authorization', `Bearer ${access2}`)
          .send({
            currentPassword: 'definitely not it 987',
            newPassword: NEW_PASSWORD,
          })
          .expect(400);
        await http()
          .post(`${API}/me/password`)
          .set('Authorization', `Bearer ${access2}`)
          .send({ currentPassword: user.password, newPassword: NEW_PASSWORD })
          .expect(204);
        secrets.push('definitely not it 987', NEW_PASSWORD);

        // forgot + reset
        await http()
          .post(`${API}/auth/password/forgot`)
          .send({ email: user.email })
          .expect(202);
        await deliverMail(app);
        const resetToken = tokenFromLink(
          mailbox(app).mails.at(-1)!,
          '/reset-password',
        );
        secrets.push(resetToken);
        const another = 'yet another long passphrase 31';
        await http()
          .post(`${API}/auth/password/reset`)
          .send({ token: resetToken, newPassword: another })
          .expect(204);
        secrets.push(another);

        // onboarding + setup
        mailbox(app).clear();
        await app.get(TenantOnboardingService).onboard(
          {
            name: 'Log Clinic',
            slug: 'log-clinic',
            ownerEmail: 'owner@log.example',
            ownerFullName: 'O',
          },
          { userId: null },
        );
        await deliverMail(app);
        const setupToken = tokenFromLink(
          mailbox(app).mails.at(-1)!,
          '/account-setup',
        );
        const setupPassword = 'setup passphrase that is long 1';
        await http()
          .post(`${API}/auth/account/setup`)
          .send({ token: setupToken, newPassword: setupPassword })
          .expect(204);
        secrets.push(setupToken, setupPassword);

        // invitation + accept
        throttle.reset();
        const clinic = await seedClinic(owner, 'invite-clinic', [
          { email: 'inviter@example.com', roles: ['owner'] },
        ]);
        await setPasswords(owner, ['inviter@example.com']);
        const inviter = await login('inviter@example.com').expect(200);
        secrets.push(inviter.body.data.accessToken as string);
        mailbox(app).clear();
        await http()
          .post(`${API}/invitations`)
          .set('Authorization', `Bearer ${inviter.body.data.accessToken}`)
          .send({ email: 'invitee@example.com', roleId: clinic.roleIds.doctor })
          .expect(201);
        await deliverMail(app);
        const inviteToken = tokenFromLink(
          mailbox(app).mails.at(-1)!,
          '/accept-invitation',
        );
        const invitePassword = 'a different long passphrase 2';
        await http()
          .post(`${API}/invitations/accept`)
          .send({
            token: inviteToken,
            fullName: 'Invitee',
            newPassword: invitePassword,
          })
          .expect(204);
        secrets.push(inviteToken, invitePassword);

        // logout
        const out = await login('invitee@example.com', invitePassword).expect(
          200,
        );
        secrets.push(out.body.data.accessToken as string, refreshCookie(out)!);
        await http()
          .post(`${API}/auth/logout`)
          .set('Authorization', `Bearer ${out.body.data.accessToken}`)
          .set('Origin', ORIGIN)
          .expect(204);
      } finally {
        capture.restore();
      }

      const logs = capture.text();
      expect(logs).toContain('request completed'); // the capture really worked
      expect(secrets.length).toBeGreaterThan(14);
      for (const secret of secrets) {
        expect(
          logs,
          `a secret leaked into the logs: ${secret.slice(0, 6)}…`,
        ).not.toContain(secret);
      }
      expect(logs).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
      expect(logs).not.toMatch(/dt_refresh=/);
      expect(logs).not.toMatch(/argon2id/);
    });
  });

  describe('responses and credentials', () => {
    it('token-bearing auth responses are never cacheable', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const res = await login().expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const cookie = refreshCookie(res)!;
      const refreshed = await http()
        .post(`${API}/auth/refresh`)
        .set('Origin', ORIGIN)
        .set('Cookie', `dt_refresh=${cookie}`)
        .expect(200);
      expect(refreshed.headers['cache-control']).toBe('no-store');
      const switched = await http()
        .post(`${API}/auth/switch-tenant`)
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
        .send({ tenantId: a.tenantId })
        .expect(200);
      expect(switched.headers['cache-control']).toBe('no-store');
      const me = await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
        .expect(200);
      expect(me.headers['cache-control']).toBe('no-store');
    });

    it('the refresh cookie is not an access credential', async () => {
      const res = await login().expect(200);
      const cookie = refreshCookie(res)!;
      await http()
        .get(`${API}/me`)
        .set('Cookie', `dt_refresh=${cookie}`)
        .expect(401);
      await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${cookie}`)
        .expect(401);
    });

    it('a refresh token never works as an access token and vice versa', async () => {
      const res = await login().expect(200);
      await http()
        .post(`${API}/auth/refresh`)
        .set('Origin', ORIGIN)
        .set('Cookie', `dt_refresh=${res.body.data.accessToken}`)
        .expect(401);
    });

    it('no response ever contains a password hash or the JWT secret', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const signedIn = await login().expect(200);
      const token = signedIn.body.data.accessToken as string;
      const bodies = [
        signedIn.text,
        (await http().get(`${API}/me`).set('Authorization', `Bearer ${token}`))
          .text,
        (
          await http()
            .get(`${API}/me/memberships`)
            .set('Authorization', `Bearer ${token}`)
        ).text,
        (
          await http()
            .get(`${API}/me/sessions`)
            .set('Authorization', `Bearer ${token}`)
        ).text,
        (
          await http()
            .get(`${API}/tenant`)
            .set('Authorization', `Bearer ${token}`)
        ).text,
        (
          await http()
            .get(`${API}/branches/${MISSING}`)
            .set('Authorization', `Bearer ${token}`)
        ).text,
      ];
      expect(a.tenantId).toBeTruthy();
      for (const text of bodies) {
        expect(text).not.toMatch(/argon2/);
        expect(text).not.toMatch(/password_?hash/i);
        expect(text).not.toContain(process.env.JWT_ACCESS_SECRET!);
      }
    });
  });

  describe('input is strict on every auth endpoint', () => {
    const noise = {
      status: 'active',
      platformRole: 'platform_admin',
      tenantId: MISSING,
      userId: MISSING,
    };
    it.each([
      ['/auth/login', { email: 'doc@example.com', password: 'x' }],
      ['/auth/password/forgot', { email: 'doc@example.com' }],
      ['/auth/password/reset', { token: 'x', newPassword: 'y' }],
      ['/auth/account/setup', { token: 'x', newPassword: 'y' }],
      ['/invitations/accept', { token: 'x' }],
    ])('POST %s rejects privileged and unknown fields', async (path, body) => {
      for (const [key, value] of Object.entries(noise)) {
        const res = await http()
          .post(`${API}${path}`)
          .send({ ...body, [key]: value })
          .expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: key, code: 'UNKNOWN_FIELD' }),
          ]),
        );
      }
    });

    it('an oversized password cannot be used to burn hashing time', async () => {
      const res = await login(user.email, 'x'.repeat(5000)).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('privileged fields cannot ride along with a password change either', async () => {
      const token = (await login().expect(200)).body.data.accessToken as string;
      await http()
        .post(`${API}/me/password`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: user.password,
          newPassword: NEW_PASSWORD,
          status: 'active',
        })
        .expect(400);
    });
  });

  describe('email is sent if and only if its transaction commits', () => {
    it('forgot password: a failure after queueing leaves no token and sends nothing', async () => {
      const queue = app.get(MailQueue);
      const real = queue.enqueue.bind(queue);
      vi.spyOn(queue, 'enqueue').mockImplementation(async (...args) => {
        await real(...args);
        throw new Error('boom after enqueue');
      });
      await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: user.email })
        .expect(500);
      await deliverMail(app);
      mailbox(app).assertNotSent();
      expect(await owner.userToken.count()).toBe(0);
    });

    it('password reset: a failure after queueing changes nothing (password, token, sessions, mail)', async () => {
      const session = await login().expect(200);
      await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: user.email })
        .expect(202);
      await deliverMail(app);
      const token = tokenFromLink(
        mailbox(app).mails.at(-1)!,
        '/reset-password',
      );
      mailbox(app).clear();

      const queue = app.get(MailQueue);
      const real = queue.enqueue.bind(queue);
      vi.spyOn(queue, 'enqueue').mockImplementation(async (...args) => {
        await real(...args);
        throw new Error('boom after enqueue');
      });
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(500);
      vi.restoreAllMocks();

      await deliverMail(app);
      mailbox(app).assertNotSent();
      const [row] = await owner.userToken.findMany({
        where: { type: 'password_reset' },
      });
      expect(row!.usedAt).toBeNull(); // the link still works
      await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .expect(200);
      await login(user.email, user.password).expect(200); // old password unchanged
      await http()
        .post(`${API}/auth/password/reset`)
        .send({ token, newPassword: NEW_PASSWORD })
        .expect(204);
    });

    it('a mail that cannot be delivered is retried by the outbox, not lost', async () => {
      await http()
        .post(`${API}/auth/password/forgot`)
        .send({ email: user.email })
        .expect(202);
      mailbox(app).failNext(new Error('smtp is down'));
      await deliverMail(app);
      mailbox(app).assertNotSent();
      // The relay backs off before retrying; the message must still be pending, not gone.
      const pending = await owner.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) FROM nest_outbox.messages WHERE topic = 'mail.password_reset'`,
      );
      expect(Number(pending[0]!.count)).toBe(1);
    });
  });
});
