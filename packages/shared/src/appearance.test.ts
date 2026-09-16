import { describe, expect, it } from "vitest";
import { isAppearanceSettings, normalizeAppearance, normalizeHexColor, resetModeAppearance } from "./appearance.js";

describe("optional appearance settings", () => {
  it("normalizes HEX without accepting partial or CSS values", () => {
    expect(normalizeHexColor(" #aBc ")).toBe("#AABBCC");
    expect(normalizeHexColor("#123aBc")).toBe("#123ABC");
    for (const value of ["abc", "#12", "#12345", "#12345678", "red", "var(--x)", null]) {
      expect(normalizeHexColor(value)).toBeUndefined();
    }
  });

  it("validates known colors and fonts while allowing future keys", () => {
    expect(isAppearanceSettings({})).toBe(true);
    expect(isAppearanceSettings({ light: { ui: { family: "'Inter', sans-serif", weight: 500 }, accent: "#abc", future: 1 } })).toBe(true);
    for (const value of [null, [], { light: [] }, { dark: { code: { weight: 950 } } }, { light: { ui: { family: "x; color: red" } } }, { dark: { accent: "red" } }]) {
      expect(isAppearanceSettings(value)).toBe(false);
    }
  });

  it("normalizes corrupted optional fields without discarding future settings", () => {
    expect(normalizeAppearance(undefined)).toBeUndefined();
    expect(normalizeAppearance({ future: true, light: { accent: "#abc", background: "bad", ui: { family: "Inter", weight: 999 }, future: 7 }, dark: null }))
      .toEqual({ future: true, light: { accent: "#AABBCC", ui: { family: "Inter" }, future: 7 } });
  });

  it("resets only the selected mode's known appearance fields", () => {
    const appearance = { light: { accent: "#ABCDEF", ui: { weight: 600 }, future: 1 }, dark: { background: "#121212" } };
    const settings = { theme: "system", fontFamily: "Inter", fontScale: 1.2, appearance, future: "keep" };
    const next = { ...settings, appearance: resetModeAppearance(appearance, "light") };
    expect(next).toEqual({ ...settings, appearance: { light: { future: 1 }, dark: appearance.dark } });
    expect(appearance.light.accent).toBe("#ABCDEF");
  });
});
