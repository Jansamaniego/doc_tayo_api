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
| Profile | A compose switch: services with `profiles:` start only when asked. |

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

### Two ways to run

**Mode 1 — API container + your existing Postgres (localhost:5432)**
```bash
docker compose up --build api          # http://localhost:3000/api/health/ready
docker compose run --rm migrate        # apply migrations
docker compose down
```
The container uses `network_mode: host` (Linux): your Postgres listens on `127.0.0.1` only, which a container on Docker's private bridge network cannot reach. With host networking, `localhost` inside the container *is* your machine.

**Mode 2 — everything in containers (isolated)**
```bash
docker compose --profile isolated up --build -d postgres api-isolated
docker compose --profile isolated run --rm migrate-isolated
docker compose --profile isolated down -v   # -v also deletes the volume
```
Here the API reaches the database by service name (`postgres:5432`), data lives in a volume, and Postgres is published on host port **5434** (connect DBeaver to `localhost:5434`, user `doctayo_app`, db `doc_tayo`). It never touches your 5432.

Override connection strings for mode 1 with `DOCKER_DATABASE_URL` / `DOCKER_DATABASE_MIGRATION_URL` in your shell or `.env`.

### Useful commands
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
