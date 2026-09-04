# ADR 0007: Temporal correspondence and sealed reply semantics

## Status

Accepted for phased implementation.

This ADR records the first-version decisions for the current implementation of
the correspondence and keepsake plan. These decisions are deliberately narrow:
Stage 0 adds disabled-by-default configuration and documentation, while later
stages add contracts, persistence, catch-up, generation, encryption, APIs and
UI. A later implementation must not silently reinterpret these decisions; a
material semantic change requires an ADR amendment or a superseding ADR.

## Context

ChatPLUS currently has immediate chat, fuzzy character life, evidence-backed
memory and deterministic FakeClock support. A letter cannot be implemented as
a delayed chat message without losing the product meaning of the medium. It
needs its own immutable seal, transit interval, effective arrival time,
knowledge boundary, historical generation snapshot and explicit opening.

The application is local-first. A stopped local process is not expected to run
background work. On the next start or relevant request it catches up overdue
events in their effective-time order. The same domain services may later run
under a resident local process or a self-hosted worker. Those drivers must not
create different story histories.

The current plan is additive. Real email, physical delivery, multi-tenant SaaS,
parallel correspondence threads, public sharing URLs and desktop packaging are
not part of this first version.

## Decision

### Correspondence has four distinct times

- `effectiveAtUtc` is when a transition counts in story history.
- `processedAtUtc` is when a running process performed catch-up or generation.
- `recordedAtUtc` is when the SQLite transaction committed.
- `openedAtUtc` is when the user first successfully opened a delivered reply.

An event processed late keeps its original effective time. Processing a letter
on September 9 that arrived effectively on September 8 does not make September
9 information available to the reply.

Clock rollback may change a displayed in-transit percentage, but it never
reverses a committed delivery, read, open or completed-task transition. Clock
advance processes all due events in deterministic order before advancing fuzzy
life to the observed current time.

### Fixed transit is calendar-based and the stored due instant is authoritative

`fixed_5d_v1` is the only first-version transit policy. Outbound and return
transit each take five calendar days in the character's IANA time zone. At seal
or reply dispatch, the service converts the UTC start instant into that zone,
adds five calendar days while preserving the local wall-clock time under the
time-zone library's DST rules, converts the result back to UTC, and stores:

- the policy version;
- the character time-zone identifier used for the calculation; and
- the resulting `arrivalDueAtUtc`.

The stored due instant is never recomputed. A later character time-zone change
or a later default-policy change cannot alter an in-transit or historical
letter. Across a DST boundary, five local calendar days may be 119 or 121
elapsed hours. Implementations must not replace calendar arithmetic with
`5 * 24 hours`.

Transit progress is not persisted. It is calculated from authoritative UTC
instants and clamped to the inclusive range zero through one:

```text
progress = clamp(
  (observedNowUtc - dispatchedAtUtc) /
  (arrivalDueAtUtc - dispatchedAtUtc),
  0,
  1
)
```

This is the meaning of `progressBasis=wall_clock`. Calendar dates drive the due
instant; actual elapsed instants drive the percentage. In a non-DST example,
the same local clock time four days into a five-day journey is 80 percent. A
DST-crossing journey does not have to report exactly 80 percent at the fourth
local date. UI day labels use the character's local dates and never persist a
second source of progress truth.

A return due time is computed from the reply's authored effective time, which
is normally the incoming letter's effective arrival time, not from its later
`processedAtUtc` or model-call completion time. A reply generated after its
return due time is therefore delivered in the same catch-up pass.

### Effective-time ordering owns offline catch-up

Due tasks for one character are ordered by `(dueAtUtc, priority, taskId)`.
First-version priorities are:

1. incoming-letter arrival;
2. snapshot freeze and reply generation;
3. return-letter arrival; and
4. keepsake generation.

Character life advances to each task's effective due time before that task is
committed. Only after all eligible due tasks have been processed may life
advance to the observed current time. A life-advance failure leaves the task
pending and prevents the catch-up pass from skipping across the failed event.

