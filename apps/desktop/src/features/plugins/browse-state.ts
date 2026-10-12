import { create } from "zustand";
import type { MarketSort, TabId } from "./model";

/** Retain only browsing choices across route unmounts, never dialogs or work. */
export const usePluginBrowseState = create<{
  tab: TabId;
  installedQuery: string;
  query: string;
  category: string;
  marketSort: MarketSort;
  setTab: (tab: TabId) => void;
  setInstalledQuery: (installedQuery: string) => void;
  setQuery: (query: string) => void;
  setCategory: (category: string) => void;
  setMarketSort: (marketSort: MarketSort) => void;
}>((set) => ({
  tab: "installed",
  installedQuery: "",
  query: "",
  category: "",
  marketSort: "default",
  setTab: (tab) => set({ tab }),
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setMarketSort: (marketSort) => set({ marketSort }),
}));
