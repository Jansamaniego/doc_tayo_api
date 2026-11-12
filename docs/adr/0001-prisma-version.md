# ADR-0001: Pin Prisma 7.10.1

Status: accepted (Phase 1)

The scaffold mixed `prisma@8.0.0-rc.33` with `@prisma/client@7.10.1`. On npm, the `latest` tag of `prisma` points at the Prisma 8 release candidate, so an unpinned install silently brings it back. Prisma 8 has no stable client or adapter.

Decision: `prisma`, `@prisma/client` and `@prisma/adapter-pg` pinned to exactly `7.10.1`. Config uses the Prisma 7 `defineConfig` shape. Revisit when Prisma 8 is GA with matching packages. Do not run `npm i prisma@latest` (the CLI's update notice suggests it).