The relevant character entry points eventually run the same catch-up service:
activation, chat before context selection, letter seal and open, Developer
FakeClock advance, resident timer and worker tick. An actor queue serializes a
character inside one process; database claims and leases provide cross-process
safety. `CORRESPONDENCE_GENERATION_LEASE_MS` defaults to 1,800,000 milliseconds.

### The arrival snapshot is immutable and excludes future knowledge

Before any reply model call, the incoming letter is delivered effectively and
the character is advanced exactly to its arrival due time. In one serialized
character section the application freezes an immutable snapshot containing:

- the exact published character version;
- runtime state and relationship revision at arrival;
- fuzzy-life context and settled interval outcomes as of arrival;
- memory evidence whose effective and recorded bounds do not exceed arrival;
- conversation messages available by arrival;
- prior correspondence already knowable to the character; and
- the incoming user letter as a separate medium-scoped input.

The snapshot evidence IDs continue to describe only the frozen contextual
evidence and do not absorb the incoming letter ID. At prompt and validation
time the application derives one reply-reference allowlist as
`snapshot.evidenceIds ∪ { snapshot.incomingLetterId }`. This lets the model
cite the letter it is directly answering without mutating the snapshot or its
hash, while every unrelated or future ID still fails closed. Prompt assembly
and post-model validation must use the same derivation so their evidence
contracts cannot drift apart.

Planned activity is not an occurred result. Advice is not a decision, a
decision is not an action, and an action is not an outcome. Snapshot canonical
JSON receives a SHA-256 hash. Every automatic retry and every later manual
generation epoch reuses that exact snapshot and evidence set.

Before incoming arrival, character prompts and memory ingestion cannot access
the user letter body. Once it has arrived and been read, chat may know the
letter and that a reply is being written. Once the reply is in transit, chat
may know that it was sent but cannot expose its body or central surprise. After
delivery but before user opening, the character cannot assume the user read it.
Only explicit later user feedback creates evidence about the user's reaction.

### Letter, generation and task states remain separate

Letter transport state, model-run state and temporal-task state are separate
state machines. They are not combined into one convenience enum:

```text
Letter: draft | sealed | in_transit | delivered_unread | read | cancelled
GenerationRun: pending | generating | retryable | committed | failed | discarded
TemporalTask: pending | claimed | completed | retryable | dead_letter
```

Direction constrains state meaning. An incoming user letter becomes `read` when
the character's arrival snapshot is frozen. A character reply becomes `read`
only through a successful user open. `cancelled` is permitted only for an
unsealed draft in the first version. A sealed letter is immutable and cannot
be cancelled or edited.

For a late catch-up, an incoming letter's `readAtUtc` is the effective arrival
and snapshot time, because that is when the character is considered to have
read it in story history. The later execution instant is recorded separately
as `processedAtUtc`. A reply's `openedAtUtc`, by contrast, is always the user's
actual first successful open time and is never backdated.

### One open thread means one unresolved sequential turn

The first version permits at most one `open` correspondence thread per
character. `CORRESPONDENCE_MAX_OPEN_THREADS` is parsed but is constrained to
the supported value `1`. A database partial unique constraint will ultimately
enforce the same rule.

An open thread may hold multiple sequential exchanges, but only one active
turn. The active turn begins when a user draft is created and remains active
while that draft is sealed or in transit, while the character is reading or
generating, while generation is retryable or failed, and while the reply is in
transit or delivered but unopened. It ends only when the corresponding reply
is successfully opened and reaches `read`, or when an unsealed draft is
cancelled.

Consequently, a user cannot create the next draft while the preceding reply is
in transit, unopened or dead-lettered. A repeated create request with the same
client request ID replays the original result. A different create request
during an active turn fails with HTTP 409 and
`correspondence_turn_in_progress`. A unique `reply_to_letter_id` and a unique
committed generation run ensure that one incoming letter has at most one
reply.

Archiving is a read projection and does not close a thread. Closed thread
history remains readable. Ordinary user-facing thread closing is not needed
in the first version.

### Rollout mode and execution driver are independent

