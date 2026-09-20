"use strict";
// Execute the production PowerShell walk and embedded owner algorithm. Only Win32
// calls and UIA objects are replaced; no desktop, Office document, or real HWND is queried.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { windowsPowerShellHosts } = require("./powershell-hosts");
const source = fs.readFileSync(path.join(__dirname, "../scripts/windows-read-value.ps1"), "utf8");
const nativePattern = /Add-Type -TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@ \| Out-Null/;
const native = source.match(nativePattern)[1];
assert.match(native, /public static class ValueReaderNative/);
const bootstrapPattern = /Add-Type -ReferencedAssemblies [^\r\n]+ -TypeDefinition @'\r?\n[\s\S]*?\r?\n'@ \| Out-Null/;
assert.match(source, bootstrapPattern);

const bodies = {
  IsWindow: "return Fixture.Exists(hWnd);",
  GetWindowThreadProcessId: "processId = Fixture.Pid(hWnd); return processId == 0 ? 0u : 1u;",
  GetClassName: "return 0;",
  EnumChildWindows: "return true;",
  EnumWindows: "foreach (int id in Fixture.TopLevels) { if (!callback(new IntPtr(id), lParam)) return false; } return true;",
  IsWindowVisible: "return hWnd.ToInt32() != 600;",
  GetWindow: "if (command != 4) throw new Exception(\"not GW_OWNER\"); return Fixture.Owner(hWnd);",
  SendMessageTimeout: "Fixture.Activated = true; result = IntPtr.Zero; return new IntPtr(1);",
};
const replaced = [];
const fakeNative = native.replace(/\s*\[DllImport\([^\n]+\)\]\s*(?:\[return: MarshalAs\([^\n]+\)\]\s*)?public static extern (\w+) (\w+)\(([^;]+)\);/g,
  (_, type, name, args) => {
    assert.ok(bodies[name], `unmocked native entry point: ${name}`);
    replaced.push(name);
    return `\n    public static ${type} ${name}(${args}) { ${bodies[name]} }\n`;
  });
assert.deepEqual(replaced.sort(), Object.keys(bodies).sort());
assert.doesNotMatch(fakeNative, /DllImport|extern/);

