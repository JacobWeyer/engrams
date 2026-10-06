import {
  BUILTIN_SCHEMES,
  DEFAULT_APPEARANCE,
  colorSchemeSchema,
  type AppearanceMode,
  type AppearancePreferences,
  type ColorScheme,
  type Theme,
} from "@engrams/user-preferences";
export { BUILTIN_SCHEMES, DEFAULT_APPEARANCE } from "@engrams/user-preferences";
export type {
  Theme,
  AppearanceMode,
  FontRole,
  ColorSeeds,
  ColorScheme,
  AppearancePreferences,
} from "@engrams/user-preferences";

import { getPresetRendererTokens } from "./appearance-palettes";

export const APPEARANCE_STORAGE_KEY = "engrams-appearance-v1";
const system =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
const inter = '"Inter Variable", ' + system;
const saira = '"Saira Variable", ' + system;
const jetbrains = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace';
const systemMono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const firaCode = '"Fira Code Variable", ' + systemMono;
export const FONT_OPTIONS = {
  sans: [
    { id: "system", label: "System", family: system },
    { id: "saira", label: "Saira", family: saira },
    { id: "inter", label: "Inter", family: inter },
  ],
  display: [
    { id: "saira", label: "Saira", family: saira },
    { id: "inter", label: "Inter", family: inter },
    { id: "system", label: "System", family: system },
    { id: "georgia", label: "Georgia", family: 'Georgia, "Times New Roman", serif' },
  ],
  mono: [
    { id: "jetbrains", label: "JetBrains Mono", family: jetbrains },
    { id: "fira-code", label: "Fira Code", family: firaCode },
    { id: "system", label: "System monospace", family: systemMono },
  ],
};
/** Validate imported colors and report the first invalid palette field. */
function validateScheme(value: unknown): ColorScheme {
  const result = colorSchemeSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const color = issue.path.at(-1);
  if (["background", "foreground", "accent", "chrome"].includes(String(color)))
    throw new Error(`${String(color)} must be a six-digit hex color, such as #223133.`);
  throw new Error(issue.message);
}
/** Parse and validate a shared color-scheme document. */
export function importScheme(json: string): ColorScheme {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Scheme JSON is not valid.");
  }
  return validateScheme(value);
}
/** Export a validated color scheme with both mode palettes. */
export function exportScheme(scheme: ColorScheme): string {
  return JSON.stringify(validateScheme(scheme), null, 2);
}
/** Find the selected scheme, with the default as a safe fallback. */
export function resolveScheme(preferences: AppearancePreferences): ColorScheme {
  return (
    BUILTIN_SCHEMES.find((scheme) => scheme.id === preferences.schemeId) ??
    preferences.customSchemes.find((scheme) => scheme.id === preferences.schemeId) ??
    BUILTIN_SCHEMES[0]!
  );
}
/** Resolve system mode on this device without changing the saved mode. */
export function resolvedTheme(mode: AppearanceMode): Theme {
  return mode === "system"
    ? typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : mode;
}
/** Decode a six-digit hex color into byte-valued RGB channels. */
function rgb(hex: string): number[] {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}
/** Calculate relative luminance from linearized sRGB channels. */
function luminance(hex: string): number {
  const c = rgb(hex).map((value) => {
    const x = value / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
}
/** Calculate the WCAG contrast ratio between two literal hex colors. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Blend two RGB colors by the supplied fraction of the second color. */
function mix(a: string, b: string, amount: number): string {
  const x = rgb(a),
    y = rgb(b);
  return (
    "#" +
    x
      .map((v, i) =>
        Math.round(v * (1 - amount) + y[i]! * amount)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
/** Choose black or white text for the greater background contrast. */
function ink(background: string): string {
  return contrastRatio(background, "#ffffff") > contrastRatio(background, "#000000")
    ? "#ffffff"
    : "#000000";
}
/** Derive a surface while keeping black or white text at 4.5:1 contrast. */
function surface(background: string, target: string, amount: number): string {
  const foreground = ink(background);
  for (let step = 20; step >= 0; step--) {
    const candidate = mix(background, target, (amount * step) / 20);
    if (contrastRatio(foreground, candidate) >= 4.5) return candidate;
  }
  return background;
}

/** Keep the preferred text color when it meets 4.5:1 background contrast. */
function readable(color: string, background: string): string {
  return readableOn(color, [background]);
}
/** Adjust text toward black or white until it is readable on every surface. */
function readableOn(color: string, backgrounds: string[]): string {
  const clears = (candidate: string) =>
    backgrounds.every((background) => contrastRatio(candidate, background) >= 4.5);
  if (clears(color)) return color;
  const score = (candidate: string) =>
    Math.min(...backgrounds.map((background) => contrastRatio(candidate, background)));
  const target = score("#ffffff") > score("#000000") ? "#ffffff" : "#000000";
  for (let step = 1; step <= 20; step++) {
    const adjusted = mix(color, target, step / 20);
    if (clears(adjusted)) return adjusted;
  }
  return target;
}

export const DEFAULT_RENDERER_TOKENS: Record<Theme, Record<string, string>> = {
  light: {
    "syntax-background": "#eef3e9",
    "syntax-plain": "#223133",
    "syntax-comment": "#3f5455",
    "syntax-keyword": "#892f84",
    "syntax-string": "#0f6a31",
    "syntax-number": "#954f00",
    "syntax-function": "#0060c1",
    "syntax-type": "#006d6d",
    "syntax-deleted": "#c2181d",
    "git-added": "#0a7e3a",
    "git-deleted": "#c2181d",
    "git-modified": "#0060c1",
    "terminal-background": "#eef3e7",
    "terminal-foreground": "#223133",
    "terminal-cursor": "#5f8f3a",
    "terminal-cursor-accent": "#eef3e7",
    "terminal-selection": "#dae7c8",
    "terminal-selection-foreground": "#223133",
    "terminal-black": "#1c2b29",
    "terminal-red": "#d9544d",
    "terminal-green": "#7faa3f",
    "terminal-yellow": "#c7a83c",
    "terminal-blue": "#4f93c9",
    "terminal-magenta": "#c56aa6",
    "terminal-cyan": "#3fa79b",
    "terminal-white": "#cdd9c4",
    "terminal-bright-black": "#5a6b63",
    "terminal-bright-red": "#e8736b",
    "terminal-bright-green": "#9bc457",
    "terminal-bright-yellow": "#dcc24f",
    "terminal-bright-blue": "#6fb0e0",
    "terminal-bright-magenta": "#d98cc0",
    "terminal-bright-cyan": "#5fc4b6",
    "terminal-bright-white": "#eef3e8",
  },
  dark: {
    "syntax-background": "#0f2122",
    "syntax-plain": "#d8e3ca",
    "syntax-comment": "#aab29e",
    "syntax-keyword": "#e69fdb",
    "syntax-string": "#7cd591",
    "syntax-number": "#ebb76c",
    "syntax-function": "#85beff",
    "syntax-type": "#73d1ca",
    "syntax-deleted": "#ff716b",
    "git-added": "#5fd37f",
    "git-deleted": "#ff716b",
    "git-modified": "#85beff",
    "terminal-background": "#11201d",
    "terminal-foreground": "#d7e4cf",
    "terminal-cursor": "#b6e84a",
    "terminal-cursor-accent": "#11201d",
    "terminal-selection": "#21332f",
    "terminal-selection-foreground": "#d7e4cf",
    "terminal-black": "#1c2b29",
    "terminal-red": "#d9544d",
    "terminal-green": "#7faa3f",
    "terminal-yellow": "#c7a83c",
    "terminal-blue": "#4f93c9",
    "terminal-magenta": "#c56aa6",
    "terminal-cyan": "#3fa79b",
    "terminal-white": "#cdd9c4",
    "terminal-bright-black": "#5a6b63",
    "terminal-bright-red": "#e8736b",
    "terminal-bright-green": "#9bc457",
    "terminal-bright-yellow": "#dcc24f",
    "terminal-bright-blue": "#6fb0e0",
    "terminal-bright-magenta": "#d98cc0",
    "terminal-bright-cyan": "#5fc4b6",
    "terminal-bright-white": "#eef3e8",
  },
};

/** Build semantic surface and renderer colors for the selected mode. */
export function getAppearanceTokens(scheme: ColorScheme, theme: Theme): Record<string, string> {
  const { background: bg, foreground: fg, accent, chrome } = scheme[theme];
  const dark = theme === "dark",
    chromeInk = ink(chrome),
    accentInk = ink(accent);
  const tokens: Record<string, string> = {};
  if (scheme.id !== "engrams") {
    Object.assign(tokens, {
      background: bg,
      foreground: fg,
      card: surface(bg, "#ffffff", luminance(bg) < 0.179 ? 0.05 : 0.5),
      "card-foreground": fg,
      popover: surface(bg, "#ffffff", luminance(bg) < 0.179 ? 0.07 : 0.6),
      "popover-foreground": fg,
      primary: accent,
      "primary-foreground": accentInk,
      secondary: surface(bg, fg, 0.07),
      "secondary-foreground": fg,
      muted: surface(bg, fg, 0.06),
      "muted-foreground": mix(fg, bg, 0.25),
      accent: surface(bg, fg, 0.09),
      "accent-foreground": fg,
      border: mix(bg, fg, 0.16),
      input: mix(bg, fg, 0.2),
      ring: contrastRatio(accent, bg) >= 3 ? accent : mix(accent, fg, 0.5),
      shell: chrome,
      pane: mix(bg, chrome, 0.12),
      sidebar: surface(chrome, "#000000", 0.22),
      "sidebar-foreground": chromeInk,
      "sidebar-primary": accent,
      "sidebar-primary-foreground": accentInk,
      "sidebar-accent": surface(chrome, chromeInk, 0.13),
      "sidebar-accent-foreground": chromeInk,
      "sidebar-border": mix(chrome, chromeInk, 0.18),
      "sidebar-ring": accent,
      "section-sidebar-accent": surface(chrome, chromeInk, 0.16),
      "section-sidebar-accent-foreground": chromeInk,
      "section-sidebar-border": mix(chrome, chromeInk, 0.18),
      "section-divider": mix(chrome, chromeInk, 0.18),
      "mark-terminal": accent,
    });
    const work = dark ? mix(bg, chrome, 0.2) : mix(chrome, chromeInk, 0.08),
      workInk = ink(work);
    Object.assign(tokens, {
      "work-pane": work,
      "work-muted": surface(work, "#000000", 0.12),
      "work-background": surface(work, workInk, 0.16),
      "work-card": surface(work, workInk, 0.07),
      "work-foreground": workInk,
      "work-card-foreground": workInk,
      "work-popover": surface(work, workInk, 0.07),
      "work-popover-foreground": workInk,
      "work-muted-foreground": mix(workInk, work, 0.2),
      "work-accent": surface(work, workInk, 0.12),
      "work-accent-foreground": workInk,
      "work-secondary": surface(work, workInk, 0.1),
      "work-secondary-foreground": workInk,
      "work-border": mix(work, workInk, 0.22),
      "work-input": mix(work, workInk, 0.25),
      "work-ring": accent,
    });
  }
  const green = dark ? "#94d69d" : "#28683b",
    red = dark ? "#f1a5a5" : "#a53030";
  Object.assign(tokens, {
    "syntax-plain": fg,
    "syntax-background": bg,
    "syntax-comment": mix(fg, bg, 0.35),
    "syntax-keyword": dark ? "#d8a4eb" : "#78449a",
    "syntax-string": green,
    "syntax-number": dark ? "#efc17e" : "#865215",
    "syntax-function": dark ? "#9ac9f0" : "#246094",
    "syntax-type": dark ? "#82d8cf" : "#146d65",
    "syntax-deleted": red,
    "git-added": green,
    "git-deleted": red,
    "terminal-background": bg,
    "terminal-foreground": fg,
    "terminal-cursor": accent,
    "terminal-cursor-accent": accentInk,
    "terminal-selection": mix(bg, accent, 0.3),
    "terminal-selection-foreground": fg,
  });
  tokens["git-modified"] = tokens["syntax-function"]!;
  const rendererPreset = getPresetRendererTokens(scheme.id, theme);
  if (rendererPreset) Object.assign(tokens, rendererPreset);
  // Selection uses its own text color. Preserve ANSI colors for normal cells.
  tokens["terminal-selection-foreground"] = readable(
    tokens["terminal-selection-foreground"]!,
    tokens["terminal-selection"]!,
  );
  if (scheme.id !== "engrams") {
    for (const role of [
      "plain",
      "comment",
      "keyword",
      "string",
      "number",
      "function",
      "type",
      "deleted",
    ] as const) {
      tokens[`syntax-${role}`] = readable(tokens[`syntax-${role}`]!, bg);
    }
    for (const role of ["added", "deleted", "modified"] as const)
      tokens[`git-${role}`] = readable(tokens[`git-${role}`]!, bg);
    const status = { nominal: "#0a7e3a", caution: "#945900", critical: "#c2181d" };
    for (const [name, color] of Object.entries(status)) {
      const pageColor = readableOn(color, [bg, tokens.card!]);
      const workColor = readableOn(color, [
        tokens["work-pane"]!,
        tokens["work-card"]!,
        tokens["work-background"]!,
      ]);
      tokens[`instrument-${name}`] = pageColor;
      tokens[`instrument-${name}-ink`] = pageColor;
      tokens[`work-instrument-${name}`] = workColor;
      tokens[`work-instrument-${name}-ink`] = workColor;
    }
    for (const role of ["card", "popover", "secondary", "accent"] as const)
      tokens[`${role}-foreground`] = readable(fg, tokens[role]!);
    tokens["muted-foreground"] = readableOn(tokens["muted-foreground"]!, [
      bg,
      tokens.muted!,
      tokens.card!,
      tokens.popover!,
    ]);
    tokens["sidebar-foreground"] = readableOn(chromeInk, [tokens.sidebar!, chrome]);
    tokens["sidebar-accent-foreground"] = readable(chromeInk, tokens["sidebar-accent"]!);
    tokens["section-sidebar-accent-foreground"] = readable(
      chromeInk,
      tokens["section-sidebar-accent"]!,
    );
    tokens["work-muted-foreground"] = readableOn(tokens["work-muted-foreground"]!, [
      tokens["work-pane"]!,
      tokens["work-muted"]!,
      tokens["work-card"]!,
      tokens["work-background"]!,
    ]);
    tokens.destructive = tokens["instrument-critical-ink"]!;
    tokens["work-destructive"] = tokens["work-instrument-critical-ink"]!;
  }
  const ansi = {
    black: "#222733",
    red: "#c95c54",
    green: "#7eaa71",
    yellow: "#cba85d",
    blue: "#6698c9",
    magenta: "#b287be",
    cyan: "#63aba8",
    white: "#d5d9e0",
  };
  if (!rendererPreset)
    for (const [name, color] of Object.entries(ansi)) {
      tokens[`terminal-${name}`] = color;
      tokens[`terminal-bright-${name}`] = mix(color, "#ffffff", 0.25);
    }
  if (scheme.id === "engrams") return { ...DEFAULT_RENDERER_TOKENS[theme] };
  return tokens;
}
let appliedColorKeys: string[] = [];
/** Apply account colors and font stacks, removing tokens from the previous scheme. */
export function applyAppearance(
  preferences: AppearancePreferences,
  theme = resolvedTheme(preferences.mode),
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  for (const key of appliedColorKeys) root.style.removeProperty(`--${key}`);
  const tokens = getAppearanceTokens(resolveScheme(preferences), theme);
  for (const [key, value] of Object.entries(tokens)) root.style.setProperty(`--${key}`, value);
  appliedColorKeys = Object.keys(tokens);
  for (const role of ["sans", "display", "mono"] as const)
    root.style.setProperty(
      `--appearance-font-${role}`,
      FONT_OPTIONS[role].find((font) => font.id === preferences.fonts[role])!.family,
    );
  root.style.setProperty(
    "--appearance-display-stretch",
    preferences.fonts.display === "saira" ? "108%" : "normal",
  );
}
/** Apply defaults before authentication resolves the account-specific cache. */
export function initializeAppearance(): AppearancePreferences {
  const preferences = {
    ...DEFAULT_APPEARANCE,
    fonts: { ...DEFAULT_APPEARANCE.fonts },
    customSchemes: [],
  };
  applyAppearance(preferences);
  return preferences;
}
