# ADR 0257: Manual bidirectional sync with the system pi CLI configuration

- Status: Proposed (for review)
- Date: 2026-09-15
- Deciders: PI-Desktop core
- Decision: D425 (proposed; reconcile the decision number at merge)
- Related: D007, D342, ADR 0012, ADR 0134, ADR 0179, ADR 0188, ADR 0254,
  `03-runtime/11-provider-model-system.md`,
  `03-runtime/12-provider-config-schema.md`,
  `03-runtime/14-secrets-storage.md`,
  `03-runtime/01-ipc-protocol.md`,
  `04-ux/06-settings-ia.md`

## Context

PI-Desktop and the system `pi` CLI already share a machine and already meet at
`~/.pi/agent`, but they keep provider configuration separately:

- PI-Desktop owns its own store (baseline D007 / ADR 0011): provider rows in
  Rust SQLite, API keys and vendor OAuth grants in the OS secret store under
  `secret:provider:<id>:api_key` and `secret:provider:<id>:oauth`, and model
  metadata from the models.dev release snapshot (ADR 0134). The desktop never
  auto-imports `~/.pi` and owns `~/.pi-desktop`.
- The system `pi` CLI keeps `~/.pi/agent/auth.json` (API keys and OAuth tokens,
  written `0600`), `~/.pi/agent/models.json` (custom providers and overrides for
  built-in providers), and `~/.pi/agent/settings.json` (startup model defaults,
  plus TUI, compaction, retry, shell, and resource settings).

D342 / ADR 0179 / ADR 0188 allowed one explicit, one-way import from
`models.json` (and other local agent stores) through the Settings → Import
Model configuration card. It never copies OAuth/subscription grants and never
writes anything back.

Two frictions follow. A user who runs both tools retypes the same endpoints,
models, and keys. And an import is only a snapshot: later edits on either side
diverge silently.

PI-Desktop already reads other parts of `~/.pi/agent` — global instructions,
prompt templates, extension discovery, and native Pi session continuation
(ADR 0254) — so sharing this directory is not a new trust boundary for the
machine. What is new here is writing back into it.

## Decision

Adopt a **manual, explicit, bidirectional** sync between PI-Desktop providers
and the system pi CLI configuration. There is no file watching, no
auto-import, and no automatic write-back; both directions require an explicit
user action with a preview and confirmation.

1. **Two manual actions.** The Settings → Import **Model configuration** card
   gains "Import from pi" and "Export to pi". Each shows a preview of the
   affected entries and runs only when the user confirms. Session import is
   unchanged, and the existing explicit scan remains the import mechanism.

2. **Content scope, both directions.** Only provider/model definitions, API
   keys, and the three model defaults are synchronized:
   - `models.json` providers and models, as described in item 6.
   - `auth.json` `type: "api_key"` entries.
   - `settings.json` `defaultProvider`, `defaultModel`, `defaultThinkingLevel`.

   Every other `settings.json` key — `theme`, `compaction`, `retry`,
   `thinkingBudgets`, `shellPath`, `packages`, resource lists, telemetry, and
   TUI/terminal settings — is never read into Desktop state and never written
   by Desktop. Adopting them would regress frozen Desktop decisions (for
   example budget derivation under D200).

3. **OAuth and subscription grants are never synced in either direction.**
   This extends D342's import rule to the export direction. Desktop vendor
   accounts stay in the OS secret store; pi's OAuth tokens stay in
   `auth.json`. Neither side writes, refreshes, or deletes the other's grant.

4. **Export merge policy is upsert-and-preserve.** Export re-reads the current
   pi file and upserts only the entries Desktop manages. Every unknown field,
   unknown provider, and pi-only entry is preserved verbatim; Desktop never
   deletes an entry it did not create. The set of managed keys, plus a
   fingerprint of the last synchronized content, is recorded in a
   main-process sidecar `~/.pi-desktop/pi-sync.json` (a plain file, not
   SQLite). Writes are atomic (temp file + rename); `auth.json` is written
   `0600`.

5. **Drift is reported, never resolved silently.** If a pi file's fingerprint
   differs from the last synchronized value, export shows the affected entries
   and requires an explicit overwrite confirmation. A managed key that is
   missing from the file is reported as removed; it is never silently
   re-created, and its recorded state is never silently dropped. Desktop never
   initiates a merge without that confirmation.

