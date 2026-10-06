import { z } from "zod";

/** The resolved color mode for one device. */
export type Theme = "light" | "dark";
/** The saved mode; each device resolves system mode locally. */
export type AppearanceMode = Theme | "system";
/** The text roles that support separate font choices. */
export type FontRole = "sans" | "display" | "mono";
/** Source colors used to derive UI, syntax, diff, and terminal colors. */
export interface ColorSeeds {
  background: string;
  foreground: string;
  accent: string;
  chrome: string;
}
/** A named pair of light and dark source palettes. */
export interface ColorScheme {
  id: string;
  name: string;
  light: ColorSeeds;
  dark: ColorSeeds;
}
/** The complete appearance group saved for one account. */
export interface AppearancePreferences {
  version: 1;
  mode: AppearanceMode;
  schemeId: string;
  customSchemes: ColorScheme[];
  fonts: Record<FontRole, string>;
}
/** Shared presets. Their IDs are reserved and cannot name custom schemes. */
export const BUILTIN_SCHEMES: ColorScheme[] = [
  {
    id: "engrams",
    name: "Engrams",
    light: { background: "#f1f5ed", foreground: "#223133", accent: "#c6e63a", chrome: "#133738" },
    dark: { background: "#0b1d1e", foreground: "#dce3c9", accent: "#bddc31", chrome: "#061617" },
  },
  {
    id: "slate",
    name: "Slate",
    light: { background: "#f5f7fa", foreground: "#253044", accent: "#2563eb", chrome: "#253044" },
    dark: { background: "#121826", foreground: "#e5eaf3", accent: "#93b4ff", chrome: "#0a1020" },
  },
  {
    id: "sand",
    name: "Sand",
    light: { background: "#faf6ee", foreground: "#3e342c", accent: "#a34b28", chrome: "#44362c" },
    dark: { background: "#211c18", foreground: "#efe3d1", accent: "#efad79", chrome: "#17120e" },
  },
  {
    id: "dracula",
    name: "Dracula",
    // Dracula Classic dark and Alucard Classic light: https://draculatheme.com/spec
    // UI, syntax, and diff text follow the app's contrast rules.
    light: { background: "#fffbeb", foreground: "#1f1f1f", accent: "#644ac9", chrome: "#ceccc0" },
    dark: { background: "#282a36", foreground: "#f8f8f2", accent: "#bd93f9", chrome: "#21222c" },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    // Latte light and Mocha dark: https://catppuccin.com/palette/
    light: { background: "#eff1f5", foreground: "#4c4f69", accent: "#8839ef", chrome: "#e6e9ef" },
    dark: { background: "#1e1e2e", foreground: "#cdd6f4", accent: "#cba6f7", chrome: "#181825" },
  },
  {
    id: "nord",
    name: "Nord",
    // Snow Storm light and Polar Night dark: https://www.nordtheme.com/docs/colors-and-palettes/
    light: { background: "#eceff4", foreground: "#2e3440", accent: "#5e81ac", chrome: "#e5e9f0" },
    dark: { background: "#2e3440", foreground: "#eceff4", accent: "#88c0d0", chrome: "#3b4252" },
  },
  {
    id: "solarized",
    name: "Solarized",
    // Official light and dark palettes: https://ethanschoonover.com/solarized/
    light: { background: "#fdf6e3", foreground: "#586e75", accent: "#268bd2", chrome: "#eee8d5" },
    dark: { background: "#002b36", foreground: "#839496", accent: "#268bd2", chrome: "#073642" },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    // Medium-contrast light and dark palettes: https://github.com/morhetz/gruvbox
    light: { background: "#fbf1c7", foreground: "#3c3836", accent: "#076678", chrome: "#ebdbb2" },
    dark: { background: "#282828", foreground: "#ebdbb2", accent: "#83a598", chrome: "#3c3836" },
  },
];
/** Defaults for anonymous users and accounts with no saved document. */
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 1,
  mode: "light",
  schemeId: "engrams",
  customSchemes: [],
  fonts: { sans: "system", display: "saira", mono: "jetbrains" },
};

/** Accepted font IDs for each role; font loading remains in the web app. */
export const FONT_IDS = {
  sans: ["system", "saira", "inter"],
  display: ["saira", "system", "georgia", "inter"],
  mono: ["jetbrains", "system", "fira-code"],
} as const;
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const hexSchema = z
  .string()
  .regex(/^#[\da-f]{6}$/i)
  .transform((value) => value.toLowerCase());
const colorSeedsSchema = z.strictObject({
  background: hexSchema,
  foreground: hexSchema,
  accent: hexSchema,
  chrome: hexSchema,
});
/** Validate a portable scheme and normalize color case and name spacing. */
export const colorSchemeSchema = z.strictObject({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  light: colorSeedsSchema,
  dark: colorSeedsSchema,
});
/** Reject unknown fields, invalid font roles, duplicate IDs, and missing selections. */
export const appearanceSchema = z
  .strictObject({
    version: z.literal(1),
    mode: z.enum(["light", "dark", "system"]),
    schemeId: idSchema,
    customSchemes: z.array(colorSchemeSchema).max(50),
    fonts: z.strictObject({
      sans: z.enum(FONT_IDS.sans),
      display: z.enum(FONT_IDS.display),
      mono: z.enum(FONT_IDS.mono),
    }),
  })
  .superRefine((value, context) => {
    const ids = new Set(BUILTIN_SCHEMES.map((scheme) => scheme.id));
    value.customSchemes.forEach((scheme, index) => {
      if (ids.has(scheme.id))
        context.addIssue({
          code: "custom",
          path: ["customSchemes", index, "id"],
          message: "Scheme IDs must be unique; built-in IDs are reserved.",
        });
      ids.add(scheme.id);
    });
    if (!ids.has(value.schemeId))
      context.addIssue({
        code: "custom",
        path: ["schemeId"],
        message: "Selected scheme must exist.",
      });
  });
/** Validate the stored document without changing its version. */
export const preferencesDocumentSchema = z.strictObject({
  version: z.literal(1),
  appearance: appearanceSchema,
});
// Keep revisions within the Postgres integer range.
const revisionSchema = z.number().int().min(0).max(2_147_483_647);
/** Validate an API response, including defaults at revision zero. */
export const preferencesSnapshotSchema = z.strictObject({
  revision: revisionSchema,
  document: preferencesDocumentSchema,
  updatedAt: z.iso.datetime().nullable(),
});
/** Require the revision the caller read and leave room for the next revision. */
export const preferencesUpdateSchema = z.strictObject({
  expectedRevision: revisionSchema.max(2_147_483_646),
  appearance: appearanceSchema,
});
/** The versioned account document stored in Postgres. */
export interface UserPreferencesDocument {
  version: 1;
  appearance: AppearancePreferences;
}
/** A confirmed document and its revision; unsaved defaults have no timestamp. */
export interface UserPreferencesSnapshot {
  revision: number;
  document: UserPreferencesDocument;
  updatedAt: string | null;
}
/** A complete appearance replacement guarded by the last confirmed revision. */
export interface UserPreferencesUpdate {
  expectedRevision: number;
  appearance: AppearancePreferences;
}
