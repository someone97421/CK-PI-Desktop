import type { Mode, SessionThinkingLevel } from "@pi-desktop/shared";

type Session = { id?: string; mode?: string; [key: string]: unknown };
export type SessionConfigurationPatch = {
  mode?: Mode;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
  permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
};
type Pending = { patch: SessionConfigurationPatch; error?: string };
type Host = { call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> };

const fields = ["mode", "providerId", "modelId", "thinkingLevel", "permissionMode"] as const;
const codeOf = (error: any): string => error?.data?.errorCode ?? error?.errorCode ?? error?.code ?? "INTERNAL";
const isBlocked = (error: unknown): boolean => codeOf(error) === "PLAN_CONFIGURATION_BLOCKED";

/** A main-owned, process-local next-turn draft; never mutates a running turn. */
export function createSessionConfigurationQueue(options: {
  getHost: () => Host | null;
  isTurnActive: (sessionId: string) => boolean;
  onChanged: (sessionId: string, session?: Session, applied?: SessionConfigurationPatch) => void;
  log: (message: string, data?: unknown) => void;
}) {
  const pending = new Map<string, Pending>();
  const tails = new Map<string, Promise<unknown>>();

  // Separate from the admission lock: finishTurn is also called by abort and
  // failed prompt startup while that lock is held. Taking it here deadlocks.
  async function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    tails.set(id, current);
    try { return await current; }
    finally { if (tails.get(id) === current) tails.delete(id); }
  }

  function changed(id: string, session?: Session, patch?: SessionConfigurationPatch): void {
    try { options.onChanged(id, session, patch); }
    catch (error) { options.log("session configuration notification failed", { sessionId: id, error: String(error) }); }
  }

  function decorate<T extends Session>(session: T): T & {
    pendingConfiguration?: SessionConfigurationPatch;
    pendingConfigurationError?: string;
  } {
    const draft = pending.get(String(session.id ?? ""));
    return {
      ...session,
      ...(draft ? { pendingConfiguration: { ...draft.patch } } : {}),
      ...(draft?.error ? { pendingConfigurationError: draft.error } : {}),
    };
  }

  function requireHost(): Host {
    const host = options.getHost();
    if (!host) throw new Error("host unavailable");
    return host;
  }

  async function read(id: string): Promise<Session> {
    const { session } = await requireHost().call<{ session?: Session }>("session.get", { id, messageLimit: 1 });
    if (!session) throw Object.assign(new Error("Session not found"), { errorCode: "NOT_FOUND" });
    return session;
  }

  function validate(config: SessionConfigurationPatch): SessionConfigurationPatch {
    const patch: SessionConfigurationPatch = {};
    for (const key of fields) {
      const value = config[key];
      if (value === undefined) continue;
      if (typeof value !== "string") throw Object.assign(new Error(`${key} must be a string`), { errorCode: "INVALID_ARGUMENT" });
      if (key === "mode" && !["agent", "plan", "goal", "chat"].includes(value) ||
          key === "thinkingLevel" && !["omit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value) ||
          key === "permissionMode" && !["inherit", "ask", "accept-edits", "auto"].includes(value)) {
        throw Object.assign(new Error(`Invalid ${key}`), { errorCode: "INVALID_ARGUMENT" });
      }
      Object.assign(patch, { [key]: key === "mode" && value === "chat" ? "plan" : value });
    }
    return patch;
  }

  function differences(session: Session, patch: SessionConfigurationPatch): SessionConfigurationPatch {
    return Object.fromEntries(fields.filter((key) => patch[key] !== undefined && patch[key] !== session[key])
      .map((key) => [key, patch[key]])) as SessionConfigurationPatch;
  }

  async function apply(id: string, session: Session, patch: SessionConfigurationPatch): Promise<Session> {
    const result = await requireHost().call<{ session?: Session }>("session.configure", {
      id, mode: session.mode, ...patch,
    });
    if (!result.session) throw Object.assign(new Error("Session not found"), { errorCode: "NOT_FOUND" });
    pending.delete(id);
    changed(id, result.session, patch);
    return result.session;
  }

  async function configure(id: string, config: SessionConfigurationPatch & { deferUntilIdle?: boolean }) {
    return serialized(id, async () => {
      const input = validate(config);
      const session = await read(id);
      const patch = differences(session, { ...pending.get(id)?.patch, ...input });
      if (!Object.keys(patch).length) {
        if (pending.delete(id)) changed(id);
        return { session: decorate(session), queued: false };
      }
      if (config.deferUntilIdle && options.isTurnActive(id)) {
        pending.set(id, { patch });
        changed(id);
        return { session: decorate(session), queued: true };
      }
      try {
        const applied = await apply(id, session, patch);
        return { session: decorate(applied), queued: false };
      } catch (error) {
        // Only the host's immutable-plan/running-turn gate is a deferral. A
        // validation, transport or storage error is never reported as success.
        if (!config.deferUntilIdle || !isBlocked(error)) throw error;
        pending.set(id, { patch });
        changed(id);
        return { session: decorate(session), queued: true };
      }
    });
  }

  async function flush(id: string, strict = false): Promise<void> {
    return serialized(id, async () => {
      const draft = pending.get(id);
      if (!draft) return;
      try {
        if (options.isTurnActive(id)) throw Object.assign(new Error("Session configuration is waiting for the current turn"), { errorCode: "AGENT_BUSY" });
        const session = await read(id);
        const patch = differences(session, draft.patch);
        if (Object.keys(patch).length) await apply(id, session, patch);
        else { pending.delete(id); changed(id); }
      } catch (error) {
        // Keep the draft visible and retryable; never allow a normal next turn
        // to run with the old configuration after a failed application.
        if (codeOf(error) === "NOT_FOUND") pending.delete(id);
        else if (!isBlocked(error) && codeOf(error) !== "AGENT_BUSY") {
          draft.error = error instanceof Error ? error.message : String(error);
          options.log("pending session configuration failed", { sessionId: id, error: draft.error });
        }
        changed(id);
        if (strict) throw error;
      }
    });
  }

  return {
    configure,
    flush,
    decorate,
    hasPending: (id: string) => pending.has(id),
    clear: async (id: string) => serialized(id, async () => { pending.delete(id); }),
  };
}

export type SessionConfigurationQueue = ReturnType<typeof createSessionConfigurationQueue>;
