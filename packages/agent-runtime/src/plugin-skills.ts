/**
 * Plugin skills: instruction documents a plugin contributes to the agent
 * through `contributes.skills`.
 *
 * Only the catalog — id, name, description — travels into the system prompt;
 * the model loads a body on demand with the `Skill` tool (D174). Reading the
 * files therefore belongs entirely to Electron main, which owns the plugin
 * registry and the permission grants. This module owns the catalog shape and
 * the reuse digest so the sidecar and main agree on both.
 */

/** One catalog entry as the model sees it in the system prompt. */
export type PluginSkillDef = {
  /** `<pluginId>/<skillId>` — the exact id the `Skill` tool expects. */
  id: string;
  name: string;
  description?: string;
};

/**
 * Stable fingerprint of a skill catalog.
 *
 * The runtime compares this before appending a skills section update. Bodies
 * are excluded: the Skill tool reads them through the permission-checked host
 * bridge on each invocation.
 */
export function pluginSkillsDigest(skills?: PluginSkillDef[]): string {
  if (!skills?.length) return "";
  return JSON.stringify(skills.map((skill) => [skill.id, skill.name, skill.description ?? ""]));
}
