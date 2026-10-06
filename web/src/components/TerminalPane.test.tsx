// Regression tests for the SHELL-tab "hangs on remount" bug.
//
// Symptom: open SHELL on an active session, navigate away via SPA,
// navigate back, click SHELL, type a command — the keystrokes flow
// over the websocket but no output renders. The underlying error is
// `RuntimeError: memory access out of bounds` thrown from inside
// term.write() the first time the new mount tries to render a chunk
// of any real size (e.g. the colorized output of `ls /`).
//
// Cause: ghostty-web 0.4 Terminal.dispose() already frees the WASM
// terminal via cleanupComponents(). An earlier version of this
// component called wasmTerm.free() ourselves first, which made
// dispose()'s subsequent free a *double-free* — that corrupted the
// allocator's free list and the next Terminal's grid landed on top
// of poisoned memory. Small writes survived; a multi-line write hit
// the corrupted region and threw.
//
// The mount-side workaround (clear-after-fit) addresses a separate,
// older "stale glyphs on remount" bug and is preserved.
//
// Both bugs have come back from "fixed" before because nothing pinned
// the cleanup contract. These tests assert it via mock invocation
// counters so a future refactor fails loudly.

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { TerminalPane } from "./TerminalPane";
import { ThemeProvider, useTheme } from "./theme-provider";
import type { ITerminalOptions } from "ghostty-web";
import { BUILTIN_SCHEMES, contrastRatio, getAppearanceTokens } from "@/lib/appearance";

// vi.hoisted runs before the vi.mock factory, so the classes are
// defined when the mock module is constructed AND accessible inside
// the test bodies via the returned references.
const { MockTerminal, MockFitAddon } = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];
    cols = 80;
    rows = 24;
    open = vi.fn();
    write = vi.fn();
    loadAddon = vi.fn();
    dispose = vi.fn();
    onData = vi.fn();
    onResize = vi.fn();
    wasmTerm = { free: vi.fn() };
    renderer = { setTheme: vi.fn(), render: vi.fn(), remeasureFont: vi.fn() };
    options: ITerminalOptions;
    constructor(options: ITerminalOptions) {
      this.options = options;
      MockTerminal.instances.push(this);
    }
  }
  class MockFitAddon {
    static instances: MockFitAddon[] = [];
    fit = vi.fn();
    observeResize = vi.fn();
    dispose = vi.fn();
    constructor() {
      MockFitAddon.instances.push(this);
    }
  }
  return { MockTerminal, MockFitAddon };
});

