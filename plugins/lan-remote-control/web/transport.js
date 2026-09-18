/**
 * 传输层：HTTP RPC、密码登录、附件上传/读取、WebSocket 事件流。
 *
 * 只负责「把请求发出去、把信封拆开、把事件交给上层」，不含 UI 文案与渲染。
 * 失败一律抛 ProtocolError（带 code / status / retriable / requestId）。
 *
 * 与桌面端固定的契约：
 * - 读操作不得带 mutationId；变更操作必须带，且同一个用户动作重试时复用同一个
 *   mutationId（服务端幂等表按 operation + 规范化 input 去重）。
 * - 断线/超时后不自动重放变更：先 `GET /api/mutation/:id` 查结果，
 *   查不到就抛 UnknownResultError，由 UI 提示“结果不确定”。
 * - 上传与附件读取都带 Bearer；附件不能用 token 查询串（不进日志/历史）。
 */

import {
  ATTACHMENT_PATH,
  ErrorCodes,
  FILENAME_HEADER,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MUTATION_PATH,
  MUTATION_TIMEOUT_MS,
  LOGIN_PATH,
  ProtocolError,
  READ_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  RPC_PATH,
  SESSION_HEADER,
  UnknownResultError,
  UPLOAD_PATH,
  WS_PATH,
  isMutationOperation,
  protocolErrorFromResponse,
  uuid,
} from "./protocol.js";

export function apiOrigin() {
  if (typeof location === "undefined") return "";
  return location.origin && location.origin !== "null" ? location.origin : "";
}

export function websocketUrl() {
  if (typeof location === "undefined") return WS_PATH;
  const secure = location.protocol === "https:";
  return `${secure ? "wss:" : "ws:"}//${location.host}${WS_PATH}`;
}

/**
 * 变更请求的幂等注册表。
 *
 * key 描述一个用户动作（例如 `send:<sessionId>:<draftId>`）。首次调用 `id(key)`
 * 生成 mutationId 并记住；用户手动重试同一动作时复用同一个 id，服务端据此去重。
 */
export class MutationRegistry {
  constructor() {
    this.entries = new Map();
  }

  id(key) {
    const existing = this.entries.get(key);
    if (existing) {
      existing.attempts += 1;
      return existing.mutationId;
    }
    const mutationId = uuid();
    this.entries.set(key, { mutationId, attempts: 1, startedAt: Date.now() });
    return mutationId;
  }

  attempts(key) {
    const entry = this.entries.get(key);
    return entry ? entry.attempts : 1;
  }

  mutationIdForKey(key) {
    const entry = this.entries.get(key);
    return entry ? entry.mutationId : "";
  }

  complete(key) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}

export class RemoteClient {
  constructor({ getToken, onUnauthorized } = {}) {
    this.getToken = getToken || (() => "");
    this.onUnauthorized = onUnauthorized || (() => {});
    this.lastRequestId = "";
  }

