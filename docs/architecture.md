# PersonaSim architecture

PersonaSim is a local, event-driven character simulation. The model generates language and bounded proposals; application code owns time, authorization, validation and persistence.

```mermaid
flowchart LR
  A["Minimal form or source text"] --> B["Character compiler"]
  B --> C["Versioned CharacterSpec"]
  C --> D["Conversation router"]
  C --> E["72-hour planner"]
  E --> F["Deterministic settlement"]
  F --> G["State, memory and activity events"]
  G --> D
  D --> U["Turn understanding"]
  U --> H["Server-validated outcome"]
  H --> X["Turn-local context plan"]
  X --> Y["Reply-only generation"]
  Y --> I["Short SQLite transaction"]
  I --> E
  F --> J["Proactive candidate"]
  J --> D
```

## Three independent loops

1. **Compilation:** user fields or text evidence become a draft `CharacterSpec`; a human edits and publishes an immutable version.
2. **Conversation:** the model first proposes evidence-grounded observations. Application services validate and execute them into an authoritative outcome, select turn-local context, and then ask a reply-only model call to express that outcome. The reply never authorizes a mutation.
3. **Simulation:** activation or an aligned top-of-hour tick advances scheduled activities in one batch. The app never replays one model call per missed hour.

## Workspace boundaries

- `packages/contracts`: shared Zod schemas and inferred TypeScript types.
- `packages/kernel`: service registry, event bus, actor queue and trusted plugin lifecycle.
- `packages/features`: pure schedule, settlement, state, memory, relationship, prompt and proactive rules.
- `packages/providers`: system/fake clocks and fixture/OpenAI-compatible LLM implementations.
- `apps/server`: Fastify routes, SQLite migrations/repositories, transactions, scheduling and SSE.
- `apps/web`: React Router application and TanStack Query cache.

## Concurrency and transactions

All mutations for one character run through `ActorQueue.runExclusive(agentId, task)`. Different characters may progress concurrently. Model/network calls are never held inside a SQLite transaction. Once a proposal is available, a short transaction persists every mutually dependent projection and audit event.

For a chat turn this means:

```text
settle if necessary
→ read one consistent context snapshot
→ route and understand the user outside SQLite transaction
→ ground evidence and prepare an authoritative domain outcome
→ select a ContextPlan for this turn
→ generate/guard a reply-only response outside SQLite transaction
→ atomic user message + assistant message + validated schedule/state/memory changes
→ publish SSE invalidation events
```

The split conversation graph is protected by two independent rollout controls:

- `TURN_PIPELINE_MODE=legacy|shadow|enforced` selects the legacy envelope or the understanding → execution → reply graph. Shadow understanding, execution and reply generation are dry-run; the split branch cannot write projections or replace the legacy reply.
- `PERSONA_CONTEXT_MODE=legacy|shadow|enforced` selects full legacy persona injection or deterministic per-turn activation. Unactivated goals, preferences and contradictions are omitted only in enforced context mode.
- Persona context selection applies to whichever turn pipeline is authoritative. Enforced mode fails closed without a server-owned `ContextPlan`; it does not silently fall back to full persona injection.

Both controls keep `legacy` as their checked-in default. LLM calls and prompts remain outside the transaction; final schedule validation, negotiation CAS, idempotent message insertion, state/memory changes and the assistant reply remain one atomic commit.

Each committed assistant message and `conversation.turn_committed` event records bounded `totalChatLatencyMs` measured from entry into the chat service through the final pre-insert commit stage. Per-purpose understanding/reply latency and token estimates remain in the existing LLM-call audit; repair/fallback status remains on assistant metadata.

## Time

- Storage: ISO-8601 UTC instants.
- Presentation and policy: the character's IANA timezone.
- Offline: activation compares the monotonic settlement cursor to current time and performs one batch.
- Open page: the server schedules a fresh timeout to the next natural top of hour for connected characters.
- Clock rollback: the cursor and terminal activity states never move backward.

## SSE delivery

SSE is a notification channel, not the source of truth. Events tell the browser to refetch `messages`, `state`, `schedule` or `timeline`. A reconnect therefore cannot lose committed state.

## Profiles

| Capability                  | lightweight | daily | high_fidelity |
| --------------------------- | ----------- | ----- | ------------- |
| Structured persona and chat | yes         | yes   | yes           |
| 72-hour schedule            | no          | yes   | yes           |
| Offline/hourly settlement   | no          | yes   | yes           |
| Dynamic state and memory    | minimal     | yes   | yes           |
| Proactive dialogue          | no          | no    | yes           |
