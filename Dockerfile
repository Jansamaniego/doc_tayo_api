# syntax=docker/dockerfile:1
#
# DocTayo API image. Multi-stage: heavy build tools stay in early stages and
# only the compiled app + production dependencies reach the final image.
#
#   docker build -t doc-tayo-api .                       # runtime image
#   docker build --target migrate -t doc-tayo-migrate .  # one-off migration image
#
# Read docs/docker.md for a guided tour.

ARG NODE_VERSION=24

# ---- 1. deps: install ALL dependencies (needed to compile) ------------------
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
# Copy only the dependency manifests first. Docker caches each step ("layer"),
# so `npm ci` re-runs only when these files change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci

# ---- 2. build: generate the Prisma client and compile TypeScript ------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# `build` = prisma generate && nest build  -> output in /app/dist
RUN npm run build

# ---- 3. prod-deps: only what the running app needs --------------------------
FROM node:${NODE_VERSION}-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm installs the Prisma CLI and TypeScript here anyway: they are *optional
# peers* of @prisma/client, so the lockfile keeps them in the production tree.
# The running app never uses them (only `prisma generate/migrate` do, and those
# run in the build and migrate stages), so delete them to save ~350 MB.
RUN npm ci --omit=dev && npm cache clean --force \
 && cd node_modules \
 && rm -rf prisma typescript effect @electric-sql \
      @prisma/dev @prisma/engines @prisma/studio-core @prisma/fetch-engine \
      @prisma/query-plan-executor @prisma/streams-local @prisma/engines-version \
      @prisma/config @prisma/get-platform

# ---- 4. migrate: run `prisma migrate deploy` once, then exit ----------------
# Needs the Prisma CLI (a dev dependency), so it is built from `deps`.
# Uses DATABASE_MIGRATION_URL (owner role). Never run this image as the API.
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- 5. runtime: the small image that actually serves traffic ---------------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Never run as root inside the container.
USER node
EXPOSE 3000
# "Is the app alive?" Docker marks the container unhealthy if this keeps failing.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main"]
