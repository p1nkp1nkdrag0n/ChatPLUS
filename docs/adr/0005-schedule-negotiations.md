# ADR 0005: Schedule agreements are server-owned negotiations

## Status

Accepted for incremental implementation.

## Context

The live chat path currently lets the model return natural language and
optional `scheduleEffects` in one response. A schedule change is therefore
easy to miss when the model accepts an invitation in prose but omits the
effect. Attempts to recover the effect by matching phrases in the assistant
reply make behaviour depend on wording, punctuation and the size of the
recent-message window.

## Decision

Schedule changes are driven by a versioned negotiation and a server-owned
command, never by parsing the assistant reply.

For a schedule-capable turn the model returns a bounded dialogue action:

- `request_details`
- `propose_offer`
- `accept_user_offer`
- `accept_pending_offer`
- `decline_offer`
- `withdraw_offer`
- `none`

An offer contains semantic activity and time terms plus verbatim evidence
from conversation messages. Application code resolves the evidence, converts
time to UTC, applies domain defaults, and stores a canonical offer. Both
`accept_user_offer` and `propose_offer` only create an
`awaiting_confirmation` offer and display its canonical terms. They never
write the schedule in that turn. A later user turn must explicitly affirm the
single active, unexpired offer version in the same session before
`accept_pending_offer` can create a command.

Once an offer is accepted, application code constructs the schedule command,
validates it against the authoritative schedule, and atomically persists the
messages, negotiation transition, schedule changes and audit events. Natural
language is presentation only. Text consistency checks may reject or repair a
misleading reply, but they can never authorize a mutation or supply command
parameters.

The first implementation supports `create` only. Reschedule, cancel and
recurring commitments are added after the create path is stable.

## Rollout and rollback

`SCHEDULE_NEGOTIATION_MODE` has three modes:

- `legacy`: current model-effect path.
- `shadow`: evaluate structured actions and write diagnostics while preserving
  the legacy writer; the new path does not write schedule or negotiation
  state.
- `enforced`: the negotiation path exclusively owns schedule changes.

A turn selects exactly one writer. Legacy effects and server commands are
never applied together. Database migrations are additive, so rollback means
switching the mode to `legacy` or reverting the feature commits; old code
ignores negotiation rows.

## Invariants

1. Equivalent dialogue actions with different reply wording produce the same
   canonical schedule result.
2. Identical reply text cannot change a schedule without an accepted,
   validated command.
3. An offer version is committed at most once.
4. Presenting an offer and accepting it require different user-message
   evidence; no caller can complete both phases in one turn.
5. Withdrawal, rejection, expiry or supersession permanently invalidates the
   old version.
6. Messages, negotiation state, schedule projection and audit events commit
   together or not at all.
