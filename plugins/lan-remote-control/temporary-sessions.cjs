"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function isTemporarySession(session) {
  return (!session.source || session.source === "desktop")
    && !session.projectId && !session.projectPath?.trim();
}

function createTemporarySessions({ host, createDefaults }) {
  const drafts = new Map();
  return {
    get: (id) => drafts.get(id),
    list: () => [...drafts.values()],
    discard(id) {
      if (!drafts.delete(id)) {
        throw Object.assign(new Error("只能放弃尚未发送的临时草稿"), { code: "NOT_FOUND" });
      }
      return { discarded: true };
    },
    async create(input) {
      let temporaryWorkspacePath;
      if (input.temporaryWorkspacePath != null && input.temporaryWorkspacePath !== "") {
        const directory = input.temporaryWorkspacePath;
        if (typeof directory !== "string" || !path.isAbsolute(directory.trim())) {
          throw Object.assign(new Error("工作目录须为电脑上的绝对路径"), { code: "INVALID_PARAMS" });
        }
        temporaryWorkspacePath = await fs.realpath(directory.trim());
        if (!(await fs.stat(temporaryWorkspacePath)).isDirectory()) {
          throw Object.assign(new Error("工作目录不是文件夹"), { code: "INVALID_PARAMS" });
        }
      }
      const defaults = await createDefaults(input);
      const now = new Date().toISOString();
      const draft = {
        id: crypto.randomUUID(), title: "新临时会话", source: "desktop", draft: true,
        projectId: null, projectPath: null, temporaryWorkspacePath,
        createdAt: now, updatedAt: now, mode: "agent", permissionMode: "inherit",
        ...defaults, messages: [], messageStart: 0,
      };
      drafts.set(draft.id, draft);
      return draft;
    },
    configure(id, config) {
      const draft = drafts.get(id);
      if (!draft) throw Object.assign(new Error("临时草稿不存在"), { code: "NOT_FOUND" });
      Object.assign(draft, config, { updatedAt: new Date().toISOString() });
      return { session: draft, queued: false };
    },
    async materialize(id) {
      const draft = drafts.get(id);
      if (!draft) return;
      const configuration = {
        mode: draft.mode, permissionMode: draft.permissionMode,
        providerId: draft.providerId, modelId: draft.modelId, thinkingLevel: draft.thinkingLevel,
      };
      let existing;
      try {
        existing = (await host("session/get", [{ id, messageLimit: 1 }]))?.session;
      } catch (error) {
        if (!["NOT_FOUND", "SESSION_NOT_FOUND"].includes(error.code || error.errorCode)) throw error;
      }
      if (!existing) {
        const { permissionMode, ...initialConfiguration } = configuration;
        const result = await host("session/create", [{
          draftId: id, temporaryWorkspacePath: draft.temporaryWorkspacePath, ...initialConfiguration,
        }]);
        if (result?.session?.id !== id) {
          throw Object.assign(new Error("临时会话创建回执不一致"), { code: "INTERNAL" });
        }
        existing = result.session;
      }
      const changes = Object.fromEntries(Object.entries(configuration)
        .filter(([key, value]) => value !== undefined && value !== existing[key]));
      if (Object.keys(changes).length) {
        const result = await host("session/configure", [id, { ...changes, deferUntilIdle: true }]);
        const effective = result?.queued ? result.session?.pendingConfiguration : result?.session;
        if (result?.session?.id !== id || Object.entries(changes).some(([key, value]) => effective?.[key] !== value)) {
          throw Object.assign(new Error("临时会话设置回执不一致"), { code: "INTERNAL" });
        }
      }
      drafts.delete(id);
    },
  };
}

module.exports = { createTemporarySessions, isTemporarySession };
