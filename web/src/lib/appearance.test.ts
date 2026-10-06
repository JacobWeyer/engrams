import { appearanceSchema } from "@engrams/user-preferences";
import { beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getPresetRendererTokens } from "./appearance-palettes";
import {
  APPEARANCE_STORAGE_KEY,
  BUILTIN_SCHEMES,
  DEFAULT_APPEARANCE,
  applyAppearance,
  contrastRatio,
  exportScheme,
  getAppearanceTokens,
  importScheme,
  initializeAppearance,
} from "./appearance";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("imports and exports palettes with strict hex validation", () => {
  const custom = { ...BUILTIN_SCHEMES[1]!, id: "custom-test", name: "Test" };
  expect(importScheme(exportScheme(custom))).toEqual(custom);
  expect(importScheme(exportScheme(BUILTIN_SCHEMES[0]!)).id).toBe("engrams");
  expect(() => importScheme("broken")).toThrow("JSON");
  expect(() =>
    importScheme(JSON.stringify({ ...custom, light: { ...custom.light, accent: "url(evil)" } })),
  ).toThrow("accent must be a six-digit hex color");
  expect(() =>
    appearanceSchema.parse({ ...DEFAULT_APPEARANCE, customSchemes: [BUILTIN_SCHEMES[0]] }),
  ).toThrow("reserved");
});

test("starts with defaults and preserves legacy settings for an explicit account import", () => {
  localStorage.setItem("engrams-theme", "dark");
  expect(initializeAppearance().mode).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(localStorage.getItem("engrams-theme")).toBe("dark");
  expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
});

test("works when storage access throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(initializeAppearance()).toEqual(DEFAULT_APPEARANCE);
});

test("applies custom surfaces and fonts, then restores exact CSS defaults", () => {
  applyAppearance({
    ...DEFAULT_APPEARANCE,
    schemeId: "slate",
    fonts: { sans: "saira", display: "georgia", mono: "system" },
  });
  const root = document.documentElement;
  expect(root.style.getPropertyValue("--background")).toBe("#f5f7fa");
  expect(root.style.getPropertyValue("--work-background")).toMatch(/^#/);
  expect(root.style.getPropertyValue("--section-sidebar-accent")).toMatch(/^#/);
  expect(root.style.getPropertyValue("--appearance-font-display")).toContain("Georgia");
  expect(root.style.getPropertyValue("--appearance-display-stretch")).toBe("normal");
  const css = readFileSync("src/index.css", "utf8");
  expect(css).toContain("--background: var(--work-background)");
  expect(css).toContain("--sidebar-accent: var(--section-sidebar-accent)");
  applyAppearance(DEFAULT_APPEARANCE);
  expect(root.style.getPropertyValue("--background")).toBe("");
  expect(root.style.getPropertyValue("--work-background")).toBe("");
  expect(root.style.getPropertyValue("--appearance-display-stretch")).toBe("108%");
  expect(getAppearanceTokens(BUILTIN_SCHEMES[0]!, "light")).toMatchObject({
    "syntax-keyword": "#892f84",
    "terminal-cursor": "#5f8f3a",
    "terminal-bright-black": "#5a6b63",
  });
});

test("calculates WCAG contrast", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
});

test("Dracula uses its light and dark renderer palettes with readable syntax", () => {
  const dracula = BUILTIN_SCHEMES.find((scheme) => scheme.id === "dracula")!;
  for (const theme of ["light", "dark"] as const) {
    const tokens = getAppearanceTokens(dracula, theme);
    expect(tokens.background).toBe(theme === "dark" ? "#282a36" : "#fffbeb");
    expect(tokens["syntax-keyword"]).toBe(theme === "dark" ? "#ff79c6" : "#a3144d");
    expect(tokens["terminal-bright-blue"]).toBe(theme === "dark" ? "#d6acff" : "#7862d0");
    expect(tokens["git-modified"]).toBe(dracula[theme].accent);
    for (const role of [
      "plain",
      "comment",
      "keyword",
      "string",
      "number",
      "function",
      "type",
      "deleted",
    ])
      expect(
        contrastRatio(tokens[`syntax-${role}`]!, tokens["syntax-background"]!),
      ).toBeGreaterThanOrEqual(4.5);
    applyAppearance({ ...DEFAULT_APPEARANCE, schemeId: "dracula", mode: theme });
    expect(document.documentElement.style.getPropertyValue("--terminal-bright-blue")).toBe(
      tokens["terminal-bright-blue"],
    );
  }
  applyAppearance(DEFAULT_APPEARANCE);
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--terminal-bright-blue")).toBe(
    getAppearanceTokens(BUILTIN_SCHEMES[0]!, "light")["terminal-bright-blue"],
  );
});

