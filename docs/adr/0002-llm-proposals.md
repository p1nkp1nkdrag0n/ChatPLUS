# ADR 0002: LLMs propose, application code commits

## Status

Accepted.

## Decision

All model output is parsed and validated with Zod. Models may propose replies, schedule effects, memories and state deltas, but never write the database or choose server-owned identifiers. Domain validation and a short SQLite transaction perform the commit.

## Consequence

A response that claims a schedule change is only persisted when the matching proposal passes validation. One repair attempt is allowed; otherwise the server writes a truthful deterministic fallback.
