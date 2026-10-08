import type { ThemedToken } from "shiki/core";

export type HighlightRequest = {
  type: "highlight";
  id: number;
  owner: string;
  code: string;
  lang: string;
  theme: string;
};

export type HighlightCommand = HighlightRequest | { type: "release"; owner: string };
export type HighlightReply =
  | { type: "loaded"; id: number }
  | { type: "result"; id: number; tokens: ThemedToken[][] | null };
