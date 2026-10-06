import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  BUILTIN_SCHEMES,
  DEFAULT_APPEARANCE,
  FONT_OPTIONS,
  applyAppearance,
  resolvedTheme,
  type AppearanceMode,
  type AppearancePreferences,
  type ColorScheme,
  type FontRole,
  type Theme,
} from "@/lib/appearance";

import { useOptionalAuth } from "@/auth/AuthProvider";
import { PreferencesSync, type SyncStatus } from "@/lib/user-preferences";
import { appearanceSchema } from "@engrams/user-preferences";

/** Appearance controls and save state for the current account. */
interface ThemeCtx {
  syncStatus: SyncStatus;
  legacyAvailable: boolean;
  retrySave: () => void;
  loadRemote: () => void;
  saveCurrent: () => void;
  importBrowserAppearance: () => void;
  dismissBrowserAppearance: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
  appearance: AppearancePreferences;
  setMode: (mode: AppearanceMode) => void;
  setScheme: (id: string) => void;
  saveScheme: (scheme: ColorScheme) => void;
  deleteScheme: (id: string) => void;
  setFont: (role: FontRole, id: string) => void;
  resetAppearance: () => void;
}
const ThemeContext = createContext<ThemeCtx | null>(null);

/** Remount the save queue when the authenticated account changes. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const auth = useOptionalAuth();
  return (
    <AccountThemeProvider
      key={auth ? `user:${auth.userId}` : "anonymous"}
      userId={auth?.userId ?? null}
    >
      {children}
    </AccountThemeProvider>
  );
}

/** Apply account preferences and refresh them on focus, reconnect, and storage events. */
function AccountThemeProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string | null;
}) {
  const [sync] = useState(() => new PreferencesSync(userId));
  const {
    appearance,
    status: syncStatus,
    legacyAvailable,
  } = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  /** Apply a local edit and let the account queue save it. */
  const setAppearance = (update: (current: AppearancePreferences) => AppearancePreferences) =>
    sync.edit(update);
  const [systemTheme, setSystemTheme] = useState<Theme>(() => resolvedTheme("system"));
  const theme = appearance.mode === "system" ? systemTheme : appearance.mode;

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    applyAppearance(appearance, theme);
    return () => {
      applyAppearance(DEFAULT_APPEARANCE);
    };
  }, [appearance, theme]);

  useEffect(() => {
    sync.activate();
    void sync.refresh();
    const refresh = () => {
      void sync.refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("storage", sync.storageChanged);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("storage", sync.storageChanged);
      sync.dispose();
    };
  }, [sync]);

  /** Save the chosen mode; each device resolves system mode itself. */
  const setMode = (mode: AppearanceMode) => setAppearance((current) => ({ ...current, mode }));
  /** Select only a known preset or a saved custom scheme. */
  const setScheme = (id: string) =>
    setAppearance((current) =>
      [...BUILTIN_SCHEMES, ...current.customSchemes].some((scheme) => scheme.id === id)
        ? { ...current, schemeId: id }
        : current,
    );
  /** Validate and replace one custom scheme without changing the font choices. */
  const saveScheme = (scheme: ColorScheme) => {
    const valid = appearanceSchema.parse({ ...DEFAULT_APPEARANCE, customSchemes: [scheme] })
      .customSchemes[0]!;
    setAppearance((current) => ({
      ...current,
      schemeId: valid.id,
      customSchemes: [...current.customSchemes.filter((item) => item.id !== valid.id), valid],
    }));
  };
  /** Remove a custom scheme and restore default colors if it was selected. */
  const deleteScheme = (id: string) =>
    setAppearance((current) => ({
      ...current,
      schemeId: current.schemeId === id ? DEFAULT_APPEARANCE.schemeId : current.schemeId,
      customSchemes: current.customSchemes.filter((scheme) => scheme.id !== id),
    }));
  /** Accept only fonts registered for the requested role. */
  const setFont = (role: FontRole, id: string) => {
    if (FONT_OPTIONS[role].some((font) => font.id === id))
      setAppearance((current) => ({ ...current, fonts: { ...current.fonts, [role]: id } }));
  };
  return (
    <ThemeContext.Provider
      value={{
        theme,
        syncStatus,
        legacyAvailable,
        retrySave: sync.retry,
        loadRemote: sync.loadRemote,
        saveCurrent: sync.saveCurrent,
        importBrowserAppearance: sync.importBrowserAppearance,
        dismissBrowserAppearance: sync.dismissBrowserAppearance,
        appearance,
        setTheme: setMode,
        setMode,
        toggle: () => setMode(theme === "dark" ? "light" : "dark"),
        setScheme,
        saveScheme,
        deleteScheme,
        setFont,
        resetAppearance: () =>
          setAppearance((current) => ({
            ...DEFAULT_APPEARANCE,
            fonts: { ...DEFAULT_APPEARANCE.fonts },
            customSchemes: current.customSchemes,
          })),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

/** Read the account controls; require a provider so edits have one save queue. */
export function useTheme(): ThemeCtx {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
