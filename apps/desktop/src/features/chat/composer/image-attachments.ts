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

/**
 * Keep images visible as inline chips when a draft enters the editor. A draft
 * cached before images became chips, a restored queue entry, or a prefill can
 * name an image without a token, so every image gets one and the text carries
 * it; appending in reference order keeps the attachment next to the draft.
 */
export function attachImageTokens(
  text: string,
  references: ComposerFileReference[],
  nextToken: () => string,
): { text: string; references: ComposerFileReference[] } {
  let nextText = text;
  const nextReferences = references.map((reference) => {
    if (!isImageReference(reference)) return reference;
    const token = reference.token ?? nextToken();
    if (!nextText.includes(token)) nextText += token;
    return reference.token ? reference : { ...reference, token };
  });
  return { text: nextText, references: nextReferences };
}
