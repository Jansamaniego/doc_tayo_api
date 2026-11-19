# ADR-0013: Email through `@nestjs/mail` and a transactional outbox

Status: accepted (Phase 3)

## Decision

An email is queued with `outbox.add(tx, message)` inside the **same database transaction** as the change that causes it, and sent after commit by the `@nestjs/outbox` relay running in the API process (`OUTBOX_RELAY=off` disables it). Delivery uses `@nestjs/mail`. Both packages are 0.x and pinned exactly (`0.0.2`, `0.1.4`) and are used only in `src/modules/mail`.

- The outbox store (`PostgresOutboxStore`, `fromPrisma`) keeps its tables in its own schema `nest_outbox`. Our Prisma migration creates that schema (SQL from `npx @nestjs/outbox sql`) and grants the runtime role DML on it, so `prisma migrate deploy` stays the only migration step. The store runs with `migrate: false`. A package upgrade that needs a newer schema version adds its SQL in a new migration.
- Mail is written inline in TypeScript with the auto-escaping `html` template; links point at the frontend with the token in the URL fragment.
- `TenantPrismaService.$transaction` hands out an opaque `transaction` handle so a domain module that may only use the tenant client (invitations) can still join the outbox.

## Why

- An email must exist if and only if its change committed (no reset link for a rolled-back change, no lost invitation after a crash). The tests force a failure after queueing and prove nothing is sent and nothing is stored.
- Retries (10 attempts, backoff) mean a mail server outage delays an email instead of losing it; permanent failures are dead-lettered.

## Consequences / risks

- Delivery is at-least-once: a duplicate email is possible, a lost one is not.
- **The raw token is in the queued payload** until delivered (and in `dead_letters` after repeated failure, purged after 14 days by the cleanup job). Hashing it first would make the link impossible to rebuild. Mitigations: single use, 30-minute (reset) and 7-day (setup, invitation) expiry, and the purge.
- `LogMailTransport` logs the message body (including links): development only. Production requires `smtp`; config validation refuses the others.
- A production email provider is still open (master plan Q6); only SMTP is wired.
- Fallback if these 0.x packages cause trouble: a small `outbox_messages` table polled by `@nestjs/schedule`.