`CORRESPONDENCE_MODE` accepts `off`, `shadow` and `enforced`, and defaults to
`off`. `CORRESPONDENCE_EXECUTION` accepts `lazy`, `resident` and `worker`, and
defaults to `lazy`. Mode determines which domain effects are authorized;
execution determines how an authorized catch-up pass is triggered. Neither may
change the resulting domain history.

The first version reads these settings at process startup and does not support
hot mode changes.

#### `off`

- No correspondence scheduler starts and no pending or retryable temporal task
  is claimed.
- Character entry points do not run correspondence catch-up.
- New draft, update and seal operations are disabled with HTTP 409 and
  `correspondence_disabled`.
- Existing list/detail history remains readable. A reply already committed as
  `delivered_unread` or `read` may be opened or reopened because doing so does
  not advance a temporal task.
- A reply whose due time passed but whose arrival task is still pending cannot
  be opened. The request fails with HTTP 409 and
  `correspondence_processing_paused`; `off` does not secretly catch up.

#### `shadow`

- Deterministic lifecycle work may commit: task ordering, incoming arrival,
  due-time life advance, immutable snapshot freeze and the return arrival of a
  reply generated before the mode change.
- Reply-generation and generation-retry tasks are not claimed. They stay
  pending or retryable, no model is called, no generation run or reply is
  created, and scheduler queries skip them to avoid repeatedly selecting the
  same due task.
- One idempotent `letter.reply_generation_shadow_observed` audit event records
  the task and snapshot hash for Developer inspection.
- Shadow is a diagnostic mode, not the friend-facing product. Public compose
  controls are hidden; non-developer writes fail with HTTP 409 and
  `correspondence_shadow_mode`.
- Switching later to `enforced` resumes the retained generation task from the
  already frozen snapshot. The snapshot is not rebuilt at the later time.

#### `enforced`

All deterministic and model-backed correspondence transitions are authorized.
This is the only first-version friend-facing write path.

Switching from enforced to off pauses work without deleting it. Switching from
off to enforced catches up outstanding work in effective-time order. Mode
changes never reset snapshots, attempts, claims or idempotency keys.

`KEEPSAKE_MODE` independently accepts `off`, `shadow` and `enforced`, defaults
to `off`, and does not authorize keepsake generation until its later phase.
`ASSET_STORAGE_PATH` defaults to `./data/assets` and is resolved from the
workspace root. The original Stage 0 rollout only parsed these values; the R1
implementation now registers correspondence behind the same default-off
boundary, while keepsake routes remain unregistered.

### A logical run is not a provider attempt

Generation uses three distinct accounting layers:

1. A logical generation run is the persistent operation for one
   `(incomingLetterId, generationEpoch)`.
2. An execution attempt is one database claim and lease followed by one
   application-level `generateObject` execution. `run.attempt` increases when
   the attempt is claimed, and every attempt has a new claim token.
3. A provider transport request is an actual provider or repair request inside
   an execution attempt and is recorded separately by LLM metrics.

Automatic retry stays in the same logical run and reuses the same snapshot.
The first-version limit is three execution attempts in total, including the
first. Provider retry and repair must be bounded and observable so they do not
create a hidden unbounded cost multiplier.

Exactly-once external model invocation is not possible across a process-crash
boundary. The guaranteed property is exactly-once business commit. A lease
recovery creates a new attempt; a late result carrying an old claim token is
discarded. The reply ID is stable for the incoming letter and policy version,
not for an attempt, so attempts cannot create multiple reply letters.

The acceptance metric “zero logical calls before arrival” means there is no
execution attempt and no provider request before the incoming due time.

### Exhausted generation becomes a visible, recoverable dead letter

After three retryable failures, or immediately after a non-retryable invariant
failure, the generation run becomes `failed` and its task becomes
`dead_letter`. The lease is cleared. The immutable snapshot, attempt count,
provider identity, sanitized error code and model-result hash may remain, but a
failed generated body is never persisted. No reply letter is created.

