# Trusted plugin SDK

The MVP exposes an in-process composition contract inspired by service-oriented harnesses. It is intentionally not a third-party plugin system.

## Manifest

Each plugin declares:

- a unique `id`;
- `apiVersion: '1'`;
- service keys it `requires`;
- service keys it `provides`;
- an `activate(context)` function that may return a disposer.

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
high-fidelity = daily + proactive reflection + persona guard
```

## Explicit non-goals

The MVP does not scan directories, hot-load arbitrary modules, expose a marketplace, sandbox permissions or execute third-party tools. Those require a separate security design.
