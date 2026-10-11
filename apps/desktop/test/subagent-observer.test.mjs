import assert from "node:assert/strict";
import test from "node:test";
import observerPlugin from "../resources/plugins/local.subagent-observer/main.js";
import { canRevokeRecall, handleSupervisionAction, renderSupervision, translate } from "../resources/plugins/local.subagent-observer/supervision.js";

test("无 delegationId 时 renderSupervision 返回 null", async () => {
  const node = await renderSupervision({ sessionId: "s1" });
  assert.equal(node, null);
});

test("尚未查到快照不显示磁盘或零版本，刷新后显示已保存", async () => {
  let recall = { execution: 1, status: "completed", persistenceState: "pending-validation", source: "disk", canResume: false, snapshotVersion: 0 };
  const context = { sessionId: "s1", delegationId: "del-1", execution: 1, running: false, locale: "zh-CN" };
  const helpers = { desktopInvoke: async () => recall };
  const before = JSON.stringify(await renderSupervision(context, helpers));
  assert.match(before, /快照待查询/);
  assert.doesNotMatch(before, /磁盘|快照 v0/);
  assert.match(before, /刷新状态/);
  await handleSupervisionAction(context, "refresh", helpers);
  recall = { ...recall, canResume: true, snapshotVersion: 1 };
  const after = JSON.stringify(await renderSupervision(context, helpers));
  assert.match(after, /快照已保存/);
  assert.match(after, /快照 v1/);
});

test("运行中子代理展示进度，停止操作统一由宿主提供，不查询 recall", async () => {
  let recallQueried = false;
  const desktopInvoke = async (operation) => {
    if (operation === "subagent/recallStatus") {
      recallQueried = true;
      return { execution: 1, status: "running" };
    }
    throw new Error(`Unexpected operation: ${operation}`);
  };

  const node = await renderSupervision(
    {
      sessionId: "s1",
      delegationId: "del-1",
      execution: 1,
      running: true,
      live: true,
      compact: false,
      locale: "zh-CN",
      collaboration: {
        reportIntervalSteps: 5,
        stepsSinceReport: 2,
        completedSteps: 7,
        intervalSource: "definition",
        phase: "running",
        latestReport: {
          reportSeq: 1,
          fromStep: 1,
          toStep: 5,
          capturedAt: "2026-09-21T10:00:00Z",
          summary: "已完成基础代码扫描",
          steps: [{ seq: 1, toolName: "Read", status: "success", args: "file.js", result: "ok" }],
        },
      },
    },
    { desktopInvoke },
  );

  assert.equal(recallQueried, false);
  assert.equal(node.kind, "column");

  const statusBar = node.children.find((c) => c.key === "status-bar");
  assert.ok(statusBar);
  assert.equal(statusBar.children.find((c) => c.key === "action-stop"), undefined);

  const statusCopy = statusBar.children.find((c) => c.key === "status-copy");
  const reportSummary = statusCopy.children.find((c) => c.key === "report-summary");
  assert.ok(reportSummary.text.includes("下次汇报进度：2 / 5 次调用 · 累计 7 次工具调用"));

  const detailBar = node.children.find((c) => c.key === "detail-bar");
  assert.ok(detailBar);
  const reportDetails = detailBar.children.find((c) => c.key === "detail-latest-report");
  assert.ok(reportDetails);
  assert.equal(reportDetails.kind, "details");
});

test("非运行态且查询 recall 失败时不提供撤销按钮，不抛出异常", async () => {
  const desktopInvoke = async (operation) => {
    if (operation === "subagent/recallStatus") {
      throw new Error("recall storage unavailable");
    }
    return null;
  };

  const node = await renderSupervision(
    {
      sessionId: "s1",
      delegationId: "del-1",
      execution: 1,
      running: false,
      live: false,
      locale: "zh-CN",
    },
    { desktopInvoke },
  );

  assert.ok(node);
  const statusBar = node.children.find((c) => c.key === "status-bar");
  const revokeAction = statusBar.children.find((c) => c.key === "action-revoke");
  assert.equal(revokeAction, undefined);
});

