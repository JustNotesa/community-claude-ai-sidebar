# Community Claude AI Sidebar

> **Inoffizielles Community-Add-on — nicht von Anthropic.** Kein offizielles
> Claude-Produkt. Nutzt deinen **eigenen Anthropic-API-Key** oder dein
> **Claude-Abo** (Pro/Max, Login). „Claude" und das Claude-Logo sind Marken von
> Anthropic; dieses Projekt steht in keiner Verbindung zu Anthropic und verwendet
> dessen Logo nicht.

Ein **agentischer KI-Assistent in der nativen Firefox-Sidebar** — die quelloffene
Community-Entsprechung zu „Claude for Chrome". Claude kann die aktuelle Seite
**lesen, klicken, tippen, Formulare ausfüllen, scrollen, navigieren, Tabs öffnen**
und **über mehrere Tabs hinweg arbeiten** — über eine Tool-Use-Schleife direkt
gegen die Anthropic-API.

## Highlights

- **Zwei Anmeldewege:** **Claude-Abo** (Login mit Pro/Max-Konto über den
  Claude-Code-OAuth-Flow — **Standard**, keine Token-Abrechnung) **oder** eigener
  **Anthropic-API-Key**.
- **Persistente Chats** in IndexedDB (`unlimitedStorage`): überleben Neuladen,
  Tab-Wechsel und Neustart. Mit Liste, Umbenennen, Anpinnen, Löschen, Export/Import.
- **Native Sidebar über alle Tabs** (`sidebar_action`) — bleibt offen, egal welcher
  Tab gerade aktiv ist.
- **Nutzung & Limits:** Panel mit Kontextfenster-Anzeige + Plan-Auslastung
  (5-Stunden- und Wochen-Limit beim Abo; Anfragen/Tokens-pro-Minute beim API-Key)
  und ein **Ring-Indikator** in der Toolbar, der die höchste Live-Auslastung zeigt
  (rot ab 90 %).
- **Pro-Unterhaltung eigener Tab-Container:** Tabs, die der Agent öffnet, landen in
  einer farbigen Firefox-Container-Identity der jeweiligen Unterhaltung und werden
  gemerkt; ein Sidebar-Button stellt sie wieder her.
- **MCP-Bridge (optional):** „Mit Claude verbinden" — Firefox aus **Claude Code /
  Claude Desktop** heraus steuern (lokaler WebSocket-MCP-Server).
- **Adaptives Denken**, **effort**-Stufen, **Vision** (Screenshots ans Modell),
  **Ausgabelimit (USD)** pro Lauf und **Schrittlimit** gegen Endlosläufe.

## Schnellstart

1. **Add-on laden:** Firefox → `about:debugging#/runtime/this-firefox` →
   „Temporäres Add-on laden…" → `manifest.json` in diesem Ordner.
   (Oder per CLI: `npm install && npm start`.)
