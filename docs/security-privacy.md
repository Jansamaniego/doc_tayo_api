# Security and privacy notes (through Phase 3)

Not legal advice; privacy requirements (Data Privacy Act of 2012) must be confirmed with qualified professionals. This file records what the foundation enforces.

## Never log, trace or return

Request or response bodies · `Authorization`, `Cookie`, `Set-Cookie` · passwords, tokens, reset/OTP codes · **query strings** (search terms can be patient names) · patient or personal data of any kind (names, birth dates, phone, address, government IDs, diagnoses, notes) · connection strings and secrets · raw Prisma/SQL error text · stack traces to clients.

## How it is enforced

- Access log records method, path without query, status, duration, request id only.
- `PrismaService` does not log queries.
- Observe (`src/observability/observe.ts`): redaction on (built-in patterns + reserved personal-data keys), request-body capture off, header allow-list without auth/cookies, search-like query params obfuscated, `forwardLogs` off, `sourceContext` off. Database spans carry statements with literals removed; parameters are never read.
- Errors to clients contain catalog text only. **Error messages must be static strings**: Observe attaches error messages and stacks to traces and redaction is key/pattern based, so a message containing a patient name would not be caught.
- Request ids are server-validated UUIDs; client text never reaches logs or headers.
- `password_hash` is omitted from every default Prisma query (`omit` in `PrismaService`); only the credentials code selects it. Passwords, tokens and the refresh cookie are never logged: `test/auth-security.e2e-spec.ts` runs every auth flow at `verbose` log level and asserts no secret appears in the output.
- Tests: `test/request-id-and-logging.e2e-spec.ts`, `test/errors.e2e-spec.ts`, `test/auth-security.e2e-spec.ts`, `src/observability/observe.spec.ts`.

## Known gaps / decisions for later

- Observe's trace id equals the request id only when Observe is enabled and honors the custom generator; this is not verified without collector credentials. Logs always carry `requestId` explicitly regardless.
- Server-side 5xx logs include the original error stack (including its message) in the local logs.
- HSTS is enabled only when `NODE_ENV=production` (not covered by an e2e test because production requires TLS to the database).
- Rate limiting and authentication exist since Phase 3 ([authentication.md](authentication.md)). Throttle counters are in memory (per process, reset on restart). Audit logging: the append-only `audit_logs` table and `AuditService` (tenant, branch, lifecycle and, since Phase 3, authentication and invitation events; field names only, no values); medical-record reads are not audited yet.
- Emailed tokens (reset, setup, invitation) are stored hashed in the database, but the raw token also sits in the queued outbox message until it is delivered (and in the dead-letter table if delivery keeps failing; purged after 14 days). Anyone who can read the database could use an undelivered link until it expires (ADR-0013). `MAIL_TRANSPORT=log` writes links to the log: development only.
