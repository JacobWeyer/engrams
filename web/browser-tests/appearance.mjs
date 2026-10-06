import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helmConfig = readFileSync(
  path.resolve(webRoot, "../deploy/helm/engram/templates/web-configmap.yaml"),
  "utf8",
);
const productionCsp = [
  ...helmConfig.matchAll(/add_header Content-Security-Policy "([^"]+)" always;/g),
]
  .map((match) => match[1])
  .find((value) => value.includes("worker-src"));
assert(productionCsp);
const server = await createServer({
  root: webRoot,
  server: {
    host: "127.0.0.1",
    port: 0,
    hmr: false,
    fs: { allow: [webRoot, realpathSync(path.join(webRoot, "node_modules"))] },
    headers: { "Content-Security-Policy": productionCsp },
  },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const localBrowser = "/usr/local/bin/engram-chromium";
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.ENGRAM_BROWSER_EXECUTABLE ??
      (existsSync(localBrowser) ? localBrowser : undefined),
  });
  const context = await browser.newContext();
  const resourceRequests = [];
  context.on("request", (request) => resourceRequests.push(request.url()));
  /** Identify optional font assets in recorded network requests. */
  const isOptionalFont = (url) => /(?:inter|fira-code)-[^/]*\.woff2(?:\?|$)/.test(url);
  const records = new Map();
  const requests = [];
  let failNextSave = false;
  const defaults = {
    version: 1,
    mode: "light",
    schemeId: "engrams",
    customSchemes: [],
    fonts: { sans: "system", display: "saira", mono: "jetbrains" },
  };
  /** Read account state without creating a server record for defaults. */
  const snapshot = (account) =>
    records.get(account) ?? {
      revision: 0,
      document: { version: 1, appearance: structuredClone(defaults) },
      updatedAt: null,
    };
  // This HTTP fixture survives page reloads and browser storage removal. Cookies
  // select the session identity; neither the URL nor the PATCH body supplies it.
  /** Model revision checks and save failures at the HTTP boundary. */
  const preferencesRoute = async (route) => {
    const request = route.request();
    const account =
      request.headers().cookie?.match(/(?:^|; )appearance-test-account=([^;]+)/)?.[1] ?? "U1";
    const current = snapshot(account);
    requests.push({ method: request.method(), account });
    /** Return the API fixture status and JSON snapshot. */
    const respond = (status, body) => route.fulfill({ status, json: body });
    if (request.method() === "GET") return respond(200, current);
    assert.equal(request.method(), "PATCH");
    const body = request.postDataJSON();
    assert.deepEqual(Object.keys(body).sort(), ["appearance", "expectedRevision"]);
    if (failNextSave) {
      failNextSave = false;
      return respond(503, { error: "Temporary save failure" });
    }
    if (body.expectedRevision !== current.revision) return respond(409, current);
    /** Wait for the current account queue to confirm its latest save. */
    const saved = {
      revision: current.revision + 1,
      document: { version: 1, appearance: body.appearance },
      updatedAt: new Date().toISOString(),
    };
    records.set(account, saved);
    return respond(200, saved);
  };
  await context.route("**/api/v1/me/preferences", preferencesRoute);
  const page = await context.newPage();
  const saved = () =>
    page
      .getByTestId("appearance-sync-status")
      .filter({ hasText: /^saved$/ })
      .waitFor();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${origin}/browser-tests/appearance.html`);
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await saved();
  assert.equal(records.size, 0, "A GET must not create server preferences.");
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    resourceRequests.filter(isOptionalFont).length,
    0,
    "Optional fonts must not load before selection.",
  );
  /** Select a scheme or font through the browser controls. */
  const choose = async (target, label, option) => {
    await target.getByRole("combobox", { name: label, exact: true }).click();
    await target.getByRole("option", { name: option, exact: true }).click();
  };
  await choose(page, "Body font", "Inter");
  await choose(page, "Heading font", "Inter");
  await choose(page, "Code font", "Fira Code");
  for (const [family, style] of [
    ["Inter Variable", "400"],
    ["Inter Variable", "italic 400"],
    ["Fira Code Variable", "400"],
  ]) {
    const faces = await page.evaluate(
      async ({ family, style }) => {
        const loaded = await document.fonts.load(`${style} 16px "${family}"`, "Engrams 123");
        return loaded.map((face) => ({
          family: face.family.replaceAll('"', ""),
          status: face.status,
        }));
      },
      { family, style },
    );
    assert(faces.length > 0, `${family} ${style} must load an actual FontFace.`);
    assert(faces.every((face) => face.family === family && face.status === "loaded"));
  }
  assert(resourceRequests.some((url) => /inter-[^/]*normal\.woff2/.test(url)));
  assert(resourceRequests.some((url) => /inter-[^/]*italic\.woff2/.test(url)));
  assert(resourceRequests.some((url) => /fira-code-[^/]*\.woff2/.test(url)));
  const optionalFamilies = await page.evaluate(() => ({
    body: getComputedStyle(document.querySelector('[data-testid="body-font-sample"]')).fontFamily,
    heading: getComputedStyle(document.querySelector("h1")).fontFamily,
    code: getComputedStyle(document.querySelector("pre")).fontFamily,
  }));
  assert.match(optionalFamilies.body, /Inter Variable/);
  assert.match(optionalFamilies.heading, /Inter Variable/);
  assert.match(optionalFamilies.code, /Fira Code Variable/);
  for (const [id, label, light, dark] of [
    ["catppuccin", "Catppuccin", "#eff1f5", "#1e1e2e"],
    ["nord", "Nord", "#eceff4", "#2e3440"],
    ["solarized", "Solarized", "#fdf6e3", "#002b36"],
    ["gruvbox", "Gruvbox", "#fbf1c7", "#282828"],
  ]) {
    await choose(page, "Color scheme", label);
    for (const [mode, background] of [
      ["Light", light],
      ["Dark", dark],
    ]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      await page.waitForFunction(
        (color) => document.documentElement.style.getPropertyValue("--background") === color,
        background,
      );
      assert.match(
        await page.getByRole("combobox", { name: "Body font", exact: true }).innerText(),
        /Inter/,
      );
      assert.match(
        await page.getByRole("combobox", { name: "Heading font", exact: true }).innerText(),
        /Inter/,
      );
      assert.match(
        await page.getByRole("combobox", { name: "Code font", exact: true }).innerText(),
        /Fira Code/,
      );
    }
    await saved();
    assert.equal(snapshot("U1").document.appearance.schemeId, id);
    assert.deepEqual(snapshot("U1").document.appearance.customSchemes, []);
  }
  assert.deepEqual(snapshot("U1").document.appearance.fonts, {
    sans: "inter",
    display: "inter",
    mono: "fira-code",
  });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await saved();
  assert.match(
    await page.getByRole("combobox", { name: "Color scheme", exact: true }).innerText(),
    /Gruvbox/,
  );
  assert.match(
    await page.getByRole("combobox", { name: "Body font", exact: true }).innerText(),
    /Inter/,
  );
  assert.match(
    await page.getByRole("combobox", { name: "Heading font", exact: true }).innerText(),
    /Inter/,
  );
  assert.match(
    await page.getByRole("combobox", { name: "Code font", exact: true }).innerText(),
    /Fira Code/,
  );
  await page.getByRole("button", { name: "Reset appearance", exact: true }).click();
  await saved();

  await page.getByRole("button", { name: "Use system setting", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await page.getByRole("button", { name: "Create custom scheme", exact: true }).click();
  await page.getByRole("textbox", { name: "Scheme name", exact: true }).fill("Browser test colors");
  await page.getByLabel("Light page color", { exact: true }).evaluate((input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "#fff4e8");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Save scheme", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--background") === "#fff4e8",
  );
  await page.getByRole("combobox", { name: "Heading font", exact: true }).click();
  await page.getByRole("option", { name: "Georgia", exact: true }).click();
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector("h1")).fontFamily.includes("Georgia"),
  );
  await page.getByRole("combobox", { name: "Code font", exact: true }).click();
  await page.getByRole("option", { name: "System monospace", exact: true }).click();
  await page.waitForFunction(
    () => !getComputedStyle(document.querySelector("pre")).fontFamily.includes("JetBrains"),
  );
  await page.getByRole("button", { name: "Export scheme", exact: true }).click();
  const exported = await page
    .getByRole("textbox", { name: "Color scheme JSON", exact: true })
    .inputValue();
  assert.equal(JSON.parse(exported).name, "Browser test colors");
  await saved();
  assert.equal(snapshot("U1").document.appearance.customSchemes[0].name, "Browser test colors");
  assert.equal(snapshot("U1").document.appearance.fonts.display, "georgia");
  // Prove the server restores preferences without any browser cache.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--background") === "#fff4e8",
  );
  assert.match(
    await page.getByRole("combobox", { name: "Heading font", exact: true }).innerText(),
    /Georgia/,
  );
  const surfaces = await page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    pane: getComputedStyle(document.querySelector('[data-testid="pane-sample"]')).getPropertyValue(
      "--background",
    ),
    rail: getComputedStyle(document.querySelector('[data-testid="rail-sample"]')).getPropertyValue(
      "--sidebar",
    ),
  }));
  assert.equal(surfaces.page, "rgb(255, 244, 232)");
  assert.notEqual(surfaces.pane.trim(), "#fff4e8");
  assert(surfaces.rail.trim());
  await page.waitForSelector('code[data-highlighted="true"]');
  const keyword = page
    .locator('code[data-highlighted="true"] span')
    .filter({ hasText: /^const$/ })
    .first();
  assert.match(await keyword.evaluate((element) => getComputedStyle(element).color), /^rgb/);
  await page.waitForFunction(() =>
    document.querySelector("diffs-container")?.shadowRoot?.textContent.includes("After"),
  );
  const diffKeyword = await page.evaluate(() => {
    const shadow = document.querySelector("diffs-container").shadowRoot;
    const token = [...shadow.querySelectorAll("span")].find(
      (element) => element.textContent === "const",
    );
    return token
      ? { color: getComputedStyle(token).color, font: getComputedStyle(token).fontFamily }
      : null;
  });
  assert(diffKeyword, "The diff keyword did not render.");
  assert.equal(
    diffKeyword.color,
    await keyword.evaluate((element) => getComputedStyle(element).color),
  );
  assert.doesNotMatch(diffKeyword.font, /JetBrains/);
  if (process.env.ENGRAM_APPEARANCE_SCREENSHOT) {
    await page.screenshot({ path: process.env.ENGRAM_APPEARANCE_SCREENSHOT, fullPage: true });
  }
  await page.getByRole("button", { name: "Open sample dialog", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(
    await dialog.evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgb(255, 244, 232)",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("textbox", { name: "Color scheme JSON", exact: true })
    .fill('{"id":"broken"}');
  await page.getByRole("button", { name: "Import scheme", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Reset appearance", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--background") === "",
  );
  assert.equal(
    await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await saved();
  const accountRevision = snapshot("U1").revision;
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await saved();
  assert(snapshot("U1").revision > accountRevision);
  await page.getByRole("button", { name: "Switch to U2", exact: true }).click();
  await saved();
  assert.equal(await page.getByTestId("account").innerText(), "U2");
  assert.equal(
    await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(snapshot("U2").revision, 0);
  await page.getByRole("combobox", { name: "Heading font", exact: true }).click();
  await page.getByRole("option", { name: "Georgia", exact: true }).click();
  await saved();
  assert.equal(snapshot("U2").document.appearance.fonts.display, "georgia");
  assert.equal(snapshot("U1").document.appearance.fonts.display, "saira");
  await page.getByRole("button", { name: "Switch to U1", exact: true }).click();
  await saved();
  assert.equal(
    await page.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    await page.getByRole("combobox", { name: "Heading font", exact: true }).innerText(),
    /Saira/,
  );

  // A failed save retains the visible edit and exposes a working retry.
  failNextSave = true;
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page
    .getByTestId("appearance-sync-status")
    .filter({ hasText: /^error$/ })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(snapshot("U1").document.appearance.mode, "dark");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await saved();
  assert.equal(snapshot("U1").document.appearance.mode, "light");

  // A second device changes the server revision. This tab must keep its local
  // edit until the user chooses the current server settings.
  const otherDevice = await browser.newContext();
  await otherDevice.route("**/api/v1/me/preferences", preferencesRoute);
  const remotePage = await otherDevice.newPage();
  remotePage.on("pageerror", (error) => errors.push(error.message));
  await remotePage.goto(`${origin}/browser-tests/appearance.html`);
  /** Wait for the second device to finish saving its account changes. */
  const remoteSaved = () =>
    remotePage
      .getByTestId("appearance-sync-status")
      .filter({ hasText: /^saved$/ })
      .waitFor();
  await remoteSaved();
  await remotePage.getByRole("button", { name: "Use system setting", exact: true }).click();
  await remotePage.getByRole("combobox", { name: "Heading font", exact: true }).click();
  await remotePage.getByRole("option", { name: "Georgia", exact: true }).click();
  await remoteSaved();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page
    .getByTestId("appearance-sync-status")
    .filter({ hasText: /^conflict$/ })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Dark", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(snapshot("U1").document.appearance.mode, "system");
  await page.getByRole("button", { name: "Load account settings", exact: true }).click();
  await saved();
  assert.equal(
    await page
      .getByRole("button", { name: "Use system setting", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    await page.getByRole("combobox", { name: "Heading font", exact: true }).innerText(),
    /Georgia/,
  );
  await remotePage.getByRole("button", { name: "Light", exact: true }).click();
  await remoteSaved();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page
    .getByTestId("appearance-sync-status")
    .filter({ hasText: /^conflict$/ })
    .waitFor();
  assert.equal(snapshot("U1").document.appearance.mode, "light");
  await page.getByRole("button", { name: "Save my current settings", exact: true }).click();
  await saved();
  assert.equal(snapshot("U1").document.appearance.mode, "dark");
  await otherDevice.close();

  // The ownerless legacy value is offered, never assigned without consent.
  await page.evaluate((appearance) => {
    localStorage.setItem("engrams-appearance-v1", JSON.stringify({ ...appearance, mode: "dark" }));
  }, defaults);
  await page.getByRole("button", { name: "Switch to U3", exact: true }).click();
  await saved();
  assert.equal(
    await page.getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(snapshot("U3").revision, 0);
  assert(await page.evaluate(() => localStorage.getItem("engrams-appearance-v1")));
  await page.getByRole("button", { name: "Import this browser appearance", exact: true }).click();
  await saved();
  assert.equal(snapshot("U3").document.appearance.mode, "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("engrams-appearance-v1")), null);
  await page.getByRole("combobox", { name: "Color scheme", exact: true }).click();
  await page.getByRole("option", { name: "Dracula", exact: true }).click();
  await saved();
  assert.equal(snapshot("U3").document.appearance.schemeId, "dracula");
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--background") === "#282a36",
  );
  assert.equal(
    await keyword.evaluate((element) => getComputedStyle(element).color),
    "rgb(255, 121, 198)",
  );
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await saved();
  assert.equal(snapshot("U3").document.appearance.mode, "light");
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--background") === "#fffbeb",
  );
  assert.equal(
    await keyword.evaluate((element) => getComputedStyle(element).color),
    "rgb(163, 20, 77)",
  );

  // An unavailable optional face must use its local fallback without blocking
  // controls, code rendering, or server saves.
  const fallbackContext = await browser.newContext();
  fallbackContext.on("request", (request) => resourceRequests.push(request.url()));
  await fallbackContext.route("**/api/v1/me/preferences", preferencesRoute);
  const blockedFonts = [];
  await fallbackContext.route(/(?:inter|fira-code)-[^/]*\.woff2(?:\?|$)/, async (route) => {
    blockedFonts.push(route.request().url());
    await route.abort("failed");
  });
  const fallbackPage = await fallbackContext.newPage();
  fallbackPage.on("pageerror", (error) => errors.push(error.message));
  await fallbackPage.goto(`${origin}/browser-tests/appearance.html`);
  await fallbackPage
    .getByTestId("appearance-sync-status")
    .filter({ hasText: /^saved$/ })
    .waitFor();
  await choose(fallbackPage, "Body font", "Inter");
  await choose(fallbackPage, "Code font", "Fira Code");
  await fallbackPage.evaluate(() => document.fonts.ready);
  for (const family of ["Inter Variable", "Fira Code Variable"]) {
    const fallback = await fallbackPage.evaluate(async (family) => {
      let rejected = false;
      try {
        await document.fonts.load(`400 16px "${family}"`, "Engrams 123");
      } catch {
        rejected = true;
      }
      const selector = family === "Inter Variable" ? '[data-testid="body-font-sample"]' : "pre";
      const element = document.querySelector(selector);
      const stack = getComputedStyle(element).fontFamily;
      const canvas = document.createElement("canvas");
      const painter = canvas.getContext("2d");
      painter.font = `16px ${stack}`;
      const actualWidth = painter.measureText("Engrams MMMiii 0123456789").width;
      painter.font = `16px ${stack.split(",").slice(1).join(",")}`;
      const fallbackWidth = painter.measureText("Engrams MMMiii 0123456789").width;
      return {
        rejected,
        actualWidth,
        fallbackWidth,
        stack,
        height: element.getBoundingClientRect().height,
      };
    }, family);
    assert(fallback.rejected, `${family} should report the blocked face.`);
    assert(fallback.actualWidth > 0 && fallback.height > 0);
    assert(
      Math.abs(fallback.actualWidth - fallback.fallbackWidth) < 0.1,
      `${family} must render with fallback metrics.`,
    );
    assert.match(fallback.stack, family === "Inter Variable" ? /system-ui/ : /ui-monospace/);
  }
  assert(blockedFonts.some((url) => url.includes("inter-")));
  assert(blockedFonts.some((url) => url.includes("fira-code-")));
  await fallbackPage
    .getByTestId("appearance-sync-status")
    .filter({ hasText: /^saved$/ })
    .waitFor();
  assert.equal(snapshot("U1").document.appearance.fonts.sans, "inter");
  assert.equal(snapshot("U1").document.appearance.fonts.mono, "fira-code");
  await fallbackContext.close();
  assert(
    resourceRequests
      .filter((url) => /\.woff2(?:\?|$)/.test(url))
      .every((url) => new URL(url).origin === origin),
    "All bundled font requests must stay on the application origin.",
  );
  assert(
    !resourceRequests.some((url) =>
      /fonts\.(?:googleapis|gstatic)\.com/.test(new URL(url).hostname),
    ),
    "Fonts must not contact Google.",
  );
  assert(requests.some((request) => request.method === "PATCH" && request.account === "U2"));
  assert.deepEqual(errors, []);
  console.log(
    "Appearance browser test passed: modes, Dracula light/dark palettes and syntax, custom colors, fonts, code, diffs, dialogs, new presets in both modes, loaded local optional fonts, lazy font requests and readable font fallback, server persistence after cache removal, account isolation, retry, revision conflicts, import validation, and reset.",
  );
} finally {
  await browser?.close();
  await server.close();
}