test("custom status inks remain readable on the page and scoped work materials", () => {
  for (const scheme of BUILTIN_SCHEMES.slice(1)) {
    for (const theme of ["light", "dark"] as const) {
      const tokens = getAppearanceTokens(scheme, theme);
      for (const status of ["nominal", "caution", "critical"]) {
        expect(
          contrastRatio(tokens[`instrument-${status}-ink`]!, tokens.background!),
        ).toBeGreaterThanOrEqual(4.5);
        for (const material of ["work-pane", "work-card", "work-background"])
          expect(
            contrastRatio(tokens[`work-instrument-${status}-ink`]!, tokens[material]!),
          ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("reversed and medium custom palettes keep derived material text readable in both modes", () => {
  for (const background of ["#000000", "#ffffff", "#777777", "#858585", "#ba26a1"]) {
    const foreground =
      contrastRatio(background, "#000000") > contrastRatio(background, "#ffffff")
        ? "#000000"
        : "#ffffff";
    const seeds = { background, foreground, accent: background, chrome: background };
    for (const theme of ["light", "dark"] as const) {
      const tokens = getAppearanceTokens(
        { id: "custom-reversed", name: "Reversed", light: seeds, dark: seeds },
        theme,
      );
      expect(tokens.foreground).toBe(foreground);
      for (const role of ["card", "popover", "secondary", "accent", "primary"])
        expect(contrastRatio(tokens[`${role}-foreground`]!, tokens[role]!)).toBeGreaterThanOrEqual(
          4.5,
        );
      for (const material of ["background", "card", "popover", "muted"])
        expect(
          contrastRatio(tokens["muted-foreground"]!, tokens[material]!),
        ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens["sidebar-foreground"]!, tokens.sidebar!)).toBeGreaterThanOrEqual(
        4.5,
      );
      for (const material of [
        "work-pane",
        "work-muted",
        "work-card",
        "work-background",
        "work-accent",
        "work-secondary",
      ]) {
        expect(contrastRatio(tokens["work-foreground"]!, tokens[material]!)).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          contrastRatio(tokens["work-muted-foreground"]!, tokens[material]!),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

const ansiRoles = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const presetAnsi = {
  catppuccin: {
    light: [
      "#bcc0cc",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#5c5f77",
      "#acb0be",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#6c6f85",
    ],
    dark: [
      "#45475a",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#bac2de",
      "#585b70",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#a6adc8",
    ],
  },
  nord: {
    light: [
      "#3b4252",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#88c0d0",
      "#e5e9f0",
      "#4c566a",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#8fbcbb",
      "#eceff4",
    ],
    dark: [
      "#3b4252",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#88c0d0",
      "#e5e9f0",
      "#4c566a",
      "#bf616a",
      "#a3be8c",
      "#ebcb8b",
      "#81a1c1",
      "#b48ead",
      "#8fbcbb",
      "#eceff4",
    ],
  },
  solarized: {
    light: [
      "#eee8d5",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#073642",
      "#fdf6e3",
      "#cb4b16",
      "#93a1a1",
      "#839496",
      "#657b83",
      "#6c71c4",
      "#586e75",
      "#002b36",
    ],
    dark: [
      "#073642",
      "#dc322f",
      "#859900",
      "#b58900",
      "#268bd2",
      "#d33682",
      "#2aa198",
      "#eee8d5",
      "#002b36",
      "#cb4b16",
      "#586e75",
      "#657b83",
      "#839496",
      "#6c71c4",
      "#93a1a1",
      "#fdf6e3",
    ],
  },
  gruvbox: {
    light: [
      "#fbf1c7",
      "#cc241d",
      "#98971a",
      "#d79921",
      "#458588",
      "#b16286",
      "#689d6a",
      "#7c6f64",
      "#928374",
      "#9d0006",
      "#79740e",
      "#b57614",
      "#076678",
      "#8f3f71",
      "#427b58",
      "#3c3836",
    ],
    dark: [
      "#282828",
      "#cc241d",
      "#98971a",
      "#d79921",
      "#458588",
      "#b16286",
      "#689d6a",
      "#a89984",
      "#928374",
      "#fb4934",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#ebdbb2",
    ],
  },
};
for (const id of ["catppuccin", "nord", "solarized", "gruvbox"] as const) {
  test(`${id} preserves all reference ANSI colors and readable syntax and diff text in both modes`, () => {
    const scheme = BUILTIN_SCHEMES.find((item) => item.id === id)!;
    const outputs = ["light", "dark"].map((theme) =>
      getAppearanceTokens(scheme, theme === "dark" ? "dark" : "light"),
    );
    for (const theme of ["light", "dark"] as const) {
      const tokens = getAppearanceTokens(scheme, theme);
      const actualAnsi = [
        ...ansiRoles.map((role) => tokens[`terminal-${role}`]),
        ...ansiRoles.map((role) => tokens[`terminal-bright-${role}`]),
      ];
      expect(actualAnsi).toEqual(presetAnsi[id][theme]);
      expect(tokens["terminal-background"]).toBe(scheme[theme].background);
      expect(tokens["syntax-background"]).toBe(scheme[theme].background);
      for (const role of [
        "plain",
        "comment",
        "keyword",
        "string",
        "number",
        "function",
        "type",
        "deleted",
      ])
        expect(
          contrastRatio(tokens[`syntax-${role}`]!, tokens["syntax-background"]!),
        ).toBeGreaterThanOrEqual(4.5);
      for (const role of ["added", "deleted", "modified"])
        expect(
          contrastRatio(tokens[`git-${role}`]!, tokens["syntax-background"]!),
        ).toBeGreaterThanOrEqual(4.5);
      applyAppearance({ ...DEFAULT_APPEARANCE, schemeId: id, mode: theme });
      expect(document.documentElement.style.getPropertyValue("--terminal-bright-cyan")).toBe(
        tokens["terminal-bright-cyan"],
      );
      expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark");
    }
    expect(outputs[0]!["git-modified"]).not.toBe(outputs[1]!["git-modified"]);
    applyAppearance(DEFAULT_APPEARANCE);
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--terminal-bright-cyan")).toBe(
      getAppearanceTokens(BUILTIN_SCHEMES[0]!, "light")["terminal-bright-cyan"],
    );
  });
}

test("Inter and Fira Code fonts have system fallbacks and reset to the existing defaults", () => {
  applyAppearance({
    ...DEFAULT_APPEARANCE,
    fonts: { sans: "inter", display: "inter", mono: "fira-code" },
  });
  const root = document.documentElement;
  expect(root.style.getPropertyValue("--appearance-font-sans")).toContain(
    '"Inter Variable", system-ui',
  );
  expect(root.style.getPropertyValue("--appearance-font-display")).toContain(
    '"Inter Variable", system-ui',
  );
  expect(root.style.getPropertyValue("--appearance-font-mono")).toContain(
    '"Fira Code Variable", ui-monospace',
  );
  expect(root.style.getPropertyValue("--appearance-display-stretch")).toBe("normal");
  applyAppearance(DEFAULT_APPEARANCE);
  expect(root.style.getPropertyValue("--appearance-font-display")).toContain("Saira Variable");
  expect(root.style.getPropertyValue("--appearance-font-mono")).toContain(
    "JetBrains Mono Variable",
  );
  expect(root.style.getPropertyValue("--appearance-display-stretch")).toBe("108%");
});

test("terminal selection text is readable in every preset and mode without changing its background", () => {
  for (const scheme of BUILTIN_SCHEMES) {
    for (const theme of ["light", "dark"] as const) {
      const tokens = getAppearanceTokens(scheme, theme);
      const foreground = tokens["terminal-selection-foreground"]!;
      const background = tokens["terminal-selection"]!;
      expect(foreground).toMatch(/^#[\da-f]{6}$/i);
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      const reference = getPresetRendererTokens(scheme.id, theme);
      if (reference) {
        expect(background).toBe(reference["terminal-selection"]);
        expect(
          contrastRatio(reference["terminal-selection-foreground"]!, background),
        ).toBeGreaterThanOrEqual(4.5);
      }
      applyAppearance({ ...DEFAULT_APPEARANCE, schemeId: scheme.id, mode: theme });
      expect(
        document.documentElement.style.getPropertyValue("--terminal-selection-foreground"),
      ).toBe(foreground);
    }
  }
  applyAppearance(DEFAULT_APPEARANCE);
  expect(document.documentElement.style.getPropertyValue("--terminal-selection-foreground")).toBe(
    "#223133",
  );
});

test("custom selection text remains readable even when every seed has the same color", () => {
  for (const color of ["#000000", "#ffffff", "#777777", "#858585", "#ba26a1"]) {
    const seeds = { background: color, foreground: color, accent: color, chrome: color };
    const scheme = { id: "custom-selection", name: "Selection test", light: seeds, dark: seeds };
    for (const mode of ["light", "dark"] as const) {
      const tokens = getAppearanceTokens(scheme, mode);
      expect(tokens["terminal-selection"]).toBe(color);
      expect(
        contrastRatio(tokens["terminal-selection-foreground"]!, tokens["terminal-selection"]!),
      ).toBeGreaterThanOrEqual(4.5);
      expect(scheme[mode].foreground).toBe(color);
      applyAppearance({
        ...DEFAULT_APPEARANCE,
        customSchemes: [scheme],
        schemeId: scheme.id,
        mode,
      });
      expect(
        document.documentElement.style.getPropertyValue("--terminal-selection-foreground"),
      ).toBe(tokens["terminal-selection-foreground"]);
    }
  }
  applyAppearance(DEFAULT_APPEARANCE);
});