vi.mock("ghostty-web", () => ({
  init: vi.fn(async () => {}),
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  binaryType = "blob";
  send = vi.fn();
  close = vi.fn();
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  MockTerminal.instances = [];
  MockFitAddon.instances = [];
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  // The mount effect awaits loadGhostty() (a microtask chain). One
  // act() turn drains the resolved promises and the synchronous body
  // that runs after them.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalPane mount sequence", () => {
  test("clear escape runs AFTER fitAddon.fit() so post-resize cells are zeroed", async () => {
    render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();

    const term = MockTerminal.instances.at(-1)!;
    const addon = MockFitAddon.instances.at(-1)!;

    expect(term.open).toHaveBeenCalledTimes(1);
    expect(addon.fit).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");

    // Order: open → fit → write(clear). If a future change moves the
    // clear above fit, fit() would resize the grid afterward and the
    // cells it added would come back stale.
    const openOrder = term.open.mock.invocationCallOrder[0];
    const fitOrder = addon.fit.mock.invocationCallOrder[0];
    const clearWriteCall = term.write.mock.calls.findIndex(
      ([arg]) => arg === "\x1b[2J\x1b[3J\x1b[H",
    );
    const clearOrder = term.write.mock.invocationCallOrder[clearWriteCall];

    expect(openOrder).toBeLessThan(fitOrder);
    expect(fitOrder).toBeLessThan(clearOrder);
  });

  test("opens a WebSocket to /sessions/:id/shell with the tty subprotocol", async () => {
    render(
      <ThemeProvider>
        <TerminalPane sessionId="abc-123" />
      </ThemeProvider>,
    );
    await flush();

    expect(MockWebSocket.instances).toHaveLength(1);
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toContain("/sessions/abc-123/shell");
    expect(ws.protocols).toBe("tty");
  });
});

describe("TerminalPane unmount sequence", () => {
  test("disposes the Terminal but does NOT call wasmTerm.free() — that path double-frees", async () => {
    const { unmount } = render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();

    const term = MockTerminal.instances.at(-1)!;
    const addon = MockFitAddon.instances.at(-1)!;
    const ws = MockWebSocket.instances.at(-1)!;

    unmount();

    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(addon.dispose).toHaveBeenCalledTimes(1);
    expect(term.dispose).toHaveBeenCalledTimes(1);

    // Terminal.dispose() runs cleanupComponents() which frees the
    // wasmTerm itself. Calling it from here too is the double-free
    // that lands the next mount on a corrupted heap and crashes
    // term.write() partway through `ls /` output.
    expect(term.wasmTerm.free).not.toHaveBeenCalled();
  });
});

describe("TerminalPane remount cycle", () => {
  test("a fresh mount allocates a new Terminal and re-runs the fit-then-clear sequence", async () => {
    const { unmount } = render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();

    const firstTerm = MockTerminal.instances.at(-1)!;
    expect(firstTerm.write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");

    unmount();

    // Second mount — same sessionId, same as a SPA route nav out and
    // back. Must produce a fresh Terminal instance, not reuse the old.
    render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();

    const secondTerm = MockTerminal.instances.at(-1)!;
    const secondAddon = MockFitAddon.instances.at(-1)!;
    expect(secondTerm).not.toBe(firstTerm);
    expect(secondTerm.open).toHaveBeenCalledTimes(1);
    expect(secondAddon.fit).toHaveBeenCalledTimes(1);
    expect(secondTerm.write).toHaveBeenCalledWith("\x1b[2J\x1b[3J\x1b[H");

    // And the second mount's clear is still post-fit.
    const fitOrder = secondAddon.fit.mock.invocationCallOrder[0];
    const clearWriteCall = secondTerm.write.mock.calls.findIndex(
      ([arg]) => arg === "\x1b[2J\x1b[3J\x1b[H",
    );
    const clearOrder = secondTerm.write.mock.invocationCallOrder[clearWriteCall];
    expect(fitOrder).toBeLessThan(clearOrder);
  });

  test("regression: navigate-away-and-back never explicitly frees wasmTerm (would corrupt the next mount)", async () => {
    // Mirrors the user repro: open SHELL, navigate to overview via
    // SPA (unmount), navigate back (remount), click SHELL again, type
    // `ls /`. Pre-fix, the explicit wasmTerm.free() in the unmount
    // path double-freed against Terminal.dispose()'s own free, and
    // the second mount's first multi-line write OOB'd inside the
    // ghostty-web WASM. Asserting the cleanup never touches
    // wasmTerm.free() pins the contract that prevents it.
    const { unmount: unmount1 } = render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const firstTerm = MockTerminal.instances.at(-1)!;
    unmount1();
    expect(firstTerm.dispose).toHaveBeenCalledTimes(1);
    expect(firstTerm.wasmTerm.free).not.toHaveBeenCalled();

    const { unmount: unmount2 } = render(
      <ThemeProvider>
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const secondTerm = MockTerminal.instances.at(-1)!;
    unmount2();
    expect(secondTerm.dispose).toHaveBeenCalledTimes(1);
    expect(secondTerm.wasmTerm.free).not.toHaveBeenCalled();
  });
});

/** Change colors and the code font together to exercise live renderer updates. */
function AppearanceControls() {
  const { setTheme, setFont, setScheme } = useTheme();
  return (
    <button
      onClick={() => {
        setTheme("dark");
        setFont("mono", "system");
        setScheme("slate");
      }}
    >
      Change appearance
    </button>
  );
}

test("theme and loaded font changes retain the terminal and socket and send fitted dimensions", async () => {
  let finishFontLoad: (() => void) | undefined;
  const load = vi.fn(
    () =>
      new Promise<FontFace[]>((resolve) => {
        finishFontLoad = () => resolve([]);
      }),
  );
  const { getByRole } = render(
    <ThemeProvider>
      <AppearanceControls />
      <TerminalPane sessionId="s1" />
    </ThemeProvider>,
  );
  await flush();
  const term = MockTerminal.instances[0]!;
  const socket = MockWebSocket.instances[0]!;
  const addon = MockFitAddon.instances[0]!;
  socket.readyState = MockWebSocket.OPEN;
  const initialFont = term.options.fontFamily;
  const initialFitCount = addon.fit.mock.calls.length;
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  try {
    await act(async () => {
      getByRole("button", { name: "Change appearance" }).click();
    });
    expect(load).toHaveBeenCalledWith(expect.stringContaining("ui-monospace"));
    expect(term.options.fontFamily).toBe(initialFont);
    expect(addon.fit).toHaveBeenCalledTimes(initialFitCount);
    await act(async () => {
      finishFontLoad?.();
    });
    expect(term.options.fontFamily).toContain("ui-monospace");
    expect(term.options.fontFamily).not.toContain("JetBrains");
    expect(term.renderer.setTheme).toHaveBeenCalledWith(
      expect.objectContaining({ background: "#121826", foreground: "#e5eaf3" }),
    );
    expect(addon.fit).toHaveBeenCalledTimes(initialFitCount + 1);
    expect(socket.send).toHaveBeenCalledWith('1{"columns":80,"rows":24}');
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, "fonts");
  }
});

test("reads literal colors from the terminal's CSS scope on appearance changes", async () => {
  const { container, getByRole } = render(
    <ThemeProvider>
      <AppearanceControls />
      <TerminalPane sessionId="s1" />
    </ThemeProvider>,
  );
  await flush();
  const pane = container.querySelector<HTMLElement>(".absolute.inset-0");
  expect(pane).not.toBeNull();
  pane?.style.setProperty("--terminal-background", "#123456");
  pane?.style.setProperty("--terminal-cursor", "#abcdef");
  pane?.style.setProperty("--terminal-selection", "#112233");
  pane?.style.setProperty("--terminal-selection-foreground", "#ffffff");
  await act(async () => {
    getByRole("button", { name: "Change appearance" }).click();
  });
  expect(MockTerminal.instances[0]?.renderer.setTheme).toHaveBeenCalledWith(
    expect.objectContaining({
      background: "#123456",
      cursor: "#abcdef",
      selectionBackground: "#112233",
      selectionForeground: "#ffffff",
    }),
  );
});

/** Change only the palette while terminal font loading is pending. */
function PaletteControls() {
  const { setTheme, setScheme } = useTheme();
  return (
    <button
      onClick={() => {
        setTheme("dark");
        setScheme("slate");
      }}
    >
      Change palette
    </button>
  );
}

test("uses the latest palette when the mode changes during initial font loading", async () => {
  let finishFontLoad: (() => void) | undefined;
  const load = vi.fn(
    () =>
      new Promise<FontFace[]>((resolve) => {
        finishFontLoad = () => resolve([]);
      }),
  );
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
  try {
    const { getByRole } = render(
      <ThemeProvider>
        <PaletteControls />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    expect(MockTerminal.instances).toHaveLength(0);
    await act(async () => {
      getByRole("button", { name: "Change palette" }).click();
    });
    await act(async () => {
      finishFontLoad?.();
    });
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockTerminal.instances[0]?.options.theme).toEqual(
      expect.objectContaining({ background: "#121826", foreground: "#e5eaf3" }),
    );
    expect(MockWebSocket.instances).toHaveLength(1);
  } finally {
    Reflect.deleteProperty(document, "fonts");
  }
});

/** Select fonts independently to test pending terminal metric updates. */
function FontControls() {
  const { setFont } = useTheme();
  return (
    <>
      <button onClick={() => setFont("mono", "fira-code")}>Use Fira Code</button>
      <button onClick={() => setFont("mono", "system")}>Use system code font</button>
      <button onClick={() => setFont("mono", "jetbrains")}>Use JetBrains Mono</button>
    </>
  );
}
/** Select Fira Code before mounting a new terminal instance. */
function FiraCodeMount() {
  const { setFont } = useTheme();
  const [mounted, setMounted] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setFont("mono", "fira-code");
          setMounted(true);
        }}
      >
        Open Fira Code terminal
      </button>
      {mounted && <TerminalPane sessionId="s1" />}
    </>
  );
}
/** Expose font-load completion and failure for deterministic ordering checks. */
function deferredFont() {
  let resolve!: (faces: FontFace[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<FontFace[]>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return {
    promise,
    resolve: () => resolve([]),
    reject: () => reject(new Error("Font unavailable")),
  };
}
/** Replace the browser font loader while retaining each test's promise ordering. */
function mockFontLoading(load: (font: string) => Promise<FontFace[]>) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { load } });
}

