# Docker in this project

Two levels: first the simple picture, then the developer details. Files: [`Dockerfile`](../Dockerfile), [`docker-compose.yml`](../docker-compose.yml), [`.dockerignore`](../.dockerignore).

---

## Level 1 — Like you're five

You bake a perfect cake at home. A friend tries your recipe and it fails: different oven, a missing ingredient.

**Docker is a lunchbox for programs.** We pack the API and everything it needs (the right Node, the libraries, the settings) into one sealed box. Open the box on any computer and it works the same.

- The **Dockerfile** is the recipe card for packing the box.
- The packed box is an **image**.
- An opened, running box is a **container**.
- **docker-compose** is a sheet that says "open these boxes together and let them talk".

Why here? So the app runs the same on your laptop, on GitHub, and later on a real server, and so a new teammate does not need to install and fiddle with anything.

---

## Level 2 — As a developer

| Term | Meaning |
|---|---|
| Image | Read-only, layered filesystem + metadata (command, env, ports). Built from a Dockerfile; each instruction is a cached layer. |
| Container | A running image: an isolated Linux process (namespaces + cgroups), not a VM. Starts in ~1s, shares the host kernel. Its filesystem is thrown away when it is removed. |
| Volume | Storage that outlives containers (database files). |
| Port mapping | `host:container`, e.g. `5434:5432`. Host port 5434 forwards to 5432 inside the container. |
| Compose | One file describing several containers, networks and volumes. Containers can reach each other by **service name** (`postgres`). |
| Profile | A compose switch: services with `profiles:` start only when asked (`migrate` uses one so `up` never runs it). |

### What the Dockerfile does (5 stages)

```
deps ──► build ──► (dist/)  ─────────────┐
  │                                       ▼
  └──► migrate          prod-deps ──► runtime  (what you deploy)
```

1. **deps** — `npm ci` of everything. `package*.json` are copied *before* the source so this slow step is cached until dependencies change.
2. **build** — `prisma generate` + compile TypeScript into `dist/`.
3. **prod-deps** — production-only `node_modules`, with the Prisma CLI and TypeScript removed (npm keeps them as optional peers of `@prisma/client`; the running app never needs them).
4. **migrate** — has the Prisma CLI; runs `prisma migrate deploy` once and exits. Uses the *owner* role (`DATABASE_MIGRATION_URL`).
5. **runtime** — slim Node, compiled code + prod deps only, runs as the non-root `node` user, has a `HEALTHCHECK` hitting `/api/health`. The final image contains no source, no tests, no secrets (`.dockerignore` keeps `.env*` out).

Why multi-stage? Compilers and dev tools never ship, so the image is smaller and has less attack surface. Why separate migrate? The API should not carry (or be able to use) the owner credentials.

### Config at runtime
Images contain **no configuration**. Everything comes from environment variables (see [environment.md](environment.md)) — the same image runs in dev, CI and production. Never `COPY .env` into an image.

### Local architecture

```
 your machine
 ├─ browser / curl ─► localhost:3000 ─┐
 ├─ DBeaver ────────► localhost:5434 ─┼──┐
 │                                    │  │
 │  ┌──────── Compose network ────────┼──┼───────┐
 │  │   api  ──── postgres:5432 ─────►│  ▼       │
 │  │ (NestJS)                    postgres (17)  │
 │  │   migrate (one-off) ───────►    │          │
 │  └────────────────────────────────────────────┘
 │                                  volume: pgdata
```

What **Docker Compose** does: reads `docker-compose.yml` and builds, wires and starts several containers, one network and one volume with a single command.

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 17. On the first start with an empty volume it runs `scripts/docker/postgres-init.sh`, which creates the `doctayo_owner` and `doctayo_app` roles and the databases (`scripts/db/bootstrap.sql`). |
| `api` | The `runtime` image. Connects as `doctayo_app` (DML only). Starts only after `postgres` is healthy. |
| `migrate` | The `migrate` image. Runs `prisma migrate deploy` as `doctayo_owner`, then exits. Never starts automatically. |

**Networking.** Compose creates a private network and gives each service a DNS name equal to its service name. Inside the `api` container, `localhost` means *that container itself*, so `localhost:5432` would find nothing. The API therefore uses `postgres:5432`. Port `5432` there is Postgres's port *inside its container*.

**Host access.** `127.0.0.1:5434:5432` publishes the container's 5432 on your machine's port 5434 (loopback only). Use it from DBeaver: host `localhost`, port `5434`, db `doc_tayo`, user `doctayo_app`. Port 5434 keeps clear of any Postgres already on your host's 5432. The API is published the same way as `127.0.0.1:3000`.

