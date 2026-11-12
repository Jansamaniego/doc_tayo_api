-- Idempotent database bootstrap. Run as a PostgreSQL superuser (or an admin
-- role allowed to create roles and databases), never by the application:
--
--   psql -v ON_ERROR_STOP=1 -v owner_password=... -v app_password=... \
--        -f scripts/db/bootstrap.sql
--
-- Creates:
--   doctayo_owner  owns the databases/schema; runs Prisma migrations.
--   doctayo_app    runtime role: DML only, no DDL, no superuser, no BYPASSRLS.
--   doc_tayo, doc_tayo_test

-- Roles (created if missing; attributes and passwords always re-applied).
SELECT format('CREATE ROLE doctayo_owner LOGIN') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'doctayo_owner') \gexec
SELECT format('CREATE ROLE doctayo_app LOGIN') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'doctayo_app') \gexec

-- CREATEDB lets `prisma migrate dev` create its shadow database. Production
-- applies migrations with `migrate deploy`, which does not need it.
SELECT format('ALTER ROLE doctayo_owner NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'owner_password') \gexec
SELECT format('ALTER ROLE doctayo_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'app_password') \gexec

-- Databases.
SELECT 'CREATE DATABASE doc_tayo OWNER doctayo_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'doc_tayo') \gexec
SELECT 'CREATE DATABASE doc_tayo_test OWNER doctayo_owner' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'doc_tayo_test') \gexec

-- A database that already existed (e.g. created by hand) is handed to the owner role.
ALTER DATABASE doc_tayo OWNER TO doctayo_owner;
ALTER DATABASE doc_tayo_test OWNER TO doctayo_owner;

\connect doc_tayo
\ir grants.sql

\connect doc_tayo_test
\ir grants.sql
