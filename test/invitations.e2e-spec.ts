import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { vi } from 'vitest';
import { hashToken } from '../src/common/security/token.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { MailQueue } from '../src/modules/mail/mail-queue.service.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  refreshCookie,
  setPasswords,
  TEST_PASSWORD,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { deliverMail, mailbox, tokenFromLink } from './support/mail.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { type SeededClinic, seedClinic } from './support/tenancy-fixtures.js';
import { DAY, MINUTE, TestClock } from './support/test-clock.js';

const API = '/api/v1';
const MISSING = '00000000-0000-4000-8000-000000000000';
const NEW_PASSWORD = 'a brand new passphrase 42';

describe('invitations (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let clock: TestClock;
  let throttle: ResettableThrottlerStorage;
  let a: SeededClinic;
  let b: SeededClinic;

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
    a = await seedClinic(owner, 'clinic-a', [
      { email: 'a-owner@example.com', roles: ['owner'] },
      { email: 'a-admin@example.com', roles: ['clinic_admin'] },
      { email: 'a-recep@example.com', roles: ['receptionist'] },
    ]);
    b = await seedClinic(owner, 'clinic-b', [
      { email: 'b-owner@example.com', roles: ['owner'] },
    ]);
    await setPasswords(owner, [
      'a-owner@example.com',
      'a-admin@example.com',
      'a-recep@example.com',
      'b-owner@example.com',
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  const http = () => request(app.getHttpServer());
  /** Real login; Clinic A's staff have exactly one clinic, so it is selected. */
  const signIn = async (email: string, password = TEST_PASSWORD) => {
    const res = await http()
      .post(`${API}/auth/login`)
      .send({ email, password })
      .expect(200);
    return res.body.data.accessToken as string;
  };
  const invite = (token: string, body: Record<string, unknown>) =>
    http()
      .post(`${API}/invitations`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  const resend = (token: string, id: string) =>
    http()
      .post(`${API}/invitations/${id}/resend`)
      .set('Authorization', `Bearer ${token}`);
  const accept = (body: Record<string, unknown>) =>
    http().post(`${API}/invitations/accept`).send(body);
  const emailedToken = async () => {
    await deliverMail(app);
    return tokenFromLink(mailbox(app).mails.at(-1)!, '/accept-invitation');
  };
  /** Owner of A invites `email` as `roleKey`; returns the raw token and invitation id. */
  const inviteAs = async (email: string, roleKey = 'doctor') => {
    const token = await signIn('a-owner@example.com');
    const res = await invite(token, {
      email,
      roleId: a.roleIds[roleKey],
    }).expect(201);
    return {
      id: res.body.data.id as string,
      token: await emailedToken(),
      admin: token,
    };
  };
  const membershipOf = (tenantId: string, email: string) =>
    owner.tenantMembership.findFirst({
      where: { tenantId, user: { email } },
      include: { roles: { include: { role: true } } },
    });

  describe('POST /invitations', () => {
    it('owner and clinic admin create one: 201, one email after commit, hashed token, audited', async () => {
      for (const [inviter, email] of [
        ['a-owner@example.com', 'new1@example.com'],
        ['a-admin@example.com', 'new2@example.com'],
      ] as const) {
        const token = await signIn(inviter);
        const res = await invite(token, {
          email,
          roleId: a.roleIds.doctor,
        }).expect(201);
        expect(Object.keys(res.body)).toEqual(['data']);
        expect(res.body.data).toMatchObject({
          email,
          roleId: a.roleIds.doctor,
          status: 'pending',
        });
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('tokenHash');
        expect(text).not.toContain('token"');
      }
      mailbox(app).assertNotSent(); // queued with the transaction, not sent by the request
      await deliverMail(app);
      expect(mailbox(app).mails).toHaveLength(2);

      // The relay publishes concurrently, so pick the mail by recipient, not by position.
      const mail = mailbox(app).assertSent({ to: 'new1@example.com' });
      expect(mail.subject).toBe('clinic-a invited you to DocTayo');
      expect(mail.html).toContain('Doctor');
      expect(mail.link('/accept-invitation').origin).toBe(
        'http://localhost:5173',
      );
      const token = tokenFromLink(mail, '/accept-invitation');
      const row = await owner.invitation.findFirstOrThrow({
        where: { email: 'new1@example.com' },
      });
      expect(row.tokenHash).toBe(hashToken(token));
      expect(row.tokenHash).not.toBe(token);
      expect(row.expiresAt.getTime() - clock.now().getTime()).toBe(7 * DAY);
      expect(row.invitedByMembershipId).toBe(
        a.members['a-owner@example.com']!.membershipId,
      );

      const audit = await owner.auditLog.findMany({
        where: { action: 'invitation.created' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        tenantId: a.tenantId,
        entityType: 'invitation',
        entityId: row.id,
        actorMembershipId: a.members['a-owner@example.com']!.membershipId,
      });
    });

    it('normalises the email', async () => {
      const token = await signIn('a-owner@example.com');
      const res = await invite(token, {
        email: '  NewPerson@Example.COM ',
        roleId: a.roleIds.nurse,
      }).expect(201);
      expect(res.body.data.email).toBe('newperson@example.com');
    });

    it('a receptionist cannot invite (403), nor can an unauthenticated caller (401)', async () => {
      const token = await signIn('a-recep@example.com');
      const res = await invite(token, {
        email: 'x@example.com',
        roleId: a.roleIds.doctor,
      }).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      await http()
        .post(`${API}/invitations`)
        .send({ email: 'x@example.com', roleId: a.roleIds.doctor })
        .expect(401);
      expect(await owner.invitation.count()).toBe(0);
    });

    it('a role from another clinic is 404; the owner role is 422; unknown role is 404', async () => {
      const token = await signIn('a-owner@example.com');
      const other = await invite(token, {
        email: 'x@example.com',
        roleId: b.roleIds.doctor,
      }).expect(404);
      expect(other.body.error.code).toBe('NOT_FOUND');
      const ownerRole = await invite(token, {
        email: 'x@example.com',
        roleId: a.roleIds.owner,
      }).expect(422);
      expect(ownerRole.body.error.code).toBe('ROLE_NOT_ASSIGNABLE');
      await invite(token, { email: 'x@example.com', roleId: MISSING }).expect(
        404,
      );
      expect(await owner.invitation.count()).toBe(0);
    });

    it('an existing member is 409 CONFLICT; an open invitation is 409 CONFLICT_UNIQUE', async () => {
      const token = await signIn('a-owner@example.com');
      const member = await invite(token, {
        email: 'a-recep@example.com',
        roleId: a.roleIds.doctor,
      }).expect(409);
      expect(member.body.error.code).toBe('CONFLICT');
      await invite(token, {
        email: 'new@example.com',
        roleId: a.roleIds.doctor,
      }).expect(201);
      const dup = await invite(token, {
        email: 'NEW@example.com',
        roleId: a.roleIds.nurse,
      }).expect(409);
      expect(dup.body.error.code).toBe('CONFLICT_UNIQUE');
      expect(await owner.invitation.count()).toBe(1);
    });

    it('a user with a REMOVED membership can be invited again', async () => {
      await owner.tenantMembership.update({
        where: { id: a.members['a-recep@example.com']!.membershipId },
        data: { status: 'removed', removedAt: new Date() },
      });
      const token = await signIn('a-owner@example.com');
      await invite(token, {
        email: 'a-recep@example.com',
        roleId: a.roleIds.doctor,
      }).expect(201);
    });

    it('validates the body', async () => {
      const token = await signIn('a-owner@example.com');
      for (const body of [
        {},
        { email: 'not-an-email', roleId: a.roleIds.doctor },
        { email: 'x@example.com', roleId: 'nope' },
        { email: 'x@example.com' },
        {
          email: 'x@example.com',
          roleId: a.roleIds.doctor,
          tenantId: b.tenantId,
        },
        { email: 'x@example.com', roleId: a.roleIds.doctor, token: 'x' },
      ]) {
        const res = await invite(token, body).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('is atomic: a failure after the email was queued leaves no invitation and no email', async () => {
      const token = await signIn('a-owner@example.com');
      const queue = app.get(MailQueue);
      const real = queue.enqueue.bind(queue);
      vi.spyOn(queue, 'enqueue').mockImplementation(async (...args) => {
        await real(...args);
        throw new Error('boom after enqueue');
      });
      await invite(token, {
        email: 'x@example.com',
        roleId: a.roleIds.doctor,
      }).expect(500);
      await deliverMail(app);
      mailbox(app).assertNotSent();
      expect(await owner.invitation.count()).toBe(0);
    });
  });

  describe('POST /invitations/:id/resend', () => {
    it('issues a new token (the old one stops working), resets the expiry and emails again', async () => {
      const { id, token: oldToken } = await inviteAs('new@example.com');
      clock.advance(3 * DAY);
      mailbox(app).clear();
      const admin = await signIn('a-admin@example.com'); // the earlier access token has expired
      const res = await resend(admin, id).expect(200);
      expect(res.body.data).toMatchObject({
        id,
        email: 'new@example.com',
        status: 'pending',
      });
      const newToken = await emailedToken();
      expect(newToken).not.toBe(oldToken);

      const row = await owner.invitation.findUniqueOrThrow({ where: { id } });
      expect(row.tokenHash).toBe(hashToken(newToken));
      expect(row.expiresAt.getTime() - clock.now().getTime()).toBe(7 * DAY);
      const stale = await accept({
        token: oldToken,
        fullName: 'N',
        newPassword: NEW_PASSWORD,
      }).expect(400);
      expect(stale.body.error.code).toBe('TOKEN_INVALID');
      await accept({
        token: newToken,
        fullName: 'N',
        newPassword: NEW_PASSWORD,
      }).expect(204);

      const audit = await owner.auditLog.findMany({
        where: { action: 'invitation.resent' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ tenantId: a.tenantId, entityId: id });
    });

    it('another clinic’s invitation is 404, an unknown id is 404, a bad id is 400', async () => {
      const bOwner = await signIn('b-owner@example.com');
      const made = await invite(bOwner, {
        email: 'b-new@example.com',
        roleId: b.roleIds.doctor,
      }).expect(201);
      const aOwner = await signIn('a-owner@example.com');
      expect(
        (await resend(aOwner, made.body.data.id).expect(404)).body.error.code,
      ).toBe('NOT_FOUND');
      await resend(aOwner, MISSING).expect(404);
      expect(
        (await resend(aOwner, 'not-a-uuid').expect(400)).body.error.code,
      ).toBe('VALIDATION_FAILED');
      // B's invitation is untouched
      const row = await owner.invitation.findUniqueOrThrow({
        where: { id: made.body.data.id },
      });
      expect(row.tenantId).toBe(b.tenantId);
    });

    it('an accepted or revoked invitation is 409 CONFLICT; a receptionist is 403', async () => {
      const { id, token, admin } = await inviteAs('new@example.com');
      const recep = await signIn('a-recep@example.com');
      await resend(recep, id).expect(403);
      await owner.invitation.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
      expect((await resend(admin, id).expect(409)).body.error.code).toBe(
        'CONFLICT',
      );
      await owner.invitation.update({
        where: { id },
        data: { revokedAt: null },
      });
      await accept({ token, fullName: 'N', newPassword: NEW_PASSWORD }).expect(
        204,
      );
      expect((await resend(admin, id).expect(409)).body.error.code).toBe(
        'CONFLICT',
      );
    });
  });

  describe('POST /invitations/accept', () => {
    it('a new email: creates an active, verified user with the role; no auto-login; they can then sign in', async () => {
      const { id, token } = await inviteAs('new@example.com', 'nurse');
      const res = await accept({
        token,
        fullName: '  Nina Nurse ',
        newPassword: NEW_PASSWORD,
      }).expect(204);
      expect(res.text).toBe('');
      expect(refreshCookie(res)).toBeUndefined();

      const user = await owner.user.findUniqueOrThrow({
        where: { email: 'new@example.com' },
      });
      expect(user).toMatchObject({ status: 'active', fullName: 'Nina Nurse' });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.passwordChangedAt).not.toBeNull();
      const membership = await membershipOf(a.tenantId, 'new@example.com');
      expect(membership).toMatchObject({ status: 'active' });
      expect(membership!.joinedAt).not.toBeNull();
      expect(membership!.roles.map((r) => r.role.key)).toEqual(['nurse']);
      const invitation = await owner.invitation.findUniqueOrThrow({
        where: { id },
      });
      expect(invitation.acceptedAt).not.toBeNull();
      expect(invitation.acceptedUserId).toBe(user.id);

      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: 'new@example.com', password: NEW_PASSWORD })
        .expect(200);
      expect(login.body.data.activeTenantId).toBe(a.tenantId);
      const me = await http()
        .get(`${API}/me`)
        .set('Authorization', `Bearer ${login.body.data.accessToken}`)
        .expect(200);
      expect(me.body.data.permissions).toEqual([
        'branches.read',
        'tenant.read',
      ]); // nurse

      const audit = await owner.auditLog.findMany({
        where: { action: 'invitation.accepted' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: a.tenantId,
        entityType: 'invitation',
        entityId: id,
        actorUserId: user.id,
        actorMembershipId: membership!.id,
      });
    });

    it('a new email needs fullName and newPassword (REQUIRED), applies the policy, and keeps the link usable', async () => {
      const { token } = await inviteAs('new@example.com');
      const missing = await accept({ token }).expect(400);
      expect(missing.body.error.code).toBe('VALIDATION_FAILED');
      expect(missing.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'fullName', code: 'REQUIRED' }),
          expect.objectContaining({ field: 'newPassword', code: 'REQUIRED' }),
        ]),
      );
      const weak = await accept({
        token,
        fullName: 'N',
        newPassword: 'password123',
      }).expect(400);
      expect(weak.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'newPassword',
            code: 'PASSWORD_TOO_COMMON',
          }),
        ]),
      );
      expect(
        await owner.user.count({ where: { email: 'new@example.com' } }),
      ).toBe(0);
      await accept({ token, fullName: 'N', newPassword: NEW_PASSWORD }).expect(
        204,
      );
    });

    it('an existing ACTIVE user needs only the token; their password and name are untouched', async () => {
      const existing = await createActiveUser(
        owner,
        'dr.existing@example.com',
        { fullName: 'Dr Existing' },
      );
      const { token } = await inviteAs('dr.existing@example.com', 'doctor');
      await accept({ token }).expect(204);
      const membership = await membershipOf(
        a.tenantId,
        'dr.existing@example.com',
      );
      expect(membership).toMatchObject({
        status: 'active',
        userId: existing.id,
      });
      expect(membership!.roles.map((r) => r.role.key)).toEqual(['doctor']);
      // password unchanged
      await http()
        .post(`${API}/auth/login`)
        .send({ email: existing.email, password: existing.password })
        .expect(200);
    });

    it('an existing active user ignores a password/name sent with the token', async () => {
      const existing = await createActiveUser(
        owner,
        'dr.existing@example.com',
        { fullName: 'Dr Existing' },
      );
      const { token } = await inviteAs('dr.existing@example.com');
      await accept({
        token,
        fullName: 'Attacker',
        newPassword: NEW_PASSWORD,
      }).expect(204);
      const stored = await owner.user.findUniqueOrThrow({
        where: { id: existing.id },
      });
      expect(stored.fullName).toBe('Dr Existing');
      await http()
        .post(`${API}/auth/login`)
        .send({ email: existing.email, password: NEW_PASSWORD })
        .expect(401);
      await http()
        .post(`${API}/auth/login`)
        .send({ email: existing.email, password: existing.password })
        .expect(200);
    });

    it('a user in several clinics signs in with no automatic clinic', async () => {
      const existing = await createActiveUser(owner, 'dr.existing@example.com');
      const bOwner = await owner.user.findUniqueOrThrow({
        where: { email: 'b-owner@example.com' },
      });
      const membership = await owner.tenantMembership.create({
        data: { tenantId: b.tenantId, userId: existing.id, status: 'active' },
      });
      await owner.membershipRole.create({
        data: {
          tenantId: b.tenantId,
          membershipId: membership.id,
          roleId: b.roleIds.doctor!,
        },
      });
      expect(bOwner).toBeTruthy();
      const { token } = await inviteAs('dr.existing@example.com');
      await accept({ token }).expect(204);
      const login = await http()
        .post(`${API}/auth/login`)
        .send({ email: existing.email, password: existing.password })
        .expect(200);
      expect(login.body.data.activeTenantId).toBeNull();
      expect(login.body.data.memberships).toHaveLength(2);
    });

    it('a PENDING user must set a password and name, then becomes active', async () => {
      const pending = await createActiveUser(owner, 'pending@example.com', {
        status: 'pending',
      });
      await owner.user.update({
        where: { id: pending.id },
        data: { passwordHash: null, emailVerifiedAt: null },
      });
      const { token } = await inviteAs('pending@example.com');
      await accept({ token }).expect(400);
      await accept({
        token,
        fullName: 'Pat Pending',
        newPassword: NEW_PASSWORD,
      }).expect(204);
      const stored = await owner.user.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(stored).toMatchObject({
        status: 'active',
        fullName: 'Pat Pending',
      });
      expect(stored.emailVerifiedAt).not.toBeNull();
      await http()
        .post(`${API}/auth/login`)
        .send({ email: 'pending@example.com', password: NEW_PASSWORD })
        .expect(200);
    });

    it('a DEACTIVATED user cannot be brought back by an invitation (TOKEN_INVALID)', async () => {
      await createActiveUser(owner, 'gone@example.com', {
        status: 'deactivated',
      });
      const { token } = await inviteAs('gone@example.com');
      expect((await accept({ token }).expect(400)).body.error.code).toBe(
        'TOKEN_INVALID',
      );
      expect(
        await owner.tenantMembership.count({
          where: { user: { email: 'gone@example.com' } },
        }),
      ).toBe(0);
    });

    it('re-activates a REMOVED membership with the newly invited role', async () => {
      const recep = a.members['a-recep@example.com']!;
      await owner.tenantMembership.update({
        where: { id: recep.membershipId },
        data: { status: 'removed', removedAt: new Date() },
      });
      const { token } = await inviteAs('a-recep@example.com', 'doctor');
      await accept({ token }).expect(204);
      const membership = await membershipOf(a.tenantId, 'a-recep@example.com');
      expect(membership).toMatchObject({
        id: recep.membershipId,
        status: 'active',
        removedAt: null,
      });
      expect(membership!.roles.map((r) => r.role.key)).toEqual(['doctor']);
    });

    it('a token works once; expired, revoked and unknown tokens are TOKEN_INVALID', async () => {
      const first = await inviteAs('one@example.com');
      await accept({
        token: first.token,
        fullName: 'One',
        newPassword: NEW_PASSWORD,
      }).expect(204);
      expect(
        (
          await accept({
            token: first.token,
            fullName: 'One',
            newPassword: NEW_PASSWORD,
          }).expect(400)
        ).body.error.code,
      ).toBe('TOKEN_INVALID');

      throttle.reset(); // the real limit is 5 attempts per 15 minutes per IP
      mailbox(app).clear();
      const expiring = await inviteAs('two@example.com');
      clock.advance(7 * DAY + MINUTE);
      expect(
        (
          await accept({
            token: expiring.token,
            fullName: 'Two',
            newPassword: NEW_PASSWORD,
          }).expect(400)
        ).body.error.code,
      ).toBe('TOKEN_INVALID');

      throttle.reset();
      mailbox(app).clear();
      const revoked = await inviteAs('three@example.com');
      await owner.invitation.update({
        where: { id: revoked.id },
        data: { revokedAt: new Date() },
      });
      expect(
        (
          await accept({
            token: revoked.token,
            fullName: 'Three',
            newPassword: NEW_PASSWORD,
          }).expect(400)
        ).body.error.code,
      ).toBe('TOKEN_INVALID');

      for (const token of ['A'.repeat(43), 'garbage']) {
        expect(
          (
            await accept({
              token,
              fullName: 'X',
              newPassword: NEW_PASSWORD,
            }).expect(400)
          ).body.error.code,
        ).toBe('TOKEN_INVALID');
      }
    });

    it('a suspended or deactivated clinic cannot be joined (nothing is consumed)', async () => {
      const { id, token } = await inviteAs('new@example.com');
      await owner.tenant.update({
        where: { id: a.tenantId },
        data: { status: 'suspended' },
      });
      expect(
        (
          await accept({
            token,
            fullName: 'N',
            newPassword: NEW_PASSWORD,
          }).expect(403)
        ).body.error.code,
      ).toBe('TENANT_SUSPENDED');
      await owner.tenant.update({
        where: { id: a.tenantId },
        data: { status: 'deactivated' },
      });
      expect(
        (
          await accept({
            token,
            fullName: 'N',
            newPassword: NEW_PASSWORD,
          }).expect(403)
        ).body.error.code,
      ).toBe('TENANT_DEACTIVATED');
      expect(
        (await owner.invitation.findUniqueOrThrow({ where: { id } }))
          .acceptedAt,
      ).toBeNull();
      await owner.tenant.update({
        where: { id: a.tenantId },
        data: { status: 'active' },
      });
      await accept({ token, fullName: 'N', newPassword: NEW_PASSWORD }).expect(
        204,
      );
    });

    it('validates the body (unknown fields, missing token)', async () => {
      for (const body of [
        {},
        { token: 'x', role: 'owner' },
        { token: 'x', tenantId: a.tenantId },
      ]) {
        expect((await accept(body).expect(400)).body.error.code).toBe(
          'VALIDATION_FAILED',
        );
      }
    });

    it('is throttled (5 per 15 minutes per IP)', async () => {
      for (let i = 0; i < 5; i++)
        await accept({ token: 'A'.repeat(43) }).expect(400);
      const res = await accept({ token: 'A'.repeat(43) }).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });
});
