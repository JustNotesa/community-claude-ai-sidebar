# Community Claude AI Sidebar

> **Inoffizielles Community-Add-on — nicht von Anthropic.** Kein offizielles Claude-Produkt;
> nutzt deinen **eigenen Anthropic-API-Key** oder **Claude Abo**. „Claude" und das Claude-Logo sind Marken von
> Anthropic — dieses Projekt steht in keiner Verbindung zu Anthropic und verwendet deren Logo nicht.

Ein **agentischer KI-Assistent in der nativen Firefox-Sidebar** für die Anthropic-/Claude-API —
eine quelloffene, von der Community gebaute Entsprechung zu „Claude for Chrome", mit zwei
Verbesserungen, die der Chrome-Version fehlen:

1. **Persistente Chats/Sessions.** Verläufe werden dauerhaft in IndexedDB
   gespeichert (mit `unlimitedStorage`). Sie verschwinden **nicht** beim Neuladen,
   Tab-Wechsel oder Neustart. Mit Session-Liste, Umbenennen, Anpinnen, Löschen,
   Export/Import.
2. **Native Sidebar über alle Tabs.** Dank Firefox `sidebar_action` bleibt das
   Chat-/Agenten-Fenster geöffnet und sichtbar, egal welcher Tab gerade aktiv ist.

Claude kann die aktuelle Seite **lesen**, **klicken**, **tippen**, **Formulare
ausfüllen**, **scrollen**, **navigieren** und **über mehrere Tabs hinweg lesen** —
über eine Tool-Use-Schleife, die direkt gegen die Anthropic-API läuft (mit deinem
eigenen API-Key oder Claude Abo).

---

## Schnellstart (Entwicklung)

1. **API-Key besorgen:** <https://console.anthropic.com/settings/keys> (`sk-ant-…`).
2. **Temporär laden:** Firefox → `about:debugging#/runtime/this-firefox` →
   „Temporäres Add-on laden…" → `manifest.json` in diesem Ordner auswählen.
   - Oder per CLI: `npm install` und dann `npm start` (nutzt `web-ext run`).
3. Sidebar öffnen: Toolbar-Button **oder** `Strg+Shift+Y`.
4. Beim ersten Start öffnet sich **Einstellungen** ⚙ — API-Key eintragen, Modell wählen.
5. Auf einer Webseite **„Agent für diese Seite freigeben"** klicken (erteilt den
   Host-Zugriff für genau diese Domain), dann eine Aufgabe eingeben.

> Hinweis: „Temporäre" Add-ons verschwinden beim Schließen von Firefox. Für eine
> dauerhafte (unsignierte) Installation Firefox **Developer Edition / Nightly** mit
> `xpinstall.signatures.required = false`, oder über AMO signieren (`web-ext sign`).

---

## Architektur

```
Toolbar/Tastenkürzel ─▶ background.js  (Sidebar öffnen, Kontextmenüs)
                                │
Firefox Sidebar (sidebar_action, bleibt über alle Tabs offen)
  panel.html / panel.js ── läuft die Agenten-Schleife + API-Calls (persistentes Dokument)
        │  IndexedDB (sessions + messages)         ▲  streamt Tokens/Tool-Schritte ins UI
        ▼                                          │
  src/agent/agent.js ──▶ src/provider/anthropic.js ──▶ api.anthropic.com (SSE, Tool-Use)
        │
        └─ tabs/scripting ──▶ src/content/content.js  (Ref-Snapshot + Klick/Tippen/Scroll)
```

**Warum die Schleife in der Sidebar läuft:** Das Sidebar-Dokument bleibt geöffnet,
solange die Sidebar sichtbar ist — kein Service-Worker-Timeout, kein Verlust des
Laufzustands. Der Hintergrund-Skript bleibt winzig und macht nur das, was von
außerhalb des Panels kommen muss (Sidebar öffnen, Kontextmenüs).

### Dateien

| Pfad | Zweck |
|------|------|
| `manifest.json` | MV3-Manifest (sidebar_action, Berechtigungen, gecko-id) |
| `background/background.js` | Toolbar-Klick → Sidebar; Kontextmenüs |
| `sidebar/panel.html` · `panel.css` · `panel.js` | Sidebar-UI + Controller |
| `src/agent/agent.js` | Agenten-Schleife, Tool-Ausführung, Bestätigungen, Limits |
| `src/agent/tools.js` | Tool-Schemata + System-Prompt |
| `src/provider/provider.js` · `anthropic.js` | Provider-Schicht + Anthropic-Client (SSE/Tool-Use) |
| `src/content/content.js` | Content-Script: Ref-Snapshot + Seitenaktionen |
| `src/storage/db.js` | IndexedDB-Wrapper (persistente Sessions) |
| `src/ui/markdown.js` | Sicherer Mini-Markdown-Renderer |
| `src/util/constants.js` | Modelle/Preise/Defaults/Nachrichten-Typen |