const fixture = `
public static class Fixture {
    public static string Mode = Environment.GetEnvironmentVariable("VALUE_READER_CASE");
    public static bool Activated, Read, ProvidersInitialized;
    public static int[] TopLevels = {100, 200, 300, 400, 500, 600, 700, 800};
    public static bool Exists(IntPtr hwnd) {
        int n = hwnd.ToInt32();
        return n == 100 || n == 200 || n == 210 || n == 300 || n == 400 || n == 500 ||
            n == 600 || n == 700 || n == 701 || (n >= 800 && n <= 833);
    }
    public static uint Pid(IntPtr hwnd) {
        if (!Exists(hwnd)) return 0;
        int n = hwnd.ToInt32();
        if (n == 300 || (Read && Mode == "target-pid-change" && n == 100) ||
            (Read && Mode == "root-pid-change" && n == 200)) return 77;
        return 42;
    }
    public static IntPtr Owner(IntPtr hwnd) {
        int n = hwnd.ToInt32();
        if (n == 200) {
            if (Mode == "foreign-only" || (Read && (Mode == "ownership-change" || Mode == "duplicate-ownership-change"))) return new IntPtr(400);
            if (Mode == "ownership-reroute" && !Read) return new IntPtr(210);
            return new IntPtr(100);
        }
        if (n == 210 || n == 300 || n == 600 || n == 833) return new IntPtr(100);
        if (n == 500) return new IntPtr(300);
        if (n == 700) return new IntPtr(701);
        if (n == 701) return new IntPtr(700);
        if (n >= 800 && n < 833) return new IntPtr(n + 1);
        return IntPtr.Zero;
    }
}
public static class ValueReaderProviderBootstrap {
    public static void Initialize() {
        if (Fixture.Activated || Fixture.Read) throw new Exception("late provider initialization");
        if (Fixture.Mode == "provider-failure") throw new Exception("sensitive provider failure");
        Fixture.ProvidersInitialized = true;
    }
}
namespace System.Windows.Automation {
    public class ControlType { public string ProgrammaticName; }
    public class Info {
        public int ProcessId = 42;
        public bool IsEnabled = true, IsOffscreen, IsPassword;
        public string Name = "", AutomationId = "";
        public ControlType ControlType = new ControlType { ProgrammaticName = "ControlType.Window" };
    }
    public class AutomationElement {
        public int Id;
        public Info Current = new Info();
        public AutomationElement Parent;
        public System.Collections.Generic.List<AutomationElement> Children = new System.Collections.Generic.List<AutomationElement>();
        static AutomationElement main, owned, edit;
        public AutomationElement(int id) { Id = id; }
        public AutomationElement Add(AutomationElement child) { Children.Add(child); child.Parent = this; return child; }
        static AutomationElement Editor(int id) {
            var n = new AutomationElement(id);
            n.Current.Name = "\\u6587\\u4ef6\\u540d:";
            n.Current.AutomationId = "1001";
            n.Current.ControlType.ProgrammaticName = "ControlType.Edit";
            return n;
        }
        static void Init() {
            main = new AutomationElement(100);
            owned = new AutomationElement(200);
            var host = owned.Add(new AutomationElement(202));
            host.Current.ControlType.ProgrammaticName = "ControlType.ComboBox";
            host.Current.AutomationId = "FileNameControlHost";
            edit = host.Add(Editor(201));
            if (Fixture.Mode == "duplicate" || Fixture.Mode == "duplicate-ownership-change") main.Add(owned);
            if (Fixture.Mode == "alias") main.Add(Editor(201));
            if (Fixture.Mode == "ambiguous") main.Add(Editor(101));
            if (Fixture.Mode == "password") edit.Current.IsPassword = true;
            var foreign = main.Add(new AutomationElement(900));
            foreign.Current.ProcessId = 77;
            foreign.Add(Editor(901));
        }
        public static AutomationElement FromHandle(IntPtr hwnd) {
            if (!Fixture.ProvidersInitialized) throw new Exception("root acquired before provider initialization");
            if (!Fixture.Activated) throw new Exception("root acquired before activation");
            if (main == null) Init();
            if (hwnd.ToInt32() == 100) return main;
            if (hwnd.ToInt32() == 200) return owned;
            throw new Exception("excluded root acquired");
        }
        public int[] GetRuntimeId() {
            if (Fixture.Mode == "missing-runtime" && Id == 201) return null;
            return new int[] { 42, Id };
        }
        public bool TryGetCurrentPattern(object pattern, out object value) {
            if (Current.IsPassword) throw new Exception("password pattern read");
            value = new ValuePattern();
            if (Fixture.Mode == "hit-pid-change") Current.ProcessId = 77;
            return pattern == ValuePattern.Pattern;
        }
    }
    public class TreeWalker {
        public static TreeWalker RawViewWalker = new TreeWalker();
        public AutomationElement GetFirstChild(AutomationElement n) {
            if (n.Current.ProcessId != 42) throw new Exception("foreign subtree traversed");
            if (Fixture.Mode == "deadline" && n.Id == 200) System.Threading.Thread.Sleep(180);
            return n.Children.Count == 0 ? null : n.Children[0];
        }
        public AutomationElement GetNextSibling(AutomationElement n) {
            var siblings = n.Parent.Children;
            int index = siblings.IndexOf(n) + 1;
            return index < siblings.Count ? siblings[index] : null;
        }
    }
    public class ValuePattern {
        public static object Pattern = new object();
        public ValuePattern Current { get { return this; } }
        public string Value { get { Fixture.Read = true; return "fixture.docx"; } }
    }
    public class TextPattern {
        public static object Pattern = new object();
        public TextPattern DocumentRange { get { return this; } }
        public string GetText(int length) { throw new Exception("unexpected fallback"); }
    }
}
`;

const mockedScript = source
  .replace(/^Add-Type -AssemblyName UIAutomation(?:Client|Types)\r?\n/gm, "")
  .replace(bootstrapPattern, 'if ($env:VALUE_READER_CASE -eq "provider-compile-failure") { throw "sensitive compile failure" }')
  .replace(nativePattern, `Add-Type -TypeDefinition @"\n${fakeNative}\n${fixture}\n"@ | Out-Null`)
  // PowerShell 7 can auto-resolve the real desktop assembly before a same-name fake.
  // Isolate every test type reference so fake HWNDs never reach real UIA providers.
  .replaceAll("System.Windows.Automation", "PiTest.Automation");
assert.doesNotMatch(mockedScript, /System\.Windows\.Automation|Add-Type -AssemblyName UIAutomation|Add-Type -ReferencedAssemblies|RegisterClientSideProvider/);

