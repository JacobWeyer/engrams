import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { DEFAULT_APPEARANCE } from "@engrams/user-preferences";
import * as schema from "../schema.ts";
import { makeUserPreferencesRoute } from "../../routes/user-preferences.ts";
import { defaultPreferencesSnapshot, makeUserPreferencesStore } from "../user-preferences.ts";

const url = process.env["ORCHESTRATOR_DATABASE_URL"];
const pool = url ? new Pool({ connectionString: url, max: 8 }) : null;
// CI supplies a migrated database; local runs skip this suite when no URL is set.
const liveTest = pool ? test : test.skip;
const ids = Array.from({ length: 4 }, () => `preferences-${randomUUID()}`);
const now = new Date("2026-10-02T12:00:00.000Z");
/** Create a store against the test database with a fixed save timestamp. */
function store() {
  if (!pool) throw new Error("Postgres tests require ORCHESTRATOR_DATABASE_URL");
  return makeUserPreferencesStore(drizzle(pool, { schema }), () => now);
}
describe("user preferences with live Postgres", () => {
  beforeAll(async () => {
    if (!pool) return;
    const db = drizzle(pool, { schema });
    await db.insert(schema.user).values(
      ids.map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        createdAt: now,
        updatedAt: now,
      })),
    );
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
    } finally {
      await pool.end();
    }
  });
  liveTest("GET defaults does not insert and preferences stay isolated", async () => {
    expect(await store().get(ids[0]!)).toEqual(defaultPreferencesSnapshot());
    expect(
      (
        await pool!.query(
          "SELECT count(*)::int AS count FROM user_preferences WHERE user_id = $1",
          [ids[0]],
        )
      ).rows[0].count,
    ).toBe(0);
    await store().update(ids[1]!, {
      expectedRevision: 0,
      appearance: { ...DEFAULT_APPEARANCE, mode: "system" },
    });
    expect(await store().get(ids[0]!)).toEqual(defaultPreferencesSnapshot());
    expect((await store().get(ids[1]!)).document.appearance.mode).toBe("system");
  });
  liveTest("concurrent first saves and later updates each have one winner", async () => {
    const initial = await Promise.all(
      ["dark", "system"].map((mode) =>
        store().update(ids[0]!, {
          expectedRevision: 0,
          appearance: { ...DEFAULT_APPEARANCE, mode: mode === "dark" ? "dark" : "system" },
        }),
      ),
    );
    expect(initial.filter((result) => result.saved)).toHaveLength(1);
    expect(initial.every((result) => result.snapshot.revision === 1)).toBe(true);
    const updates = await Promise.all(
      ["slate", "sand"].map((schemeId) =>
        store().update(ids[0]!, {
          expectedRevision: 1,
          appearance: { ...DEFAULT_APPEARANCE, schemeId },
        }),
      ),
    );
    expect(updates.filter((result) => result.saved)).toHaveLength(1);
    expect(updates.every((result) => result.snapshot.revision === 2)).toBe(true);
    const latest = await store().get(ids[0]!);
    expect(latest).toEqual(updates.find((result) => result.saved)!.snapshot);
    expect(latest.updatedAt).toBe(now.toISOString());
    // A new pool models a separate process reading the same persisted document.
    const secondPool = new Pool({ connectionString: url, max: 1 });
    try {
      expect(await makeUserPreferencesStore(drizzle(secondPool, { schema })).get(ids[0]!)).toEqual(
        latest,
      );
    } finally {
      await secondPool.end();
    }
  });
  liveTest("stale writes do not create rows; deleting a user cascades", async () => {
    const absent = await store().update(ids[2]!, {
      expectedRevision: 8,
      appearance: DEFAULT_APPEARANCE,
    });
    expect(absent).toEqual({ saved: false, snapshot: defaultPreferencesSnapshot() });
    await store().update(ids[2]!, { expectedRevision: 0, appearance: DEFAULT_APPEARANCE });
    await drizzle(pool!, { schema }).delete(schema.user).where(eq(schema.user.id, ids[2]!));
    expect(
      (
        await pool!.query(
          "SELECT count(*)::int AS count FROM user_preferences WHERE user_id = $1",
          [ids[2]],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  liveTest("authenticated routes persist the complete appearance group", async () => {
    const app = makeUserPreferencesRoute({
      store: store(),
      getSession: async (headers) => {
        const id = headers.get("x-test-user");
        return id ? { user: { id } } : null;
      },
    });
    const path = "/api/v1/me/preferences";
    const headers = { "x-test-user": ids[3]!, "content-type": "application/json" };
    const defaults = await app.request(path, { headers });
    expect(await defaults.json()).toEqual(defaultPreferencesSnapshot());
    const appearance = {
      ...DEFAULT_APPEARANCE,
      mode: "system" as const,
      fonts: { sans: "saira", display: "georgia", mono: "system" },
      schemeId: "custom",
      customSchemes: [
        {
          id: "custom",
          name: "Stored custom palette",
          light: {
            background: "#ffffff",
            foreground: "#111111",
            accent: "#223344",
            chrome: "#334455",
          },
          dark: {
            background: "#111111",
            foreground: "#ffffff",
            accent: "#aabbcc",
            chrome: "#223344",
          },
        },
      ],
    };
    const saved = await app.request(path, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expectedRevision: 0, appearance }),
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const snapshot = await saved.json();
    expect(snapshot.document.appearance).toEqual(appearance);
    const reopened = await app.request(path, { headers });
    expect(await reopened.json()).toEqual(snapshot);
    const conflict = await app.request(path, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ expectedRevision: 0, appearance: DEFAULT_APPEARANCE }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual(snapshot);
    const other = await app.request(path, { headers: { "x-test-user": ids[1]! } });
    expect((await other.json()).document.appearance.customSchemes).toEqual([]);
  });
});
