# ADR: Separate Subagent Model Opt-In from Definition Pins

- Status: Accepted for implementation
- Date: 2026-09-13
- Related: D278, ADR 0062, ADR 0089, E2E-166, issue #286

## Context

Electron resolves definition pins and automatically selectable models into one
credential-bearing `subagentProviders` map. Treating every map key as a
`Task.model` selection both advertises private pins and bypasses main's
`availableForSubagents` check on the on-demand path. A definition pin expresses
one delegate's default, not permission to select that model for any delegate.

## Decision

Add an optional `subagentModelKeys: string[]` field to the internal Electron-to-
sidecar launch payload, runtime options, and reuse comparison. Main includes
only successfully resolved bindings independently marked
`availableForSubagents` on enabled providers. Reusing a resolved pin does not
skip this independent opt-in decision. `subagentProviders` continues to carry
all resolved bindings so existing definition defaults keep working. If an
opted-in row's vendor/model alias collides with a binding from another row,
main uses that row's exact provider ID as the override key; one account's
opt-in cannot authorize another account's pinned credentials.

The runtime uses the separate keys for its model summary. Missing keys mean
no cached override authorization. Other keys still use the existing
main-owned `provider.resolveSubagentModel` check; only a successful response
can populate a separate override cache. That cache is not part of launch
reuse matching and must not overwrite a definition pin with a different
provider id. On-demand provider matching uses the same unique id / vendor /
name rule as pin resolution; ambiguous vendor aliases fail closed unless the
caller uses the exact provider id. A changed launch list retires an idle
runtime on the next prompt, including after opt-in is revoked.

D278's priority remains Task.model → definition pin → session model. The
existing exact-session-model exception remains unchanged. Repeating the
target definition's own pin key is treated as omitting `model`, so catalog
echo does not become a tool error. The Task catalog displays each definition
default and says that omitting or repeating that key keeps it; this does not
prohibit deliberately selecting an opted-in override for a different model.

## Consequences

- No provider credential leaves its existing process boundary. No Host RPC,
  persisted setting, database schema, or Plugin SDK change is required.
- Older callers that omit the additive field retain definition defaults and
  session inheritance. Explicit overrides require on-demand authorization;
  missing authorization support fails closed instead of promoting pins.
- Runtime, model transport, and launch wiring regression coverage prove the
  boundary. The deterministic sidecar E2E uses a local OpenAI-compatible model
  fixture; provider UI interaction and external provider quality are separate.
- Reversing model-selection priority is a product decision outside this fix.
