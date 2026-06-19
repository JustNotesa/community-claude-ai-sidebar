# Projekt-Hinweise — Community Claude AI Sidebar (Firefox-Extension)

## Persistentes, steuerbares Firefox-Fenster (über Sessions hinweg)

Es gibt ein echtes Firefox-Fenster mit geladener Extension, das **von jeder
Claude-Session aus** steuerbar ist (Tabs öffnen, Sidebar, navigieren, screenshotten).
Mechanik: ein **abgekoppelter Keeper-Prozess** hält geckodriver auf festem Port,
die Session-ID liegt in `tests/.ff-session.json` → andere Sessions docken per
rekonstruiertem WebDriver wieder an (selenium-webdriver 4.45 hat kein
`attachToSession` mehr; daher Wiederaufbau aus `Session`+`Executor`).

**Starten / neu starten** (detached; Login bleibt im Profil `~/claude-ff-profile`):
```
cd "<projekt>" && MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 nohup node tests/ff-claude-live.mjs >> tests/.ff-keeper.log 2>&1 & disown
```
Das öffnet das Fenster (violetter Akzent via `userChrome.css`, Sidebar offen),
fixiert geckodriver auf Port 4445 und schreibt `tests/.ff-session.json`.

**Aus einer beliebigen Session andocken** (kein neues Fenster):
```
node tests/ff-attach.mjs                     # Health-Check (Handle, #Tabs)
node tests/ff-attach.mjs tabs                # ALLE Tabs + Container-IDs
node tests/ff-attach.mjs front               # Fenster nach vorne holen
node tests/ff-attach.mjs -s <id> open <url>  # <url> im EIGENEN Container der Session öffnen (+persistiert)
node tests/ff-attach.mjs -s <id> restore     # persistierte Tabs dieser Session wieder öffnen
node tests/ff-attach.mjs -s <id> tabs        # nur Tabs dieser Session
node tests/ff-attach.mjs -s <id> close       # Tabs dieser Session schließen (bleiben persistiert)
node tests/ff-attach.mjs -s <id> forget      # Container + persistierte Tabs der Session verwerfen
```
`-s <id>` = Claude-Session-ID (oder beliebiges Label); alt. via Env `CLAUDE_SESSION_ID`.

**Pro Session ein eigener, farbiger Container + persistente Tabs:** Jede Session
bekommt eine eigene Contextual Identity `Claude-<id>` mit eigener Farbe (Palette in
`ff-lib.mjs`). Geöffnete Tab-URLs werden in `tests/.ff-containers.json` gehalten.
Beim **Keeper-Start werden alle Sessions automatisch wiederhergestellt** (Tabs
„kommen mit"), zusätzlich on demand per `restore`. Container persistieren in
`containers.json` des Profils (gleiche `userContextId` über Neustarts). Kernlogik
in `tests/ff-lib.mjs`; Öffnen via chrome-context `gBrowser.addTab(url, { userContextId,
triggeringPrincipal })`.

**Wichtig:**
- `ff-attach.mjs` ruft **nie** `driver.quit()` (würde das geteilte Fenster schließen).
- Die Session kann im *chrome*-Kontext stehen; `ff-attach.mjs` schaltet für
  Inhalts-Aktionen selbst auf *content* zurück.
- Keeper ist via `nohup` abgekoppelt → überlebt das Session-Ende **best effort**.
  Ist er weg, einfach den Start-Befehl erneut ausführen — Login persistiert
  (`extensions.webextensions.keepStorageOnUninstall` + gepinnte UUID).
- Stoppen (nur diese Instanz, **nie** das normale Firefox des Users):
  `pkill -f "ff-claude-live.mjs"; pkill -f "marionette-port 2828"; pkill -f "claude-ff-profile"`.
- Der User hat oft mehrere echte Firefox-Profile offen — Selenium-Instanz **nur**
  über `claude-ff-profile` / `marionette-port 2828` identifizieren, sonst killt man
  den falschen Browser. Voraussetzung für eigene Instanz neben laufendem Firefox:
  `-no-remote`.

## Login (Claude-Abo) — einmal menschlich, dann Automatisierung

Der Abo-Login (OAuth) lässt sich **nicht automatisieren** (verifiziert FF 152 /
geckodriver 0.37, Juni 2026): `navigator.webdriver` ist unter geckodriver nicht
zuverlässig versteckbar (Mozilla bietet keine Option, `dom.webdriver.enabled=false`
wird überschrieben; `undetected-geckodriver` ist Linux-only), und der
Identity-Provider „Mit Google" blockt automatisierte Browser by-design. Cloudflare
lässt die Login-*Seite* zwar durch — die Wand ist der Google-Schritt.

**Lösung — Login von der Automatisierung entkoppeln:**
1. Firefox **ohne** Marionette auf dem Test-Profil starten (kein webdriver-Flag →
   Google/Cloudflare lassen durch):
   ```
   /Applications/Firefox.app/Contents/MacOS/firefox -profile ~/claude-ff-profile -no-remote -foreground "about:debugging#/runtime/this-firefox" &
   ```
2. Im Fenster: `about:debugging` → „Temporäres Add-on laden" → `manifest.json`;
   Sidebar via **Ctrl+Shift+Y**; „Anmelden" → **„Mit E-Mail"** (umgeht Googles Block).
3. Fenster schließen — Token bleibt im Profil (`keepStorageOnUninstall` + gepinnte
   UUID `d9b1f1e2-…`). Selbst öffnen für den Login geht jederzeit mit dem Befehl oben.
4. Ab jetzt Automatisierung (Selenium/Keeper) auf **demselben** Profil: Token ist da,
   `getValidToken` refresht selbst, Calls gehen an `api.anthropic.com` (Bearer, kein
   Cloudflare). `claude.ai` wird nie wieder gebraucht → webdriver-Flag egal.

**Nutzungs-/Limit-Header (verifiziert live):**
- `count_tokens` liefert **keine** rate-limit-Header → für die „Nutzung"-Anzeige
  unbrauchbar; nur ein echtes `/v1/messages` (auch `max_tokens:1`) liefert die
  `anthropic-ratelimit-unified-*`-Header. `probeLimits()` im Provider macht genau das.
- `unified-*-utilization` ist ein **0–1-Bruch** (0.41 = 41 %), nicht 0–100
  (Geschwisterfeld `-fallback-percentage:0.5` bestätigt es). `usage.js` skaliert ×100.

**Verifizier-Harnesse** (laufen auf `claude-ff-profile`, brauchen echtes Firefox):
- `node tests/ff-usage-probe.mjs` — liest Token + vergleicht count_tokens vs messages.
- `node e2e/screenshot-usage-live.js` — öffnet „Nutzung", löst die Probe aus, liest
  die echten Werte + screenshotet (→ `web-ext-artifacts/shot-usage-live.png`).
- `node tests/ff-webdriver-flag-probe.mjs` — prüft webdriver-Flag + Cloudflare-Status.

## Test / Build
- Unit-Tests: `node --test tests/*.test.mjs` (nicht `tests/*.mjs` — die `ff-*`/`e2e-*`
  sind Selenium-Harnesse und brauchen echtes Firefox).
- `npm run lint` (AMO-Validator), `npm run build` → xpi in `web-ext-artifacts/`.
- Selenium/geckodriver sind via `npm i --no-save` installiert (nicht in package.json).
