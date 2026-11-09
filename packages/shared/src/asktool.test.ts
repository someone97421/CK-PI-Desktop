import { describe, expect, it } from "vitest";
import { defaultAskToolAnswers, formatAskToolOutput, type AskToolQuestion } from "./types.js";
import { normalizeAskToolTimeoutMinutes } from "./composer-trigger.js";

describe("asktool output", () => {
  const questions: AskToolQuestion[] = [
    { question: "Preferred color?", options: ["Blue", "Green"] },
    {
      question: "Which platforms?",
      options: [
        { label: "**Web**", description: "Runs in a browser." },
        { label: "Desktop", description: "Installs on the user's computer." },
      ],
      multiSelect: true,
    },
  ];

  it("serializes each question with selected answers and a stable separator", () => {
    expect(formatAskToolOutput(questions, [["Blue"], ["**Web**", "Desktop"]])).toBe(
      "Preferred color?：Blue\n---\nWhich platforms?：**Web**、Desktop",
    );
  });

  it("keeps skipped answers as empty placeholders", () => {
    expect(formatAskToolOutput(questions, [null, ["Desktop"]])).toBe(
      "Preferred color?：\n---\nWhich platforms?：Desktop",
    );
  });
});

describe("提问超时默认答案", () => {
  it.each([
    [["第一个", "第二个（推荐）"], "第二个（推荐）"],
    [["First", "**Second (Recommended)**"], "**Second (Recommended)**"],
    [["第一个", { label: "推荐：第二个", description: "补充说明" }], "推荐：第二个"],
    [["第一个", "第二个【推荐方案】"], "第二个【推荐方案】"],
    [["第一个", "不推荐第二个"], "第一个"],
    [["First", "Not recommended"], "First"],
    [[{ label: "第一个" }, "第二个"], "第一个"],
  ])("优先明确推荐标记，否则回退第一项：%j", (options, expected) => {
    expect(defaultAskToolAnswers([{ question: "选择？", options: options as AskToolQuestion["options"] }]))
      .toEqual([[expected]]);
  });

  it("整组问题都生成默认答案，多选题也只选一项", () => {
    expect(defaultAskToolAnswers([
      { question: "单选？", options: ["A", "B"] },
      { question: "多选？", options: ["C", "D（推荐）"], multiSelect: true },
      { question: "没有选项？", options: [] },
    ])).toEqual([["A"], ["D（推荐）"], null]);
  });

  it.each([undefined, null, -1, 1.5, 1441, Infinity, NaN, "3"])("非法或缺省设置按关闭处理：%s", (value) => {
    expect(normalizeAskToolTimeoutMinutes(value)).toBe(0);
  });

  it.each([0, 1, 1440])("接受有效分钟数：%s", (value) => {
    expect(normalizeAskToolTimeoutMinutes(value)).toBe(value);
  });
});
