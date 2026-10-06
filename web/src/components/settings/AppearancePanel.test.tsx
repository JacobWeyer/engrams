import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearancePanel } from "./AppearancePanel";
import { ThemeProvider, useTheme } from "../theme-provider";
import {
  BUILTIN_SCHEMES,
  DEFAULT_APPEARANCE,
  exportScheme,
  type AppearancePreferences,
} from "@/lib/appearance";

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());
let current: AppearancePreferences;
/** Expose provider state so assertions include the stored preference values. */
function Probe() {
  current = useTheme().appearance;
  return null;
}
/** Render appearance controls inside the account fixture. */
function mount() {
  return render(
    <ThemeProvider>
      <Probe />
      <AppearancePanel />
    </ThemeProvider>,
  );
}
/** Read the preference state exposed by the test probe. */
function preferences(): AppearancePreferences {
  return current;
}
/** Select a font or scheme through its accessible control. */
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("AppearancePanel", () => {
  it("selects Dracula in both modes without changing fonts or creating a custom copy", async () => {
    mount();
    const user = userEvent.setup();
    await choose("Heading font", "Georgia");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    await choose("Color scheme", "Dracula");
    expect(preferences().schemeId).toBe("dracula");
    expect(preferences().mode).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#282a36");
    await user.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#fffbeb");
    expect(preferences().schemeId).toBe("dracula");
    expect(preferences().fonts.display).toBe("georgia");
    expect(preferences().customSchemes).toEqual([]);
  });
  it.each([
    ["catppuccin", "Catppuccin"],
    ["nord", "Nord"],
    ["solarized", "Solarized"],
    ["gruvbox", "Gruvbox"],
  ])("selects %s in both modes and keeps independent font choices", async (id, label) => {
    mount();
    await choose("Body font", "Inter");
    await choose("Heading font", "Georgia");
    await choose("Code font", "Fira Code");
    const scheme = BUILTIN_SCHEMES.find((candidate) => candidate.id === id)!;
    expect(scheme).toBeDefined();
    await choose("Color scheme", label);
    expect(preferences().schemeId).toBe(id);
    const user = userEvent.setup();
    for (const mode of ["light", "dark"] as const) {
      await user.click(screen.getByRole("button", { name: mode === "light" ? "Light" : "Dark" }));
      expect(preferences().mode).toBe(mode);
      expect(document.documentElement.style.getPropertyValue("--background")).toBe(
        scheme[mode].background,
      );
      expect(preferences().fonts).toEqual({ sans: "inter", display: "georgia", mono: "fira-code" });
      expect(preferences().customSchemes).toEqual([]);
    }
  });
  it("chooses Inter headings without changing the body or code font", async () => {
    mount();
    await choose("Heading font", "Inter");
    expect(preferences().fonts).toEqual({ sans: "system", display: "inter", mono: "jetbrains" });
    expect(document.documentElement.style.getPropertyValue("--appearance-font-display")).toContain(
      "Inter Variable",
    );
  });
  it("changes mode and fonts independently and restores defaults", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Use system setting" }));
    expect(preferences().mode).toBe("system");
    await choose("Body font", "Saira");
    await choose("Heading font", "Georgia");
    await choose("Code font", "System monospace");
    expect(preferences().fonts).toEqual({ sans: "saira", display: "georgia", mono: "system" });
    await user.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(preferences()).toEqual(DEFAULT_APPEARANCE);
    expect(screen.getByRole("status").textContent).toBe("Appearance reset to defaults.");
  });
  it("previews custom colors before saving and discards a cancelled edit", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create custom scheme" }));
    fireEvent.change(screen.getByLabelText("Scheme name"), { target: { value: "Night desk" } });
    fireEvent.change(screen.getByLabelText("Light page color"), { target: { value: "#ffffff" } });
    fireEvent.change(screen.getByLabelText("Light text color"), { target: { value: "#ffffff" } });
    expect(screen.getByText(/Below the 4.5:1 target/)).toBeTruthy();
    expect(preferences().customSchemes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save scheme" }));
    expect(preferences().customSchemes[0]!.name).toBe("Night desk");
    expect(preferences().customSchemes[0]!.light.background).toBe("#ffffff");
    expect(preferences().schemeId).toBe(preferences().customSchemes[0]!.id);
    await user.click(screen.getByRole("button", { name: "Edit scheme" }));
    fireEvent.change(screen.getByLabelText("Scheme name"), { target: { value: "Discard me" } });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(preferences().customSchemes[0]!.name).toBe("Night desk");
    await user.click(screen.getByRole("button", { name: "Delete scheme" }));
    expect(preferences().customSchemes).toEqual([]);
    expect(preferences().schemeId).toBe(DEFAULT_APPEARANCE.schemeId);
  });
  it("rejects malformed imports, previews valid imports, and exports both palettes", async () => {
    mount();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText("Color scheme JSON"), { target: { value: "{bad}" } });
    await user.click(screen.getByRole("button", { name: "Import scheme" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(preferences().customSchemes).toHaveLength(0);
    const imported = { ...BUILTIN_SCHEMES[1]!, id: "shared-desk", name: "Shared desk" };
    fireEvent.change(screen.getByLabelText("Color scheme JSON"), {
      target: { value: exportScheme(imported) },
    });
    await user.click(screen.getByRole("button", { name: "Import scheme" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>("Scheme name").value).toBe("Shared desk");
    expect(preferences().customSchemes).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save scheme" }));
    await user.click(screen.getByRole("button", { name: "Export scheme" }));
    const result = JSON.parse(
      screen.getByLabelText<HTMLTextAreaElement>("Color scheme JSON").value,
    );
    expect(result).toEqual(preferences().customSchemes[0]);
    expect(result.light).toEqual(imported.light);
    expect(result.dark).toEqual(imported.dark);
  });
  it("can export a preset and import it as a custom copy", async () => {
    mount();
    const user = userEvent.setup();
    await choose("Color scheme", "Slate");
    await user.click(screen.getByRole("button", { name: "Export scheme" }));
    await user.click(screen.getByRole("button", { name: "Import scheme" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save scheme" }));
    expect(preferences().schemeId).not.toBe("slate");
    expect(preferences().customSchemes[0]!.light).toEqual(BUILTIN_SCHEMES[1]!.light);
    expect(screen.getAllByText("Complete")).toHaveLength(2);
    expect(screen.getAllByText("Needs attention")).toHaveLength(2);
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });
});
