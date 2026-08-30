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
- `DailyLifeContext`: one idempotent fuzzy context per character/local date, containing a short theme, coarse day period, a few intentions and availability. It has no required exact activity intervals.
- `LifeThread`: a durable work, creative, relationship, relocation or personal-growth thread with current phase, pressure, progress summary and next uncertainty.
- `LifePulse`: the character's current fuzzy focus and availability, with `observed` or `inferred` confidence.
- `Memory`: bounded fact/episode with confidence, importance, provenance and optional expiry.
- `ProactiveCandidate`: bounded, expiring opportunity linked to a settled meaningful outcome, reflection or life-thread milestone.

Routine intentions such as eating, sleeping or commuting are background context. They do not automatically become long-term memories or one event per clock interval.

## Choice and consequence records

- `DilemmaEpisode`: the subject, options, value conflict, owner and current phase of one choice.
- `SupportIntervention`: one response classified as `listen_only`, `deliberate`, `recommend` or `delegated_decision`, with source-message evidence.
- `DecisionRecord`: selected option, decision authority (`subject`, `shared` or `delegated`), deciding actor (`user`, `character` or `joint`), reason summary and authorization evidence.
- `ActionRecord`: explicit evidence that the owner acted, deferred or did not act. A decision alone cannot create it.
- `OutcomeRecord`: an observed or scenario-injected positive, negative or mixed consequence of an action.
- `ReflectionRecord`: how the character or test user later interprets the decision and result.
- `PressureEpisode`: pressure, clarity and feeling-understood observations across the episode; a warm reply does not mechanically prove improvement.
- `RelationshipMilestone`: a meaningful support, disagreement, repair or shared turning point backed by episode evidence.

The required order is:

```text
DilemmaEpisode
→ SupportIntervention*
→ DecisionRecord?
→ ActionRecord?
→ OutcomeRecord?
→ ReflectionRecord*
```

Later records may be absent. They may not be inferred merely because enough UTC time elapsed.

## Temporal and evidence fields

Durable life and choice facts use both system time and effective story time:

- `recordedAtUtc`: exact infrastructure commit time;
- `effectiveLocalDate`: the character-local date on which a fact applies;
- `effectivePeriod`: optional `morning`, `afternoon`, `evening`, `late_night` or `anytime`;
- `temporalPrecision`: `day` or `period`; exact instants remain audit metadata rather than ordinary story-time claims;
- `sourceMessageIds` / `causationId`: evidence used to authorize the transition;
- `idempotencyKey`: stable retry/restart identity.

An exact `recordedAtUtc` must never be presented as proof that a fuzzy life event happened at that exact instant.

## LLM contracts

Supported product purposes center on:

```text
compile_character
import_character
chat_turn
repair_chat_turn
plan_daily_life
advance_life_thread
compose_proactive_message
```

`AgentTurnDecision` includes a reply plus optional bounded state, relationship, memory, life-thread, support and decision proposals. No output contract accepts database IDs, audit fields or hidden reasoning. Application code resolves message evidence, generates identifiers, validates phase order and commits the accepted projection.

The response policy does not impose a general refusal on career, relocation or relationship choices. In `delegated_decision` mode, a valid explicit user authorization allows the character to select one option. That record still cannot claim the test user acted or that an outcome occurred.

Legacy schedule-purpose and `ScheduleItem` contracts may remain temporarily readable for database/history compatibility, but they do not define the current product surface and new ordinary life facts must not be written through them.

## API transport contracts

`packages/contracts/src/api.ts` defines the shared success-response schemas for health, character lists and publication, agent activation, sessions and messages, timeline and memory projections, settings, and SSE event variants. The web product exposes fuzzy life summaries and causal history, not a character schedule rail or future-72-hours calendar.

The server contract integration test sends requests through a real Fastify instance with `inject`, then parses serialized JSON responses with these shared schemas. It also subscribes to the production SSE hub and parses events emitted by the real conversation and life-progression services. This is an integration regression check for covered routes and event variants; it does not imply that every response is reparsed at runtime before Fastify sends it.

## Database JSON policy

Relational columns carry IDs, uniqueness, exact infrastructure time, phase and lookup fields. Structured persona, fuzzy-life and state details may remain JSON where relational queries are not required. Domain services validate model proposals before persistence. Immutable domain events keep the causal chain replayable even when a read projection changes.
