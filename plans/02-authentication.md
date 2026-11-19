# Plan 02 — Authentication (Master Plan Phase 3)

> **Parent:** [`../plan.md`](../plan.md) (source of truth). This plan implements **Phase 3 — Authentication** only.
> **Status:** **Implemented (2026-11-19).** D1 and D3–D11 approved as recommended; D2 = httpOnly cookie (frontend and API share a site). Deviations from this plan are listed in §19 (As Built); where the body below differs from the code, §19 and the code win.
> **Builds on:** [`00-project-foundation.md`](00-project-foundation.md) and [`01-multitenancy.md`](01-multitenancy.md) (both implemented).

Statements marked **(verified)** were checked against the repository, the npm registry or docs.nestjs.com on 2026-11-19. Everything else is a design decision, or an assumption that the M1 spike must confirm.

---

## 1. Goal

Replace the fail-closed `DenyAllAuthenticator` with real, secure authentication, so that the Phase 2 tenant routes become usable:

- passwords hashed with Argon2id;
- short-lived access JWTs plus opaque, rotated, server-stored refresh tokens (sessions), with reuse detection;
- login, refresh, logout, logout everywhere, switch tenant, current user;
- forgot/reset password, change password, session listing and revocation;
- invitations (create, resend, accept) and account setup for users created by onboarding;
- login throttling and account lockout;
- email delivery that only happens after the database commit (outbox);
- scheduled cleanup of expired tokens and sessions;
- every auth event audited, and no secret ever in logs.

---

## 2. Baseline (verified)

