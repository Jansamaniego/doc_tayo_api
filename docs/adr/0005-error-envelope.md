# ADR-0005: One error filter, explicit success envelopes

Status: accepted (Phase 1)

A single `@Catch()` filter maps everything to `{ error: { status, code, message, details?, requestId } }` using only catalog text (the original message is never trusted or returned). Only one custom class exists, `DomainError`. Success responses are shaped by controllers (`{ data }`, `{ data, meta }`); there is no global wrapping interceptor because hidden response rewriting complicates Terminus output and OpenAPI. Nest wraps body-parser failures in HttpExceptions and keeps the original as `cause`, which the mapper inspects.
