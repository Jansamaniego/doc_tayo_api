# API Error Codes

Every non-2xx response uses one shape:

```json
{
  "error": {
    "status": 400,
    "code": "VALIDATION_FAILED",
    "message": "Some fields need attention.",
    "details": [
      { "field": "email", "code": "INVALID_FORMAT", "message": "This value is not in the expected format." }
    ],
    "requestId": "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
  }
}
```

- `code` is stable and machine-readable. Clients should branch on `code`, never on `message`.
- `message` is plain-language fallback text; the frontend may replace it using `code`.
- `details` appears only for validation errors. `field` is a dotted path (`address.city`, `items[0].id`).
- `requestId` equals the `X-Request-Id` response header; quote it when reporting a problem.
- Codes are **append-only**. Renaming or repurposing a code is a breaking change.
- Responses never contain stack traces, SQL, Prisma details, hostnames or credentials.
- Source of truth: `src/common/errors/error-codes.ts` (a unit test keeps this file in sync).

## Error codes

| Code | HTTP | Default message |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Some fields need attention. |
| `BAD_REQUEST` | 400 | The request could not be understood. |
| `MALFORMED_JSON` | 400 | The request body is not valid JSON. |
| `PAYLOAD_TOO_LARGE` | 413 | The request is too large. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request content type is not supported. |
| `ROUTE_NOT_FOUND` | 404 | The requested address does not exist. |
| `NOT_FOUND` | 404 | We could not find what you were looking for. |
| `CONFLICT_UNIQUE` | 409 | This record already exists. |
| `CONFLICT_REFERENCE` | 409 | This record is linked to other information and cannot be changed this way. |
| `NOT_READY` | 503 | The service is not ready yet. Please try again shortly. |
| `SERVICE_UNAVAILABLE` | 503 | The service is temporarily unavailable. Please try again shortly. |
| `INTERNAL_ERROR` | 500 | Something went wrong on our side. Please try again. |

## Reserved codes

Cataloged now so the contract is stable; nothing produces them yet (authentication, authorization and rate limiting arrive in later phases).

| Code | HTTP | Default message |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Please sign in to continue. |
| `FORBIDDEN` | 403 | You do not have permission to do this. |
| `CONFLICT` | 409 | This action conflicts with the current state of the record. |
| `METHOD_NOT_ALLOWED` | 405 | This action is not allowed on this address. |
| `RATE_LIMITED` | 429 | Too many attempts. Please wait a moment and try again. |

## Field-level codes (`details[].code`)

| Code | Message |
|---|---|
| `REQUIRED` | Please fill in this field. |
| `INVALID_FORMAT` | This value is not in the expected format. |
| `INVALID_TYPE` | This value is not the expected type. |
| `INVALID_VALUE` | This value is not allowed. |
| `OUT_OF_RANGE` | This value is outside the allowed range. |
| `TOO_SHORT` | This value is too short. |
| `TOO_LONG` | This value is too long. |
| `UNKNOWN_FIELD` | This field is not accepted. |