The incoming letter remains `read`, and the thread's active turn remains
occupied. The product derives a “reply delayed / needs retry” presentation
without adding that condition to `Letter.status`. A dead-letter task is not
selected by normal scheduling and does not block fuzzy life from advancing to
the observed time. Restart, mode changes and worker ticks never revive it
automatically.

A developer route or self-hosted operator command may explicitly retry only
when the current run is failed, its task is dead-lettered, and no committed run
or reply exists. Manual retry creates `generationEpoch + 1` and a new task,
while reusing the original snapshot. Old failed runs are immutable, and a
unique cross-epoch commit constraint still permits at most one reply. Invalid
manual retry fails with HTTP 409 and `generation_not_retryable` or
`reply_already_committed`.

Network timeout, rate limit and structure validation after bounded repair are
retryable. Snapshot-hash mismatch, evidence-invariant failure, missing or wrong
key metadata and cryptographic initialization failure are non-retryable until
an operator fixes the underlying condition. Encryption failure follows the
plan's fail-closed rule: no reply is created, only a result hash is retained,
and plaintext is discarded from memory.

### Sealed replies use authenticated encryption

Character reply bodies are encrypted immediately before their in-transit
letter is committed. The first version uses AES-256-GCM, a random 12-byte IV,
and a per-letter key derived with HKDF-SHA256 from the instance secret,
`salt=letterId` and `info="chatplus-letter-v1"`. Canonical AAD includes at
least the letter ID, direction, content hash, authored effective time and
arrival due time. Persistence contains ciphertext, IV, authentication tag, key
version and AAD hash, never the role reply plaintext.

This encryption prevents ordinary early inspection and enforces the product's
sealed/open boundary. It is not DRM against the device owner because the
application ultimately holds the key.

### Open verifies integrity before committing read, and releases plaintext after commit

The phrase “open first, then return plaintext” describes the service boundary,
not an unsafe two-step database mutation. A first-version open operation uses
one short local transaction:

1. Read and authorize a character reply in `delivered_unread` or `read`.
2. Reconstruct canonical AAD and authenticate/decrypt in memory.
3. On authentication failure, roll back without changing status.
4. Conditionally change `delivered_unread` to `read`, set `openedAtUtc` once,
   and idempotently write `letter-open:<replyLetterId>`.
5. Commit, and only then let plaintext leave the service boundary.

The transaction contains no network or model work. Concurrent opens create one
state transition and one event; the loser rereads `read` and returns the same
body without changing the first `openedAtUtc`. Plaintext responses use
`Cache-Control: no-store` and are never logged.

Open error semantics are:

- 404 `not_found` for an unavailable letter;
- 409 `letter_not_arrived` for sealed or in-transit mail;
- 409 `letter_not_openable` for the wrong direction or an invalid state;
- 409 `correspondence_processing_paused` when off mode prevents a due arrival
  task from being processed; and
- 500 `letter_integrity_error` for ciphertext, AAD or tag failure. The client
  receives no cryptographic detail, and the letter stays `delivered_unread`.

### Instance-secret validation is staged, not silently weakened

Stage 0 initially parsed `INSTANCE_SECRET` without deriving a key because the
encrypted tables did not yet exist. With migrations 018/019 and encrypted
replies now implemented, startup validation follows the staged rules below:

- Provisioning uses a canonical encoding such as Base64 whose decoded secret
  contains at least 32 random bytes. Character count is not an entropy check.
- `enforced` requires an explicit valid secret even for a new empty database.
- On first enforced startup of a new database, a domain-separated irreversible
  fingerprint is written atomically before HTTP or worker processing starts.
- If a database already contains that fingerprint or any encrypted reply, all
  modes, including off and shadow, require the matching secret so historical
  letters remain readable.
- Missing, malformed or mismatched secret and encrypted rows without key
  metadata fail startup before binding HTTP or starting a worker.
- Tests pass an explicit deterministic secret through configuration override;
  production code has no built-in secret and never silently generates an
  in-memory-only value.
- Secret rotation and re-encryption are not first-version features.

