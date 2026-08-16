# ADR 0003: UTC persistence, IANA presentation and SQLite projections

## Status

Accepted.

## Decision

Instants are stored as ISO UTC strings and displayed in each character's IANA timezone. SQLite projection tables are the read model and `domain_events` is an append-only audit stream, not full event sourcing. WAL, foreign keys and a busy timeout are enabled.

Simulation mutations are serialized per character with an actor queue. Network calls happen outside SQLite transactions; validated results are committed in short atomic transactions.