**Volume.** `pgdata` is a named volume holding `/var/lib/postgresql/data`. Containers are disposable; the volume is not removed by `docker compose down`, so the data survives restarts and rebuilds.

**Health checks and dependencies.** `postgres` has a healthcheck (`pg_isready`). `api` and `migrate` use `depends_on: condition: service_healthy`, so they wait until the database answers. The `runtime` image has its own `HEALTHCHECK` on `/api/health`; `docker compose ps` shows it.

### Commands

```bash
docker compose up --build -d          # start postgres + api (builds the image)
docker compose ps                     # service status and health
docker compose logs -f api            # API logs
docker compose logs -f postgres       # database logs
docker compose run --rm migrate       # apply migrations (run after first start and after pulling new ones)
                                       # after ADDING a migration use `docker compose run --rm --build migrate`:
                                       # `run` reuses the existing image, which would not contain the new file
docker compose restart api            # restart without rebuilding
docker compose up --build -d api      # rebuild and restart only the API
docker compose down                   # stop and remove containers; DATABASE DATA IS KEPT
docker compose down -v                # stop AND PERMANENTLY DELETE the database volume
```

First-time setup: `docker compose up --build -d`, then `docker compose run --rm migrate`, then open `http://localhost:3000/api/health/ready`.

**Reset the local database completely** (destroys all local data):
```bash
docker compose down -v
docker compose up --build -d
docker compose run --rm migrate
```
The init script and any `DB_*_PASSWORD` values apply only when the volume is empty, so a password change needs this reset.

Compose substitutes `${VAR:-default}` from your shell or `.env`. The local defaults need no `.env`. The `DATABASE_URL` in your `.env` (host `localhost`) is for running the API outside Docker and is *not* used by Compose.

### Same image, different database (production)

The image contains no configuration. Locally Compose sets `DATABASE_URL=postgresql://doctayo_app:...@postgres:5432/doc_tayo`. On a server, run the same image with an external database instead (values come from the host's secret store, never from a file in Git):

```bash
docker run -d --name doctayo-api -p 3000:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL='postgresql://doctayo_app:<secret>@<rds-endpoint>:5432/doc_tayo' \
  -e DATABASE_SSL=verify-full \
  -e CORS_ALLOWED_ORIGINS=https://app.example.com -e CORS_ALLOW_CREDENTIALS=true \
  -e OBSERVE_APP_KEY=... -e OBSERVE_APP_SECRET=... \
  -e JWT_ACCESS_SECRET=... -e APP_PUBLIC_URL=https://app.example.com \
  -e MAIL_TRANSPORT=smtp -e SMTP_URL=... -e MAIL_FROM='DocTayo <no-reply@example.com>' \
  doc-tayo-api
```
Production requires TLS to the database (`DATABASE_SSL` of `require` or `verify-full`), `CORS_ALLOWED_ORIGINS`, Observe keys, `JWT_ACCESS_SECRET` (at least 32 characters), `APP_PUBLIC_URL`, `MAIL_FROM` and `MAIL_TRANSPORT=smtp` with `SMTP_URL`; set `CORS_ALLOW_CREDENTIALS=true` for the refresh cookie. `verify-full` validates the server certificate against Node's trusted CAs; if the provider uses its own CA (as RDS does), supply its bundle with Node's `NODE_EXTRA_CA_CERTS` environment variable and mount the file into the container. Run migrations as a separate step with the `migrate` image and `DATABASE_MIGRATION_URL` (owner role). The API never gets that URL.

### Adding services later (e.g. Redis)

Nothing Redis-related exists today. When the app needs it, the pattern is the same as for Postgres: add a service to `docker-compose.yml`, add a connection variable to the config validation, and pass it to `api` through `environment:`. The API would reach it by service name locally and by an external endpoint (e.g. a managed service) in production, with no image change.

### Other useful commands
```bash
docker build -t doc-tayo-api .                 # build the runtime image
docker build --target migrate -t doc-tayo-migrate .
docker images                                   # list images
docker ps                                       # running containers
docker logs -f <container>                      # follow logs
docker exec -it <container> sh                  # shell inside a running container
docker system prune                             # clean unused data (careful)
```

### Production notes (Phase 7)
- Production uses `NODE_ENV=production`, which requires TLS to the database (`DATABASE_SSL=require`) and `CORS_ALLOWED_ORIGINS`. Compose sets `NODE_ENV=development` for local runs.
- Run migrations as a separate step before starting new API containers, using the `migrate` image.
- Image size is ~600 MB (Node base + dependencies such as Swagger UI). Further trimming is optional.