---

## Berechtigungen (und warum)

- `storage`, `unlimitedStorage` — persistente Sessions in IndexedDB.
- `tabs`, `activeTab`, `scripting` — aktiven Tab erkennen, Content-Script injizieren.
- `contextMenus` — „Mit Claude zusammenfassen" / Auswahl erklären.
- `host_permissions: https://api.anthropic.com/*` — direkte API-Aufrufe.
- `optional_host_permissions: <all_urls>` — **wird nicht vorab verlangt.** Der
  Seitenzugriff wird **pro Domain** erst dann angefragt, wenn du „Agent für diese
  Seite freigeben" klickst. Das ist der Datenschutz-Vorteil: ohne deine
  ausdrückliche Freigabe liest der Agent keine Seite.

## Datenschutz

- Der API-Key liegt **nur lokal** (`storage.local`) und wird ausschließlich an
  `api.anthropic.com` gesendet (Header `x-api-key`).
- Chats liegen **lokal** in IndexedDB; nichts wird an Dritte außer Anthropic gesendet.
- Wenn der Agent eine Seite liest, wird deren Inhalt als Teil der Anfrage an
  Anthropic übertragen — wie bei jeder Claude-Nutzung. Freigabe erfolgt pro Domain.
- Keine Telemetrie.

## Sicherheits-UX

- **Bestätigung** vor riskanten Aktionen (Klick, Tippen, Auswahl, Navigation,
  Screenshot) — abschaltbar via „Aktionen automatisch ausführen".
- **Aktions-Timeline** in jeder Antwort zeigt jeden Tool-Schritt + Ergebnis.
- **Ausgabelimit (USD)** pro Lauf; **Schrittlimit** (Standard 30) gegen Endlosläufe.
- Claude wird angewiesen, **keine** Passwörter/Zahlungs-/2FA-Daten einzugeben.

---

## Modelle & Kosten

| Modell | ID | Input $/Mio | Output $/Mio | Kontext |
|--------|----|------------:|-------------:|--------:|
| Claude Opus 4.8 | `claude-opus-4-8` | 5 | 25 | 1M |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 3 | 15 | 1M |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 1 | 5 | 200K |

Die Statuszeile schätzt die Kosten pro Lauf. `effort`/adaptives Denken werden nur
an Modelle gesendet, die sie unterstützen (Opus/Sonnet), nicht an Haiku.

---

## Status — verifiziert

In echtem Firefox getestet (Selenium + geckodriver, chrome-context):

- ✅ Lädt als Add-on; `web-ext lint` 0 Fehler; Sidebar rendert (Screenshot-geprüft).
- ✅ **Voller End-to-End-Agentenlauf mit echter Claude-API:** Seite lesen →
  zusammenfassen; und mehrstufig **lesen → klicken → navigieren → erneut lesen**
  (cross-origin), korrektes Ergebnis.
- ✅ 10 Unit-/Integrationstests grün (Content-Script-DOM via Playwright,
  IndexedDB-Persistenz, SSE-Parser, Markdown, Agenten-Schleife).

Behobene reale Bugs aus dem Testen: `executeScript({files})` ist in Firefox
unzuverlässig → Content-Script wird per **`executeScript({func})`** injiziert;
`[hidden]` von Klassen-`display:` überschrieben → globale `[hidden]{display:none!important}`;
`effort`/Thinking nur an unterstützende Modelle; keine DOM-Knoten in IndexedDB.


## TODO / Optionales

- **iframes** (insb. cross-origin) im Content-Script-Snapshot noch nicht abgedeckt.
- Icons sind SVG-Platzhalter; für AMO ggf. PNGs ergänzen.
- Für dauerhafte Installation signieren: `web-ext sign` (AMO-Credentials nötig).
- Test-Harness (`e2e/`) ist vom Release-Build via `--ignore-files` ausgeschlossen.
- Mögliche nächste Features: geplante Aufgaben (Scheduling), Multi-Tab-Extraktion
  als dediziertes Tool, weitere (legitime) Provider wie ein lokaler Proxy.

## Lizenz

Noch festzulegen (Vorschlag: MPL-2.0, passend zum Firefox-Ökosystem).
