import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@fontsource-variable/saira/wdth.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/fira-code/wght.css";
import "../src/index.css";
import { ThemeProvider, useTheme } from "../src/components/theme-provider";
import { AppearancePanel } from "../src/components/settings/AppearancePanel";
import { CodeBlock } from "../src/components/CodeBlock";
import PierreDiff from "../src/components/session-thread/PierreDiff";
import { initializeAppearance } from "../src/lib/appearance";
import { AuthContextProvider } from "../src/auth/AuthProvider";
import { abilityFor } from "../src/lib/ability";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../src/components/ui/dialog";

initializeAppearance();

/** Expose surfaces, fonts, and renderers for browser assertions. */
function Samples() {
  const { theme, syncStatus } = useTheme();
  return (
    <>
      <output data-testid="resolved-mode">{theme}</output>
      <p data-testid="body-font-sample">
        Local font sample. <em>Italic sample.</em>
      </p>
      <output data-testid="appearance-sync-status">{syncStatus}</output>
      <div
        className="sidebar-section bg-sidebar text-sidebar-foreground p-3"
        data-testid="rail-sample"
      >
        Navigation sample
      </div>
      <div className="work-pane bg-pane p-3" data-testid="pane-sample">
        Work pane sample
      </div>
      <pre className="font-mono">
        <CodeBlock code={'const message = "Hello";'} language="javascript" />
      </pre>
      <PierreDiff
        path="sample.js"
        before={'const message = "Before";'}
        after={'const message = "After";'}
      />
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Open sample dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Theme sample dialog</DialogTitle>
          <p>Custom colors also apply to dialogs.</p>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Switch fixture accounts while retaining server records across page reloads. */
function Harness() {
  const [userId, setUserId] = useState(
    () => document.cookie.match(/(?:^|; )appearance-test-account=([^;]+)/)?.[1] ?? "U1",
  );
  const value = {
    userId,
    principal: {
      email: `${userId}@example.test`,
      display_name: userId,
      role: "member" as const,
      is_admin: false,
      can_sign_out: true,
    },
    isAdmin: false,
    ability: abilityFor({ id: userId, role: "user" }),
  };
  return (
    <AuthContextProvider value={value}>
      <ThemeProvider>
        <main className="mx-auto max-w-4xl space-y-6 p-6">
          <nav aria-label="Test accounts" className="flex gap-2">
            {["U1", "U2", "U3"].map((account) => (
              <Button
                key={account}
                aria-pressed={userId === account}
                onClick={() => {
                  document.cookie = `appearance-test-account=${account}; path=/; SameSite=Lax`;
                  setUserId(account);
                }}
              >
                Switch to {account}
              </Button>
            ))}
          </nav>
          <output data-testid="account">{userId}</output>
          <AppearancePanel key={userId} />
          <Samples />
        </main>
      </ThemeProvider>
    </AuthContextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
