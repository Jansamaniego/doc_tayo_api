# ADR-0003: Separate owner and runtime database roles

Status: accepted (Phase 1)

Migrations run as `doctayo_owner`; the API runs as `doctayo_app` (DML only, no DDL, not superuser, `NOBYPASSRLS`). The supplied superuser URL is used only to bootstrap the container. Rationale: least privilege, a compromised API cannot alter the schema, and PostgreSQL row-level security (master plan §3.6) stays possible because table owners and superusers bypass it. Default privileges give the runtime role access to future tables without per-migration grants. The API verifies its own role at startup.
