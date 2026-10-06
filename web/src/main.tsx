// JetBrains Mono is a multi-axis variable font; Fontsource splits it into one
// CSS file per axis. Import the `wght` axis so the full weight range is
// available to anything using `--font-mono` (code, IDs, tabular numbers).
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
// Saira's `wdth` file ships the weight and width axes for its 8% wider page
// titles. The default body face uses system-ui.
import "@fontsource-variable/saira/wdth.css";
// Optional fonts use Fontsource variable weights and its default swap policy.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/fira-code/wght.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeAppearance } from "./lib/appearance";
// index.css defines the shared color and font tokens and imports Tailwind once.
import "./index.css";

// StrictMode intentionally double-mounts effects in dev. Useful in
// general, but it interacts badly with ghostty-web's WASM Terminal:
// the first mount opens a WS to ttyd, cleanup closes it, the second
// mount opens a fresh WS — bash sees two SIGWINCH-driven resize
// flurries on top of each other and the rendered output overlaps.
// Until we make TerminalPane fully StrictMode-idempotent, opt out
// at the root.
initializeAppearance();

createRoot(document.getElementById("root")!).render(<App />);
