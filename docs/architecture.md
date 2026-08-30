# PersonaSim architecture

PersonaSim is a local, event-driven long-term companion simulation. The model generates language and bounded proposals; application code owns evidence, ordering, validation and persistence. Character life is represented as fuzzy daily context and durable life threads, not as a minute-by-minute calendar.

```mermaid
flowchart LR
  A["Minimal form or source text"] --> B["Character compiler"]
  B --> C["Versioned CharacterSpec"]
  C --> D["Conversation engine"]
  C --> E["Daily fuzzy-life context"]
  E --> F["Life threads and dilemmas"]
  F --> D
  D --> G["Support and decision proposals"]
  G --> H["Evidence and domain validation"]
  H --> I["Short SQLite transaction"]
  I --> J["Decision / state / relationship projections"]
  J --> D
  J --> K["Action, outcome and reflection progression"]
  K --> L["Memory and proactive candidate"]
  L --> D
```

## Three independent loops

1. **Compilation:** user fields or text evidence become a draft `CharacterSpec`; a human edits and publishes an immutable version.
2. **Conversation:** recent messages plus bounded persona, state, relationship, fuzzy-life and evidence context become a reply and mutation proposal. Zod and domain rules validate it before an atomic commit.
3. **Life progression:** activation advances local dates and open life threads in one batch. It may settle an explicitly supplied action or outcome, but it never fabricates one model call per missed hour or invents an outcome merely because time passed.

## Product time model

The character has three kinds of temporal information:

- **today:** a small set of fuzzy intentions grouped by `morning`, `afternoon`, `evening` or `anytime`;
- **recently:** actual outcomes and progress on ongoing work, creative, relationship or relocation threads;
- **now:** a low-precision `LifePulse` such as free, interruptible or occupied, with an observed/inferred confidence marker.

There is no user-facing character calendar and ordinary life does not claim exact start or end instants. Exact UTC is still infrastructure truth for message order, idempotency, audit records, quiet hours and FakeClock advancement. A life fact separately records its effective local date/period and temporal precision so that database write time cannot masquerade as event time.

## Decision causality

The primary consequence path is:

```text
dilemma raised
→ listen / deliberate / recommend / delegated decision
→ pressure and clarity may change
→ decision recorded
→ action observed or explicitly injected
→ outcome observed or explicitly injected
→ reflection, memory, relationship and life-thread change
```

Each arrow requires evidence. Discussion is not a decision, a decision is not an action, and an action is not a successful result. The four support modes are behavioral choices, not permission ceilings: an explicit test-user delegation permits the character to select one option even for career, relocation or relationship choices.

## Workspace boundaries

- `packages/contracts`: shared Zod schemas and inferred TypeScript types.
- `packages/kernel`: service registry, event bus, actor queue and trusted plugin lifecycle.
- `packages/features`: pure state, memory, relationship, fuzzy-life, decision, outcome, prompt and proactive rules.
- `packages/providers`: system/fake clocks and fixture/OpenAI-compatible LLM implementations.
- `apps/server`: Fastify routes, SQLite migrations/repositories, transactions, life progression and SSE.
- `apps/web`: React Router application and TanStack Query cache; no schedule rail or future-72-hours surface.

## Concurrency and transactions

All mutations for one character run through `ActorQueue.runExclusive(agentId, task)`. Different characters may progress concurrently. Model/network calls are never held inside a SQLite transaction. Once a proposal is available, a short transaction persists every mutually dependent projection and audit event.

For a chat turn this means:

```text
advance local life context if necessary
→ read one consistent context snapshot
→ call LLM outside SQLite transaction
→ validate/repair proposal and cited evidence
→ atomic user message + assistant message + state/relationship/life/decision changes
→ publish SSE invalidation events
```

For later consequences this means:

```text
read the open decision and its source evidence
→ receive an explicit action/outcome scenario fact
→ enforce phase order and idempotency key
→ atomic outcome + reflection eligibility + thread progress
```

## Offline progression

- Activation compares the monotonic life cursor to current time and advances completed local dates once.
- The current day advances only through elapsed coarse periods; no offline `started` event is fabricated.
- Reopen, retry and restart use stable idempotency keys and cannot duplicate a decision or outcome.
- Clock rollback never moves a cursor or durable fact backward.
- No offline step executes an external tool or reality-facing action.

## SSE delivery

SSE is a notification channel, not the source of truth. Events tell the browser to refetch `messages`, `state`, `relationship`, `life-context` or `timeline`. A reconnect therefore cannot lose committed state.

## Profiles

| Capability                                  | lightweight | daily | high_fidelity |
| ------------------------------------------- | ----------- | ----- | ------------- |
| Structured persona and chat                 | yes         | yes   | yes           |
| Fuzzy today/recently context                | no          | yes   | yes           |
| Life threads and coarse offline progression | no          | yes   | yes           |
| Dynamic state and memory                    | minimal     | yes   | yes           |
| Dilemma/decision/outcome causality          | no          | yes   | yes           |
| Proactive reflection                        | no          | no    | yes           |

The previous rolling 72-hour planner, exact schedule negotiation and schedule rail are historical implementation paths and no longer define the product contract. See [ADR 0006](adr/0006-fuzzy-life-and-decision-causality.md).
