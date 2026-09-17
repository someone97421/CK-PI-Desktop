export function createMutationRecovery({
  api,
  storage,
  uuid,
  onPending = () => {},
}) {
  const key = "lan-remote-pending-mutation";
  let pending = null;
  let sending = false;
  try {
    pending = JSON.parse(storage.getItem(key) || "null");
  } catch {}
  function save(value) {
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
    pending = value;
    onPending(pending);
  }
  async function resolve() {
    if (sending) throw new Error("请求仍在等待响应。");
    if (!pending) return null;
    const record = pending;
    const lookup = await api.mutationStatus(record.id);
    if (pending !== record) throw new Error("提交状态已变化，请重新查询。");
    if (lookup.status === "done") {
      const result = { ...record, result: lookup.result };
      save(null);
      return result;
    }
    if (lookup.status === "failed") {
      save(null);
      throw new Error(lookup.error?.message || "电脑端执行失败");
    }
    throw new Error(
      lookup.status === "pending"
        ? "电脑仍在处理，请继续查询原提交。"
        : "原提交结果无法确定，请核对会话后手动解除未决状态。",
    );
  }
  return {
    get pending() {
      return pending;
    },
    resolve,
    acknowledge: () => {
      if (sending) throw new Error("请求仍在等待响应，不能解除。");
      save(null);
    },
    async mutate(operation, input) {
      if (pending) throw new Error("有未确认的提交，请先查询原提交结果。");
      const record = { id: uuid(), operation, input };
      save(record);
      sending = true;
      try {
        const result = await api.mutate(operation, input, {
          mutationId: record.id,
        });
        save(null);
        return result;
      } catch (error) {
        sending = false;
        if (["NETWORK", "TIMEOUT"].includes(error.code)) {
          const resolved = await resolve();
          return resolved.result;
        }
        save(null);
        throw error;
      } finally {
        sending = false;
      }
    },
  };
}
