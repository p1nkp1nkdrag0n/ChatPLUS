# ADR 0001: a small typed microkernel

## Status

Accepted.

## Decision

PersonaSim owns a small service registry, typed event bus, actor queue and trusted in-process plugin contract. Profiles compose capabilities; the MVP does not dynamically load third-party code.

## Why

This keeps feature and provider boundaries replaceable without coupling the product to a developer-preview harness or pretending that the MVP has a safe plugin sandbox.
