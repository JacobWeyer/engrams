import { Hono } from "hono";
import { preferencesUpdateSchema } from "@engrams/user-preferences";
import { getSessionFromHeaders } from "../auth/session.ts";
import { makeUserPreferencesStore, type UserPreferencesStore } from "../db/user-preferences.ts";
import { BodyTooLargeError, readBoundedBody } from "../http/bounded-body.ts";
import type { GetSession } from "./guard.ts";

/** Bound the actual request stream before JSON parsing. */
export const MAX_PREFERENCES_BODY_BYTES = 64 * 1024;
/**
 * Create authenticated GET and PATCH routes for the current account.
 * The session supplies the account ID. PATCH replaces the appearance group
 * and returns the latest snapshot with HTTP 409 when its revision is stale.
 * Session and store dependencies are injectable for tests.
 */
export function makeUserPreferencesRoute(
  deps: { getSession?: GetSession; store?: UserPreferencesStore } = {},
) {
  const app = new Hono();
  const resolveSession = deps.getSession ?? getSessionFromHeaders;
  // Resolve the database lazily so imports and unauthenticated calls need no pool.
  const resolveStore = () => deps.store ?? makeUserPreferencesStore();
  // Account data and error responses must not enter a browser or shared cache.
  app.use("/api/v1/me/preferences", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  // GET returns defaults without inserting an account document.
  app.get("/api/v1/me/preferences", async (c) => {
    const session = await resolveSession(c.req.raw.headers);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    return c.json(await resolveStore().get(session.user.id));
  });
  // Authenticate before reading the body; never accept a caller-supplied user ID.
  app.patch("/api/v1/me/preferences", async (c) => {
    const session = await resolveSession(c.req.raw.headers);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(c.req.raw, MAX_PREFERENCES_BODY_BYTES)),
      );
    } catch (error) {
      if (error instanceof BodyTooLargeError) return c.json({ error: error.message }, 413);
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = preferencesUpdateSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "invalid preferences", issues: parsed.error.issues }, 400);
    const result = await resolveStore().update(session.user.id, parsed.data);
    return c.json(result.snapshot, result.saved ? 200 : 409);
  });
  return app;
}
export default makeUserPreferencesRoute();
