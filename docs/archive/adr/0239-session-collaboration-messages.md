# ADR 0239: Host-owned session collaboration messages

- Status: Accepted
- Date: 2026-09-13
- Decision: D409
- Amends: ADR 0237, ADR 0165, ADR 0213

## Context

Session Orchestrator must address existing durable sessions in both directions,
reuse their context, deliver completion callbacks, and expose reliable state.
Polling assistant text cannot establish a turn's outcome. Plugin settings must
not become an authority for session identity, authorization, or execution state.

## Decision

Rust host-core owns a durable session communication ledger keyed by message ID,
referencing the existing source and target Session IDs. Session IDs remain the
only session identity. Message IDs identify deliveries and idempotency, never a
second worker or work identity. A delivery is bound to its actual durable turn
before execution, and results derive from that turn's persisted terminal state.

The official plugin composes reviewed desktop operations for spawn, send,
status, result, and cancellation. The host authenticates the sending Session ID
from a correlated plugin tool invocation; plugins cannot supply a forged sender.
Existing target sessions keep their project, model, context, and permissions.
New sessions inherit the initiating session's project and permission mode.
Autonomous session creation is bounded separately from bidirectional messaging.

The Agent Host's existing admission and turn queue remain the execution owner.
The ledger retains deliveries across dequeue and process failure. A busy target
queues a message; an idle target starts it. Restored work follows the existing
startup fence and is never replayed merely because the application restarted.
Permission checks remain host-owned; session messaging cannot raise a target's
effective permission above the initiating operation's authorized ceiling.

Messages have explicit task, message, or completion provenance, persisted with
the transcript and rendered separately from human input. Live model prompts and
restored history use the same source framing. Session messages are not new human
authorization and do not participate in user-message editing or regeneration.

A requested completion callback produces at most one durable completion message
to the originating session. It references the original delivery and the actual
turn outcome. Completion messages never request another automatic callback.
The host bounds autonomous communication chains and retains delivery failures for
passive inspection. Cancellation preserves the session and its history.

The plugin obtains available models from the host's public model catalog. An
unspecified model is chosen from bindings enabled for AI delegation; if none are
enabled, the configured default is used. Explicit requests resolve against real
configured keys, IDs, aliases, names, and supported capability intent. Ambiguous
or unmatched requests return candidates or a clear error without silently
substituting an unrelated model. Reusing a session does not reselect its model.

The existing session-list hover card gains an on-demand host projection of its
creation source, current task, recent exchanges, current status, and turn-bound
result. The projection is bounded, supports keyboard focus, and does not load
complete transcripts or add a read for every sidebar row.

## Compatibility and validation

The storage migration is additive. Existing conversations, plugin settings, and
the core Task family remain intact. This is a deliberate plugin-mediated
exception to ADR 0165's withdrawn cross-session coordination feature; the old
A2A broker, tools, and protocol are not restored. ADR 0237's parent-only messaging
restriction and polling-based result inference are superseded.

Validation covers concurrent senders, durable identity, reuse, queue admission,
source preservation across reload, exactly-once callback creation, failure and
cancellation results, permission ceilings, model resolution, hover lifecycle,
and the relevant host/Electron E2E journeys.