| Area | State |
|---|---|
| Auth seam | `Authenticator` interface + `AUTHENTICATOR` token (`src/common/auth/`). Production binding `DenyAllAuthenticator` → every non-`@Public()` route returns `401 UNAUTHENTICATED`. `Principal = { userId, activeTenantId }`. |
| Guards | `AuthGuard` → `TenantGuard` → `PermissionsGuard`, registered as `APP_GUARD` by `TenancyModule`. `RequestContext` (AsyncLocalStorage) holds `userId`, `activeTenantId`, `tenantId`, `membershipId`, `permissions`. |
| Users | `users`: `email` (required, unique, normalized), `full_name`, `status` (`pending` \| `active` \| `deactivated`), `platform_role`. **No credential columns.** Onboarding creates owners as `pending`; `TenantGuard` denies `pending` users. |
| Tenancy | Tenants, branches, memberships, roles, permissions, append-only `audit_logs`, `AuditService` (same transaction, field names only). |
| Config | Namespaces `app`, `database`, `cors`, `logging`, `swagger`, `observe`. `TRUST_PROXY` and `CORS_ALLOW_CREDENTIALS` already exist (for this phase). |
| Errors | Catalog includes `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_*`. 405 → `METHOD_NOT_ALLOWED` and 429 → `RATE_LIMITED` are mapped from framework exceptions (`to-api-error.ts`). |
| Observe | Redaction keys already include `password`, `currentPassword`, `newPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `authorization`, `cookie`, `setCookie`. Request bodies are never captured. |
| Docker | `node:<version>-slim` (Debian, glibc) for every stage, so native modules use glibc prebuilds. |
| Tests | `TestAuthenticator` (`Bearer test.<userId>.<tenantId\|none>`) is used by the Phase 2 suites. |

### 2.1 Packages considered (verified on npm, 2026-11-19)

| Package | Version | Recommendation |
|---|---|---|
| `@nestjs/jwt` | 12.0.5 (peer `@nestjs/common` ^12) | **Adopt.** Signs and verifies HS256 access tokens. |
| `@nestjs/throttler` | 6.8.0 (peers ^12) | **Adopt.** Login and recovery rate limits. In-memory storage (single instance). |
| `@nestjs/schedule` | 12.0.4 | **Adopt.** Daily cleanup job. |
| `argon2` | 0.45.2 | **Adopted** (master plan §8 item 1). Native module: the prebuilt binary loads in the Debian-slim runtime image (verified, §17); its install script is disabled in `allowScripts` because the prebuild is used. |
| `cookie-parser` | 1.4.7 | **Adopted** (D2 = cookie). Reads the refresh cookie. |
| `@nestjs/mail` | 0.0.2 | **Adopted, pinned exactly** (D4). Wired transports: `smtp` (production), `log` and `file` (development), `memory` (tests). Its HTTP provider transports (Resend, Postmark, SendGrid, SES) exist but are not wired. |
| `@nestjs/outbox` | 0.1.4 | **Adopted, pinned exactly** (D4). PostgreSQL store (`fromPrisma`, `migrate: false`); `outbox.add(tx, message)` joins our transaction; at-least-once relay with retries. |
| `@nestjs/authentication` | 0.1.6 | **Do not adopt** (D1). See §16. |
| `@nestjs/locks` | 0.0.6 | Not needed while single-instance (cleanup is idempotent). |

---

## 3. Scope

### 3.1 In scope

1. Schema: credential columns on `users`; new `sessions`, `refresh_tokens`, `user_tokens`, `invitations`; the outbox tables.
2. Password hashing (Argon2id) and password policy.
3. Access tokens (JWT) and sessions with refresh rotation and reuse detection.
4. `JwtAuthenticator` replacing `DenyAllAuthenticator`; session re-verification on every request.
5. Endpoints: login, refresh, logout, logout-all, switch-tenant, forgot/reset password, `GET /me`, `GET /me/memberships`, change password, session list/revoke.
6. Invitations: create, resend, accept (new and existing users). New permission `members.invite`.
7. Account setup for `pending` users created by onboarding (set-password link).
8. Throttling (`ThrottlerGuard` first in the chain) and per-account lockout.
9. Mail via outbox: invitation, account setup, password reset and password-changed notice.
10. Daily cleanup of expired tokens, sessions and delivered outbox rows.
11. Audit of auth events; log-hygiene tests for secrets.

### 3.2 Out of scope

| Item | Phase |
|---|---|
| `PATCH /me` (profile edit), email change and its re-verification | 4 (global profile management) |
| `POST /auth/email/verify` | When something produces verification tokens: email change (Phase 4) or self-registration (future). See D6. |
| Member listing, role assignment, membership suspension/removal, invitation listing/revocation | 4 |
| Platform-admin endpoints (`POST /admin/tenants`, user status) | 4 |
| Public self-registration | Future (Q3) |
| MFA (TOTP), SSO | Future (Q10) |
| Patient-portal principals | Later phase. Phase 3 only adds the principal-type claim (`staff`). |
| Shared rate-limit store (Redis) | Only when scaled out |

---

## 4. Data Model

Migration `<ts>_authentication`. Conventions from master plan §6 apply: UUIDv7 ids, `snake_case`, timestamps, `onDelete: Restrict`.

### 4.1 Changes to `users` (global)

| Column | Type | Notes |
|---|---|---|
| `password_hash` | `text?` | Argon2id PHC string. Null for `pending` users. **Globally omitted** from Prisma results (`omit` in the client config); read only by the credentials service through an explicit `select`. |
| `email_verified_at` | `timestamptz?` | Set when an emailed token (invitation or account setup) is consumed. |
| `password_changed_at` | `timestamptz?` | Shown in `/me`; also used to word the password-changed email. |
| `failed_login_count` | `int` default 0 | Reset on successful login. |
| `locked_until` | `timestamptz?` | Account lockout (§9.2). |

`status` meanings stay: `pending` = no password yet; `active` = may log in; `deactivated` = may not log in (set by Phase 4 platform admins).

### 4.2 New global tables

| Table | Columns (beyond id/timestamps) | Constraints / indexes |
|---|---|---|
| `sessions` | `user_id` → users, `active_tenant_id?` → tenants, `principal_type` enum `staff` (portal later adds `patient`), `user_agent?` (truncated to 256 chars), `ip inet?`, `last_used_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at?`, `revoked_reason?` enum (`logout`, `logout_all`, `password_changed`, `password_reset`, `refresh_reuse`, `user_deactivated`, `admin`) | Index `(user_id)`, index `(absolute_expires_at)` for cleanup |
| `refresh_tokens` | `session_id` → sessions, `token_hash` (SHA-256, hex), `expires_at`, `rotated_at?` | `UNIQUE(token_hash)`, index `(session_id)` |
| `user_tokens` | `user_id` → users, `type` enum `password_reset` \| `account_setup` (later `email_verification`), `token_hash`, `expires_at`, `used_at?` | `UNIQUE(token_hash)`, index `(user_id, type)` |

One session is one refresh-token *family*: every rotation adds a `refresh_tokens` row to the same session. Presenting a token whose row has `rotated_at` set is reuse, and revokes the whole session.

Why a separate `refresh_tokens` table and not "current hash on the session": reuse detection needs to recognise *any* previously issued token of the family, not only the immediate predecessor. Rows are small and cleaned up with their session.

### 4.3 New tenant-owned table

| Table | Columns | Constraints |
|---|---|---|
| `invitations` | `email` (normalized), `role_id` (one role per invitation, D7), `invited_by_membership_id`, `token_hash`, `expires_at` (7 days), `accepted_at?`, `accepted_user_id?` → users, `revoked_at?` | `@@unique([tenantId, id])`; `UNIQUE(token_hash)`; composite FKs `(tenant_id, role_id)` → `roles` and `(tenant_id, invited_by_membership_id)` → `tenant_memberships`; partial unique index `(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` (raw SQL in the migration: at most one open invitation per email per clinic) |

`invitations` joins `TENANT_OWNED_MODELS`, so the registry test enforces the composite-FK rules automatically.

### 4.4 Outbox tables

`@nestjs/outbox` ships its own versioned SQL (`npx @nestjs/outbox sql`, per its docs). It goes into **our Prisma migration as raw SQL** so that `migrate deploy` stays the only migration step (no second migration tool in CI, Docker or production). M1 confirms that the SQL is plain DDL and that the runtime role needs only DML on those tables (default privileges already cover tables the owner creates).

### 4.5 Permissions

Add `members.invite` ("Invite staff to the clinic") to the catalog. The same migration inserts it and grants it to existing `owner` and `clinic_admin` roles (`plans/01` §4.5 pattern). `ROLE_TEMPLATES` grants it to the same two roles.

### 4.6 Token formats

| Token | Format | Stored as |
|---|---|---|
| Access token | JWT HS256 | Not stored |
| Refresh token | 32 random bytes, base64url | SHA-256 hex in `refresh_tokens.token_hash` |
| Reset / setup / invitation token | 32 random bytes, base64url | SHA-256 hex |

SHA-256 (not Argon2) is right for these: they are 256-bit random values, so slow hashing adds nothing, and lookup must be by hash.

---

## 5. Access Token and Principal

### 5.1 Claims

`sub` (user id), `sid` (session id), `typ` (`staff`), `iat`, `exp`, `iss` (`doctayo-api`), `aud` (`doctayo`). **No roles, permissions or tenant id in the token** (D5).

- Signed HS256 with `JWT_ACCESS_SECRET` (≥ 32 bytes, validated at boot; production refuses a weak or missing secret).
- Verified with an explicit `algorithms: ['HS256']`, issuer and audience. 30 s clock tolerance.
- TTL 15 minutes (`JWT_ACCESS_TTL`, validated range 5–60 minutes).

### 5.2 `JwtAuthenticator` (replaces `DenyAllAuthenticator`)

1. Read `Authorization: Bearer <jwt>`; no header → `null` (→ `401 UNAUTHENTICATED`).
2. Verify the signature and claims. Expired → `401 ACCESS_TOKEN_EXPIRED` (the client should refresh). Any other failure → `401 UNAUTHENTICATED`.
3. **One indexed query** on `sessions` by `sid` joined to `users`: session not revoked, idle and absolute expiry not passed, `sessions.user_id = sub`, user `active`. Otherwise → `401 UNAUTHENTICATED`. Logout, password change/reset and deactivation therefore take effect on the next request.
4. Return `Principal { userId, sessionId, type: 'staff', activeTenantId: session.active_tenant_id }`.
5. `last_used_at`/`idle_expires_at` are bumped at most once per minute per session (a conditional `UPDATE ... WHERE last_used_at < now() - 1 minute`), not on every request.

`Principal` gains `sessionId` and `type`; `RequestContext` gains `sessionId`. This is the addition `plans/01` §5 anticipated, not a rewrite. `TenantGuard` and `PermissionsGuard` are unchanged except that they reject a non-`staff` principal (none exists yet).

`DenyAllAuthenticator` is deleted. `TestAuthenticator` stays for the Phase 2 suites (it is test-only and unaffected).

---

## 6. Sessions and Refresh

### 6.1 Lifetimes

| Item | Default | Env var |
|---|---|---|
| Access token | 15 min | `JWT_ACCESS_TTL` |
| Session idle timeout | 14 days | `SESSION_IDLE_TTL` |
| Session absolute lifetime | 30 days | `SESSION_ABSOLUTE_TTL` |
| Refresh token row expiry | = session absolute expiry | — |

### 6.2 Refresh (`POST /auth/refresh`, public)

In one transaction:

1. Hash the presented token and find its `refresh_tokens` row with its session (`FOR UPDATE`).
2. Not found → `401 UNAUTHENTICATED`.
3. Row already `rotated_at` → **reuse**: revoke the session (`refresh_reuse`), audit `auth.refresh_reuse_detected`, log a security event (ids only), `401 UNAUTHENTICATED`.
4. Session revoked or expired, or user not `active` → `401 UNAUTHENTICATED`.
5. Mark the row rotated, insert a new row, bump idle expiry, and return a new access token and refresh token.

Two concurrent refreshes with the same token: the row lock serialises them, and the second one is treated as reuse (D10). The frontend must serialise its refresh calls.

### 6.3 Transport (D2, master plan Q5)

**Recommended: cookie** (if the frontend is served from the same site as the API, e.g. `app.doctayo.ph` and `api.doctayo.ph`):

- Refresh token in cookie `dt_refresh`: `HttpOnly`, `Secure` (outside development), `SameSite=Strict`, `Path=/api/v1/auth`, `Max-Age` = remaining absolute lifetime.
- Access token in the JSON body, held in memory by the client.
- Cookie-authenticated endpoints (`refresh`, `logout`) also require an `Origin` header that is in `CORS_ALLOWED_ORIGINS` (CSRF defence in depth on top of `SameSite=Strict`). `CORS_ALLOW_CREDENTIALS=true`.

**Alternative (if the frontend is on a different site):** the refresh token in the response body and the request body; the client stores it. No cookie, no `cookie-parser`. The rest of the design is identical, so the choice can still change before M5.

---

## 7. Endpoints

All under `/api/v1`. Envelope `{ data }`. Request DTOs with `class-validator`; no endpoint takes a token in a query string (tokens in emailed links go in the URL **fragment** of the frontend page, which is never sent to servers).

### 7.1 Auth (`modules/auth`)

| Method & path | Category | Behavior |
|---|---|---|
| `POST /auth/login` | `@Public()` | Body `email`, `password`. Generic `401 INVALID_CREDENTIALS` for unknown email, wrong password, `pending` or `deactivated` user (a dummy Argon2 verify runs for unknown emails so timing is similar). Success: new session; if the user has exactly one active membership in an active tenant it becomes the session's active tenant. Returns `accessToken`, `expiresIn`, `user`, `memberships` (tenant id, name, status, role names), `activeTenantId`. Refresh token per §6.3. Throttled (§9). Rehashes the password if Argon2 parameters changed. |
| `POST /auth/refresh` | `@Public()` | §6.2. |
| `POST /auth/logout` | `@TenantNotRequired()` | Revokes the current session. `204`. Clears the cookie. |
| `POST /auth/logout-all` | `@TenantNotRequired()` | Revokes every session of the user. `204`. |
| `POST /auth/switch-tenant` | `@TenantNotRequired()` | Body `tenantId`. Same checks as `TenantGuard` (`TENANT_ACCESS_DENIED`, `TENANT_SUSPENDED`, `TENANT_DEACTIVATED`). Sets `sessions.active_tenant_id`; the change applies to the very next request (D5). Returns the active tenant and the user's permissions there. Audited. |
| `POST /auth/password/forgot` | `@Public()` | Body `email`. **Always `202`.** If an `active` user exists: create a `password_reset` token (30 min, earlier unused ones invalidated) and enqueue the email in the same transaction. Throttled. |
| `POST /auth/password/reset` | `@Public()` | Body `token`, `newPassword`. Valid unused unexpired token → set password, mark token used, `email_verified_at` if null, revoke **all** sessions, enqueue the password-changed email. Otherwise `400 TOKEN_INVALID`. Throttled. |
| `POST /auth/account/setup` | `@Public()` | Body `token`, `newPassword` (and optional `fullName`). For `account_setup` tokens (onboarded owners, §8.3). Sets password, `status = active`, `email_verified_at`. `400 TOKEN_INVALID` otherwise. |

### 7.2 Current user (`modules/users`)

| Method & path | Category | Behavior |
|---|---|---|
| `GET /me` | `@TenantNotRequired()` | Profile (`id`, `email`, `fullName`, `emailVerifiedAt`, `passwordChangedAt`), `activeTenantId`, and the effective permissions in the active tenant (via `MembershipResolver`; empty if none or not active). |
| `GET /me/memberships` | `@TenantNotRequired()` | Every membership with tenant name and status and role names. Removed memberships excluded. |
| `POST /me/password` | `@TenantNotRequired()` | Body `currentPassword`, `newPassword`. Wrong current → `400 VALIDATION_FAILED` with field code `PASSWORD_INCORRECT`. Revokes all **other** sessions; enqueues the password-changed email. Throttled. |
| `GET /me/sessions` | `@TenantNotRequired()` | Active sessions: id, created, last used, user agent, IP, `current: boolean`. |
| `DELETE /me/sessions/:sessionId` | `@TenantNotRequired()` | Revokes one of **own** sessions; another user's id → `404`. `204`. |

### 7.3 Invitations

| Method & path | Category | Behavior |
|---|---|---|
| `POST /invitations` | tenant-scoped, `members.invite` | Body `email`, `roleId`. Role must belong to the tenant (composite FK + lookup → `404`). The `owner` role cannot be granted by invitation (`422 ROLE_NOT_ASSIGNABLE`; owner transfer is Phase 4). Already an active member → `409 CONFLICT`. Open invitation exists → `409 CONFLICT_UNIQUE` (resend instead). Creates the invitation and enqueues the email in one transaction (tenant client). `201`. Audited. |
| `POST /invitations/:invitationId/resend` | tenant-scoped, `members.invite` | New token (old one stops working), expiry reset to 7 days, email enqueued. Other tenant's id → `404`. Accepted/revoked → `409 CONFLICT`. Audited. |
| `POST /invitations/accept` | `@Public()` | Body `token`, plus `fullName` and `newPassword` **only when the email has no usable account** (no user, or a `pending` user). For an existing `active` user the token alone is enough: it proves control of the email, and the membership goes to that account. Creates or activates the user (`email_verified_at` set), creates the membership `active` with the invited role, marks the invitation accepted, audits — one transaction (unscoped client, `auth` module). Invalid, expired, revoked or used → `400 TOKEN_INVALID`. Tenant not `active` → `403 TENANT_SUSPENDED`/`TENANT_DEACTIVATED`. No auto-login: the client then calls `/auth/login`. Throttled. |

### 7.4 New error codes

| Code | HTTP | Message |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | The email or password is incorrect. |
| `ACCESS_TOKEN_EXPIRED` | 401 | Your session needs to be refreshed. |
| `TOKEN_INVALID` | 400 | This link is invalid or has expired. Please request a new one. |
| `ROLE_NOT_ASSIGNABLE` | 422 | This role cannot be given through an invitation. |

Field-level codes: `PASSWORD_TOO_COMMON`, `PASSWORD_INCORRECT`, `PASSWORD_CONTAINS_EMAIL`. `RATE_LIMITED` (429) becomes active, with a `Retry-After` header.

---

## 8. Passwords, Tokens and Email

### 8.1 Password hashing

- Argon2id, OWASP baseline `m = 19 MiB, t = 2, p = 1` (master plan §8 item 1), in the `auth` config namespace. The test environment may lower them to keep tests fast; validation refuses lowered values when `NODE_ENV=production`.
- `needsRehash` on successful login → rehash in the same transaction.
- A constant dummy hash is verified for unknown emails (timing).

### 8.2 Password policy

- Length 10–128 (Unicode code points, after NFKC normalisation; no trimming of inner spaces).
- Not in a bundled list of common passwords (D11). Not equal to, or containing, the email local part.
- No composition rules (better usability for the target users).
- Errors are field-level in `VALIDATION_FAILED` (`TOO_SHORT`, `TOO_LONG`, `PASSWORD_TOO_COMMON`, `PASSWORD_CONTAINS_EMAIL`).

### 8.3 Account setup for onboarded owners

`TenantOnboardingService` (Phase 2) creates owners as `pending`. Phase 3 adds: if the owner user is newly created (or still `pending`), create an `account_setup` token (7 days) and enqueue the setup email **in the same onboarding transaction**. An owner who already has an `active` account is only notified that they now own a clinic. The setup link can be re-issued through `forgot password` once the user is `active`, and for a still-`pending` user by a Phase 4 admin action (until then, re-running onboarding is not possible: a support script is documented as a stopgap).

### 8.4 Email delivery (D4)

- `MailModule` with a transport chosen by `MAIL_TRANSPORT`: `log` (development default), `file` (development, `var/mail`), `memory` (tests), `smtp` (`SMTP_URL`). Production requires `smtp` (config validation refuses the others). An HTTP provider transport is added once Q6 is answered.
- Mail classes: `invitation`, `account-setup`, `password-reset`, `password-changed`, `clinic-owner` (ownership notice for an owner who already has an account). Written inline in TypeScript with the `html` tagged template (auto-escaped), not as template files. Plain, short, large-text friendly; links built from `APP_PUBLIC_URL` with the token in the fragment (`/reset-password#token=…`).
- **Never sent directly from a request.** Services call `outbox.add(tx, message)` inside their transaction; a local `@OnOutboxMessage()` handler renders and sends. At-least-once delivery: a duplicate email is acceptable; a lost one is not.
- The relay runs inside the API process (single instance). `OUTBOX_RELAY=off` is available for later worker separation.
- No PHI and no tokens in mail logs: the handler logs message id and type only. The emailed token itself is part of the queued payload and is therefore stored in `nest_outbox.messages` (and in `dead_letters` after repeated failure) until delivered or purged; see §19.

### 8.5 Cleanup job (`@nestjs/schedule`)

Daily at 03:00 Asia/Manila: delete `user_tokens` expired or used > 7 days ago; sessions revoked or expired > 30 days ago (with their `refresh_tokens`); delivered outbox rows via the package's `prune()`. Idempotent, so it is safe without `@nestjs/locks` while there is one instance. Expired invitations are **kept** (history); they are simply unusable.

---

## 9. Throttling and Lockout

### 9.1 Throttler

`ThrottlerGuard` becomes the **first** `APP_GUARD` (before `AuthGuard`), in-memory storage. Client IP comes from Express with the existing `TRUST_PROXY` setting.

| Route | Limit (D8) | Tracker |
|---|---|---|
| Global default | 300 / minute | IP |
| `POST /auth/login` | 5 / 15 min **and** 30 / 15 min | IP + normalized email, and IP |
| `POST /auth/password/forgot`, `/password/reset`, `/account/setup`, `/invitations/accept` | 5 / 15 min | IP |
| `POST /auth/refresh` | 30 / minute | IP |
| `POST /me/password` | 5 / 15 min | user id |

Health endpoints are excluded from throttling (`@SkipThrottle()`).

### 9.2 Account lockout

After 10 consecutive failed logins for an existing user, `locked_until = now + 15 min`. While locked, login answers **exactly like the per-email throttle** (`429 RATE_LIMITED` with `Retry-After`), so the response never reveals whether the email exists. A successful login, password reset or account setup resets the counter. Lockout is per account, not per IP, and expires on its own, which limits lockout-as-denial-of-service.

---

## 10. Audit and Logging

| Event | `action` | Tenant | Entity |
|---|---|---|---|
| Login succeeded | `auth.login` | null | user |
| Login failed (existing user) | `auth.login_failed` | null | user |
| Logout / logout-all | `auth.logout`, `auth.logout_all` | null | session / user |
| Refresh reuse detected | `auth.refresh_reuse_detected` | null | session |
| Tenant switched | `auth.tenant_switched` | new tenant | session |
| Password reset requested (existing user) | `auth.password_reset_requested` | null | user |
| Password reset / changed / account set up | `auth.password_reset`, `auth.password_changed`, `auth.account_setup` | null | user |
| Session revoked by user | `auth.session_revoked` | null | session |
| Invitation created / resent / accepted | `invitation.created`, `invitation.resent`, `invitation.accepted` | tenant | invitation |

Successful refreshes are not audited (volume). Failed logins for unknown emails are not audited (there is no user id and `audit_logs` stores no free text); they appear only as a throttle count. Each security event also logs ids only. Log-assertion tests (§13.8) prove that no password, token, cookie or `Authorization` value appears in logs.

---

## 11. Code Layout (new and changed files)

```
src/
  config/                      auth, mail namespaces in env.validation.ts / configuration.ts
  common/auth/                 authenticator.ts (Principal + sessionId, type); deny-all.authenticator.ts deleted
  common/guards/               user-throttle.guard.ts (per-user route limit)
  common/security/             token.ts (random token + SHA-256), clock.ts (injectable clock for expiry tests)
  context/                     request-context.ts (+ sessionId)
  modules/
    auth/                      auth.controller.ts, invitation-acceptance.controller.ts, auth.module.ts,
                               throttle.ts, dto/
      session/                 access-token.service.ts, jwt.authenticator.ts, session.service.ts,
                               refresh.service.ts, auth-cookie.service.ts
      password/                password-hasher.ts, password-policy.ts (policy + assertPasswordPolicy),
                               common-passwords.ts (+ specs)
      flows/                   login.service.ts (+ lockout constants), password-recovery.service.ts,
                               account-setup.service.ts, password-change.service.ts,
                               invitation-acceptance.service.ts, switch-tenant.service.ts,
                               user-token.service.ts
    users/                     me.controller.ts, me.service.ts, users.module.ts, dto/
    members/                   invitations.controller.ts, invitations.service.ts, members.module.ts, dto/
    mail/                      mail.module.ts, mail-queue.service.ts, mail-outbox.handler.ts, mails/{emails,layout}.ts
    maintenance/               cleanup.service.ts, cleanup.job.ts, maintenance.module.ts
    tenancy/                   tenancy.module.ts (ThrottlerGuard first), tenant-access.ts (the shared access rule), user-memberships.service.ts
    tenants/                   tenant-onboarding.service.ts (+ account setup token and email)
    access-control/            catalog.ts (+ members.invite)
prisma/schema/                 identity.prisma (users columns, sessions, refresh_tokens, user_tokens), tenancy.prisma (invitations)
prisma/migrations/             <ts>_authentication/ (+ outbox SQL, partial unique index, members.invite insert and grants)
test/support/                  auth.ts (createActiveUser, setPasswords, seedMembership, cookie helpers), mail.ts (mailbox, deliverMail,
                               tokenFromLink), test-clock.ts, resettable-throttler-storage.ts
docs/                          authentication.md (new); environment, error-codes, authorization, multitenancy,
                               architecture, security-privacy, database (updated)
docs/adr/                      0011-authentication-without-nestjs-authentication.md, 0012-refresh-token-transport.md,
                               0013-mail-and-outbox.md
```

`test/architecture/prisma-access.spec.ts` adds `auth`, `users`, `mail`, `maintenance` to the unscoped allow-list. `members` stays a domain module (tenant client only).

---

## 12. New Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | **yes** | — | ≥ 32 bytes. Generated per environment; never committed. |
| `JWT_ACCESS_TTL` | no | `15m` | 5–60 minutes. |
| `SESSION_IDLE_TTL` | no | `14d` | |
| `SESSION_ABSOLUTE_TTL` | no | `30d` | Must be ≥ idle TTL. |
| `APP_PUBLIC_URL` | **yes in production** | `http://localhost:5173` outside production | Frontend base URL for emailed links. |
| `MAIL_TRANSPORT` | no | `log` (dev), `memory` (test) | `log` \| `file` \| `memory` \| `smtp`. Production requires `smtp`. |
| `MAIL_FROM` | **yes in production** | `DocTayo <no-reply@doctayo.local>` outside production | |
| `SMTP_URL` | when `MAIL_TRANSPORT=smtp` | — | e.g. `smtps://user:password@host:465`. A provider transport and its key are added after Q6. |
| `OUTBOX_RELAY` | no | `on` | `off` = this process does not deliver queued mail (tests use it and drive delivery explicitly). |
| `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | no | `19456`, `2`, `1` | Production refuses values below these. Tests lower them for speed. |

`AUTH_REFRESH_COOKIE` was dropped: D2 chose the cookie, so there is no second mode to switch to.

Each variable is validated in `env.validation.ts` and documented in `docs/environment.md` and `.env.example`; Compose passes the development values.

---

## 13. Test Plan (written before implementation, per CLAUDE.md)

All database behavior is tested against the real `doc_tayo_test` PostgreSQL. New e2e suites authenticate with **real login** (the production `JwtAuthenticator`); the Phase 2 suites keep `TestAuthenticator`. An injectable clock lets tests move time without sleeping. Mail is captured with the in-memory transport.

### 13.1 Schema (`test/auth-schema.e2e-spec.ts`)
- `users.password_hash` is never returned by default queries (global omit).
- `refresh_tokens.token_hash`, `user_tokens.token_hash`, `invitations.token_hash` unique.
- Two open invitations for the same email in one tenant → unique violation; after accept or revoke, a new one is allowed.
- Cross-tenant `invitations.role_id` / `invited_by_membership_id` → FK violation (raw insert).
- `permissions` table equals the code catalog (now including `members.invite`).

### 13.2 Password hashing and policy (unit: `password-hasher.spec.ts`, `password-policy.spec.ts`)
- Argon2id PHC string with the configured parameters; verify true/false; `needsRehash` after a parameter change.
- Boundaries: 9 vs 10 and 128 vs 129 code points; common password; contains email local part; Unicode normalisation.
- Production config refuses lowered hashing parameters (env validation spec).

### 13.3 Tokens and sessions (`test/auth-sessions.e2e-spec.ts`)
- Login issues a JWT with exactly `sub`, `sid`, `typ`, `iat`, `exp`, `iss`, `aud`; no tenant, role or permission claims.
- Tampered signature, `alg: none`, HS512, wrong issuer or audience, malformed token → `401 UNAUTHENTICATED`. Expired → `401 ACCESS_TOKEN_EXPIRED`.
- Refresh rotates: old refresh token now fails; **reuse of an old token revokes the session** and the current access token stops working on the next request.
- Idle expiry and absolute expiry (clock moved) → `401`.
- Logout: refresh fails and the access token fails on the next request. Logout-all: every session of the user fails; another user's sessions unaffected.
- Deactivated user (status changed in DB) → next request `401`, refresh `401`.
- Cookie mode: `Set-Cookie` flags (`HttpOnly`, `Secure` outside development, `SameSite=Strict`, `Path=/api/v1/auth`); refresh without a valid `Origin` → `403 FORBIDDEN`.

### 13.4 Login, throttling and lockout (`test/auth-login.e2e-spec.ts`)
- Valid login; wrong password, unknown email, `pending` user, `deactivated` user → identical `401 INVALID_CREDENTIALS` bodies.
- Exactly one active membership → `activeTenantId` set; several or none → null.
- 6th attempt for the same IP + email within 15 min → `429 RATE_LIMITED` with `Retry-After`; same response for an unknown email.
- 10 failed attempts → `locked_until` set; locked login with the correct password → the same 429; successful login after expiry resets the counter.
- Login rehashes a hash created with older parameters.

### 13.5 Switch tenant and `/me` (`test/auth-endpoints.e2e-spec.ts`, `test/auth-me.e2e-spec.ts`)
- User M (member of Clinic A and Clinic B): switch to B → the next request sees B's data with B's permissions; A's permissions do not carry over (master plan §11.5).
- Switch to a tenant without membership → `403 TENANT_ACCESS_DENIED`; suspended tenant → `403 TENANT_SUSPENDED`.
- Membership removed while the access token is valid → next tenant request `403`.
- `GET /me` permissions match the active tenant; `GET /me/memberships` excludes removed memberships.
- **The Phase 2 isolation matrix re-run with real tokens** for `/tenant` and `/branches`.

### 13.6 Password flows (`test/auth-password.e2e-spec.ts`)
- Forgot password: `202` for existing and unknown emails with identical bodies; email captured only for the existing active user; token valid once; expiry at 30 min; a second request invalidates the first token.
- Reset: sets the password, revokes all sessions, sends the password-changed email; reused or expired token → `400 TOKEN_INVALID`.
- Change password: wrong current password → `PASSWORD_INCORRECT`; success revokes other sessions but keeps the current one.
- Account setup: onboarding sends the setup email in the same transaction (forced failure → no email row); setup activates the `pending` user, who can then pass `TenantGuard`.

### 13.7 Invitations (`test/invitations.e2e-spec.ts`)
- Receptionist → `403 FORBIDDEN`; owner/admin → `201` and one email.
- Role from Clinic B → `404`; `owner` role → `422`; existing active member → `409`; open invitation → `409 CONFLICT_UNIQUE`.
- Accept as a new email: user created `active` and verified, membership `active` with the role, can log in.
- Accept as an existing active user: no password needed, membership added, existing password unchanged.
- Accept as a `pending` user: requires `fullName` and `newPassword`, then the user is active.
- Expired, revoked, resent (old token) or used token → `400 TOKEN_INVALID`. Tenant suspended → `403 TENANT_SUSPENDED`.
- Resend on Clinic B's invitation id → `404`.

### 13.8 Security and hygiene (`test/auth-security.e2e-spec.ts`)
- Captured logs during login, refresh, reset, setup and invitation flows contain no password, token, cookie value or `Authorization` header.
- Unknown fields in auth bodies (`status`, `platformRole`, `tenantId`) → `400 VALIDATION_FAILED`.
- Tokens are never accepted from query strings.
- Outbox: an email is enqueued only when its transaction commits (forced rollback → none).

### 13.9 Architecture and existing suites
- Route registry: every new route is in exactly one category; `members` endpoints declare `members.invite`.
- Prisma-access allow-list updated; `members` must not use `PrismaService`.
- `DenyAllAuthenticator` removed; the production binding is `JwtAuthenticator` (asserted in `tenancy-guards.e2e-spec.ts`).
- Every Phase 1 and Phase 2 suite stays green.

---

## 14. Milestones (each: tests first, then code, then the relevant suites)

| # | Milestone | Done when |
|---|---|---|
| M0 ✅ | Approvals (§16) | Decisions recorded in this file |
| M1 ✅ | **Spike** (scratch, not committed): `argon2` loads in the Debian-slim image and CI; `@nestjs/outbox` `fromPrisma` with the Prisma 7 pg adapter inside an interactive transaction, including the tenant client's `$transaction`; outbox SQL fits in a Prisma migration and works for the runtime role; `@nestjs/mail` in-memory transport in Vitest; `@nestjs/throttler` v6 as the first `APP_GUARD` with per-route trackers; ESM imports for every new package | Findings in §17; plan adjusted if an assumption fails |
| M2 ✅ | Schema + migration (+ outbox SQL, partial unique index, `members.invite`) | §13.1 green; `migrate deploy` locally and in Docker |
| M3 ✅ | Password hasher + policy + common-password list | §13.2 green |
| M4 ✅ | Session, refresh-token and access-token services; `JwtAuthenticator`; `Principal`/context changes | §13.3 green (except cookie cases, which land with M5) |
| M5 ✅ | Auth controller: login, refresh, logout, logout-all, switch-tenant; cookie handling; throttler and lockout | §13.3, §13.4, §13.5 green |
| M6 ✅ | `/me` endpoints | §13.5 green |
| M7 ✅ | Mail module + outbox + forgot/reset + change password + account setup (onboarding change) | §13.6 green |
| M8 ✅ | Invitations (create, resend, accept) | §13.7 green |
| M9 ✅ | Cleanup job | Unit test with the clock; e2e run of the job against seeded expired rows |
| M10 ✅ | Security/hygiene suite, architecture updates | §13.8, §13.9 green |
| M11 ✅ | Docs + ADRs 0011–0013 + env docs; plan sync (master plan and this file's "As Built") | Lint, format, typecheck, unit, e2e, Docker build all green |

---

## 15. Phase 3 Completion Criteria (master plan §10, made testable)

- Every flow in §7 is covered by e2e tests, including token reuse, expired and revoked sessions, and enumeration-safe responses (§13.3–§13.7).
- Password change and reset revoke sessions (§13.6).
- Switch-tenant refuses non-members (§13.5).
- The Phase 2 tenant routes work end to end with real tokens, and the isolation matrix passes with them (§13.5).
- No password, token or cookie value appears in logs (§13.8).
- No email is sent for a rolled-back transaction (§13.8).

---

## 16. Decisions (`REQUIRES APPROVAL`)

- **D1 — Build on the existing seam with `@nestjs/jwt` + `argon2`; do not adopt `@nestjs/authentication` (0.1.6).** *Recommended: approve.* Per its docs it registers its own global guard and its own `@Public()`, which would duplicate ours and bypass the `AuthGuard` → `TenantGuard` → `PermissionsGuard` chain. It hashes with scrypt, not the Argon2id the master plan specifies. Its sessions are cookie-first, and it requires implementing six store interfaces. The pieces we need (rotation, reuse detection, revocation) are small and fully tested here. Revisit when it reaches 1.0, especially for MFA/OIDC.
- **D2 — Refresh token transport (master plan Q5).** *Recommended: httpOnly cookie,* if the frontend will be served from the same site as the API. Otherwise the token goes in the body. **Your input needed: will the frontend and API share a domain (e.g. `app.` and `api.doctayo.ph`)?**
- **D3 — Registration (Q3): invitation-only; no public sign-up.** Tenants are provisioned through onboarding (platform admin). *Recommended: approve.*
- **D4 — Email via `@nestjs/mail` + `@nestjs/outbox`, pinned exactly.** Both are 0.x. *Recommended: approve,* because they are first-party (AGENTS.md), match the master plan's outbox design, and are confined to `modules/mail`. Fallback if the M1 spike fails: our own small `outbox_messages` table polled by `@nestjs/schedule`. The **production provider (Q6) is still open**: Phase 3 can be implemented and tested without it, but cannot go live without it.
- **D5 — The active tenant lives on the session row, not in the token.** *Recommended: approve.* The authenticator reads the session on every request anyway, so `tid` in the JWT would only add a 15-minute stale copy. Switch-tenant then applies immediately with no new token. This deviates from master plan §4.2 (`tid` claim), see §18.
- **D6 — Defer `POST /auth/email/verify`.** *Recommended: approve.* With invitation-only accounts, consuming an emailed invitation, setup or reset token already proves the email, so nothing would produce verification tokens until email change (Phase 4) or self-registration.
- **D7 — Invitations in Phase 3: create, resend, accept;** one role per invitation; new permission `members.invite` for owner and clinic admin; the owner role cannot be invited. Listing and revocation move to Phase 4 with member management. *Recommended: approve.*
- **D8 — Rate limits and lockout numbers** as in §9. *Recommended: approve;* tune with real traffic.
- **D9 — Lifetimes:** access 15 min, idle 14 days, absolute 30 days (master plan §4.2). *Recommended: approve.*
- **D10 — No grace window for concurrent refreshes:** a second use of the same refresh token is always reuse. *Recommended: approve;* the frontend serialises refreshes. A grace window weakens theft detection.
- **D11 — Common-password list:** bundle a top-10,000 list in the repository. *Recommended: approve.* M1 confirms the source's license (SecLists is MIT). No external breach-check API, so no data leaves the server.

---

## 17. Spike Findings (M1, 2026-11-19)

Scratch test, deleted after the run. Results:

| Assumption | Result |
|---|---|
| `argon2` 0.45.2 loads and hashes (`argon2id`, `needsRehash`) on Linux x64 | **Confirmed**, locally and in the Debian-slim `runtime` Docker image with the production parameters (`m=19456,t=2,p=1`): the prebuilt binary is used and the install script is not needed (disabled in `allowScripts`). The GitHub Actions run was not executed. |
| `@nestjs/outbox` `fromPrisma(prisma)` works with our `PrismaService` (Prisma 7.10.1, pg adapter) | **Confirmed.** `outbox.add(tx, msg)` inside `prisma.$transaction` commits with the transaction; a rolled-back transaction produces no message. |
| `outbox.add` works with the **tenant-extended** client's transaction | **Confirmed**, when given the extended transaction client itself. `TenantPrismaService.$transaction` only hands out picked delegates, so it needs a small addition (M8). |
| The outbox SQL fits a Prisma migration; runtime role needs DML only | **Confirmed.** The store lives in its own schema `nest_outbox` (not `public`), so our default privileges do not cover it: the migration adds `GRANT USAGE` on the schema, DML on its tables and sequences, and `ALTER DEFAULT PRIVILEGES` for later outbox migrations. The store runs with `migrate: false`. |
| `@nestjs/mail` `InMemoryMailTransport` + `Mailer.send` in Vitest | **Confirmed.** Tests drive delivery with `OutboxRelay.runOnce()` (relay disabled in tests). |
| ESM imports for every new package | **Confirmed** (`@nestjs/outbox`, `/postgres`, `@nestjs/mail` import with `.js` project style). |
| `@nestjs/throttler` v6 as first `APP_GUARD` with per-route trackers | **Confirmed in M5.** v6.8 supports `getTracker` per route and several named throttlers; the throttler's windows use real time, not our injectable clock. The throttler's storage keeps its hit timestamps in two maps, so test resets must clear both (`test/support/resettable-throttler-storage.ts`). |

Other findings: `@nestjs/outbox` pulls in `@nestjs/store-kit` (dependency). Both 0.x packages are pinned exactly in `package.json`.

---

## 18. Deviations from the Master Plan (applied to `plan.md` on 2026-11-19)

| # | Master plan said | Built | Why |
|---|---|---|---|
| 1 | Access token claim `tid` (§4.2, §3.3) | No `tid`; the active tenant is `sessions.active_tenant_id`, read by the authenticator | D5: one source of truth, immediate switch, no stale tenant in tokens |
| 2 | Session check "combined with the membership query" (§4.2) | Separate indexed session query in the authenticator; `TenantGuard` keeps its own query | The session check is also needed on `@TenantNotRequired()` routes, which have no membership query. Two indexed lookups per tenant request; measured in Phase 7. |
| 3 | Email verification endpoint in Phase 3 | Deferred (D6) | No producer of verification tokens in Phase 3 |
| 4 | Invitation management in Phase 4 | Create/resend/accept in Phase 3; listing/revoke in Phase 4 (D7) | Acceptance (Phase 3) needs invitations to exist |
| 5 | `user_tokens.type`: `email_verification`, `password_reset` | `password_reset`, `account_setup` now; `email_verification` added when used | Onboarded owners need a set-password link |
| 6 | `@nestjs/authentication` to be evaluated | Not adopted (D1) | Duplicate guard chain, scrypt, cookie-first sessions, 0.x |
| 7 | `JwtAuthGuard` in the guard order (§5.2) | `ThrottlerGuard` → `AuthGuard` (with `JwtAuthenticator`) → `TenantGuard` → `PermissionsGuard` | The Phase 2 seam already exists; only the binding changes |

---

## 19. As Built

Implemented on 2026-11-19. Verified with: `npx tsc --noEmit`, `oxlint --type-aware`, `prettier --check`, the unit/architecture suite and the full e2e suite against the real `doc_tayo_test` PostgreSQL (counts are in the final report), plus Docker: both images build, `migrate` applied the migration to the Compose database, the API container booted, answered health and auth requests, and hashed with `argon2` in the Debian-slim image.

### Deviations from the plan (all intentional)

| # | Plan said | Built | Why |
|---|---|---|---|
| 1 | Common-password list: bundle SecLists top 10,000 | `common-passwords.ts`: the 9,126 entries of 10+ characters (deduplicated, NFKC lower-case) from the NCSC "100k most used passwords" list as redistributed by SecLists (MIT) | The top-10k list has only 51 passwords of 10+ characters, and the minimum length is 10, so it would block almost nothing. Same licence, same "no data leaves the server". A TypeScript module instead of a `.txt` asset avoids copying assets in the build. |
| 2 | Password must not contain the email local part | Only a local part of 4+ characters is checked (and the whole address always is) | A 2-character local part ("jo") would reject ordinary passwords. |
| 3 | Mail templates as files in `mails/*.ts` + `templates/*` | Inline TypeScript with the `html` tagged template (`mails/emails.ts`, `mails/layout.ts`) | Auto-escaped, typed, nothing to copy at build time, and the five mails are short. |
| 4 | Four emails | Five: `clinic_owner` (ownership notice) | §8.3 required telling an owner who already has an account that they now own a clinic. |
| 5 | Lockout "after 10 consecutive failures" | The counter is **not** reset when the lock expires, so the next failure locks again; only a success, password reset or account setup clears it | Stricter against slow guessing; the lock is short (15 min) so the denial-of-service risk is bounded. |
| 6 | Throttler "first `APP_GUARD`" with a per-user limit for `POST /me/password` | The throttler is first, but the per-user limit is a route guard (`UserThrottleGuard`, `common/guards`), because the throttler runs before authentication and cannot know the user. A named throttler `ip15` + `@IpLimited()` provides login's second (per-IP) limit. `ThrottlerModule` is re-exported by `TenancyModule` so both guards share one counter store. | Authentication order. |
| 7 | Reset/setup/accept/change responses unspecified | `forgot` → `202 { data: { accepted: true } }`; `reset`, `account/setup`, `invitations/accept`, `POST /me/password`, `logout`, `logout-all`, `DELETE /me/sessions/:id` → `204`; `resend` → `200` | Consistent and simple for the client. |
| 8 | (not specified) | `Cache-Control: no-store` on every `/api/v1/auth/*` and `/api/v1/me*` response (middleware in `app.setup.ts`) | Responses carry access tokens or account data and must never be cached by a browser or proxy. |
| 9 | The emailed token is only "enqueued" | The raw token is part of the outbox message payload, so it sits in `nest_outbox.messages` until delivered and in `dead_letters` if delivery keeps failing. The cleanup job purges dead letters after 14 days. | The token is needed to build the link when the relay sends the email; hashing it first would make the link impossible to rebuild. Accepted risk: anyone who can read the database could use an undelivered link. Mitigated by 30-minute/7-day expiry, single use, and the purge. |
| 10 | `TenantPrismaService.$transaction` unchanged | The callback now receives a `TenantTransaction`: the scoped delegates plus an opaque `transaction` handle used only to join the outbox. `TenantModels` gains the `invitation` delegate. | `members` may only use the tenant client but must queue the invitation email in the same transaction. The handle does not expose the Prisma client. |
| 11 | `TenantGuard` unchanged except rejecting non-staff principals | The access rule moved to `tenancy/tenant-access.ts` (`tenantAccessError`) and is used by `TenantGuard` and switch-tenant. No runtime non-staff check was added because `Principal.type` can only be `staff`. | One rule in one place, so switch-tenant and the guard cannot drift. The check is added with the first non-staff principal. |
| 12 | `UserMembershipsService` not planned | Added in `modules/tenancy` (unscoped, global identity data) for the login response and `GET /me/memberships` | Shared by `auth` and `users`. |
| 13 | `POST /auth/refresh` accepts request metadata | `RefreshService.rotate(token, meta)` keeps the parameter but ignores it; user agent and IP are recorded at login only | Not required by the plan; the parameter is kept for a later "last seen device" feature. |
| 14 | Refresh-token body mode as a switchable alternative | Not built; `AUTH_REFRESH_COOKIE` does not exist | D2 chose the cookie. Moving to the body later changes `AuthController` and `AuthCookieService` only. |
| 15 | `ThrottlerGuard` on health | Health is `@SkipThrottle({ default: true })` | Probes must never be rate limited. |

### Follow-up: frontend readiness (after the milestones)

Added once the first frontend integration was planned; none of it changes the design above.

- Response DTOs with `@ApiProperty` for `login`, `refresh`, `switch-tenant`, `password/forgot`, `GET /me`, `/me/memberships`, `/me/sessions` (they had none), so the OpenAPI document is complete.
- `docs/openapi.json`, generated by `npm run openapi:export` (`scripts/export-openapi.mjs` builds the app **without initialising it**, so it needs no database) and kept current by a drift test; `buildOpenApiDocument` was extracted from `app.setup.ts` so Swagger UI, the export and the test share it.
- `npm run db:seed:dev` (`src/dev/seed.ts`): a clinic with an owner and a receptionist, a second branch and a documented password; idempotent; refuses `NODE_ENV=production`. It ships in `dist/` like all of `src/` and is not reachable from any route.
- CORS: `Retry-After` is now in `exposedHeaders` (without it, browser code cannot read the header that `429` responses rely on). Credentialed preflight and responses are covered by `test/cors-credentials.e2e-spec.ts`.
- `docs/frontend-integration.md`.

### Test files

`auth-schema`, `auth-sessions`, `auth-login`, `auth-endpoints` (cookie, refresh, logout, switch-tenant, isolation with real tokens), `auth-me`, `auth-password` (forgot/reset/change/account setup), `invitations`, `cleanup`, `auth-security` (log hygiene, strict input, rollback atomicity, caching) and additions to `route-registry`, `tenancy-guards`, `architecture/prisma-access` and the unit specs (`env.validation`, `password-hasher`, `password-policy`, `error-codes`, `auth.guard`). `plans §13.5` ("auth-tenancy") is covered by `auth-endpoints` and `auth-me`.

### Known limits (not bugs)

- Throttle counters are in memory: they reset on restart and are per process (D8, single instance).
- A `forgot` request for an existing account does slightly more work than one for an unknown account (a transaction); this is not equalised.
- Without a production email provider (Q6) the system cannot go live: only SMTP is wired.
- `GET /me` reports permissions in the active tenant only when the membership is currently active; the access token itself never carries them.
