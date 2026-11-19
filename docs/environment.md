# Environment variables

All configuration is read in `src/config` (`env.validation.ts`), validated at startup, and exposed as typed namespaces (`app`, `database`, `cors`, `logging`, `swagger`, `observe`, `auth`, `mail`). **Invalid or missing required variables stop the app from starting**; the error names the variables, never their values.

Files: `.env` (development, gitignored), `.env.test` (tests, gitignored). Templates: `.env.example`, `.env.test.example`. In production only real environment variables are used. Never commit secrets.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | 1–65535 |
| `TRUST_PROXY` | no | `false` | `false`, `loopback` or hop count. Set correctly behind a proxy so client IPs are real. |
| `DATABASE_URL` | **yes** | — | `postgresql://` URL for the **runtime role** `doctayo_app`. No `?schema=` parameter; use `DATABASE_SCHEMA`. |
| `DATABASE_SCHEMA` | no | `public` | |
| `DATABASE_SSL` | no | `disable` (`require` in production) | `disable` \| `require` \| `verify-full`; `disable` is rejected in production. |
| `DATABASE_POOL_MAX` | no | `10` | 1–100 |
| `DATABASE_MIGRATION_URL` | tooling | — | Owner role (`doctayo_owner`). Read by `prisma.config.ts`, CI and test setup — **not** by the app. Do not give it to the running API in production. |
| `CORS_ALLOWED_ORIGINS` | production | empty | Comma-separated exact origins (`https://app.example.com`). No wildcard, path or trailing slash. Empty = no cross-origin access. |
| `CORS_ALLOW_CREDENTIALS` | no | `false` | **Must be `true`** for the httpOnly refresh cookie (the frontend is on another origin of the same site). Compose defaults it to `true`. |
| `LOG_LEVEL` | no | `debug` dev, `log` prod, `error` test | `error` \| `warn` \| `log` \| `debug` \| `verbose` |
| `LOG_FORMAT` | no | `pretty` dev, `json` prod | |
| `SWAGGER_ENABLED` | no | `true` outside production, `false` in production | |
| `OBSERVE_ENABLED` | no | `true` in production, else `false` | |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | if Observe enabled | — | Secrets. Written by `npx @nestjs/observe link`. |
| `JWT_ACCESS_SECRET` | **yes** | — | At least 32 characters (`openssl rand -base64 48`). Required in **every** environment, including tests. Secret: never committed. |
| `JWT_ACCESS_TTL` | no | `15m` | `5m`–`60m`. Formats: `30s`, `15m`, `2h`, `14d`. |
| `SESSION_IDLE_TTL` | no | `14d` | |
| `SESSION_ABSOLUTE_TTL` | no | `30d` | Not shorter than `SESSION_IDLE_TTL`. |
| `APP_PUBLIC_URL` | production | `http://localhost:5173` | Frontend base URL used in emailed links (no trailing slash). |
| `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | no | `19456`, `2`, `1` | Argon2id cost. Production refuses lower values; tests lower them for speed. |
| `MAIL_TRANSPORT` | no | `log` (`memory` when `NODE_ENV=test`) | `log` \| `file` \| `memory` \| `smtp`. **Production requires `smtp`.** `log` writes emailed links to the log: development only. |
| `SMTP_URL` | when `smtp` | — | e.g. `smtps://user:password@smtp.example.com:465`. Secret. |
| `MAIL_FROM` | production | `DocTayo <no-reply@doctayo.local>` | Sender, e.g. `DocTayo <no-reply@example.com>`. |
| `OUTBOX_RELAY` | no | `on` | `off` = this process does not deliver queued email (tests use `off` and drive delivery). |

One-off tooling variable: `DB_ADMIN_URL` (admin connection used only by `npm run db:bootstrap`; never stored in `.env`).