describe("TerminalPane Fira Code loading", () => {
  afterEach(() => Reflect.deleteProperty(document, "fonts"));

  test("loads Fira Code before creating and fitting the terminal", async () => {
    const font = deferredFont();
    const load = vi.fn(() => font.promise);
    mockFontLoading(load);
    const { getByRole } = render(
      <ThemeProvider>
        <FiraCodeMount />
      </ThemeProvider>,
    );
    await act(async () => {
      getByRole("button", { name: "Open Fira Code terminal" }).click();
    });
    await flush();
    expect(load).toHaveBeenCalledWith(expect.stringContaining("Fira Code Variable"));
    expect(MockTerminal.instances).toHaveLength(0);
    expect(MockFitAddon.instances).toHaveLength(0);
    expect(MockWebSocket.instances).toHaveLength(0);
    await act(async () => {
      font.resolve();
    });
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockTerminal.instances[0]?.options.fontFamily).toContain("Fira Code Variable");
    expect(MockFitAddon.instances[0]?.fit).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("waits for Fira Code before changing live metrics and retains the terminal and socket", async () => {
    const { getByRole } = render(
      <ThemeProvider>
        <FontControls />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const term = MockTerminal.instances[0]!;
    const socket = MockWebSocket.instances[0]!;
    const addon = MockFitAddon.instances[0]!;
    socket.readyState = MockWebSocket.OPEN;
    const initialFamily = term.options.fontFamily;
    const initialFits = addon.fit.mock.calls.length;
    const font = deferredFont();
    const load = vi.fn(() => font.promise);
    mockFontLoading(load);
    await act(async () => {
      getByRole("button", { name: "Use Fira Code" }).click();
    });
    expect(load).toHaveBeenCalledWith(expect.stringContaining("Fira Code Variable"));
    expect(term.options.fontFamily).toBe(initialFamily);
    expect(term.renderer.remeasureFont).not.toHaveBeenCalled();
    expect(addon.fit).toHaveBeenCalledTimes(initialFits);
    await act(async () => {
      font.resolve();
    });
    expect(term.options.fontFamily).toContain("Fira Code Variable");
    expect(term.renderer.remeasureFont).toHaveBeenCalledTimes(1);
    expect(addon.fit).toHaveBeenCalledTimes(initialFits + 1);
    expect(socket.send).toHaveBeenCalledWith('1{"columns":80,"rows":24}');
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  test("uses the readable monospace fallback when a live Fira Code load fails", async () => {
    const { getByRole } = render(
      <ThemeProvider>
        <FontControls />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const term = MockTerminal.instances[0]!;
    const socket = MockWebSocket.instances[0]!;
    const font = deferredFont();
    mockFontLoading(vi.fn(() => font.promise));
    await act(async () => {
      getByRole("button", { name: "Use Fira Code" }).click();
    });
    await act(async () => {
      font.reject();
    });
    expect(term.options.fontFamily).toContain("Fira Code Variable");
    expect(term.options.fontFamily).toContain("ui-monospace");
    expect(term.renderer.remeasureFont).toHaveBeenCalledTimes(1);
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  test("ignores an older Fira Code completion after a faster system font change", async () => {
    const { getByRole } = render(
      <ThemeProvider>
        <FontControls />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const term = MockTerminal.instances[0]!;
    const socket = MockWebSocket.instances[0]!;
    const addon = MockFitAddon.instances[0]!;
    const fira = deferredFont();
    const system = deferredFont();
    mockFontLoading(
      vi.fn((font: string) =>
        font.includes("Fira Code Variable") ? fira.promise : system.promise,
      ),
    );
    await act(async () => {
      getByRole("button", { name: "Use Fira Code" }).click();
    });
    await act(async () => {
      getByRole("button", { name: "Use system code font" }).click();
    });
    await act(async () => {
      system.resolve();
    });
    expect(term.options.fontFamily).toContain("ui-monospace");
    expect(term.options.fontFamily).not.toContain("Fira Code Variable");
    const systemFamily = term.options.fontFamily;
    const fitCount = addon.fit.mock.calls.length;
    const measurements = term.renderer.remeasureFont.mock.calls.length;
    await act(async () => {
      fira.resolve();
    });
    expect(term.options.fontFamily).toBe(systemFamily);
    expect(addon.fit).toHaveBeenCalledTimes(fitCount);
    expect(term.renderer.remeasureFont).toHaveBeenCalledTimes(measurements);
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  test("cancels a pending Fira Code switch when the user keeps the current font", async () => {
    const { getByRole } = render(
      <ThemeProvider>
        <FontControls />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const term = MockTerminal.instances[0]!;
    const initialFamily = term.options.fontFamily;
    const font = deferredFont();
    mockFontLoading(vi.fn(() => font.promise));
    await act(async () => {
      getByRole("button", { name: "Use Fira Code" }).click();
    });
    await act(async () => {
      getByRole("button", { name: "Use JetBrains Mono" }).click();
    });
    await act(async () => {
      font.resolve();
    });
    expect(term.options.fontFamily).toBe(initialFamily);
    expect(term.renderer.remeasureFont).not.toHaveBeenCalled();
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

/** Change the selected preset and mode without replacing the terminal pane. */
function SelectionPaletteControls({
  schemeId,
  mode,
}: {
  schemeId: string;
  mode: "light" | "dark";
}) {
  const { setScheme, setTheme } = useTheme();
  return (
    <button
      onClick={() => {
        setScheme(schemeId);
        setTheme(mode);
      }}
    >
      Change selection palette
    </button>
  );
}

test.each(
  BUILTIN_SCHEMES.flatMap((scheme) => [
    { scheme, mode: "light" as const },
    { scheme, mode: "dark" as const },
  ]),
)(
  "passes readable $scheme.id $mode selection colors on mount and live changes",
  async ({ scheme, mode }) => {
    const { getByRole } = render(
      <ThemeProvider>
        <SelectionPaletteControls schemeId={scheme.id} mode={mode} />
        <TerminalPane sessionId="s1" />
      </ThemeProvider>,
    );
    await flush();
    const term = MockTerminal.instances[0]!;
    const socket = MockWebSocket.instances[0]!;
    expect(term.options.theme?.selectionForeground).toBe("#223133");
    expect(
      contrastRatio(
        term.options.theme!.selectionForeground!,
        term.options.theme!.selectionBackground!,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    await act(async () => {
      getByRole("button", { name: "Change selection palette" }).click();
    });
    const tokens = getAppearanceTokens(scheme, mode);
    expect(term.renderer.setTheme).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectionBackground: tokens["terminal-selection"],
        selectionForeground: tokens["terminal-selection-foreground"],
      }),
    );
    const applied = term.renderer.setTheme.mock.lastCall![0];
    expect(
      contrastRatio(applied.selectionForeground, applied.selectionBackground),
    ).toBeGreaterThanOrEqual(4.5);
    expect(MockTerminal.instances).toHaveLength(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(term.dispose).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  },
);
