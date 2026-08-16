# Domain schema guide

The executable schema definitions live in `packages/contracts/src`. They provide shared Zod contracts and inferred TypeScript types for domain data, LLM proposals, HTTP transport payloads and server-sent events.

## Character data

- `CharacterSpecDraft`: editable, has provenance and locked paths, but no model-owned database identifiers.
- `CharacterSpec`: server-owned ID, version, status and timestamps plus the complete persona.
- Published versions are immutable. Restoring a version creates a new draft.

Core persona rules include an origin (`user_spec`, `canon_extract`, `model_inference`, `synthetic_extension` or `runtime_simulation`) and source references. Imported text is reduced to structured fields and short excerpts; the complete source is not injected into runtime chat prompts.

## Runtime projections

- `RuntimeState`: mood valence `[-1,1]`; energy, stress, arousal, social battery and focus `[0,1]`.
- `RelationshipState`: closeness, trust, familiarity and recent interaction valence.
- `ScheduleItem`: UTC interval, rigidity, status, origin, adherence probability, narrative importance and deterministic state effects.
- `Memory`: bounded fact/episode with confidence, importance, provenance and optional expiry.
- `ActivityEvent`: immutable result of settling a schedule item, with a unique idempotency key.
- `ProactiveCandidate`: bounded, expiring opportunity to send a message linked to an activity event.

## LLM contracts

Supported purposes are:

```text
compile_character
import_character
plan_schedule
chat_turn
repair_chat_turn
enrich_activity
compose_proactive_message
```

`AgentTurnDecision` includes a reply plus optional bounded proposals. `ScheduleEffectProposal` is a strict discriminated union:

- `create` has a new item draft;
- `reschedule` has an existing item ID and new interval;
- `cancel` has an existing item ID.

No output contract accepts database IDs, audit fields or hidden reasoning. `reasonSummary` is a short behavior explanation capped at 240 characters.

## API transport contracts

`packages/contracts/src/api.ts` defines the shared success-response schemas for health, character lists and publication, agent activation, sessions and messages, timeline and memory projections, settings, and the five current SSE event variants.

The server contract integration test sends requests through a real Fastify instance with `inject`, then parses the serialized JSON responses with these shared schemas. It also subscribes to the production SSE hub and parses events emitted by the real conversation and settlement services. This is an integration regression check for the covered routes and event variants; it does not imply that every response is reparsed at runtime before Fastify sends it.

Transport optionality follows serialized JSON rather than in-memory object shape. Undefined message links, cursor buckets, current activities, settlement results and proactive messages are omitted. Nullable relational projections such as memory source IDs and domain-event correlation or causation IDs remain explicit `null` values.

## Database JSON policy

Relational columns carry IDs, uniqueness, time and lookup fields; structured persona/state details remain JSON where relational queries are not required. Domain services validate model proposals before persistence, while individual store read/write paths use the relevant shared schema where implemented. The API integration regression described above independently checks the serialized transport shape of its covered endpoints.
