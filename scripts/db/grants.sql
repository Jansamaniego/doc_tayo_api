-- Per-database grants. Included by bootstrap.sql after \connect.
-- :DBNAME is the psql built-in holding the current database name.
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO doctayo_app;

ALTER SCHEMA public OWNER TO doctayo_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO doctayo_app;

-- Tables and sequences created later by migrations (as the owner) become
-- usable by the runtime role without per-migration GRANT boilerplate.
-- Later migrations tighten specific tables (e.g. audit_logs: no UPDATE/DELETE).
ALTER DEFAULT PRIVILEGES FOR ROLE doctayo_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO doctayo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE doctayo_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO doctayo_app;
