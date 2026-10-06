import type { ThemeRegistration } from "shiki/types";

import { DEFAULT_RENDERER_TOKENS, type Theme } from "./appearance";

// Shiki and Pierre share these scope roles. Colors come from the selected
// appearance scheme through inherited CSS variables. Defaults live in the
// appearance model; light/dark fallbacks preserve the existing palette even
// when a code block is rendered without an appearance provider.

type Role = "plain" | "comment" | "keyword" | "string" | "number" | "function" | "type" | "deleted";

// `git` feeds the diff viewer (@pierre/diffs reads `gitDecoration.*` off the
// theme). They are the app's instrument inks, so an expanded diff agrees with
// the +N / -N counts in its own header rather than falling back to Pierre's
// stock green and red.
type Palette = Record<Role, string> & {
  background: string;
  git: { added: string; deleted: string; modified: string };
};

/** Provide renderer colors when no account appearance variables are present. */
function defaultPalette(theme: Theme): Palette {
  const tokens = DEFAULT_RENDERER_TOKENS[theme];
  return {
    background: tokens["syntax-background"]!,
    plain: tokens["syntax-plain"]!,
    comment: tokens["syntax-comment"]!,
    keyword: tokens["syntax-keyword"]!,
    string: tokens["syntax-string"]!,
    number: tokens["syntax-number"]!,
    function: tokens["syntax-function"]!,
    type: tokens["syntax-type"]!,
    deleted: tokens["syntax-deleted"]!,
    git: {
      added: tokens["git-added"]!,
      deleted: tokens["git-deleted"]!,
      modified: tokens["git-modified"]!,
    },
  };
}

// One scope table, both themes. Ordered least-to-most specific: TextMate takes
// the LAST match, so a later row refines an earlier one.
const SCOPES: Array<[Role, string[]]> = [
  // Identifiers, operators and punctuation are the page, not the highlight.
  // Leaving them at plain ink is what keeps six colours from reading as twenty.
  [
    "plain",
    ["variable", "variable.other", "variable.parameter", "punctuation", "keyword.operator"],
  ],
  ["comment", ["comment", "punctuation.definition.comment"]],
  [
    "keyword",
    [
      "keyword",
      "keyword.control",
      "keyword.operator.expression",
      "keyword.operator.new",
      "storage",
      "storage.type",
      "storage.modifier",
      "variable.language", // self / this / super
      "entity.name.tag", // HTML, JSX, XML
    ],
  ],
  [
    "string",
    [
      "string",
      "string.quoted",
      "string.template",
      "constant.other.symbol", // Ruby :symbols
      "markup.inserted", // a ```diff fence
    ],
  ],
  [
    "number",
    [
      "constant.numeric",
      "constant.language", // true / false / null / nil
      "constant.character",
      "constant.character.escape",
      "support.constant",
    ],
  ],
  [
    "function",
    [
      "entity.name.function",
      "meta.function-call",
      "support.function",
      "support.type.property-name", // JSON keys, CSS properties
      "markup.heading",
    ],
  ],
  [
    "type",
    [
      "entity.name.type",
      "entity.name.class",
      "entity.name.namespace",
      "entity.other.inherited-class",
      "entity.other.attribute-name",
      "support.type",
      "support.class",
    ],
  ],
  ["deleted", ["markup.deleted", "invalid", "invalid.illegal"]],
];

// Emphasis carried by weight/slant rather than a seventh colour.
const FONT_STYLE: Partial<Record<Role, string>> = { comment: "italic" };

/** Bind syntax scopes and diff roles to inherited colors with mode-specific defaults. */
function build(name: string, type: "light" | "dark", palette: Palette): ThemeRegistration {
  /** Use the selected scheme role and retain a standalone renderer fallback. */
  const color = (role: Role | "background") => `var(--syntax-${role}, ${palette[role]})`;
  return {
    name,
    type,
    colors: {
      "editor.foreground": color("plain"),
      "editor.background": color("background"),
      "gitDecoration.addedResourceForeground": `var(--git-added, ${palette.git.added})`,
      "gitDecoration.deletedResourceForeground": `var(--git-deleted, ${palette.git.deleted})`,
      "gitDecoration.modifiedResourceForeground": `var(--git-modified, ${palette.git.modified})`,
    },
    fg: color("plain"),
    bg: color("background"),
    settings: [
      { settings: { foreground: color("plain"), background: color("background") } },
      ...SCOPES.map(([role, scope]) => ({
        scope,
        settings: {
          foreground: color(role),
          ...(FONT_STYLE[role] ? { fontStyle: FONT_STYLE[role] } : {}),
        },
      })),
    ],
  };
}

/** The registered name of each theme — what Shiki and Pierre are told to use. */
export const SYNTAX_THEME_NAMES = { light: "engrams-light", dark: "engrams-dark" } as const;

export const ENGRAMS_LIGHT_THEME = build(
  SYNTAX_THEME_NAMES.light,
  "light",
  defaultPalette("light"),
);
export const ENGRAMS_DARK_THEME = build(SYNTAX_THEME_NAMES.dark, "dark", defaultPalette("dark"));
