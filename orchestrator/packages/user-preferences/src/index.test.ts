import { describe, expect, test } from "bun:test";
import {
  appearanceSchema,
  colorSchemeSchema,
  preferencesDocumentSchema,
  preferencesSnapshotSchema,
  preferencesUpdateSchema,
  DEFAULT_APPEARANCE,
  BUILTIN_SCHEMES,
  FONT_IDS,
} from "./index.ts";

/** Return an independent custom palette for normalization and validation tests. */
const custom = () => ({
  ...structuredClone(BUILTIN_SCHEMES[0]!),
  id: "custom",
  name: "  My scheme  ",
});
describe("user preferences contract", () => {
  test("validates defaults and normalizes imported colors and names", () => {
    expect(appearanceSchema.parse(DEFAULT_APPEARANCE)).toEqual(DEFAULT_APPEARANCE);
    const scheme = custom();
    scheme.light.accent = "#ABCDEF";
    expect(colorSchemeSchema.parse(scheme)).toMatchObject({
      name: "My scheme",
      light: { accent: "#abcdef" },
    });
    expect(
      preferencesDocumentSchema.parse({ version: 1, appearance: DEFAULT_APPEARANCE }).version,
    ).toBe(1);
    expect(
      preferencesSnapshotSchema.safeParse({
        revision: 0,
        document: { version: 1, appearance: DEFAULT_APPEARANCE },
        updatedAt: null,
      }).success,
    ).toBe(true);
  });
  test("Dracula selection survives update, stored document, and snapshot round trips", () => {
    for (const mode of ["light", "dark", "system"] as const) {
      const appearance = { ...DEFAULT_APPEARANCE, mode, schemeId: "dracula" };
      const update = preferencesUpdateSchema.parse({ expectedRevision: 3, appearance });
      const document = preferencesDocumentSchema.parse(
        JSON.parse(JSON.stringify({ version: 1, appearance: update.appearance })),
      );
      const snapshot = preferencesSnapshotSchema.parse({
        revision: update.expectedRevision + 1,
        document,
        updatedAt: "2026-10-02T12:00:00.000Z",
      });
      expect(snapshot.document.appearance).toEqual(appearance);
    }
  });
  test("Dracula is reserved for the built-in scheme; a distinct copy is valid", () => {
    const dracula = BUILTIN_SCHEMES.find((scheme) => scheme.id === "dracula");
    expect(dracula).toBeDefined();
    const replacement = {
      ...dracula!,
      name: "My replacement",
      dark: { ...dracula!.dark, accent: "#ffffff" },
    };
    expect(
      preferencesUpdateSchema.safeParse({
        expectedRevision: 0,
        appearance: { ...DEFAULT_APPEARANCE, schemeId: "dracula", customSchemes: [replacement] },
      }).success,
    ).toBe(false);
    const copy = { ...replacement, id: "my-dracula" };
    expect(
      appearanceSchema.parse({
        ...DEFAULT_APPEARANCE,
        schemeId: copy.id,
        customSchemes: [copy],
      }).customSchemes,
    ).toEqual([copy]);
  });
  test("new presets and fonts survive all mode and persisted document round trips", () => {
    for (const schemeId of ["catppuccin", "nord", "solarized", "gruvbox"]) {
      for (const mode of ["light", "dark", "system"] as const) {
        const appearance = {
          ...DEFAULT_APPEARANCE,
          schemeId,
          mode,
          fonts: { sans: "inter", display: "inter", mono: "fira-code" },
        };
        const update = preferencesUpdateSchema.parse({ expectedRevision: 3, appearance });
        const document = preferencesDocumentSchema.parse(
          JSON.parse(JSON.stringify({ version: 1, appearance: update.appearance })),
        );
        expect(
          preferencesSnapshotSchema.parse({
            revision: 4,
            document,
            updatedAt: "2026-10-02T12:00:00.000Z",
          }).document.appearance,
        ).toEqual(appearance);
      }
    }
  });
  test("new built-in IDs cannot be replaced by custom schemes", () => {
    for (const id of ["catppuccin", "nord", "solarized", "gruvbox"]) {
      const builtin = BUILTIN_SCHEMES.find((scheme) => scheme.id === id);
      expect(builtin).toBeDefined();
      const replacement = { ...builtin!, name: "My replacement" };
      const appearance = { ...DEFAULT_APPEARANCE, schemeId: id, customSchemes: [replacement] };
      expect(preferencesUpdateSchema.safeParse({ expectedRevision: 0, appearance }).success).toBe(
        false,
      );
      const copy = { ...replacement, id: `my-${id}` };
      expect(
        appearanceSchema.parse({ ...appearance, schemeId: copy.id, customSchemes: [copy] })
          .customSchemes,
      ).toEqual([copy]);
    }
  });
  test("the font registry preserves display order and accepts every ID for its role", () => {
    expect(FONT_IDS).toEqual({
      sans: ["system", "saira", "inter"],
      display: ["saira", "inter", "system", "georgia"],
      mono: ["jetbrains", "fira-code", "system"],
    });
    expect(DEFAULT_APPEARANCE.fonts).toEqual({
      sans: "system",
      display: "saira",
      mono: "jetbrains",
    });
    for (const role of ["sans", "display", "mono"] as const) {
      for (const id of FONT_IDS[role]) {
        const appearance = {
          ...DEFAULT_APPEARANCE,
          fonts: { ...DEFAULT_APPEARANCE.fonts, [role]: id },
        };
        expect(
          preferencesUpdateSchema.parse({ expectedRevision: 0, appearance }).appearance.fonts[role],
        ).toBe(id);
      }
    }
  });
  test("new font IDs remain limited to their supported roles", () => {
    for (const fonts of [
      { sans: "fira-code", display: "inter", mono: "fira-code" },
      { sans: "inter", display: "fira-code", mono: "fira-code" },
      { sans: "inter", display: "inter", mono: "inter" },
    ])
      expect(appearanceSchema.safeParse({ ...DEFAULT_APPEARANCE, fonts }).success).toBe(false);
  });
  test("rejects unknown fields at each nested level", () => {
    for (const appearance of [
      { ...DEFAULT_APPEARANCE, userId: "other" },
      { ...DEFAULT_APPEARANCE, fonts: { ...DEFAULT_APPEARANCE.fonts, other: "system" } },
      { ...DEFAULT_APPEARANCE, customSchemes: [{ ...custom(), extra: true }] },
      {
        ...DEFAULT_APPEARANCE,
        customSchemes: [{ ...custom(), light: { ...custom().light, extra: "#ffffff" } }],
      },
    ])
      expect(appearanceSchema.safeParse(appearance).success).toBe(false);
    expect(
      preferencesUpdateSchema.safeParse({
        expectedRevision: 0,
        appearance: DEFAULT_APPEARANCE,
        userId: "other",
      }).success,
    ).toBe(false);
  });
  test("requires existing selected scheme, unique custom IDs, and reserved built-in IDs", () => {
    for (const appearance of [
      { ...DEFAULT_APPEARANCE, schemeId: "missing" },
      { ...DEFAULT_APPEARANCE, customSchemes: [custom(), custom()] },
      { ...DEFAULT_APPEARANCE, customSchemes: [BUILTIN_SCHEMES[0]] },
    ])
      expect(appearanceSchema.safeParse(appearance).success).toBe(false);
    expect(
      appearanceSchema.safeParse({
        ...DEFAULT_APPEARANCE,
        schemeId: "custom",
        customSchemes: [custom()],
      }).success,
    ).toBe(true);
  });
  test("enforces palette, font, version, count, and revision bounds", () => {
    for (const appearance of [
      { ...DEFAULT_APPEARANCE, fonts: { ...DEFAULT_APPEARANCE.fonts, mono: "saira" } },
      { ...DEFAULT_APPEARANCE, version: 2 },
      { ...DEFAULT_APPEARANCE, mode: "automatic" },
      {
        ...DEFAULT_APPEARANCE,
        customSchemes: [{ ...custom(), light: { ...custom().light, accent: "red" } }],
      },
      {
        ...DEFAULT_APPEARANCE,
        customSchemes: Array.from({ length: 51 }, (_, i) => ({ ...custom(), id: `custom-${i}` })),
      },
    ])
      expect(appearanceSchema.safeParse(appearance).success).toBe(false);
    for (const expectedRevision of [-1, 0.5, 2_147_483_647, Number.MAX_SAFE_INTEGER + 1, "0"])
      expect(
        preferencesUpdateSchema.safeParse({ expectedRevision, appearance: DEFAULT_APPEARANCE })
          .success,
      ).toBe(false);
  });
});
