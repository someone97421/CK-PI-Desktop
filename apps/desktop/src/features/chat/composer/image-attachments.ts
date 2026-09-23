import type { ComposerFileReference } from "./model";

export function isImageReference(reference: ComposerFileReference): boolean {
  return reference.kind === "image" || Boolean(reference.mimeType?.toLowerCase().startsWith("image/"));
}

export function detachImageTokens(
  text: string,
  references: ComposerFileReference[],
  caret: number,
): { text: string; references: ComposerFileReference[]; caret: number } {
  const tokens = new Set(
    references.filter((reference) => isImageReference(reference) && reference.token)
      .map((reference) => reference.token!),
  );
  if (tokens.size === 0) return { text, references, caret };

  const detachedReferences = references.map((reference) => {
    if (!isImageReference(reference) || !reference.token) return reference;
    const { token: _token, ...detached } = reference;
    return detached;
  });
  let detachedText = "";
  let detachedCaret = caret;
  for (let index = 0; index < text.length; index += 1) {
    if (tokens.has(text[index])) {
      if (index < caret) detachedCaret -= 1;
    } else {
      detachedText += text[index];
    }
  }
  return { text: detachedText, references: detachedReferences, caret: Math.max(0, detachedCaret) };
}
