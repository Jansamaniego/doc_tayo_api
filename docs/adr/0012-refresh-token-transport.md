# ADR-0012: The refresh token travels only in an httpOnly cookie

Status: accepted (Phase 3; resolves master plan Q5)

## Decision

The refresh token is the cookie `dt_refresh`: `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` everywhere except development. It is never in a response or request body or a query string. The access token is returned in the JSON body and kept in memory by the client. `refresh`, `logout` and `logout-all` also require an `Origin` header in `CORS_ALLOWED_ORIGINS`. `CORS_ALLOW_CREDENTIALS` must be `true`.

## Why

- The frontend and API are served from one site (`app.` and `api.` of the same domain), so `SameSite=Strict` cookies work.
- JavaScript cannot read an httpOnly cookie, so an XSS bug cannot steal the long-lived credential.
- The `Origin` check is defence in depth beside `SameSite=Strict` (CSRF on the cookie endpoints).

## Consequences

- If the frontend is ever hosted on a different site, the token must move to the request/response body and be stored by the client; only `AuthController` and `AuthCookieService` change.
- The client must serialise refresh calls: there is no grace window (plans/02 D10), so two concurrent refreshes with one token count as reuse and end the session.
- Every `/auth/*` and `/me*` response is `Cache-Control: no-store`.