  baseHeaders(extra) {
    const headers = Object.assign({ Accept: "application/json" }, extra || {});
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async rawRequest(path, { method = "GET", headers, body, timeoutMs = READ_TIMEOUT_MS, signal, allowUnauthorized = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(`${apiOrigin()}${path}`, {
        method,
        headers,
        body,
        signal: signal ? mergeSignal(signal, controller.signal) : controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      // 超时覆盖响应正文，手机切到后台后正文读取也可能停滞。
      text = await response.text();
    } catch (error) {
      const aborted = controller.signal.aborted || signal?.aborted || (error && (error.name === "AbortError" || /timeout/i.test(String(error.message || ""))));
      throw new ProtocolError(
        aborted ? ErrorCodes.TIMEOUT : ErrorCodes.NETWORK,
        aborted ? "请求超时" : "网络不可达",
        { retriable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (response.status === 401 && !allowUnauthorized) {
      const forwarded = protocolErrorFromResponse(payload, "连接已失效");
      const unauthorized = new ProtocolError(ErrorCodes.UNAUTHORIZED, forwarded.message || "连接已失效", {
        status: 401,
      });
      this.onUnauthorized(unauthorized);
      throw unauthorized;
    }

    if (!response.ok && !(payload && typeof payload === "object" && "ok" in payload)) {
      throw new ProtocolError(
        response.status === 404 ? ErrorCodes.NOT_FOUND : `HTTP_${response.status}`,
        `请求失败（HTTP ${response.status}）`,
        { status: response.status, retriable: response.status >= 500 },
      );
    }

    if (payload && typeof payload === "object" && "ok" in payload) {
      if (payload.requestId) this.lastRequestId = String(payload.requestId);
      if (payload.ok === false) throw protocolErrorFromResponse(payload, "请求失败");
      return { result: payload.result, requestId: asStringOrEmpty(payload.requestId), replayed: payload.replayed === true };
    }
    return { result: payload, requestId: "", replayed: false };
  }

  /** 只读调用。 */
  async read(operation, input = {}, options = {}) {
    return this.call(operation, input, options);
  }

  /**
   * 变更调用。`mutationId` 由调用方通过 MutationRegistry 提供，保证重试复用。
   */
  async mutate(operation, input = {}, { mutationId, timeoutMs, signal, requestId } = {}) {
    if (!isMutationOperation(operation)) {
      throw new ProtocolError("INTERNAL", `${operation} 不是变更操作`);
    }
    return this.call(operation, input, { mutationId, timeoutMs, signal, requestId });
  }

  async call(operation, input = {}, { mutationId, timeoutMs, signal, requestId } = {}) {
    const body = {
      requestId: requestId || uuid(),
      operation,
      input: input && typeof input === "object" ? input : {},
    };
    if (mutationId) body.mutationId = mutationId;
    else if (isMutationOperation(operation)) {
      throw new ProtocolError("INTERNAL", `${operation} 需要 mutationId`);
    }
    const { result } = await this.rawRequest(RPC_PATH, {
      method: "POST",
      headers: this.baseHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      timeoutMs: timeoutMs || (mutationId ? MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS),
      signal,
    });
    return result;
  }

  /**
   * 变更结果核对（断网/超时后唯一允许的动作，不重放）。
   * 返回 { status, result, error }；status: "unknown" 表示服务端没有记录。
   */
  async mutationStatus(mutationId, { signal } = {}) {
    const { result } = await this.rawRequest(`${MUTATION_PATH}/${encodeURIComponent(mutationId)}`, {
      method: "GET",
      headers: this.baseHeaders(),
      timeoutMs: READ_TIMEOUT_MS,
      signal,
    });
    const source = result && typeof result === "object" ? result : {};
    const status = String(source.status || source.state || "unknown");
    return {
      mutationId,
      status,
      result: source.result,
      error: source.error && typeof source.error === "object" ? source.error : null,
      replayed: source.replayed === true,
    };
  }

  /**
   * 变更失败后的收尾：结果不确定时先查幂等表，仍不确定就抛 UnknownResultError。
   * 明确失败（服务端有记录或错误码确定）时抛原始错误。
   */
  async resolveUncertainMutation(mutationId, originalError) {
    try {
      const lookup = await this.mutationStatus(mutationId);
      const status = String(lookup.status || "").toLowerCase();
      if (status === "completed" || status === "done" || status === "settled" || status === "success") {
        return { settled: true, result: lookup.result };
      }
      if (status === "failed" || status === "error") {
        const error = lookup.error || {};
        throw new ProtocolError(String(error.code || "INTERNAL"), String(error.message || "电脑端执行失败"), {
          operation: originalError && originalError.operation,
        });
      }
      if (status === "pending" || status === "running" || status === "in_flight") {
        throw new ProtocolError("IN_FLIGHT", "电脑端仍在执行，请稍后刷新", { retriable: true });
      }
    } catch (error) {
      if (error instanceof ProtocolError && error.code !== ErrorCodes.NOT_FOUND && error.code !== ErrorCodes.NETWORK) {
        throw error;
      }
    }
    throw new UnknownResultError("结果不确定：电脑端可能已经执行，请先核对再决定是否重试", {
      mutationId,
      operation: originalError && originalError.operation,
    });
  }

  // --- 登录 ---------------------------------------------------------------

  async health({ signal } = {}) {
    const { result } = await this.rawRequest("/api/health", { method: "GET", headers: {}, signal });
    return result;
  }

  async login(password, name) {
    const { result } = await this.rawRequest(LOGIN_PATH, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password, name }), allowUnauthorized: true,
    });
    if (!result || typeof result.token !== "string" || !result.deviceId) throw new ProtocolError("INTERNAL", "登录响应无效");
    return result;
  }

  async logout() {
    await this.rawRequest("/api/logout", { method: "POST", headers: this.baseHeaders() });
  }

  // --- 附件 ---------------------------------------------------------------

  async upload(file, sessionId, { signal } = {}) {
    const extension = /\.([^.]+)$/.exec(file.name || "")?.[1].toLowerCase();
    const fallbackTypes = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg",
      webp: "image/webp", gif: "image/gif",
      md: "text/markdown", markdown: "text/markdown", txt: "text/plain", text: "text/plain",
      log: "text/plain", csv: "text/csv", json: "application/json", pdf: "application/pdf",
    };
    // 手机文件提供器可能不报告 MIME；最终仍由服务端校验扩展名和内容。
    const declaredType = (file.type || "").split(";")[0].trim().toLowerCase();
    const mimeType = (!declaredType || declaredType === "application/octet-stream")
      ? fallbackTypes[extension] || "application/octet-stream"
      : declaredType;
    const headers = this.baseHeaders({
      "Content-Type": mimeType,
      [FILENAME_HEADER]: encodeURIComponent(file.name || "file"),
    });
    if (sessionId) headers[SESSION_HEADER] = sessionId;
    const { result } = await this.rawRequest(UPLOAD_PATH, {
      method: "POST",
      headers,
      body: file,
      timeoutMs: MUTATION_TIMEOUT_MS,
      signal,
    });
    const attachment = result && typeof result === "object" ? result : {};
    const id = String(attachment.id || "");
    if (!id) throw new ProtocolError("INTERNAL", "上传响应缺少附件 id");
    return {
      id,
      name: String(attachment.name || file.name || "附件"),
      mimeType: String(attachment.mimeType || mimeType),
      size: Number(attachment.size || file.size || 0),
      kind: String(attachment.kind || (mimeType.startsWith("image/") ? "image" : "file")),
    };
  }

  /** 预览/下载上传暂存附件：必须带 Bearer，返回 Blob。 */
  async fetchAttachmentBlob(id, { signal } = {}) {
    return this.fetchBinary(`${ATTACHMENT_PATH}/${encodeURIComponent(id)}`, signal);
  }

  async fetchBinary(path, signal) {
    const response = await fetch(`${apiOrigin()}${path}`, {
      method: "GET",
      headers: this.baseHeaders({ Accept: "*/*" }),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) {
      this.onUnauthorized(new ProtocolError(ErrorCodes.UNAUTHORIZED, "连接已失效", { status: 401 }));
    }
    if (!response.ok) {
      throw new ProtocolError(
        response.status === 404 ? ErrorCodes.NOT_FOUND : `HTTP_${response.status}`,
        `附件读取失败（HTTP ${response.status}）`,
        { status: response.status },
      );
    }
    return response.blob();
  }
}

function asStringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

/** 两个信号合并：任一 abort 都取消（用于把 UI 取消接到 fetch）。 */
function mergeSignal(outer, inner) {
  if (outer.aborted) return outer;
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer.addEventListener("abort", abort, { once: true });
  inner.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/**
 * 事件 WebSocket。
 *
 * 生命周期：connect → auth → ready → subscribe → subscribed →（上层取快照）→ 事件。
 * 重连按指数退避；重连成功后上层必须重新订阅并取快照（先订阅再快照，
 * 避免订阅空窗），本类只负责转发。
 */
export class EventSocket {
  constructor({ getToken, onStatus, onReady, onEvent, onError, onResync, onFrame }) {
    this.getToken = getToken;
    this.onStatus = onStatus || (() => {});
    this.onReady = onReady || (() => {});
    this.onEvent = onEvent || (() => {});
    this.onError = onError || (() => {});
    this.onResync = onResync || (() => {});
    this.onFrame = onFrame || (() => {});
    this.socket = null;
    this.status = "idle";
    this.subscriptions = new Set();
    this.pendingAuth = false;
    this.lastMessageAt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.closedByUser = false;
    this.ready = false;
  }

  setStatus(status, detail) {
    this.status = status;
    this.onStatus(status, detail || {});
  }

  connect() {
    this.closedByUser = false;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const token = this.getToken();
    if (!token) {
      this.setStatus("unauthenticated");
      return;
    }
    this.setStatus(this.attempts > 0 ? "reconnecting" : "connecting");
    let socket;
    try {
      socket = new WebSocket(websocketUrl());
    } catch (error) {
      this.scheduleReconnect(`无法建立 WebSocket：${error && error.message ? error.message : error}`);
      return;
    }
    this.socket = socket;
    this.pendingAuth = true;
    this.ready = false;

    socket.addEventListener("open", () => {
      this.lastMessageAt = Date.now();
      this.send({ type: "auth", token: this.getToken() });
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now();
      let frame = null;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      this.handleFrame(frame);
    });

    socket.addEventListener("close", (event) => {
      this.stopHeartbeat();
      this.socket = null;
      this.pendingAuth = false;
      this.ready = false;
      this.subscriptions.clear();
      if (this.closedByUser) {
        this.setStatus("closed");
        return;
      }
      const code = event && event.code;
      if (code === 4401 || code === 4403) {
        this.setStatus("unauthorized", { code });
        this.onError(new ProtocolError(ErrorCodes.UNAUTHORIZED, "授权已失效，请重新登录", { status: 401 }));
        return;
      }
      this.scheduleReconnect(code === 4001 ? "电脑端服务已停止" : "连接已断开");
    });

    socket.addEventListener("error", () => {
      // close 一定随后触发，重连只在那里做一次。
    });
  }

  handleFrame(frame) {
    this.onFrame(frame);
    const type = String(frame.type || "");
    if (type === "ready") {
      if(frame.protocolVersion!==1){this.onError(new ProtocolError('UNSUPPORTED','远程协议不兼容，请刷新页面或升级插件'));this.close();return;}
      this.pendingAuth = false;
      this.ready = true;
      this.attempts = 0;
      this.onReady(frame);
      for (const sessionId of this.subscriptions) this.sendSubscribe(sessionId);
      return;
    }
    if (type === "subscribed") {
      this.onEvent({ type: "subscribed", sessionId: String(frame.sessionId || "") });
      return;
    }
    if (type === "unsubscribed") {
      this.onEvent({ type: "unsubscribed", sessionId: String(frame.sessionId || "") });
      return;
    }
    if (type === "event") {
      const payload = frame.event && typeof frame.event === "object" ? frame.event : null;
      if (!payload) return;
      if (String(payload.kind || "") === "resync.required") {
        this.onResync(String(payload.sessionId || ""));
        return;
      }
      this.onEvent({ type: "event", event: payload });
      return;
    }
    if (type === "ping") {
      this.send({ type: "pong", ts: Number(frame.ts) || Date.now() });
      return;
    }
    if (type === "pong") return;
    if (type === "error") {
      const error = frame.error && typeof frame.error === "object" ? frame.error : {};
      this.onError(
        new ProtocolError(String(error.code || "INTERNAL"), String(error.message || "事件流错误"), {
          retriable: Boolean(error.retriable),
        }),
        String(frame.sessionId || ""),
      );
    }
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendSubscribe(sessionId) {
    this.send({ type: "subscribe", sessionId });
  }

  /** 订阅（幂等）。服务端回 subscribed 后上层再取快照。 */
  subscribe(sessionId) {
    if (!sessionId) return;
    this.subscriptions.add(sessionId);
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.ready) {
      this.sendSubscribe(sessionId);
    }
  }

  unsubscribe(sessionId) {
    if (!sessionId) return;
    this.subscriptions.delete(sessionId);
    this.send({ type: "unsubscribe", sessionId });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.send({ type: "ping" });
      if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          this.socket.close(4000, "heartbeat timeout");
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect(reason) {
    if (this.closedByUser) return;
    this.attempts += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.attempts - 1));
    const jittered = Math.round(delay * (0.85 + Math.random() * 0.3));
    this.setStatus("reconnecting", { reason, retryInMs: jittered, attempt: this.attempts });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jittered);
  }

  /** 页面回到前台：立刻重连或补一次心跳。 */
  wake() {
    if (this.closedByUser) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect();
      return;
    }
    this.send({ type: "ping" });
  }

  close() {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "client closed");
      } catch {
        /* ignore */
      }
    }
    this.setStatus("closed");
  }
}
