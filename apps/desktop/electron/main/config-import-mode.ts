import { dialog } from "electron";

export type ConfigImportMode = "replace" | "merge" | "skip";

export async function chooseConfigImportMode(input: {
  scopes: readonly string[];
  conflicts: readonly string[];
  removals: readonly string[];
  count: number;
}): Promise<ConfigImportMode | null> {
  const details = [
    `范围：${input.scopes.join("、")}；待应用 ${input.count} 项。`,
    "完整覆盖：替换文件中包含的类别，移除其中未备份的手动条目。",
    "合并更新：更新同名项并添加新项，保留本机其他条目。",
    "仅添加新项：跳过同名条目和已有配置。",
  ];
  if (input.conflicts.length) details.push(`同名或已有配置：\n${input.conflicts.join("\n")}`);
  if (input.removals.length) details.push(`仅完整覆盖会移除：\n${input.removals.join("\n")}`);
  const answer = await dialog.showMessageBox({
    type: input.removals.length ? "warning" : "question",
    title: "导入配置",
    message: "选择配置导入方式",
    detail: details.join("\n\n"),
    buttons: ["完整覆盖", "合并更新", "仅添加新项", "取消"],
    defaultId: 1,
    cancelId: 3,
    noLink: true,
  });
  return (["replace", "merge", "skip"] as const)[answer.response] ?? null;
}
