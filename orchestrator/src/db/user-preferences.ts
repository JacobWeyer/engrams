import { and, eq } from "drizzle-orm";
import {
  DEFAULT_APPEARANCE,
  preferencesDocumentSchema,
  preferencesUpdateSchema,
  type UserPreferencesSnapshot,
  type UserPreferencesUpdate,
} from "@engrams/user-preferences";
import { getDb } from "./client.ts";
import { userPreferences } from "./schema.ts";

/** Account-scoped reads and atomic writes used by the preferences API. */
export interface UserPreferencesStore {
  /** Return the saved document or defaults without inserting a row. */
  get(userId: string): Promise<UserPreferencesSnapshot>;
  /** Save only at the expected revision; return the current snapshot on conflict. */
  update(
    userId: string,
    update: UserPreferencesUpdate,
  ): Promise<{ saved: boolean; snapshot: UserPreferencesSnapshot }>;
}
/** Return independent default objects at revision zero with no save timestamp. */
export function defaultPreferencesSnapshot(): UserPreferencesSnapshot {
  return {
    revision: 0,
    document: { version: 1, appearance: structuredClone(DEFAULT_APPEARANCE) },
    updatedAt: null,
  };
}
/** Validate a stored document and convert its timestamp to the API format. */
function snapshot(row: typeof userPreferences.$inferSelect): UserPreferencesSnapshot {
  return {
    revision: row.revision,
    document: preferencesDocumentSchema.parse(row.document),
    updatedAt: row.updatedAt.toISOString(),
  };
}
/**
 * Create a Postgres store with an injectable database and clock.
 * Revision zero permits one insert. Later writes require both the account ID
 * and current revision to match. A failed write reads the latest snapshot.
 */
export function makeUserPreferencesStore(
  db: ReturnType<typeof getDb> = getDb(),
  clock: () => Date = () => new Date(),
): UserPreferencesStore {
  const store: UserPreferencesStore = {
    /** Read only this account; a missing row does not create persistent state. */
    async get(userId) {
      const [row] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId));
      return row ? snapshot(row) : defaultPreferencesSnapshot();
    },
    /** Validate before writing and advance the revision in the same SQL statement. */
    async update(userId, input) {
      const update = preferencesUpdateSchema.parse(input);
      const document = { version: 1 as const, appearance: update.appearance };
      const updatedAt = clock();
      // The unique user key permits one first save. The revision condition
      // permits one later save when concurrent callers hold the same revision.
      const rows =
        update.expectedRevision === 0
          ? await db
              .insert(userPreferences)
              .values({ userId, document, revision: 1, updatedAt })
              .onConflictDoNothing({ target: userPreferences.userId })
              .returning()
          : await db
              .update(userPreferences)
              .set({ document, revision: update.expectedRevision + 1, updatedAt })
              .where(
                and(
                  eq(userPreferences.userId, userId),
                  eq(userPreferences.revision, update.expectedRevision),
                ),
              )
              .returning();
      const row = rows[0];
      return row
        ? { saved: true, snapshot: snapshot(row) }
        : { saved: false, snapshot: await store.get(userId) };
    },
  };
  return store;
}
