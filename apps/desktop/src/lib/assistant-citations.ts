import type { HostedSearchCitation } from "@pi-desktop/shared";

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  url?: string;
  title?: string;
};

type Replacement = { start: number; end: number; nodes: Node[] };

export const EMPTY_ASSISTANT_CITATIONS: readonly HostedSearchCitation[] = [];

/** Render provider annotations without changing the transcript or its source offsets. */
export function remarkAssistantCitations(options: {
  source: string;
  sourceOffset: number;
  citations: readonly HostedSearchCitation[];
}) {
  const citations = options.citations.filter((citation) => {
    try {
      return ["http:", "https:"].includes(new URL(citation.url).protocol);
    } catch {
      return false;
    }
  });
  const numbers = new Map<string, number>();
  for (const citation of citations) {
    if (!numbers.has(citation.url)) numbers.set(citation.url, numbers.size + 1);
  }
  const link = (citation: HostedSearchCitation, text?: string): Node => ({
    type: "link",
    url: citation.url,
    title: citation.title || citation.url,
    children: [{ type: "text", value: text ?? `[${numbers.get(citation.url)}]` }],
  });

  const replaceText = (node: Node): Node[] => {
    const value = node.value ?? "";
    const offset = node.position?.start.offset;
    const replacements: Replacement[] = [];
    let rawCursor = 0;
    // Incomplete streaming markers stay hidden until the closing delimiter arrives.
    const markers = /\uE200cite\uE202[A-Za-z0-9_\-\uE202]*\uE201?|\uE200(?:c(?:i(?:t(?:e)?)?)?)?$/g;
    for (const match of value.matchAll(markers)) {
      const start = match.index;
      const end = start + match[0].length;
      const rawNode = offset === undefined ? "" : options.source.slice(offset, node.position?.end.offset);
      const rawIndex = rawNode.indexOf(match[0], rawCursor);
      if (rawIndex >= 0) rawCursor = rawIndex + match[0].length;
      const absoluteStart = offset === undefined || rawIndex < 0 ? undefined
        : options.sourceOffset + offset + rawIndex;
      const absoluteEnd = absoluteStart === undefined ? undefined : absoluteStart + match[0].length;
      const sources = match[0].endsWith("\uE201") && absoluteStart !== undefined
        ? citations.filter((citation) => citation.startIndex !== undefined && citation.endIndex !== undefined &&
          Number.isSafeInteger(citation.startIndex) && Number.isSafeInteger(citation.endIndex) &&
          citation.startIndex >= absoluteStart && citation.endIndex <= absoluteEnd! &&
          citation.endIndex > citation.startIndex)
        : [];
      const unique = [...new Map(sources.map((citation) => [citation.url, citation])).values()];
      replacements.push({ start, end, nodes: unique.map((citation) => link(citation)) });
    }
    if (offset !== undefined) {
      for (const citation of citations) {
        if (citation.startIndex === undefined || citation.endIndex === undefined) continue;
        const start = citation.startIndex - options.sourceOffset - offset;
        const end = citation.endIndex - options.sourceOffset - offset;
        if (start < 0 || end > value.length || start >= end ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          replacements.some((item) => start < item.end && end > item.start)) continue;
        const text = value.slice(start, end);
        if (!/^\[\d+\]$/.test(text) || options.source.slice(offset + start, offset + end) !== text) continue;
        replacements.push({ start, end, nodes: [link(citation, text)] });
      }
    }
    if (!replacements.length) return [node];
    replacements.sort((a, b) => a.start - b.start);
    const result: Node[] = [];
    let cursor = 0;
    for (const replacement of replacements) {
      if (replacement.start > cursor) result.push({ type: "text", value: value.slice(cursor, replacement.start) });
      result.push(...replacement.nodes);
      cursor = replacement.end;
    }
    if (cursor < value.length) result.push({ type: "text", value: value.slice(cursor) });
    return result;
  };
  const visit = (node: Node): void => {
    if (["code", "inlineCode", "html", "link", "linkReference", "image", "imageReference"].includes(node.type) || !node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return replaceText(child);
      visit(child);
      return [child];
    });
  };
  return visit;
}