Expected startup error codes are
`CORRESPONDENCE_SECRET_REQUIRED`, `CORRESPONDENCE_SECRET_INVALID`,
`CORRESPONDENCE_SECRET_MISMATCH` and
`CORRESPONDENCE_KEY_METADATA_MISSING`. They are startup failures, not HTTP
errors. Logs never include the secret, derived keys, complete fingerprint,
plaintext, complete prompt or provider API key. Database and secret backups
must be kept together without copying the secret into a log or backup manifest.

### Application code owns truth and idempotency

The model may propose only bounded reply or keepsake content. Application code
owns identifiers, status, effective and arrival times, evidence membership,
encryption, dispatch and ownership. Stable idempotency keys cover seal,
incoming arrival, snapshot, run, reply, return arrival, open and later
keepsakes. State transition and its domain event commit together.

Sealing and transit do not invoke a model. A model is called only after an
incoming letter has arrived and its snapshot has committed. Ordinary logs
record purpose, snapshot hash, token use, latency, provider and sanitized error
code, not letter bodies or complete prompts.

### Acceptance-scenario vocabulary remains isolated

Long-run acceptance stories may contain names, organizations, dates and answer
fixtures that production services must never recognize as rules. The existing
guard at
`apps/server/src/scenarios/acceptance-scenario-isolation.test.ts` recursively
checks production TypeScript under `apps/server/src` and
`packages/features/src`, while excluding scenario, script and test sources.
It currently protects markers including 山鸣影像, 许宁 and the September 14/16
correction.

That guard remains part of the correspondence unit gate. Stage 0 does not
modify `FuzzyLifeService`: the reviewed story-specific logic is already kept in
scenario fixtures and tests. Future correspondence work must preserve this
separation and express any general behavior through structured evidence rather
than story-name or date matching.

## Migration and rollback

1. Stage 0 adds only configuration, this ADR, rollout documentation and test
   commands. All new capability flags default to off, so current chat and fuzzy
   life behavior remains unchanged.
2. Correspondence persistence is added in a later additive migration using the
   next unoccupied migration number. The plan's `018` is valid only if the
   current migration registry still ends at `017`; an implementation must not
   overwrite a migration added after the reviewed baseline.
3. The correspondence migration does not rewrite chat or fuzzy-life tables.
   Keepsake persistence remains a separate migration so image work cannot
   block the letter core.
4. Rollback changes correspondence mode to off and leaves tables intact.
   Historical letters remain readable under the secret rules above, while new
   tasks stop. Removing the feature first preserves a read-only path for at
   least one version; it does not drop history.
5. Lazy, resident and worker drivers call the same domain service and use the
   same task and idempotency records. Rollback never replaces that domain
   service with a second local-only implementation.

## Consequences

### Positive

- Late processing cannot leak later character knowledge into an earlier reply.
- DST and clock rollback have one deterministic, testable meaning.
- Shadow diagnostics can validate ordering and snapshot quality without model
  cost or fabricated replies.
- Retry and crash recovery may repeat external work but cannot commit a second
  reply.
- Authentication failure cannot consume an unopened letter.
- A disabled Stage 0 rollout does not alter the existing local Demo.

### Trade-offs

- A DST-crossing percentage may not be a round multiple of 20 percent even
  though the product still describes a five-calendar-day journey.
- Off mode intentionally leaves due tasks unprocessed; a due but uncommitted
  arrival cannot be opened until enforced processing resumes.
- A dead-letter reply blocks the next sequential turn until an explicit
  recovery succeeds.
- Existing encrypted history makes the instance secret mandatory even when new
  correspondence generation is switched off.
- The first version chooses one sequential correspondence thread over parallel
  topics.

## Non-goals

- SMTP, IMAP or real email ingestion and delivery.
- Physical mail, addresses, payments, printing or logistics.
- Multi-tenant identity or sharing one character between friends.
- Parallel correspondence threads for one character.
- Model-selected transit duration, route or postage.
- Public sharing URLs, a stationery marketplace or random keepsake rewards.
- Complete historical state replay, key rotation or desktop-system delivery.
