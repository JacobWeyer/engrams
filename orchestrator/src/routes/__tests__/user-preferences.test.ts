import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SCHEMES,
  DEFAULT_APPEARANCE,
  type UserPreferencesSnapshot,
} from "@engrams/user-preferences";
import {
  defaultPreferencesSnapshot,
  type UserPreferencesStore,
} from "../../db/user-preferences.ts";
import { makeUserPreferencesRoute, MAX_PREFERENCES_BODY_BYTES } from "../user-preferences.ts";
const path = "/api/v1/me/preferences";
/** Create a route with controlled session identity and a revision-aware fake store. */
function setup() {
  const users: string[] = [];
  let latest = defaultPreferencesSnapshot();
  const store: UserPreferencesStore = {
    /** Record the account ID supplied by the route. */
    async get(id) {
      users.push(id);
      return latest;
    },
    /** Model a revision conflict without a database dependency. */
    async update(id, update) {
      users.push(id);
      if (update.expectedRevision !== latest.revision) return { saved: false, snapshot: latest };
      latest = {
        revision: latest.revision + 1,
        document: { version: 1, appearance: update.appearance },
        updatedAt: "2026-10-02T12:00:00.000Z",
      };
      return { saved: true, snapshot: latest };
    },
  };
  const app = makeUserPreferencesRoute({
    store,
    getSession: async (headers) =>
      headers.get("x-user") ? { user: { id: headers.get("x-user")! } } : null,
  });
  return { app, users };
}
/** Build an authenticated JSON request for the first fixture account. */
function patch(body: unknown) {
  return {
    method: "PATCH",
    headers: { "x-user": "U1", "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
/** Check the status and cache policy before reading response JSON. */
async function check(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}
describe("user preferences routes", () => {
  test("requires authentication before accessing store or reading body", async () => {
    const { app, users } = setup();
    await check(await app.request(path), 401);
    await check(await app.request(path, { method: "PATCH", body: "invalid" }), 401);
    expect(users).toEqual([]);
  });
  test("returns defaults, updates authenticated user, and reports latest on conflict", async () => {
    const { app, users } = setup();
    expect(await check(await app.request(path, { headers: { "x-user": "U1" } }), 200)).toEqual(
      defaultPreferencesSnapshot(),
    );
    const appearance = { ...DEFAULT_APPEARANCE, mode: "dark" };
    const saved = (await check(
      await app.request(path, patch({ expectedRevision: 0, appearance })),
      200,
    )) as UserPreferencesSnapshot;
    expect(saved.revision).toBe(1);
    expect(saved.document.appearance.mode).toBe("dark");
    expect(
      await check(
        await app.request(path, patch({ expectedRevision: 0, appearance: DEFAULT_APPEARANCE })),
        409,
      ),
    ).toEqual(saved);
    expect(users).toEqual(["U1", "U1", "U1"]);
  });
  test("PATCH and GET preserve new presets, font IDs, and selected mode", async () => {
    const { app } = setup();
    let revision = 0;
    for (const schemeId of ["catppuccin", "nord", "solarized", "gruvbox"]) {
      for (const mode of ["light", "dark", "system"] as const) {
        const appearance = {
          ...DEFAULT_APPEARANCE,
          schemeId,
          mode,
          fonts: { sans: "inter", display: "inter", mono: "fira-code" },
        };
        const saved = await check(
          await app.request(path, patch({ expectedRevision: revision, appearance })),
          200,
        );
        revision++;
        expect(saved.revision).toBe(revision);
        expect(saved.document.appearance).toEqual(appearance);
        const readback = await check(await app.request(path, { headers: { "x-user": "U1" } }), 200);
        expect(readback).toEqual(saved);
      }
    }
  });
  test("PATCH rejects replacement of each new built-in ID before writing", async () => {
    const { app, users } = setup();
    for (const id of ["catppuccin", "nord", "solarized", "gruvbox"]) {
      const builtin = BUILTIN_SCHEMES.find((scheme) => scheme.id === id);
      await check(
        await app.request(
          path,
          patch({
            expectedRevision: 0,
            appearance: {
              ...DEFAULT_APPEARANCE,
              schemeId: id,
              customSchemes: [{ ...builtin, name: "Replacement" }],
            },
          }),
        ),
        400,
      );
    }
    expect(users).toEqual([]);
  });
  test("rejects invalid JSON, extra user IDs, invalid appearance, and oversized stream", async () => {
    const { app, users } = setup();
    await check(await app.request(path, { ...patch({}), body: "{" }), 400);
    await check(
      await app.request(
        path,
        patch({ expectedRevision: 0, appearance: DEFAULT_APPEARANCE, userId: "U2" }),
      ),
      400,
    );
    await check(
      await app.request(
        path,
        patch({ expectedRevision: 0, appearance: { ...DEFAULT_APPEARANCE, schemeId: "absent" } }),
      ),
      400,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PREFERENCES_BODY_BYTES + 1));
        controller.close();
      },
    });
    await check(
      await app.request(
        new Request(`http://localhost${path}`, {
          method: "PATCH",
          headers: { "x-user": "U1" },
          body: stream,
        }),
      ),
      413,
    );
    expect(users).toEqual([]);
  });
  test("sets no-store on unexpected failures", async () => {
    const app = makeUserPreferencesRoute({
      getSession: async () => {
        throw new Error("session failed");
      },
    });
    const response = await app.request(path);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
