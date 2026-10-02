import { registerHooks } from "node:module";

// Provider IPC tests exercise real discovery/catalog code in Node. Electron's
// native file picker is unrelated and must never open during these tests.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") {
      const source = 'export const dialog = new Proxy({}, { get() { return () => { throw new Error("Unexpected Electron dialog in provider IPC test"); }; } });';
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
