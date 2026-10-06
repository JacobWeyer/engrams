import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_APPEARANCE, appearanceSchema } from "@engrams/user-preferences";
import { PreferencesSync, preferencesCacheKey, type PreferencesSnapshot } from "./user-preferences";
/** Build validated snapshots with stable revision and timestamp semantics. */
const snapshot = (
  revision = 0,
  mode: "light" | "dark" | "system" = "light",
): PreferencesSnapshot => ({
  revision,
  document: { version: 1, appearance: appearanceSchema.parse({ ...DEFAULT_APPEARANCE, mode }) },
  updatedAt: revision ? "2026-10-02T12:00:00.000Z" : null,
});
/** Use fresh response bodies because fetch consumes them once. */
const reply = (value: PreferencesSnapshot, status = 200) =>
  new Response(JSON.stringify(value), { status });
const queues: PreferencesSync[] = [];
/** Dispose every account queue after each test to isolate timers and requests. */
const create = (id = "U1") => {
  const queue = new PreferencesSync(id);
  queues.push(queue);
  return queue;
};
/** Advance past the save debounce and settle its asynchronous response. */
const tick = async () => {
  await vi.advanceTimersByTimeAsync(351);
};
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  queues.forEach((queue) => queue.dispose());
  queues.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("serializes writes and saves later edits with the next revision", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(reply(snapshot(2, "system")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  queue.edit((value) => ({ ...value, mode: "system" }));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(reply(snapshot(1, "dark")));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toMatchObject({
    expectedRevision: 1,
    appearance: { mode: "system" },
  });
  expect(queue.state.status).toBe("saved");
});
test("keeps offline edits across reload and retries after reading the server", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  expect(queue.state.status).toBe("error");
  expect(JSON.parse(localStorage.getItem(preferencesCacheKey("U1"))!).pending.mode).toBe("dark");
  queue.dispose();
  const reloaded = create();
  expect(reloaded.state.appearance.mode).toBe("dark");
  fetcher
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockResolvedValueOnce(reply(snapshot(2, "dark")));
  reloaded.retry();
  await tick();
  expect(reloaded.state.status).toBe("saved");
});
test("conflicts preserve edits until the user chooses current or remote settings", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockResolvedValueOnce(reply(snapshot(2, "system"), 409))
    .mockResolvedValueOnce(reply(snapshot(3, "dark")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  expect(queue.state.status).toBe("conflict");
  expect(queue.state.appearance.mode).toBe("dark");
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  queue.saveCurrent();
  await tick();
  expect(JSON.parse(fetcher.mock.calls[2]![1].body).expectedRevision).toBe(2);
  queue.edit((value) => ({ ...value, mode: "light" }));
  fetcher.mockResolvedValueOnce(reply(snapshot(4, "system")));
  await queue.refresh();
  queue.loadRemote();
  expect(queue.state.appearance.mode).toBe("system");
  expect(queue.state.status).toBe("saved");
});
test("disposed accounts ignore late replies and caches remain isolated", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(reply(snapshot(7, "system")));
  vi.stubGlobal("fetch", fetcher);
  const alice = create();
  const request = alice.refresh();
  alice.dispose();
  const bob = create("U2");
  await bob.refresh();
  finish(reply(snapshot(8, "dark")));
  await request;
  expect(alice.state.appearance.mode).toBe("light");
  expect(localStorage.getItem(preferencesCacheKey("U1"))).toBeNull();
  expect(bob.state.appearance.mode).toBe("system");
  bob.storageChanged(new StorageEvent("storage", { key: preferencesCacheKey("U1") }));
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test("denied browser storage does not prevent server saves", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(reply(snapshot()))
      .mockResolvedValueOnce(reply(snapshot(1, "dark"))),
  );
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  expect(queue.state.status).toBe("saved");
});
test("legacy import is explicit and removes browser values only after a successful save", async () => {
  localStorage.setItem("engrams-theme", "dark");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot()))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(reply(snapshot()))
    .mockResolvedValueOnce(reply(snapshot(1, "dark")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  expect(queue.state.appearance.mode).toBe("light");
  expect(queue.state.legacyAvailable).toBe(true);
  queue.importBrowserAppearance();
  await tick();
  expect(localStorage.getItem("engrams-theme")).toBe("dark");
  queue.retry();
  await tick();
  expect(queue.state.status).toBe("saved");
  expect(localStorage.getItem("engrams-theme")).toBeNull();
  localStorage.setItem("engrams-theme", "dark");
  const bob = create("U2");
  fetcher.mockResolvedValueOnce(reply(snapshot()));
  await bob.refresh();
  bob.dismissBrowserAppearance();
  expect(localStorage.getItem("engrams-theme")).toBeNull();
  expect(bob.state.appearance.mode).toBe("light");
});

