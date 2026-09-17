# Trusted plugin SDK

Historical reference, retained for the standalone kernel SDK. Since 2026-09-13,
production server composition uses typed service factories and one cleanup
stack; it no longer registers or activates these plugins. See
[the current architecture](ARCHITECTURE.md). This contract was an in-process
composition mechanism, not a third-party plugin system.

## Manifest

Each plugin declares:

- a unique `id`;
- `apiVersion: 1`;
- plugin IDs it `requires`;
- service keys it `provides`;
- a `setup(context)` function that may return a disposer.

The runtime validates API versions, rejects duplicate IDs and service keys, topologically sorts requirements, activates in dependency order and disposes in reverse order. If activation fails, already-active plugins are cleaned up before the error escapes.

## Context

The context offers:

- a typed service registry;
- an in-memory typed event bus;
- a logger that must redact credentials;
- lifecycle cleanup registration.

Persistent facts such as `message.created`, `decision.recorded` or `life.outcome_recorded` are separately recorded in SQLite `domain_events`. The in-memory bus is for runtime coordination and SSE notification.

## Bundle composition

Profiles compose trusted code at bootstrap:

```text
core
├── character store/compiler
├── conversation and LLM provider
└── audit/cost meter

daily = core + fuzzy life + decision causality + state + memory + relationship
high-fidelity = daily + persona guard + proactive contact (shadow by default)
```

## Explicit non-goals

The MVP does not scan directories, hot-load arbitrary modules, expose a marketplace, sandbox permissions or execute third-party tools. Those require a separate security design.
