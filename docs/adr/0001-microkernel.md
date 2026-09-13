# ADR 0001: a small typed microkernel

## Status

Historical; superseded for production server composition on 2026-09-13.
The standalone SDK remains available, but the server now uses typed service
factories and a shared cleanup stack as documented in
[the architecture](../ARCHITECTURE.md). The original decision below records
the earlier design.

## Decision

PersonaSim owns a small service registry, typed event bus, actor queue and trusted in-process plugin contract. Profiles compose capabilities; the MVP does not dynamically load third-party code.

## Why

This keeps feature and provider boundaries replaceable without coupling the product to a developer-preview harness or pretending that the MVP has a safe plugin sandbox.
