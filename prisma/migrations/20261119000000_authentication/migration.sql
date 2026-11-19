-- CreateEnum
CREATE TYPE "principal_type" AS ENUM ('staff');

-- CreateEnum
CREATE TYPE "session_revoked_reason" AS ENUM ('logout', 'logout_all', 'password_changed', 'password_reset', 'refresh_reuse', 'user_deactivated', 'admin');

-- CreateEnum
CREATE TYPE "user_token_type" AS ENUM ('password_reset', 'account_setup');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(6),
ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_tenant_id" UUID,
    "principal_type" "principal_type" NOT NULL DEFAULT 'staff',
    "user_agent" TEXT,
    "ip" INET,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" "session_revoked_reason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "user_token_type" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by_membership_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions"("absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tokens_token_hash_key" ON "user_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_tokens_user_id_type_idx" ON "user_tokens"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_id_key" ON "invitations"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_tenant_id_fkey" FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "roles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_invited_by_membership_id_fkey" FOREIGN KEY ("tenant_id", "invited_by_membership_id") REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- At most one OPEN invitation (not accepted, not revoked) per email per tenant.
-- Prisma cannot express a partial unique index, so it is raw SQL here.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "invitations_open_email_key"
  ON "invitations" ("tenant_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ---------------------------------------------------------------------------
-- New permission (source of truth: src/modules/access-control/catalog.ts),
-- granted to the existing owner and clinic_admin roles of every tenant.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "key", "description") VALUES
  (gen_random_uuid(), 'members.invite', 'Invite staff to the clinic')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("id", "tenant_id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."tenant_id", r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE p."key" = 'members.invite'
  AND r."key" IN ('owner', 'clinic_admin')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- @nestjs/outbox PostgresOutboxStore schema "nest_outbox" (version 1), from
-- `npx @nestjs/outbox sql` (package version 0.1.4). Applied here so that
-- `prisma migrate deploy` stays the only migration step; the store runs with
-- `migrate: false`. A later package upgrade that needs a newer schema version
-- adds its SQL in a new migration.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "nest_outbox";

CREATE TABLE IF NOT EXISTS "nest_outbox".migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "nest_outbox".messages (
  seq bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  topic text NOT NULL,
  payload jsonb,
  headers jsonb NOT NULL,
  key text,
  created_at bigint NOT NULL,
  available_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  history jsonb NOT NULL DEFAULT '[]',
  lease_owner text,
  lease_until bigint
);

CREATE TABLE "nest_outbox".dead_letters (
  id text PRIMARY KEY,
  seq bigint NOT NULL,
  topic text NOT NULL,
  payload jsonb,
  headers jsonb NOT NULL,
  key text,
  created_at bigint NOT NULL,
  attempts integer NOT NULL,
  last_error text,
  history jsonb NOT NULL,
  reason text NOT NULL,
  failed_at bigint NOT NULL
);

CREATE TABLE "nest_outbox".inbox (
  consumer text NOT NULL,
  message_id text NOT NULL,
  processed_at bigint NOT NULL,
  PRIMARY KEY (consumer, message_id)
);

CREATE INDEX messages_key_seq ON "nest_outbox".messages (key, seq) WHERE key IS NOT NULL;

CREATE INDEX dead_letters_topic_failed_at ON "nest_outbox".dead_letters (topic, failed_at);

CREATE INDEX inbox_processed_at ON "nest_outbox".inbox (processed_at);

INSERT INTO "nest_outbox".migrations (version, name) VALUES (1, 'initial');

-- The runtime role gets DML only (no DDL), including on what later outbox
-- migrations create as the owner role.
GRANT USAGE ON SCHEMA "nest_outbox" TO doctayo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "nest_outbox" TO doctayo_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "nest_outbox" TO doctayo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE doctayo_owner IN SCHEMA "nest_outbox"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO doctayo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE doctayo_owner IN SCHEMA "nest_outbox"
  GRANT USAGE, SELECT ON SEQUENCES TO doctayo_app;
