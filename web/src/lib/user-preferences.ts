import {
  appearanceSchema,
  preferencesSnapshotSchema,
  DEFAULT_APPEARANCE,
  type AppearancePreferences,
} from "@engrams/user-preferences";
import { API_BASE, API_CREDENTIALS } from "./base";

export type PreferencesSnapshot = ReturnType<typeof preferencesSnapshotSchema.parse>;
export type SyncStatus =
  | "loading"
  | "saving"
  | "saved"
  | "error"
  | "conflict"
  | "unauthenticated"
  | "local";
export interface PreferencesState {
  appearance: AppearancePreferences;
  status: SyncStatus;
  legacyAvailable: boolean;
}
interface Cache {
  confirmed: PreferencesSnapshot;
  pending: AppearancePreferences | null;
  importing: boolean;
}
/** A missing server row has revision zero and does not claim browser settings. */
const emptySnapshot = (): PreferencesSnapshot => ({
  revision: 0,
  document: { version: 1, appearance: appearanceSchema.parse(DEFAULT_APPEARANCE) },
  updatedAt: null,
});
/** Cache ownership follows authenticated identity, never the browser origin alone. */
export const preferencesCacheKey = (userId: string) => `engrams:user-preferences:v1:${userId}`;
/** Reject malformed caches and treat denied storage as an optional cache miss. */
function readCache(userId: string): Cache | null {
  try {
    const value = JSON.parse(localStorage.getItem(preferencesCacheKey(userId)) ?? "null");
    if (!value) return null;
    return {
      confirmed: preferencesSnapshotSchema.parse(value.confirmed),
      pending: value.pending === null ? null : appearanceSchema.parse(value.pending),
      importing: value.importing === true,
    };
  } catch {
    return null;
  }
}
/** Read ownerless settings only to offer an explicit import. */
function readLegacy(): AppearancePreferences | null {
  try {
    const stored = localStorage.getItem("engrams-appearance-v1");
    if (stored) return appearanceSchema.parse(JSON.parse(stored));
    const mode = localStorage.getItem("engrams-theme");
    if (mode === "light" || mode === "dark") return { ...DEFAULT_APPEARANCE, mode };
  } catch {
    /* Browser storage is optional. */
  }
  return null;
}
/** Removal is allowed only after an imported save or explicit dismissal. */
function removeLegacy() {
  try {
    localStorage.removeItem("engrams-appearance-v1");
    localStorage.removeItem("engrams-theme");
  } catch {
    /* Browser storage is optional. */
  }
}
class AuthenticationRequired extends Error {}
/** Validated documents have stable field order, so equality includes every edit. */
const same = (a: AppearancePreferences, b: AppearancePreferences) =>
  JSON.stringify(a) === JSON.stringify(b);

/** One account owns this queue. Disposal aborts requests and rejects late replies. */
export class PreferencesSync {
  state: PreferencesState;
  private confirmed: PreferencesSnapshot;
  private pending: AppearancePreferences | null;
  private importing = false;
  private conflict: PreferencesSnapshot | null = null;
  private ready = false;
  private disposed = false;
  private generation = 0;
  private writing = false;
  private refreshing = false;
  private blockedAuth = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort = new AbortController();
  private listeners = new Set<() => void>();
  private publishedCache: string | null = null;
  private ownedPending: AppearancePreferences | null;
  private ownedRevision: number;

