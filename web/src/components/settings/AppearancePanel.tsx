import { useState, type CSSProperties } from "react";
import { Check, AlertTriangle, X } from "lucide-react";
import { PageHeading } from "../page-heading";
import { useTheme } from "../theme-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUILTIN_SCHEMES,
  FONT_OPTIONS,
  resolveScheme,
  contrastRatio,
  exportScheme,
  importScheme,
  getAppearanceTokens,
  type ColorScheme,
  type ColorSeeds,
} from "@/lib/appearance";

const COLOR_ROLES: { role: keyof ColorSeeds; label: string }[] = [
  { role: "background", label: "Page" },
  { role: "foreground", label: "Text" },
  { role: "accent", label: "Accent" },
  { role: "chrome", label: "Frame" },
];
const FONT_ROLES = [
  { role: "sans", label: "Body font" },
  { role: "display", label: "Heading font" },
  { role: "mono", label: "Code font" },
] as const;

/** Edit account colors and fonts, with explicit retry and conflict controls. */
export function AppearancePanel() {
  const {
    appearance,
    syncStatus,
    legacyAvailable,
    retrySave,
    loadRemote,
    saveCurrent,
    importBrowserAppearance,
    dismissBrowserAppearance,
    theme,
    setMode,
    setScheme,
    saveScheme,
    deleteScheme,
    setFont,
    resetAppearance,
  } = useTheme();
  const selected = resolveScheme(appearance);
  const [draft, setDraft] = useState<ColorScheme | null>(null);
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const preview = draft ?? selected;
  const isCustom = appearance.customSchemes.some((scheme) => scheme.id === selected.id);

  /** Copy both modes into an unsaved custom scheme with its own ID. */
  function beginCopy() {
    setDraft({
      ...selected,
      id: `custom-${crypto.randomUUID()}`,
      name: `${selected.name} copy`,
      light: { ...selected.light },
      dark: { ...selected.dark },
    });
    setError("");
    setMessage("");
  }
  /** Validate the preview before it becomes the active account scheme. */
  function save() {
    if (!draft) return;
    try {
      const validated = importScheme(exportScheme(draft));
      saveScheme(validated);
      setDraft(null);
      setError("");
      setMessage("Color scheme saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the name and colors.");
    }
  }
  /** Read color-only JSON into a preview without replacing a preset. */
  function importColors() {
    try {
      const imported = importScheme(json);
      // An imported scheme is a new local copy. It cannot replace a preset.
      setDraft({ ...imported, id: `custom-${crypto.randomUUID()}` });
      setError("");
      setMessage("Imported colors are ready to preview. Save to use them.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This color scheme could not be read.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeading title="Appearance" />
      <p className="text-sm text-muted-foreground">
        Your appearance settings follow your account across devices.
      </p>
      <div className="space-y-2" aria-live="polite">
        <p data-testid="sync-state" className="text-sm">
          {syncStatus === "loading"
            ? "Loading account settings…"
            : syncStatus === "saving"
              ? "Saving…"
              : syncStatus === "saved"
                ? "Saved"
                : syncStatus === "error"
                  ? "Not saved"
                  : syncStatus === "conflict"
                    ? "Settings changed on another device. Your edits are kept."
                    : syncStatus === "unauthenticated"
                      ? "Not saved. Sign in to save your settings."
                      : "Settings apply to this page only."}
        </p>
        {syncStatus === "error" && (
          <Button variant="outline" onClick={retrySave}>
            Retry
          </Button>
        )}
        {syncStatus === "conflict" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={loadRemote}>
              Load account settings
            </Button>
            <Button onClick={saveCurrent}>Save my current settings</Button>
          </div>
        )}
        {legacyAvailable && (
          <div className="space-y-2">
            <p className="text-sm">
              This browser has appearance settings from before account sync. Import them into your
              account?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={importBrowserAppearance}>
                Import this browser appearance
              </Button>
              <Button variant="outline" onClick={dismissBrowserAppearance}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Mode</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(["light", "dark", "system"] as const).map((mode) => (
            <Button
              key={mode}
              variant={appearance.mode === mode ? "default" : "outline"}
              aria-pressed={appearance.mode === mode}
              onClick={() => setMode(mode)}
            >
              {mode === "system" ? "Use system setting" : mode === "light" ? "Light" : "Dark"}
            </Button>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Colors</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="appearance-scheme">Color scheme</Label>
            <Select
              value={appearance.schemeId}
              onValueChange={(id) => {
                setScheme(id);
                setDraft(null);
                setError("");
              }}
            >
              <SelectTrigger id="appearance-scheme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Presets</SelectLabel>
                  {BUILTIN_SCHEMES.map((scheme) => (
                    <SelectItem key={scheme.id} value={scheme.id}>
                      {scheme.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {appearance.customSchemes.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Saved custom schemes</SelectLabel>
                    {appearance.customSchemes.map((scheme) => (
                      <SelectItem key={scheme.id} value={scheme.id}>
                        {scheme.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={beginCopy}>
              Create custom scheme
            </Button>
            {isCustom && (
              <Button
                variant="outline"
                onClick={() => {
                  setDraft({
                    ...selected,
                    light: { ...selected.light },
                    dark: { ...selected.dark },
                  });
                  setError("");
                }}
              >
                Edit scheme
              </Button>
            )}
            {isCustom && (
              <Button
                variant="outline"
                onClick={() => {
                  deleteScheme(selected.id);
                  setDraft(null);
                  setMessage("Color scheme deleted.");
                }}
              >
                Delete scheme
              </Button>
            )}
          </div>
          {draft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="scheme-name">Scheme name</Label>
                <Input
                  id="scheme-name"
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(["light", "dark"] as const).map((mode) => (
                  <fieldset key={mode} className="space-y-3">
                    <legend className="mb-2 text-sm font-semibold">
                      {mode === "light" ? "Light colors" : "Dark colors"}
                    </legend>
                    {COLOR_ROLES.map(({ role, label }) => (
                      <div key={role} className="flex items-center justify-between gap-3">
                        <Label htmlFor={`${mode}-${role}`}>{label}</Label>
                        <input
                          id={`${mode}-${role}`}
                          aria-label={`${mode === "light" ? "Light" : "Dark"} ${label.toLowerCase()} color`}
                          type="color"
                          className="h-9 w-16 cursor-pointer rounded-md border border-input bg-transparent p-1"
                          value={draft[mode][role]}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [mode]: { ...draft[mode], [role]: event.target.value },
                            })
                          }
                        />
                      </div>
                    ))}
                  </fieldset>
                ))}
              </div>
              <div className="flex gap-2">
                <Button onClick={save} disabled={!draft.name.trim()}>
                  Save scheme
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDraft(null);
                    setError("");
                    setMessage("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {(["light", "dark"] as const).map((mode) => (
              <SchemePreview key={mode} scheme={preview} mode={mode} fonts={appearance.fonts} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Previews show both modes. Your current mode is {theme}.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Fonts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {FONT_ROLES.map(({ role, label }) => (
            <div key={role} className="space-y-2">
              <Label htmlFor={`appearance-font-${role}`}>{label}</Label>
              <Select value={appearance.fonts[role]} onValueChange={(id) => setFont(role, id)}>
                <SelectTrigger id={`appearance-font-${role}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FONT_OPTIONS[role].map((font) => (
                    <SelectItem key={font.id} value={font.id}>
                      {font.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Share colors</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label htmlFor="scheme-json">Color scheme JSON</Label>
          <Textarea
            id="scheme-json"
            value={json}
            onChange={(event) => setJson(event.target.value)}
            className="min-h-32 font-mono"
            placeholder="Paste a color scheme here to import it."
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!json.trim()} onClick={importColors}>
              Import scheme
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                try {
                  setJson(exportScheme(preview));
                  setError("");
                  setMessage("Color scheme is ready to copy.");
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : "Check the scheme name and colors.",
                  );
                }
              }}
            >
              Export scheme
            </Button>
          </div>
        </CardContent>
      </Card>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <Button
        variant="outline"
        onClick={() => {
          resetAppearance();
          setDraft(null);
          setJson("");
          setError("");
          setMessage("Appearance reset to defaults.");
        }}
      >
        Reset appearance
      </Button>
    </div>
  );
}

/** Show generated colors and selected fonts without changing page appearance. */
function SchemePreview({
  scheme,
  mode,
  fonts,
}: {
  scheme: ColorScheme;
  mode: "light" | "dark";
  fonts: { sans: string; display: string; mono: string };
}) {
  const colors = scheme[mode];
  const tokens = getAppearanceTokens(scheme, mode);
  const background = tokens.background ?? colors.background;
  const foreground = tokens.foreground ?? colors.foreground;
  const accent = tokens.primary ?? colors.accent;
  /** Choose contrasting text for preview accents and frames. */
  const readableInk = (background: string) =>
    contrastRatio(background, "#ffffff") > contrastRatio(background, "#16202b")
      ? "#ffffff"
      : "#16202b";
  const accentInk = tokens["primary-foreground"] ?? readableInk(accent);
  const frameInk = tokens["sidebar-foreground"] ?? readableInk(colors.chrome);
  const ratio = contrastRatio(foreground, background);
  // The same generated tokens apply only to this preview, before Save.
  const previewVariables: CSSProperties = Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [`--${key}`, value]),
  );
  /** Resolve each independent font choice to its stack of fallback fonts. */
  const fontFamily = (role: keyof typeof fonts) =>
    FONT_OPTIONS[role].find((font) => font.id === fonts[role])?.family;
  return (
    <section
      aria-label={`${mode === "light" ? "Light" : "Dark"} preview`}
      className="overflow-hidden rounded-lg"
      style={{
        ...previewVariables,
        backgroundColor: colors.chrome,
        color: frameInk,
        padding: 12,
        fontFamily: fontFamily("sans"),
      }}
    >
      <p className="mb-2 text-xs">Tasks · Settings</p>
      <div
        className="space-y-3 rounded-md p-3 text-sm"
        style={{ backgroundColor: background, color: foreground }}
      >
        <h2 className="text-lg font-semibold" style={{ fontFamily: fontFamily("display") }}>
          {mode === "light" ? "Light preview" : "Dark preview"}
        </h2>
        <p>Your task is ready. Review the changes and send a message.</p>
        <code className="block text-xs" style={{ fontFamily: fontFamily("mono") }}>
          src/example.ts · +12 −3
        </code>
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="inline-flex items-center gap-1">
            <Check aria-hidden className="size-3" />
            Complete
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertTriangle aria-hidden className="size-3" />
            Needs attention
          </span>
          <span className="inline-flex items-center gap-1">
            <X aria-hidden className="size-3" />
            Failed
          </span>
        </div>
        <span
          className="inline-flex h-9 items-center rounded-md px-3 text-xs font-semibold"
          style={{ backgroundColor: accent, color: accentInk }}
        >
          Send message
        </span>
      </div>
      <div className="mt-3 space-y-1">
        <p className="text-xs">
          Button contrast: {contrastRatio(accent, accentInk).toFixed(1)}:1. Frame contrast:{" "}
          {contrastRatio(colors.chrome, frameInk).toFixed(1)}:1.
        </p>
        <p className="text-xs">
          Text contrast: {ratio.toFixed(1)}:1.{" "}
          {ratio >= 4.5
            ? "Meets the 4.5:1 target for body text."
            : "Below the 4.5:1 target. Change the page or text color for easier reading."}
        </p>
      </div>
    </section>
  );
}
