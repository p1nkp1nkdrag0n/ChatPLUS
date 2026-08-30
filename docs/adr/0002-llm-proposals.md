# ADR 0002: LLMs propose, application code commits

## Status

Accepted.

## Decision

All model output is parsed and validated with Zod. Models may propose replies, fuzzy-life changes, support interventions, decisions, memories and bounded state/relationship deltas, but never write the database or choose server-owned identifiers. Domain validation, cited evidence and a short SQLite transaction perform the commit.

## Consequence

A response that claims a decision or life change is persisted only when the matching proposal and phase transition pass validation. One repair attempt is allowed; otherwise the server writes a truthful deterministic fallback. In particular, a reply cannot turn discussion into a decision or a decision into an action/outcome without source evidence.
