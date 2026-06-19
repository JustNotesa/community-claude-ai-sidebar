// Loads the built extension into a real (visible) Firefox and screenshots the
// sidebar so we can eyeball the new usage ring. Needs MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1
// for setContext('chrome') on FF 138+. Run:
//   MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node e2e/screenshot-sidebar.js
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const path = require("path");
const fs = require("fs");

const XPI = path.resolve(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const OUT = path.resolve(__dirname, "../web-ext-artifacts");

const save = (name, b64) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, b64, "base64");
  console.log("saved", p);
};

(async () => {
  const opts = new firefox.Options();
  opts.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
  // A user Firefox is usually already running; force our own instance so the
  // launched process doesn't hand off to it and drop the Marionette socket.
  opts.addArguments("-no-remote");
  opts.setPreference("xpinstall.signatures.required", false);
  opts.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
  opts.windowSize({ width: 1100, height: 820 });

  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(opts).build();
  const out = {};
  try {
    await driver.installAddon(XPI, true);
    await driver.sleep(1500);

    // --- real sidebar, composed window screenshot (chrome context) ---
    try {
      await driver.setContext(firefox.Context.CHROME);
      const key = await driver.executeScript(
        "const k=[...SidebarController.sidebars.keys()].find(k=>/sidebar-action/.test(k));" +
          "SidebarController.show(k);return k;"
      );
      out.sidebarKey = key;
      await driver.sleep(2600);
      save("shot-sidebar.png", await driver.takeScreenshot());
      out.sidebar = "ok";
    } catch (e) {
      out.sidebar = "ERR " + e.message;
    }

    // --- panel.html as a tab: clear view of the ring + filled live state ---
    try {
      await driver.setContext(firefox.Context.CONTENT);
      await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
      await driver.sleep(2000);
      save("shot-panel-initial.png", await driver.takeScreenshot());

      const r = await driver.executeScript(
        "const a=document.querySelector('#btn-usage .arc');" +
          "const b=document.querySelector('#btn-usage');" +
          "if(a)a.setAttribute('stroke-dasharray','62 100');" +
          "if(a)a.classList.remove('high');" +
          "if(b)b.title='Nutzung & Limits — 62%';" +
          "return a?('arc dasharray='+a.getAttribute('stroke-dasharray')):'no-arc';"
      );
      out.fill = r;
      await driver.sleep(700);
      save("shot-panel-fill.png", await driver.takeScreenshot());

      // also a high (>=90%) state to confirm the danger color
      await driver.executeScript(
        "const a=document.querySelector('#btn-usage .arc');" +
          "if(a){a.setAttribute('stroke-dasharray','94 100');a.classList.add('high');}"
      );
      await driver.sleep(700);
      save("shot-panel-high.png", await driver.takeScreenshot());
    } catch (e) {
      out.panel = "ERR " + e.message;
    }
  } finally {
    console.log("RESULT " + JSON.stringify(out));
    await driver.quit();
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
