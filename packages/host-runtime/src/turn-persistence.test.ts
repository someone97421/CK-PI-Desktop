import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";

import { TurnPersistence } from "./turn-persistence.js";

function row(id: string): UiMessage {
  return { id, role: "assistant", content: id, createdAt: "2026-09-18T00:00:00.000Z", status: "complete" };
}

describe("TurnPersistence", () => {
  it("writes a session's rows in order and reports nothing pending afterwards", async () => {
    const written: string[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call(_method: string, params: { message: UiMessage }) {
          written.push(params.message.id);
        },
      }),
      log: () => undefined,
    });
    const first = persistence.append({ sessionId: "s", message: row("a") });
    const second = persistence.append({ sessionId: "s", message: row("b") });
    expect(persistence.size()).toBe(2);
    await Promise.all([first, second]);
    expect(written).toEqual(["a", "b"]);
    expect(persistence.size()).toBe(0);
  });

  it("retries while host-core is unavailable and lands the row once it is back", async () => {
    let attempts = 0;
    let available = false;
    const sleeps: number[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        isAvailable: () => available,
        async call() {
          attempts += 1;
        },
      }),
      log: () => undefined,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 3) available = true;
      },
    });
    await persistence.append({ sessionId: "s", message: row("a") });
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([100, 250, 500]);
  });

  it("keeps a database failure queued, retries it and does not let later rows pass", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    let fail = true;
    let failed!: () => void;
    const observedFailure = new Promise<void>((resolve) => { failed = resolve; });
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call(_method: string, params: { message: UiMessage }) {
          calls.push(params.message.id);
          if (fail) throw new Error("database or disk is full");
        },
      }),
      log: (_level, message) => logs.push(message),
      sleep: async () => {
        fail = false;
        failed();
      },
    });
    const first = persistence.append({ sessionId: "s", message: row("kept") });
    const second = persistence.append({ sessionId: "s", message: row("later") });
    await observedFailure;
    await Promise.all([first, second]);
    expect(calls).toEqual(["kept", "kept", "later"]);
    expect(logs).toEqual(["transcript append retry scheduled"]);
    expect(persistence.size()).toBe(0);
  });

  it("treats a duplicate message id as already written", async () => {
    const logs: string[] = [];
    const persistence = new TurnPersistence({
      getHost: () => ({
        async call() {
          throw new Error("UNIQUE constraint failed: messages.id");
        },
      }),
      log: (_level, message) => logs.push(message),
    });
    await persistence.append({ sessionId: "s", message: row("dup") });
    expect(logs).toEqual([]);
    expect(persistence.size()).toBe(0);
  });

  it("keeps every restored row when a new append rewrites the queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-turn-persistence-"));
    const queuePath = join(directory, "turn-persistence.json");
    try {
      await writeFile(queuePath, `${JSON.stringify([
        { key: "first", sessionId: "s", message: row("first") },
        { key: "second", sessionId: "s", message: row("second") },
      ])}\n`, "utf8");
      const persistence = new TurnPersistence({
        getHost: () => null,
        log: () => undefined,
        sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
        persistencePath: queuePath,
      });
      const pending = persistence.append({ sessionId: "other", message: row("new") });
      let saved: Array<{ message?: UiMessage }> = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        saved = JSON.parse(await readFile(queuePath, "utf8"));
        if (saved.length === 3) break;
      }
      expect(saved.map((entry) => entry.message?.id)).toEqual(["first", "second", "new"]);
      persistence.dispose();
      await pending;
      expect(JSON.parse(await readFile(queuePath, "utf8"))).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists an unacknowledged row and replays it after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-turn-persistence-"));
    const queuePath = join(directory, "turn-persistence.json");
    try {
      let observedFailure!: () => void;
      const failed = new Promise<void>((resolve) => { observedFailure = resolve; });
      const interrupted = new TurnPersistence({
        getHost: () => ({
          async call() {
            throw new Error("database or disk is full");
          },
        }),
        log: () => undefined,
        sleep: async () => observedFailure(),
        persistencePath: queuePath,
      });
      const pending = interrupted.append({ sessionId: "s", message: row("survives") });
      await failed;
      interrupted.dispose();
      await pending;
      expect(interrupted.size()).toBe(1);
      const saved = JSON.parse(await readFile(queuePath, "utf8")) as Array<{ message?: UiMessage }>;
      expect(saved.map((entry) => entry.message?.id)).toEqual(["survives"]);

      const written: string[] = [];
      const restored = new TurnPersistence({
        getHost: () => ({
          async call(_method: string, params: { message: UiMessage }) {
            written.push(params.message.id);
          },
        }),
        log: () => undefined,
        persistencePath: queuePath,
      });
      await restored.flush();
      restored.dispose();
      expect(written).toEqual(["survives"]);
      expect(JSON.parse(await readFile(queuePath, "utf8"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
