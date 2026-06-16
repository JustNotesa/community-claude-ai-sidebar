// Drives the REAL Firefox chrome (not just page content): installs the
// extension, opens the actual docked sidebar via the privileged
// SidebarController (chrome context), and screenshots the whole browser window
// — sidebar + toolbar + content — via privileged canvas drawWindow.

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";

// Firefox 138+ gates chrome-context (parent-process) automation behind an
// explicit opt-in. Enable both the env var and the geckodriver flag.
process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/claude_for_firefox-0.1.0.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);
// Disable process isolation so privileged drawWindow can capture content
// (the sidebar panel and the page) — otherwise OOP frames render blank.
options.setPreference("fission.autostart", false);
options.setPreference("fission.webContentIsolationStrategy", 0);

// Point the service at the npm-installed geckodriver and pass the system-access flag.
const geckoCandidates = [
  join(__dirname, "node_modules", "geckodriver", "geckodriver"),
  join(__dirname, "node_modules", "geckodriver", "bin", "geckodriver"),
];
const geckoBin = geckoCandidates.find(existsSync);
let builder = new Builder().forBrowser("firefox").setFirefoxOptions(options);
if (geckoBin) {
  const service = new firefox.ServiceBuilder(geckoBin).addArguments("--allow-system-access");
  builder = builder.setFirefoxService(service);
  console.log("geckodriver:", geckoBin);
} else {
  console.log("geckodriver binary not found; relying on env var only");
}

const driver = await builder.build();
try {
  await driver.manage().window().setRect({ width: 1180, height: 820 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);
  await driver.get("https://example.com/"); // a real page beside the sidebar
  await driver.sleep(1200);

  await driver.setContext(firefox.Context.CHROME);

  // Discover the extension's sidebar view id and open it.
  const opened = await driver.executeScript(`
    const win = window;
    const SC = win.SidebarController || win.SidebarUI;
    if (!SC) return { ok:false, reason:"no SidebarController/SidebarUI" };
    let keys = [];
    try { keys = SC.sidebars ? [...SC.sidebars.keys()] : []; } catch(e){}
    const viewId = keys.find(k => /sidebar-action/.test(k));
    if (!viewId) return { ok:false, reason:"no sidebar-action view", keys };
    try { SC.show(viewId); } catch(e){ return { ok:false, reason:"show() threw: "+e.message, viewId }; }
    return { ok:true, viewId, controller: win.SidebarController ? "SidebarController" : "SidebarUI", keys };
  `);
  console.log("OPEN_SIDEBAR", JSON.stringify(opened));
  await driver.sleep(2500);

  // Capture the whole chrome window (sidebar + toolbar + content).
  const cap = await driver.executeScript(`
    const win = window;
    const w = win.innerWidth, h = win.innerHeight;
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml","canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    try { ctx.drawWindow(win, 0, 0, w, h, "rgb(255,255,255)"); }
    catch(e){ return "drawWindow-error:" + e.message; }
    return canvas.toDataURL("image/png");
  `);

  if (typeof cap === "string" && cap.startsWith("data:image")) {
    writeFileSync(join(__dirname, "ff-sidebar-draw.png"), cap.split(",")[1], "base64");
    console.log("SCREENSHOT(drawWindow) -> ff-sidebar-draw.png");
  } else {
    console.log("DRAWWINDOW_FAILED:", cap);
  }

  // Also try the WebDriver chrome-context screenshot (different capture path).
  try {
    const png = await driver.takeScreenshot();
    writeFileSync(join(__dirname, "ff-sidebar-wd.png"), png, "base64");
    console.log("SCREENSHOT(webdriver-chrome) -> ff-sidebar-wd.png");
  } catch (e) {
    console.log("WEBDRIVER_SHOT_FAILED:", e.message);
  }
} finally {
  await driver.quit();
}
