import type { ComposerFileReference } from "./model";

export function isImageReference(reference: ComposerFileReference): boolean {
  return reference.kind === "image" || Boolean(reference.mimeType?.toLowerCase().startsWith("image/"));
}
