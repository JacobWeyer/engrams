import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BUILTIN_SCHEMES } from "@/lib/appearance";
import { DEFAULT_APPEARANCE } from "@engrams/user-preferences";
import { AuthContextProvider, type AuthState } from "@/auth/AuthProvider";
import { abilityFor } from "@/lib/ability";
import { preferencesCacheKey } from "@/lib/user-preferences";
import { ThemeProvider, useTheme } from "./theme-provider";

/** Expose appearance controls and save state for provider lifecycle tests. */
function Controls() {
  const { appearance, theme, setMode, setScheme, setFont, saveScheme, resetAppearance } =
    useTheme();
  return (
    <>
      <output>
        {appearance.mode}/{theme}/{appearance.schemeId}/{appearance.fonts.display}/
        {appearance.customSchemes.length}
      </output>
      <button onClick={() => setMode("system")}>System</button>
      <button
        onClick={() => {
          setScheme("sand");
          setFont("display", "georgia");
        }}
      >
        Customize
      </button>
      <button
        onClick={() => saveScheme({ ...BUILTIN_SCHEMES[0]!, id: "custom-copy", name: "Copy" })}
      >
        Save custom
      </button>
      <button onClick={resetAppearance}>Reset</button>
    </>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
afterEach(() => vi.unstubAllGlobals());
test("anonymous appearance starts with defaults and never reads or writes account or legacy values", () => {
  localStorage.setItem("engrams-theme", "dark");
  let dark = false;
  let onChange = () => {};
  const removeEventListener = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, callback: () => void) => {
      onChange = callback;
    },
    removeEventListener,
  }));
  const view = render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  expect(screen.getByText("light/light/engrams/saira/0")).toBeTruthy();
  fireEvent.click(screen.getByText("System"));
  act(() => {
    dark = true;
    onChange();
  });
  expect(screen.getByText("system/dark/engrams/saira/0")).toBeTruthy();
  fireEvent.click(screen.getByText("Customize"));
  expect(screen.getByText("system/dark/sand/georgia/0")).toBeTruthy();
  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem("engrams-theme")).toBe("dark");
  view.unmount();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(removeEventListener).toHaveBeenCalled();
});
test("reset restores defaults and keeps custom palettes in this page only", () => {
  render(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText("Save custom"));
  expect(screen.getByText("light/light/custom-copy/saira/1")).toBeTruthy();
  fireEvent.click(screen.getByText("Reset"));
  expect(screen.getByText("light/light/engrams/saira/1")).toBeTruthy();
  expect(localStorage.length).toBe(0);
});

test("account changes reset colors and fonts before loading and ignore prior account replies", async () => {
  /** Build an authenticated fixture with a distinct account ID. */
  const account = (userId: string): AuthState => ({
    userId,
    principal: {
      email: `${userId}@example.com`,
      display_name: userId,
      role: "member",
      is_admin: false,
      can_sign_out: true,
    },
    isAdmin: false,
    ability: abilityFor({ id: userId, role: "user" }),
  });
  const appearance = {
    ...DEFAULT_APPEARANCE,
    mode: "dark",
    schemeId: "sand",
    fonts: { ...DEFAULT_APPEARANCE.fonts, display: "georgia" },
  };
  const confirmed = {
    revision: 1,
    document: { version: 1, appearance },
    updatedAt: "2026-10-02T12:00:00.000Z",
  };
  localStorage.setItem(
    preferencesCacheKey("U1"),
    JSON.stringify({ confirmed, pending: null, importing: false }),
  );
  let finishAlice: (response: Response) => void = () => {};
  let finishBob: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishAlice = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishBob = resolve;
          }),
      ),
  );
  /** Render one account to test request cancellation during identity changes. */
  const page = (userId: string) => (
    <AuthContextProvider value={account(userId)}>
      <ThemeProvider>
        <Controls />
      </ThemeProvider>
    </AuthContextProvider>
  );
  const view = render(page("U1"));
  expect(screen.getByText("dark/dark/sand/georgia/0")).toBeTruthy();
  expect(document.documentElement.style.getPropertyValue("--appearance-font-display")).toContain(
    "Georgia",
  );
  view.rerender(page("U2"));
  expect(screen.getByText("light/light/engrams/saira/0")).toBeTruthy();
  expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--appearance-font-display")).toContain(
    "Saira",
  );
  await act(async () => {
    finishAlice(new Response(JSON.stringify(confirmed)));
  });
  expect(screen.getByText("light/light/engrams/saira/0")).toBeTruthy();
  await act(async () => {
    finishBob(
      new Response(
        JSON.stringify({
          revision: 0,
          document: { version: 1, appearance: DEFAULT_APPEARANCE },
          updatedAt: null,
        }),
      ),
    );
  });
  expect(screen.getByText("light/light/engrams/saira/0")).toBeTruthy();
  view.rerender(
    <ThemeProvider>
      <Controls />
    </ThemeProvider>,
  );
  expect(screen.getByText("light/light/engrams/saira/0")).toBeTruthy();
});

test("React StrictMode effect replay still loads authenticated account settings", async () => {
  const auth: AuthState = {
    userId: "U1",
    principal: {
      email: "U1@example.com",
      display_name: "Alice",
      role: "member",
      is_admin: false,
      can_sign_out: true,
    },
    isAdmin: false,
    ability: abilityFor({ id: "U1", role: "user" }),
  };
  const fetcher = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          revision: 1,
          document: { version: 1, appearance: { ...DEFAULT_APPEARANCE, mode: "dark" } },
          updatedAt: "2026-10-02T12:00:00.000Z",
        }),
      ),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <StrictMode>
      <AuthContextProvider value={auth}>
        <ThemeProvider>
          <Controls />
        </ThemeProvider>
      </AuthContextProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(screen.getByText("dark/dark/engrams/saira/0")).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
});
