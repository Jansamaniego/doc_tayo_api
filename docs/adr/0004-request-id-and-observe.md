# ADR-0004: Request ids are server-validated UUIDs

Status: accepted (Phase 1)

Inbound `X-Request-Id` is honored only if it is a canonical UUID; otherwise a UUID is generated. Observe's default trace id is the raw header, so a custom `traceIdGenerator` returns the sanitized id. The middleware is raw Express registered before the body parsers so parse errors also carry an id. UUID (not ULID) because Observe already uses UUIDs and Node provides them without a dependency.