test("an unrelated in-flight save does not remove a later pending legacy import", async () => {
  localStorage.setItem("engrams-theme", "dark");
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, schemeId: "sand" }));
  await tick();
  queue.importBrowserAppearance();
  finish(reply(snapshot(1)));
  await tick();
  expect(queue.state.status).toBe("error");
  expect(queue.state.appearance.mode).toBe("dark");
  expect(localStorage.getItem("engrams-theme")).toBe("dark");
});
test("401 stops writes until a successful authenticated refresh", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot()))
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(reply(snapshot()))
    .mockResolvedValueOnce(reply(snapshot(1, "dark")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  expect(queue.state.status).toBe("unauthenticated");
  queue.retry();
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await queue.refresh();
  await tick();
  expect(queue.state.status).toBe("saved");
});
test("refresh and save cannot race, including edits made during a slow refresh", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(reply(snapshot(2, "dark")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  const refresh = queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(reply(snapshot(1)));
  await refresh;
  await tick();
  expect(queue.state.status).toBe("saved");
  expect(queue.state.appearance.mode).toBe("dark");
});
test("effect replay starts a fresh request and ignores replies from the disposed lifecycle", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(reply(snapshot(2, "system")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  const old = queue.refresh();
  queue.dispose();
  queue.activate();
  await queue.refresh();
  finish(reply(snapshot(1, "dark")));
  await old;
  expect(queue.state.appearance.mode).toBe("system");
  expect(queue.state.status).toBe("saved");
});

test("different pending edits in two tabs do not cause refresh loops", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply(snapshot(1))));
  vi.stubGlobal("fetch", fetcher);
  const first = create();
  const second = create();
  await first.refresh();
  await second.refresh();
  first.edit((value) => ({ ...value, mode: "dark" }));
  const firstCache = localStorage.getItem(preferencesCacheKey("U1"))!;
  second.edit((value) => ({ ...value, mode: "system" }));
  const secondCache = localStorage.getItem(preferencesCacheKey("U1"))!;
  for (let index = 0; index < 5; index++) {
    first.storageChanged(
      new StorageEvent("storage", { key: preferencesCacheKey("U1"), newValue: secondCache }),
    );
    second.storageChanged(
      new StorageEvent("storage", { key: preferencesCacheKey("U1"), newValue: firstCache }),
    );
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(first.state.appearance.mode).toBe("dark");
  expect(second.state.appearance.mode).toBe("system");
});

test("clean tabs refresh from a newer server revision while pending tabs keep their edits", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockResolvedValueOnce(reply(snapshot(2, "dark")))
    .mockResolvedValueOnce(reply(snapshot(3, "system")));
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.storageChanged(
    new StorageEvent("storage", {
      key: preferencesCacheKey("U1"),
      newValue: JSON.stringify({ confirmed: snapshot(2, "dark"), pending: null }),
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(queue.state.appearance.mode).toBe("dark");
  queue.edit((value) => ({ ...value, schemeId: "sand" }));
  await queue.refresh();
  expect(queue.state.status).toBe("conflict");
  expect(queue.state.appearance.schemeId).toBe("sand");
  expect(queue.state.appearance.mode).toBe("dark");
});

for (const remoteRevision of [1, 2]) {
  test(`clean tab refresh at revision ${remoteRevision} preserves another tab's failed draft across reload`, async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(snapshot(1)))
      .mockResolvedValueOnce(reply(snapshot(1)))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reply(snapshot(remoteRevision)))
      .mockResolvedValueOnce(reply(snapshot(remoteRevision)));
    vi.stubGlobal("fetch", fetcher);
    const edited = create();
    const clean = create();
    await edited.refresh();
    await clean.refresh();
    edited.edit((value) => ({ ...value, mode: "dark" }));
    await tick();
    expect(edited.state.status).toBe("error");
    await clean.refresh();
    const stored = JSON.parse(localStorage.getItem(preferencesCacheKey("U1"))!);
    expect(stored.pending.mode).toBe("dark");
    expect(stored.confirmed.revision).toBe(1);
    edited.dispose();
    const reloaded = create();
    expect(reloaded.state.appearance.mode).toBe("dark");
    await reloaded.refresh();
    expect(reloaded.state.status).toBe(remoteRevision === 1 ? "saving" : "conflict");
    expect(reloaded.state.appearance.mode).toBe("dark");
  });
}

test("an own successful save clears its draft but cannot clear a different tab's later draft", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const first = create();
  const second = create();
  await first.refresh();
  await second.refresh();
  first.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  second.edit((value) => ({ ...value, mode: "system" }));
  finish(reply(snapshot(2, "dark")));
  await vi.advanceTimersByTimeAsync(0);
  expect(first.state.status).toBe("saved");
  expect(JSON.parse(localStorage.getItem(preferencesCacheKey("U1"))!).pending.mode).toBe("system");
  second.dispose();
  const reload = create();
  expect(reload.state.appearance.mode).toBe("system");
  fetcher.mockResolvedValueOnce(reply(snapshot(2, "dark")));
  await reload.refresh();
  reload.loadRemote();
  expect(reload.state.status).toBe("saved");
  expect(JSON.parse(localStorage.getItem(preferencesCacheKey("U1"))!).pending).toBeNull();
});

test("a late save reply cannot clear another tab's identical draft with a newer base revision", async () => {
  let finish: (response: Response) => void = () => {};
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(snapshot(1)))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal("fetch", fetcher);
  const queue = create();
  await queue.refresh();
  queue.edit((value) => ({ ...value, mode: "dark" }));
  await tick();
  const pending = appearanceSchema.parse({ ...DEFAULT_APPEARANCE, mode: "dark" });
  localStorage.setItem(
    preferencesCacheKey("U1"),
    JSON.stringify({ confirmed: snapshot(3, "system"), pending, importing: false }),
  );
  finish(reply(snapshot(2, "dark")));
  await vi.advanceTimersByTimeAsync(0);
  const stored = JSON.parse(localStorage.getItem(preferencesCacheKey("U1"))!);
  expect(stored.confirmed.revision).toBe(3);
  expect(stored.pending.mode).toBe("dark");
});
