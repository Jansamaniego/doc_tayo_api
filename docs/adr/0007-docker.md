# ADR-0007: Docker image and compose

Status: accepted

Multi-stage Dockerfile with `runtime` (non-root, healthcheck, prod deps only) and `migrate` (Prisma CLI, owner role) targets. Images hold no configuration or secrets. Local development runs everything in Compose: `api`, `postgres` (named volume, published on 127.0.0.1:5434) and a one-off `migrate` job, talking over the Compose network (`postgres:5432`). The same `runtime` image is deployed elsewhere by supplying a different `DATABASE_URL` (e.g. RDS). The Prisma CLI and TypeScript are deleted from the production `node_modules` because the lockfile keeps them as optional peers of `@prisma/client`.