test("非运行态且具 disk 快照时呈现撤销召回按钮与版本徽标", async () => {
  const desktopInvoke = async (operation) => {
    if (operation === "subagent/recallStatus") {
      return {
        execution: 2,
        status: "completed",
        persistenceState: "durable-ready",
        source: "disk",
        snapshotVersion: 3,
        canResume: true,
      };
    }
    return null;
  };

  const node = await renderSupervision(
    {
      sessionId: "s1",
      delegationId: "del-2",
      execution: 2,
      running: false,
      live: false,
      locale: "zh-CN",
    },
    { desktopInvoke },
  );

  const statusBar = node.children.find((c) => c.key === "status-bar");
  const revokeAction = statusBar.children.find((c) => c.key === "action-revoke");
  assert.ok(revokeAction);
  assert.equal(revokeAction.action, "revoke");

  const statusCopy = statusBar.children.find((c) => c.key === "status-copy");
  const persistenceStatus = statusCopy.children.find((c) => c.key === "persistence-status");
  assert.ok(persistenceStatus.text.includes("可召回 · 已保存"));
  assert.ok(persistenceStatus.text.includes("快照 v3"));
});

test("观察插件不再执行运行停止动作", async () => {
  await assert.rejects(() => handleSupervisionAction(
    { sessionId: "s1", delegationId: "del-1", execution: 2, running: true, live: true },
    "stop", { desktopInvoke: async () => { throw new Error("不应发出停止请求"); } },
  ), /Unsupported action: stop/);
});

test("动作保护：revoke 动作重新校验 recall 状态与执行版本，防止越权和历史错撤", async () => {
  const desktopInvoke = async (operation) => {
    if (operation === "subagent/recallStatus") {
      return {
        execution: 1, // 期望为 2，版本不匹配
        status: "completed",
        source: "disk",
      };
    }
    return null;
  };

  await assert.rejects(
    handleSupervisionAction(
      { sessionId: "s1", delegationId: "del-1", execution: 2, running: false },
      "revoke",
      { desktopInvoke },
    ),
    /Subagent execution mismatch or recall not found/,
  );
});

test("动作执行：满足条件的 disk 快照成功撤销召回并更新最新 recall 状态", async () => {
  let recallVersion = 1;
  const calls = [];
  const desktopInvoke = async (operation, args) => {
    calls.push({ operation, args });
    if (operation === "subagent/recallStatus") {
      return {
        execution: 1,
        source: "disk",
        status: recallVersion === 1 ? "completed" : "stopped",
        persistenceState: recallVersion === 1 ? "durable-ready" : "revoked",
      };
    }
    if (operation === "subagent/stop") {
      recallVersion = 2;
      return { ok: true };
    }
    return null;
  };

  const res = await handleSupervisionAction(
    { sessionId: "s1", delegationId: "del-1", execution: 1, running: false },
    "revoke",
    { desktopInvoke },
  );

  assert.equal(res.ok, true);
  assert.equal(res.recall.persistenceState, "revoked");
  assert.equal(calls.length, 3); // initial recall check -> stop -> refreshed recall check
  assert.equal(calls[1].operation, "subagent/stop");
  assert.deepEqual(calls[1].args, [{ sessionId: "s1", delegationId: "del-1", expectedExecution: 1 }]);
});

test("main.js onPanelInvoke 契约与生命周期分发", async () => {
  const renderRes = await observerPlugin.onPanelInvoke("inline.render", {
    viewId: "supervision",
    context: { sessionId: "s1" }, // 无 delegationId
  });
  assert.equal(renderRes, null);

  await assert.rejects(
    observerPlugin.onPanelInvoke("inline.action", {
      viewId: "unknown-view",
      context: {},
    }),
    /Unknown inline view/,
  );

  await assert.rejects(
    observerPlugin.onPanelInvoke("unsupported.channel", { viewId: "supervision", context: {} }),
    /Unsupported inline view channel: unsupported.channel/,
  );
});
