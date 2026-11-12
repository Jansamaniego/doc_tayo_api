# Environment variables

All configuration is read in `src/config` (`env.validation.ts`), validated at startup, and exposed as typed namespaces (`app`, `database`, `cors`, `logging`, `swagger`, `observe`). **Invalid or missing required variables stop the app from starting**; the error names the variables, never their values.

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
| `CORS_ALLOW_CREDENTIALS` | no | `false` | Enable only if httpOnly cookies are adopted (Phase 3). |
| `LOG_LEVEL` | no | `debug` dev, `log` prod, `error` test | `error` \| `warn` \| `log` \| `debug` \| `verbose` |
| `LOG_FORMAT` | no | `pretty` dev, `json` prod | |
| `SWAGGER_ENABLED` | no | `true` outside production, `false` in production | |
| `OBSERVE_ENABLED` | no | `true` in production, else `false` | |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | if Observe enabled | — | Secrets. Written by `npx @nestjs/observe link`. |

One-off tooling variable: `DB_ADMIN_URL` (admin connection used only by `npm run db:bootstrap`; never stored in `.env`).
