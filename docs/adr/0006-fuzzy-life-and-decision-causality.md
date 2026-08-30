# ADR 0006: Fuzzy life context and evidence-backed decision causality

## Status

Accepted. This decision supersedes rolling 72-hour schedules and exact schedule negotiation as the product model. Legacy tables and services may remain temporarily for migration and historical evidence.

## Context

The original design represented independent character life as exact UTC `ScheduleItem` intervals. Long-run evaluation showed that this precision was mostly invented rather than observed: ordinary sleep, meals and creative work created overlap failures, excessive activity events, low-value memories and large prompt segments. Autonomous plans could also block user interactions even though local user research found precise calendar coordination with a character to be rare.

The product promise is not that a character owns a convincing task calendar. Its useful consequence is that two people can lower each other's pressure, think through meaningful choices, affect what is decided, and remember the result as part of a continuing relationship.

This repository is a local functional-validation Demo. Conversations use synthetic test users and no model output is delivered to a real person or executed in the world. Public-release policies are therefore not product requirements for this phase.

## Decision

### Fuzzy life is the primary time model

Each character/local date has one idempotent `DailyLifeContext` describing a few coarse intentions, current availability and ongoing life threads. Values such as “this afternoon”, “today” and “recently” are valid story time. Ordinary life does not require exact start/end timestamps and the web product does not display a future character calendar.

Exact UTC remains mandatory for infrastructure ordering, persistence, idempotency, audit events, quiet-hour delivery and FakeClock advancement. It does not imply exact story-time precision.

### Consequence means psychological and biographical change

The principal causal chain is:

```text
dilemma
→ support intervention
→ decision
→ action
→ outcome
→ reflection
→ memory / relationship / life-thread change
```

Both the character and test user can own a dilemma. Either can listen, challenge, recommend, disagree or influence the other. A relationship milestone comes from meaningful support, disagreement, repair and shared consequences rather than from a routine schedule mutation.

### Four support modes are first-class

- `listen_only`: primarily listen, reflect and ask focused questions;
- `deliberate`: compare options, values, uncertainty and trade-offs;
- `recommend`: name a preferred direction and explain why;
- `delegated_decision`: after explicit synthetic-user delegation, select one option on that user's behalf.

The product does not include a general ban or refusal template for major career, relocation or relationship choices. It does not require the character to return “final autonomy” to the test user after an explicit delegation. It also removes public-product crisis-response, emotional-dependency and permission-ceiling matrices from the current prompt and acceptance gates.

### Experimental correctness boundaries remain

The removed product policies must not be confused with evidence integrity. The application still enforces:

1. A discussion is not a decision.
2. A recommendation is not proof that the recommendation was accepted.
3. A decision is not proof that anyone acted.
4. An action is not proof of success or any later outcome.
5. A delegated decision cites the message that explicitly delegated it.
6. An action or outcome cites scenario, message or deterministic progression evidence.
7. Retry, replay, restart and clock rollback cannot duplicate a durable transition.
8. Choice branches created from one snapshot remain isolated.
9. No model proposal directly executes an external tool or real-world action.

These are simulation truth and causal-audit rules, not safety boundaries for human deployment.

## Consequences

### Positive

- Character life sounds natural instead of like a generated timetable.
- Prompt budget shifts from routine schedule JSON to relevant pressure, choice, history and evidence.
- Routine activity no longer floods event and memory stores.
- “Interaction has consequences” can be tested through divergent choices and later outcomes.
- The model can be compared on listening, deliberation, direct recommendation and delegated choice.

### Trade-offs

- The system cannot answer exact “what are you doing at 14:05?” questions unless explicit evidence exists; it should answer at day-period precision.
- Offline progression needs scenario or domain evidence for meaningful outcomes instead of assuming completion when an interval ends.
- Historical schedule projections need a read-only compatibility period and cannot be silently converted into occurred facts.

## Migration

1. Stop presenting schedule rails, future-72-hour lists and exact current activities in the web application.
2. Stop injecting authoritative future-schedule JSON into chat prompts; inject today/recently/life-thread/decision evidence instead.
3. Generate at most one fuzzy daily context per character/local date.
4. Preserve historical terminal activity events as immutable history, but do not generate new ordinary `ScheduleItem` records.
5. Replace schedule-based proactive triggers with meaningful settled outcomes, reflections and life-thread milestones.
6. Retire schedule negotiation as a product gate; keep its ADR and old evidence marked as superseded.
7. Replace long-run invitation branches with decision-before/after branches and verify causal isolation.

## Non-goals

- Public deployment, real-user counseling or crisis handling.
- Background execution while the application is closed.
- Sending messages, calendar changes, purchases or other external actions.
- Claiming that a synthetic reduction in `stress` is a clinical measurement.