const skip = process.platform !== "win32" || !process.env.PI_SCRATCH_DIR
  ? "requires Windows PowerShell and PI_SCRATCH_DIR; never falls back to real UIA" : false;

for (const host of windowsPowerShellHosts) {
test(`${host.name}: production root selection and UIA walk with isolated native/provider boundaries`, { skip }, async t => {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR, "value-owned-roots-"));
  const script = path.join(dir, "probe.ps1");
  // UTF-8 BOM also keeps Windows PowerShell 5.1 fixture source decoding deterministic.
  fs.writeFileSync(script, `\ufeff${mockedScript}`);
  function run(mode, maxNodes = 30, deadline = 4500) {
    const result = spawnSync(host.executable, ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", script], {
      input: JSON.stringify({ target: { pid: 42, window_id: 100 }, selector: { name: "文件名:", role: "Edit" },
        limits: { max_chars: 100, max_nodes: maxNodes, deadline_ms: deadline } }),
      encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, TEMP: process.env.PI_SCRATCH_DIR, TMP: process.env.PI_SCRATCH_DIR,
        TMPDIR: process.env.PI_SCRATCH_DIR, VALUE_READER_CASE: mode },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout.trim());
  }
  function unavailable(result, code) {
    assert.equal(result.code, code, JSON.stringify(result));
    assert.equal(result.status, "unavailable");
    assert.ok(!Object.hasOwn(result, "value"));
  }
  try {
    for (const mode of ["provider-failure", "provider-compile-failure"]) {
      await t.test(`${mode}: fails before UIA access without exposing text or a value`, () => {
        const result = run(mode);
        assert.equal(result.status, "error");
        assert.equal(result.code, "provider_initialization_failed");
        assert.equal(result.complete, false);
        assert.equal(result.match_count, 0);
        assert.equal(result.diagnostics.stage, "provider_initialization");
        assert.equal(result.diagnostics.nodes_visited, 0);
        assert.ok(!Object.hasOwn(result, "value"));
        assert.doesNotMatch(JSON.stringify(result), /sensitive/);
      });
    }
    await t.test("owned dialog is searched; independent, hidden, foreign-chain, cyclic and over-depth roots are excluded", () => {
      const result = run("owned");
      assert.equal(result.code, "value_read", JSON.stringify(result));
      assert.equal(result.value, "fixture.docx");
      assert.equal(result.match_count, 1);
      assert.equal(result.diagnostics.roots_scanned, 2);
      assert.equal(result.diagnostics.owned_roots, 1);
      assert.equal(result.diagnostics.candidates_filtered, 6);
      assert.equal(result.diagnostics.nodes_visited, 4);
    });
    for (const mode of ["duplicate", "alias"]) {
      await t.test(`${mode}: shared runtime IDs do not cause ambiguity or consume the four-node budget twice`, () => {
        const result = run(mode, 4);
        assert.equal(result.code, "value_read", JSON.stringify(result));
        assert.equal(result.match_count, 1);
        assert.equal(result.diagnostics.nodes_visited, 4);
      });
    }
    await t.test("distinct matches across main and owned roots are ambiguous", () => {
      const result = run("ambiguous");
      unavailable(result, "ambiguous_match");
      assert.equal(result.match_count, 2);
    });
    await t.test("node and deadline budgets are shared across roots", () => {
      for (const result of [run("owned", 3), run("owned", 1), run("deadline", 30, 100)]) {
        unavailable(result, "partial_search");
        assert.equal(result.complete, false);
        assert.ok(result.diagnostics.nodes_visited <= result.diagnostics.limit);
      }
      const partialMatch = run("ambiguous", 4);
      unavailable(partialMatch, "partial_search");
      assert.equal(partialMatch.match_count, 1);
    });
    await t.test("no match is borrowed from another document or a foreign subtree", () => {
      const result = run("foreign-only");
      unavailable(result, "no_match");
      assert.equal(result.diagnostics.roots_scanned, 1);
      assert.equal(result.diagnostics.nodes_visited, 1);
    });
    for (const mode of ["ownership-change", "duplicate-ownership-change", "ownership-reroute", "root-pid-change", "hit-pid-change", "target-pid-change"]) {
      await t.test(`${mode}: changed identity after pattern read discards value`, () => {
        unavailable(run(mode), mode === "target-pid-change" ? "target_pid_changed" : "root_scope_changed");
      });
    }
    await t.test("password and missing runtime identity fail closed", () => {
      unavailable(run("password"), "password_blocked");
      unavailable(run("missing-runtime"), "search_unavailable");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}