6. **Mapping (Desktop to pi).**
   - `type = native`, built-in `vendorKey`: an API key becomes
     `auth.json.<vendorKey>.{ type: "api_key", key }`. An endpoint override
     becomes `models.json.providers.<vendorKey>.baseUrl` while the built-in
     model catalog stays intact.
   - `type = openai_compatible | custom`: becomes
     `models.json.providers.<piProviderKey>.{ baseUrl, api, apiKey?, headers?,
     models[] }`.
   - `apiStyle` maps to pi's `api`: `chat_completions` → `openai-completions`,
     `responses` → `openai-responses`, `anthropic_messages` →
     `anthropic-messages`, `google_generative_ai` → `google-generative-ai`.
   - Model fields map as `contextWindow` → `contextWindow`, `maxTokens` →
     `maxTokens`, `supportsImages` → `input: ["text","image"]`,
     `supportsReasoning` → `reasoning: true`.
   - `defaultProviderId` / `defaultModelId` / `defaultThinkingLevel` map to
     `settings.json` `defaultProvider` / `defaultModel` /
     `defaultThinkingLevel`.
   - `piProviderKey` derivation is normative and stable, and is persisted in
     `pi-sync.json` so a Desktop rename updates the same pi entry instead of
     creating a duplicate.

7. **Import stays an explicit scan.** The existing scan is extended to read
   `auth.json` `api_key` entries (keyed by pi vendor id) in addition to
   `models.json`, and keeps writing through the existing
   `providers.create` / `providers.update` host RPC. Existing idempotence
   (`draftMatchesExisting`, ADR 0188) is preserved. OAuth entries continue to
   be skipped.

8. **Secret boundary is unchanged.** Keys are read only in Electron main; the
   renderer sees only public previews with `hasSecret`. Export writes plaintext
   to pi's `auth.json`, which is a deliberate downgrade from the Desktop secret
   store and must be stated in the confirmation copy. No secret ever crosses
   the preload boundary.

9. **Value resolution is not inherited.** pi allows `"!command"` shell
   execution and `$ENV` interpolation in `models.json` and `auth.json` values.
   Import never executes `!command` and never resolves `$ENV` against the
   Desktop process environment; such values are preserved verbatim and
   reported as unresolved. Export never emits `!command`. A key entered through
   Desktop is always stored as a literal in the Desktop secret store.

10. **Transport.** Electron IPC only. No host protocol version bump and no
    storage schema change, because the sync sidecar is a main-process file and
    providers continue to be written through the existing host RPC.

## Consequences

- A user who runs both tools can keep one endpoint/model/key set and choose
  when to reconcile, without retyping and without silent divergence.
- D007's "no auto-import" remains true. The amendment is the explicit
  user-triggered write-back direction, which D007 did not previously permit.
- Desktop's provider storage, secret store, and models.dev metadata source
  remain authoritative for Desktop behavior; the pi files are a sync partner,
  not the source of Desktop truth.
- `pi-sync.json` becomes durable state that must survive provider row
  renames and deletions; a provider deleted in Desktop is reported and left
  in pi rather than removed.
- pi defines no file lock. If pi is running during an export, the fingerprint
  check and confirmation reduce but do not eliminate a lost update.
  Cooperative locking is out of scope and only possible if pi adopts one.
- pi may change its config schema between versions. The writer preserves
  unknown fields, and the reader degrades to a preview error instead of
  guessing at an unrecognized shape.
- Import and export are unavailable when `~/.pi/agent` does not exist; the
  card explains that pi must be installed and used once.

## Alternatives

- **Automatic import or file watching:** rejected by D007 and by
  concurrent-writer hazards with pi's own refresh.
- **Field-level bidirectional merge:** rejected as overkill for a manual
  action; upsert-and-preserve already avoids destroying pi-only content.
- **Wholesale replacement of the pi files:** rejected; it would destroy
  manually maintained pi providers and unknown future fields.
- **Syncing OAuth/subscription grants:** rejected; refresh-token ownership
  conflicts and it weakens the credential boundary on both sides.
- **Adopting pi's `settings.json` in full:** rejected; it would import
  terminal-only settings and regress frozen compaction and retry decisions.
- **Making pi's config the Desktop source of truth:** rejected; it would
  replace Desktop provider storage, the OS secret store, and models.dev
  metadata ownership, which the baseline freezes.
