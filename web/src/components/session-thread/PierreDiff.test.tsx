import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { resolveTheme } from "@pierre/diffs";
import { beforeEach, expect, test } from "vitest";

import PierreDiff from "./PierreDiff";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import type { Theme } from "@/lib/appearance";
import { SYNTAX_THEME_NAMES } from "@/lib/syntax-theme";

// The diff viewer keeps its own Shiki instance, so the ONE thing holding it to
// the same palette as a fenced code block is the theme we register with it.
// These cover both halves of that: Pierre resolves the theme we registered, and
// what it paints is our palette, on the ground the APP chose.

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

const BEFORE = 'def greet(name):\n    return "hi"\n';
const AFTER = 'def greet(name: str) -> str:\n    return f"hello {name}"\n';

function ThemeChoice() {
  const { setTheme } = useTheme();
  return <button onClick={() => setTheme("dark")}>Select dark</button>;
}

async function renderDiff(theme: Theme = "light") {
  const { container } = render(
    <ThemeProvider>
      <ThemeChoice />
      <PierreDiff path="app/greet.py" before={BEFORE} after={AFTER} />
    </ThemeProvider>,
  );
  if (theme === "dark") fireEvent.click(container.querySelector("button")!);
  const shadow = () => container.querySelector("diffs-container")?.shadowRoot?.innerHTML ?? "";
  await waitFor(
    () => {
      expect(shadow()).toContain("hello");
      expect(shadow()).toContain(`color-scheme: ${theme}`);
    },
    { timeout: 10_000 },
  );
  return shadow().toLowerCase();
}

test("registers the engrams themes with Pierre", async () => {
  for (const name of [SYNTAX_THEME_NAMES.light, SYNTAX_THEME_NAMES.dark]) {
    const theme = await resolveTheme(name);
    expect(theme.name).toBe(name);
    // Pierre reads its add/delete/modify colours off these keys. Without them
    // an expanded diff silently falls back to Pierre's stock green and red and
    // stops matching the +N / −N counts in its own header.
    expect(theme.colors?.["gitDecoration.addedResourceForeground"]).toContain("var(--git-");
    expect(theme.colors?.["gitDecoration.deletedResourceForeground"]).toContain("var(--git-");
  }
});

test("paints a diff in the engrams palette", async () => {
  const html = await renderDiff();

  // Keyword violet and string emerald — the same values a ```python fence uses.
  expect(html).toContain("#892f84");
  expect(html).toContain("#0f6a31");
  // Pierre's stock add/delete green and red are gone.
  expect(html).not.toContain("#0dbe4e");
  expect(html).not.toContain("#ff2e3f");
});

test("follows the app's theme, not the operating system's", async () => {
  expect(await renderDiff()).toContain("color-scheme: light");

  // An explicit app choice overrides the operating system. Pierre's own
  // system mode must not make a second, different decision.
  cleanup();
  expect(await renderDiff("dark")).toContain("color-scheme: dark");
});

test("inherits custom syntax and git roles through Pierre's shadow root", async () => {
  const html = await renderDiff();
  expect(html).toContain("--diffs-token-light:var(--syntax-keyword,");
  expect(html).toContain("--diffs-token-dark:var(--syntax-keyword,");
  expect(html).toContain("--diffs-light-addition-color:var(--git-added,");
  expect(html).toContain("--diffs-dark-deletion-color:var(--git-deleted,");
});
