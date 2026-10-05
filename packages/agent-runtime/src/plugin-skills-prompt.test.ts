import { describe, expect, it } from "vitest";
import {
  pluginSkillsPrompt,
  pluginSkillsPromptSections,
  SKILL_TOOL_NAME,
  type PluginSkillDef,
} from "./plugin-skills-prompt.js";

const skills: PluginSkillDef[] = [
  {
    id: "demo.hello/release-notes",
    name: "Release notes",
    description: "Draft release notes from the changelog.",
  },
  { id: "demo.hello/no-description", name: "Bare" },
];

describe("pluginSkillsPrompt", () => {
  it("returns nothing when no plugin taught a skill", () => {
    expect(pluginSkillsPrompt([])).toBeUndefined();
  });

  it("lists ids, names and descriptions and names the load tool", () => {
    const prompt = pluginSkillsPrompt(skills) ?? "";
    expect(prompt.startsWith("# Skills")).toBe(true);
    expect(prompt).toContain(`\`${SKILL_TOOL_NAME}\` tool`);
    expect(prompt).toContain(
      "- `demo.hello/release-notes` — Release notes: Draft release notes from the changelog.",
    );
    // A skill without a description still has to be addressable.
    expect(prompt).toContain("- `demo.hello/no-description` — Bare");
  });

  it("keeps the document body out of the prompt", () => {
    const prompt = pluginSkillsPrompt([
      { id: "a/b", name: "B", description: "Short line." },
    ]) ?? "";
    expect(prompt).not.toContain("Short line.\n\n");
    expect(prompt.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });
});

it("gives skill IDs collision-free section names and stable catalog ordering", () => {
  const entries = [
    { id: "__proto__", name: "Prototype" }, { id: "runtime", name: "Reserved" },
    { id: "skill:a", name: "Colon" }, { id: "a", name: "A" },
  ];
  const sections = pluginSkillsPromptSections(entries);
  expect(sections).toEqual(pluginSkillsPromptSections([...entries].reverse()));
  expect(Object.keys(sections)).toEqual(Object.keys(pluginSkillsPromptSections([...entries].reverse())));
  expect(sections["skill:__proto__"]).toContain("Prototype");
  expect(sections["skill:runtime"]).toContain("Reserved");
  expect(sections["skill:skill:a"]).toContain("Colon");
  expect(sections["skill:a"]).toContain("A");
  expect(pluginSkillsPromptSections([])).toEqual({});
});
