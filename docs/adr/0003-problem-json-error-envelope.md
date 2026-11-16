# ADR-0003 — RFC 9457 problem envelope

**Status:** accepted · **Date:** 2026-09-14 · **Slice:** 0B

## Decision

Every API failure uses `application/problem+json`, with a stable `ERR_*` code, a remedy, and a request ID. The code registry in `packages/contracts/src/errors.ts` is authoritative for shipped errors. Database driver messages are never returned to clients; known SQLSTATEs and explicit database tokens are mapped, while unknown failures become `ERR_INTERNAL` with only their SQLSTATE retained for structured logging.

## Consequences

Clients can branch on codes rather than English text. Future API routes share one schema and must register each new error code before raising it.
