import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    return {
      url: pathToFileURL(join(here, "updater-electron-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  if (specifier === "electron-updater") {
    return {
      url: pathToFileURL(join(here, "updater-electron-updater-stub.mjs")).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
