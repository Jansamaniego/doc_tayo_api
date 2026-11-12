# ADR-0007: Docker image and compose

Status: accepted

Multi-stage Dockerfile with `runtime` (non-root, healthcheck, prod deps only) and `migrate` (Prisma CLI, owner role) targets. Images hold no configuration or secrets. Local development uses the developer's own PostgreSQL on 5432 (the compose `api` service uses host networking because that server listens on 127.0.0.1 only); an optional `isolated` profile provides a throwaway Postgres on host port 5434. The Prisma CLI and TypeScript are deleted from the production `node_modules` because the lockfile keeps them as optional peers of `@prisma/client`.
