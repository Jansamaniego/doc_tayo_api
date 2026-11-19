# ADR-0011: Own authentication on `@nestjs/jwt` and `argon2`; `@nestjs/authentication` not adopted

Status: accepted (Phase 3)

## Decision

Authentication is built on the existing `Authenticator` seam with `@nestjs/jwt` (access tokens) and `argon2` (Argon2id passwords), plus our own session, refresh-rotation, recovery and invitation services in `src/modules/auth`. The first-party `@nestjs/authentication` (0.1.x) was evaluated and not adopted.

## Why

- It registers its own global guard and its own `@Public()`, which would duplicate ours and bypass the `AuthGuard` → `TenantGuard` → `PermissionsGuard` chain and the route-category test.
- It hashes with scrypt; the master plan specifies Argon2id (OWASP baseline).
- Its sessions are cookie-first and it needs six store interfaces implemented; the parts we need (rotation, reuse detection, revocation) are small and fully tested here.
- It is 0.x. Revisit at 1.0, especially for MFA and OIDC.

## Consequences

- The access token carries only `sub`, `sid`, `typ`, `iat`, `exp`, `iss`, `aud`. Roles, permissions and the active tenant are read from the database on every request (plans/02 D5), so there is no stale copy to expire.
- `JwtAuthenticator` always re-checks the session; a valid signature alone never authenticates.
- `argon2` is a native module. Its prebuilt binary loads in the Debian-slim runtime image (verified); its install script is disabled in `allowScripts` because the prebuild is used.
