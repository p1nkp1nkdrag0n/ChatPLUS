# Companion long-run testing

The companion long-run harness executes the versioned
`companion-long-run-v1` manifest through a real ephemeral HTTP listener. Fixture
and DeepSeek runs share the same 100-turn manifest, FakeClock actions, database
snapshots, hard assertions, report projection, restart path, and idempotency
probe.

## Commands

Run the deterministic 100-turn integration profile without network access:

```bash
pnpm test:companion:long-run
```

Run one explicitly paid 30-turn DeepSeek profile:

```bash
pnpm exec cross-env RUN_PAID_DEEPSEEK_TESTS=true LLM_PROVIDER=openai-compatible pnpm test:deepseek:long-run -- --turns 30 --runs 1 --pipeline target
```

Run the release matrix only when its cost and three independent 100-turn runs
have been intentionally approved:

```bash
pnpm exec cross-env RUN_PAID_DEEPSEEK_TESTS=true LLM_PROVIDER=openai-compatible pnpm test:deepseek:long-run:release
```

The existing five-turn real-network smoke remains separate:

```bash
pnpm exec cross-env REAL_NETWORK_ACCEPTANCE=1 LLM_PROVIDER=openai-compatible pnpm test:deepseek:acceptance
```

The DeepSeek command exits as `SKIPPED` before application construction or
network access unless all of the following are true:

- `RUN_PAID_DEEPSEEK_TESTS=true`;
- the configured provider is `openai-compatible`;
- a non-empty API key is available through the normal local configuration;
- the provider endpoint and model pass the existing DeepSeek acceptance guard.

Do not put an API key on the command line or commit it to the repository.

## Profiles and artifacts

`--turns` accepts `30`, `50`, or `100`; each profile is an explicit ordered
subset with its prerequisite writes and session actions. `--runs` executes
independent databases sequentially. `--pipeline target` requires audited
`turn_understanding` and `reply_generation` calls and rejects silent use of
legacy `chat_turn`.

Real reports are written below `docs/reports/companion-long-run/` by default.
Each run creates:

- a JSON report as the machine-readable source of truth;
- a Markdown report rendered from the same allowlisted DTO;
- a detailed JSON-lines diagnostic log;
- an independent SQLite database under the local ignored `tmp/` directory.

Every ten completed turns a uniquely named `PARTIAL` JSON/Markdown checkpoint
is written atomically. Final reports are never overwritten. Generated reports,
logs, databases, credentials, request headers, complete prompts, and raw
provider payloads are not committed.

## Interpretation

`PASS` requires every selected logical turn and every hard assertion to pass.
`FAIL` is a valid test result and must not be converted to PASS by retrying a
semantic failure. `PARTIAL` means a budget or runner boundary stopped the run.
`SKIPPED` means paid prerequisites were absent; it is not evidence of model
quality.

The report records per-turn HTTP status, persisted reply, safe understanding
and outcome summaries, ContextPlan and prompt-segment trace, selected evidence
IDs, authoritative before/after state, domain-event and rejected-proposal
summaries, LLM purpose/token/latency usage, and each hard assertion. A
fail-closed scan rejects credentials and absolute local paths before artifacts
are published.
