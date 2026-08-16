# ADR 0004: deterministic fixture by default, compatible live provider by opt-in

## Status

Accepted.

## Decision

Normal development and tests use a deterministic fixture provider. An OpenAI-compatible Chat Completions provider is configured only in the local server environment and supports DeepSeek V4 Flash. Paid smoke tests are explicit and skipped without credentials.

## Security

Credentials never enter browser bundles, the database, fixtures, logs or snapshots. Local `.env` files are ignored by Git.