  /** Restore only this account's confirmed state and pending draft. */
  constructor(readonly userId: string | null) {
    const cache = userId ? readCache(userId) : null;
    this.confirmed = cache?.confirmed ?? emptySnapshot();
    this.pending = cache?.pending ?? null;
    this.ownedPending = this.pending;
    this.ownedRevision = this.confirmed.revision;
    this.importing = cache?.importing ?? false;
    this.state = {
      appearance: this.pending ?? this.confirmed.document.appearance,
      status: userId ? "loading" : "local",
      legacyAvailable: false,
    };
  }
  /** React subscribers receive immutable snapshots and release their own listener. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** The snapshot identity changes only when state is published. */
  getSnapshot = () => this.state;
  /** Effect replay uses a fresh abort signal without accepting the old generation. */
  activate() {
    if (!this.disposed) return;
    this.disposed = false;
    this.abort = new AbortController();
    this.refreshing = false;
    this.writing = false;
  }
  /** Passive refreshes cannot erase a different tab's persisted pending draft. */
  private persistCache() {
    if (!this.userId) return;
    const payload = JSON.stringify({
      confirmed: this.confirmed,
      pending: this.pending,
      importing: this.importing,
    });
    if (payload === this.publishedCache) return;
    this.publishedCache = payload;
    try {
      const stored = readCache(this.userId);
      if (
        !this.pending &&
        stored?.pending &&
        (!this.ownedPending ||
          !same(stored.pending, this.ownedPending) ||
          stored.confirmed.revision !== this.ownedRevision)
      )
        return;
      localStorage.setItem(preferencesCacheKey(this.userId), payload);
      this.ownedPending = this.pending;
      this.ownedRevision = this.confirmed.revision;
    } catch {
      /* Server saves work without browser storage. */
    }
  }
  /** Publish optimistic state while preserving foreign cache ownership. */
  private publish(status: SyncStatus = this.state.status) {
    if (this.disposed) return;
    this.state = {
      appearance: this.pending ?? this.confirmed.document.appearance,
      status,
      legacyAvailable: this.ready && this.confirmed.revision === 0 && readLegacy() !== null,
    };
    this.persistCache();
    this.listeners.forEach((listener) => listener());
  }
  /** Validate and apply each edit immediately, even while a save is in flight. */
  edit(update: (appearance: AppearancePreferences) => AppearancePreferences) {
    this.pending = appearanceSchema.parse(update(this.state.appearance));
    this.publish(
      this.userId
        ? this.conflict
          ? "conflict"
          : this.blockedAuth
            ? "unauthenticated"
            : this.state.status === "error"
              ? "error"
              : "saving"
        : "local",
    );
    this.schedule();
  }
  /** Debounce one account's writes without retrying errors or unresolved conflicts. */
  private schedule() {
    clearTimeout(this.timer);
    if (
      !this.userId ||
      !this.ready ||
      this.conflict ||
      this.blockedAuth ||
      this.state.status === "error"
    )
      return;
    this.timer = setTimeout(() => void this.save(), 350);
  }
  /** Authenticate each request and validate every successful or conflict snapshot. */
  private async request(method: "GET" | "PATCH", body?: unknown) {
    const options: RequestInit = {
      credentials: API_CREDENTIALS,
      signal: this.abort.signal,
    };
    if (method === "PATCH") {
      options.method = "PATCH";
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${API_BASE}/me/preferences`, options);
    if (response.status === 401) throw new AuthenticationRequired("Authentication required");
    if (!response.ok && response.status !== 409) throw new Error("Preferences request failed");
    return {
      conflict: response.status === 409,
      snapshot: preferencesSnapshotSchema.parse(await response.json()),
    };
  }
  /** Refresh clean state; a changed base revision protects pending edits as a conflict. */
  async refresh() {
    if (!this.userId || this.disposed || this.refreshing || this.writing) return;
    this.refreshing = true;
    const generation = this.generation;
    try {
      const { snapshot } = await this.request("GET");
      if (this.disposed || generation !== this.generation) return;
      this.ready = true;
      this.blockedAuth = false;
      if (this.pending && snapshot.revision !== this.confirmed.revision) {
        this.conflict = snapshot;
        this.publish("conflict");
      } else {
        this.confirmed = snapshot;
        this.publish(this.pending ? "saving" : "saved");
        this.schedule();
      }
    } catch (cause) {
      if (!this.disposed && generation === this.generation) {
        if (cause instanceof AuthenticationRequired) this.blockedAuth = true;
        this.publish(this.blockedAuth ? "unauthenticated" : "error");
      }
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
        if (!this.disposed && this.state.status === "saving") this.schedule();
      }
    }
  }
  /** Serialize one draft against its base revision and keep edits made during the request. */
  private async save() {
    if (
      !this.userId ||
      !this.ready ||
      !this.pending ||
      this.writing ||
      this.refreshing ||
      this.conflict ||
      this.blockedAuth ||
      this.disposed
    )
      return;
    this.writing = true;
    const generation = this.generation;
    const sent = this.pending;
    const importing = this.importing;
    this.publish("saving");
    try {
      const result = await this.request("PATCH", {
        expectedRevision: this.confirmed.revision,
        appearance: sent,
      });
      if (this.disposed || generation !== this.generation) return;
      if (result.conflict) {
        this.conflict = result.snapshot;
        this.publish("conflict");
        return;
      }
      this.confirmed = result.snapshot;
      if (same(this.pending!, sent)) this.pending = null;
      if (importing) {
        removeLegacy();
        this.importing = false;
      }
      this.publish(this.pending ? "saving" : "saved");
    } catch (cause) {
      if (!this.disposed && generation === this.generation) {
        if (cause instanceof AuthenticationRequired) this.blockedAuth = true;
        this.publish(this.blockedAuth ? "unauthenticated" : "error");
      }
    } finally {
      if (generation === this.generation) {
        this.writing = false;
        if (!this.disposed && this.pending && this.state.status === "saving") this.schedule();
      }
    }
  }
  /** Read the latest revision before retrying; 401 requires authentication first. */
  retry = () => {
    if (!this.blockedAuth) void this.refresh();
  };
  /** Explicitly discard this queue's draft in favor of the observed remote snapshot. */
  loadRemote = () => {
    if (!this.conflict) return;
    this.confirmed = this.conflict;
    this.conflict = null;
    this.pending = null;
    this.importing = false;
    this.publish("saved");
  };
  /** Explicitly rebase current edits onto the observed revision before saving. */
  saveCurrent = () => {
    if (!this.conflict) return;
    this.confirmed = this.conflict;
    this.conflict = null;
    this.publish("saving");
    this.schedule();
  };
  /** Claim legacy settings only through the user's import action. */
  importBrowserAppearance = () => {
    if (!this.state.legacyAvailable) return;
    const legacy = readLegacy();
    if (legacy) {
      this.importing = true;
      this.edit(() => legacy);
    }
  };
  /** Dismiss ownerless settings without applying them to the account. */
  dismissBrowserAppearance = () => {
    removeLegacy();
    this.publish();
  };
  /** Ignore unrelated accounts and pending-only changes to prevent refresh loops. */
  storageChanged = (event: StorageEvent) => {
    if (!this.userId || (event.key !== preferencesCacheKey(this.userId) && event.key !== null))
      return;
    if (event.newValue) {
      try {
        const cache = JSON.parse(event.newValue);
        const incoming = preferencesSnapshotSchema.parse(cache.confirmed);
        if (incoming.revision <= this.confirmed.revision) return;
      } catch {
        return;
      }
    }
    void this.refresh();
  };
  /** Cancel timers and requests; generation checks also reject replies that ignore abort. */
  dispose() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.abort.abort();
  }
}
