import { Script } from "node:vm";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * 对刚写入的可视化片段提供静态诊断。
 *
 * Only static checks run here: every inline classic script is compiled (never
 * executed) to catch syntax errors, and string-literal element ids passed to
 * the `viz` helpers or DOM lookups must exist in the fragment. Dynamic ids are
 * not reported, so a passing check never claims more than it verified.
 */

const MAX_ISSUES = 5;
const MAX_LISTED_IDS = 12;

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=/i;
const TYPE_ATTR_RE = /\btype\s*=\s*["']?([^"'\s>]+)/i;
const CLASSIC_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
const HTML_ID_RE = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/gi;
// Ids a script assigns itself: `el.id = "x"`, `setAttribute("id", "x")`, `.attr("id", "x")`.
const SCRIPT_ID_RES = [
  /\.id\s*=\s*(["'`])([^"'`$]+)\1/g,
  /\.(?:setAttribute|attr)\(\s*["']id["']\s*,\s*(["'`])([^"'`$]+)\1/g,
];
const REFERENCE_RES = [
  /\bviz\.(?:render|chart)\(\s*(["'`])#?([^"'`$]+)\1/g,
  /\bgetElementById\(\s*(["'`])([^"'`$]+)\1/g,
  /\bquerySelector\(\s*(["'`])#([A-Za-z_][\w-]*)\1/g,
];

/** Whether `path` is an absolute `.html` path directly under `visualizationsDir`. */
export function isGenUiFragmentPath(path: unknown, visualizationsDir: string | undefined): path is string {
  // Relative Write paths resolve against the workspace, never this directory.
  if (typeof path !== "string" || !isAbsolute(path)) return false;
  if (!visualizationsDir || !isAbsolute(visualizationsDir)) return false;
  if (!path.toLowerCase().endsWith(".html")) return false;
  const rel = relative(resolve(visualizationsDir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !/[\\/]/.test(rel);
}

/** Return static diagnostics, or an empty list when none were found. */
export function checkGenUiFragment(content: string): string[] {
  const issues: string[] = [];
  const scripts: string[] = [];
  let markup = "";
  let last = 0;
  for (const match of content.matchAll(SCRIPT_RE)) {
    markup += content.slice(last, match.index);
    last = match.index + match[0].length;
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (SRC_ATTR_RE.test(attrs)) continue;
    const type = (TYPE_ATTR_RE.exec(attrs)?.[1] ?? "").toLowerCase();
    if (!CLASSIC_TYPES.has(type)) continue;
    scripts.push(body);
    // Module syntax is not valid in a classic script; only classic scripts are compiled.
    if (type === "module") continue;
    const error = syntaxError(body);
    if (error) issues.push(`Script ${scripts.length} does not parse: ${error}`);
  }
  markup += content.slice(last);

  const ids = new Set<string>();
  for (const match of markup.matchAll(HTML_ID_RE)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) ids.add(id);
  }
  const code = scripts.join("\n");
  for (const re of SCRIPT_ID_RES) {
    for (const match of code.matchAll(re)) ids.add(match[2]);
  }
  const missing = new Map<string, string>();
  for (const re of REFERENCE_RES) {
    for (const match of code.matchAll(re)) {
      const id = match[2];
      if (!ids.has(id) && !missing.has(id)) missing.set(id, match[0]);
    }
  }
  if (missing.size > 0) {
    const known = [...ids].slice(0, MAX_LISTED_IDS);
    const list = known.length > 0 ? known.map((id) => `"${id}"`).join(", ") : "none";
    for (const [id, call] of missing) {
      issues.push(`\`${call.trim()}…\` refers to element id "${id}", which the fragment never defines (ids present: ${list}).`);
    }
  }
  return issues.slice(0, MAX_ISSUES);
}

/** Text appended to a successful Write result when the check found problems. */
export function genUiFragmentCheckNote(issues: readonly string[]): string {
  return [
    "",
    "Visualization static check found possible problems. Review and correct the relevant issues:",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

function syntaxError(source: string): string | undefined {
  try {
    // Compiling a Script parses it without running any of its code.
    new Script(source);
    return undefined;
  } catch (error) {
    return error instanceof SyntaxError ? error.message : undefined;
  }
}