2. **Sidebar öffnen:** Toolbar-Button oder **Strg/Ctrl+Shift+Y**.
3. **Anmelden** (Einstellungen ⚙ öffnen sich beim ersten Start):
   - **Claude-Abo (Standard):** „Anmelden" → im geöffneten Tab **„Mit E-Mail"** oder
     **„Mit Google"** → der Code wird automatisch übernommen. Über dein Abo gedeckt,
     kein API-Key nötig.
   - **Anthropic-API-Key:** Anmeldemethode auf „API-Key" stellen und `sk-ant-…`
     eintragen ([Key holen](https://console.anthropic.com/settings/keys)).
4. Modell wählen, optional adaptives Denken / `effort` / Ausgabelimit setzen.
5. Auf einer Webseite eine Aufgabe eingeben — Claude liest, klickt und navigiert.

> „Temporäre" Add-ons verschwinden beim Schließen von Firefox (der Login bleibt im
> Profil erhalten). Für eine dauerhafte **unsignierte** Installation Firefox
> **Developer Edition / Nightly** (`xpinstall.signatures.required=false`), oder über
> AMO signieren (`npm run sign`).
>
> **Hinweis zum Abo-Login:** Ein Abo über ein Drittanbieter-Tool zu nutzen ist eine
> Grauzone gegenüber Anthropics Nutzungsbedingungen — Einsatz auf eigene Verantwortung.

## Architektur

```
Toolbar/Tastenkürzel ─▶ background/background.js  (Sidebar öffnen, Kontextmenüs,
                         │                          UA/Origin-Rewrite für Abo-Calls)
Firefox Sidebar (sidebar_action — bleibt über alle Tabs offen)
  sidebar/panel.html · panel.js  ── Agenten-Schleife + API-Calls (persistentes Dokument)
        │  IndexedDB (sessions + messages)        ▲  streamt Tokens/Tool-Schritte ins UI
        ▼                                         │
  src/agent/agent.js ─▶ src/provider/*  ─▶ api.anthropic.com (SSE, Tool-Use)
        │                 (anthropic.js = API-Key · oauth.js = Abo/Bearer)
        ├─ tabs/scripting ─▶ src/content/content.js  (Snapshot + Klick/Tippen/Scroll)
        └─ src/util/containers.js  (pro-Unterhaltung-Container + Tab-Restore)

optional:  src/bridge/bridge.js ◀─ WebSocket ─▶ mcp-bridge/  (Claude Code/Desktop)
```

**Warum die Schleife in der Sidebar läuft:** Das Sidebar-Dokument bleibt geöffnet,
solange die Sidebar sichtbar ist — kein Service-Worker-Timeout, kein Verlust des
Laufzustands. Das Hintergrund-Skript bleibt winzig.

### Dateien (Auswahl)

| Pfad | Zweck |
|------|------|
| `manifest.json` | MV3-Manifest (sidebar_action, Berechtigungen, gecko-id) |
| `background/background.js` | Sidebar öffnen; Kontextmenüs; UA/Origin-Rewrite für Abo-Token-/Messages-Calls |
| `sidebar/panel.html · panel.css · panel.js` | Sidebar-UI + Controller (Chat, Timeline, Einstellungen, Nutzung) |
| `src/agent/agent.js · tools.js` | Agenten-Schleife, Tools (inkl. `open_tab`), System-Prompt, Limits |
| `src/provider/provider.js · anthropic.js · oauth.js` | Provider-Schicht; API-Key- und Abo-(OAuth/PKCE)-Client |
| `src/content/content.js · oauth-grab.js` | Seiten-Snapshot/-Aktionen; Auto-Capture des OAuth-Codes |
| `src/util/usage.js` | Rate-Limit-/Usage-Header → Panel + Ring |
| `src/util/containers.js` | Pro-Unterhaltung-Container + Tab-Restore |
| `src/storage/db.js` | IndexedDB-Wrapper (persistente Sessions) |
| `src/ui/markdown.js` | Sicherer Mini-Markdown-Renderer |
| `src/bridge/bridge.js · mcp-bridge/` | MCP-Bridge (Firefox aus Claude Code/Desktop steuern) |
| `src/util/constants.js` | Modelle/Preise/Defaults/OAuth-Konfiguration |

## Berechtigungen (und warum)

- `storage`, `unlimitedStorage` — persistente Sessions in IndexedDB.
- `tabs`, `activeTab`, `scripting` — aktiven Tab lesen, Content-Script injizieren,
  Tabs öffnen/verwalten.
- `contextMenus` — Auswahl zusammenfassen/erklären.
- `webRequest`, `webRequestBlocking` — beim **Abo-Login** den User-Agent auf einen
  CLI-Wert umschreiben und `Origin` entfernen (nur für `…/oauth/token` und
  `api.anthropic.com/v1/messages`); sonst weist der Server den Token ab.
- `contextualIdentities`, `cookies` — farbige Container pro Unterhaltung für die
  Tabs des Agenten.
- `host_permissions: https://api.anthropic.com/*` — die API-Aufrufe.
- `host_permissions: <all_urls>` — der Agent agiert auf den Seiten, die du ihm aufträgst.
- `data_collection_permissions: websiteContent` (AMO-Deklaration) — Seiteninhalt, den
  du den Agenten verarbeiten lässt, geht als Teil der Anfrage an Anthropic.

## Datenschutz

- API-Key/Abo-Token liegen **nur lokal** (`storage.local`); Aufrufe gehen
  ausschließlich an `api.anthropic.com`.
- Chats liegen **lokal** in IndexedDB.
- Seiteninhalt wird **nur** an Anthropic übertragen, wenn du den Agenten eine Seite
  verarbeiten lässt — wie bei jeder Claude-Nutzung.
- Keine Telemetrie, keine Dritten.

## Sicherheits-UX

- **Bestätigung** vor riskanten Aktionen (Klick/Tippen/Navigation/Screenshot) —
  optional automatisch.
- **Aktions-Timeline** je Antwort mit jedem Tool-Schritt + Ergebnis.
- **Ausgabelimit (USD)** pro Lauf; **Schrittlimit** (Standard 30) gegen Endlosläufe.
- Claude wird angewiesen, **keine** Passwörter/Zahlungs-/2FA-Daten einzugeben.

## Modelle & Kosten

| Modell | ID | Input $/Mio | Output $/Mio | Kontext |
|--------|----|------------:|-------------:|--------:|
| Claude Opus 4.8 | `claude-opus-4-8` | 5 | 25 | 1M |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 3 | 15 | 1M |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 1 | 5 | 200K |

Die Statuszeile schätzt die Kosten pro Lauf im **API-Key**-Modus; im **Abo**
entstehen keine Token-Kosten (gedeckt), stattdessen zählt die Plan-Auslastung (siehe
„Nutzung & Limits"). `effort`/adaptives Denken gehen nur an Modelle, die sie
unterstützen (Opus/Sonnet), nicht an Haiku.

## Entwicklung & Tests

- `npm start` — `web-ext run` (lädt das Add-on in eine Firefox-Instanz).
- `npm run build` — XPI nach `web-ext-artifacts/`.
- `npm run lint` — AMO-Validator (`web-ext lint`).
- `npm run sign` — signiertes XPI über AMO (`WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET`).
- `npm test` bzw. `node --test tests/*.test.mjs` — 17 Unit-/Integrationstests
  (SSE-Parser, IndexedDB-Persistenz, Usage-Berechnung, Markdown, Agenten-Schleife).
  Die `tests/ff-*.mjs` / `e2e/*` sind **Selenium-Harnesse** und brauchen echtes
  Firefox (vom Release-Build via `--ignore-files` ausgeschlossen).

Live in echtem Firefox verifiziert (Selenium, chrome-context): Add-on lädt, Sidebar
rendert, voller Agentenlauf gegen die echte API, und das Nutzungs-Panel zeigt echte
Abo-Limits.

## Lizenz

**MPL-2.0** — siehe [`LICENSE`](LICENSE).
