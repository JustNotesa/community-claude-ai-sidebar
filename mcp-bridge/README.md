# Claude ↔ Firefox MCP-Bridge

Lässt **Claude Code** und **Claude Desktop** Firefox über die *Claude for Firefox*-Erweiterung
fernsteuern (lesen, klicken, tippen, navigieren, Tabs, Screenshot) — über den offiziellen
**MCP**-Mechanismus, nicht über eine gespoofte Kopplung.

```
Claude Code / Claude Desktop ──stdio(MCP)──▶ server.js ──ws://127.0.0.1:8765──▶ Firefox-Sidebar
                                                                                   │ executeTool()
                                                                                   ▼  content.js
```

Der Node-Server (von Claude gestartet) betreibt einen lokalen WebSocket-Server; die Firefox-Sidebar
verbindet sich **dorthin** und führt die Tool-Aufrufe mit exakt derselben Logik aus wie der
eingebaute Agent.

## 1. Server installieren

```bash
cd mcp-bridge
npm install
```

## 2. Bei Claude registrieren

Den **absoluten** Pfad zu `server.js` verwenden (Ordner enthält Leerzeichen → in Anführungszeichen).
Ein **Token** wird beim ersten Start automatisch erzeugt und in `mcp-bridge/.token` gespeichert.

### Claude Code

```bash
claude mcp add --scope user firefox-bridge -- \
  node "/Users/maximilianbottcher/Documents/claudeDesktop/Mozzilla ADDONS/ClaudeFirefox/mcp-bridge/server.js"

claude mcp list      # sollte "firefox-bridge" zeigen
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` bearbeiten, dann Claude Desktop
**komplett beenden und neu starten**. Absoluten `node`-Pfad nutzen (`which node`):

```json
{
  "mcpServers": {
    "firefox-bridge": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/maximilianbottcher/Documents/claudeDesktop/Mozzilla ADDONS/ClaudeFirefox/mcp-bridge/server.js"]
    }
  }
}
```

> Optional kannst du Port/Token über die Umgebung erzwingen:
> `"env": { "CLAUDE_BRIDGE_TOKEN": "<token>", "CLAUDE_BRIDGE_PORT": "8765" }`.

## 3. Token holen

Nach dem ersten Start (durch Claude) steht das Token in der Datei:

```bash
cat "/Users/maximilianbottcher/Documents/claudeDesktop/Mozzilla ADDONS/ClaudeFirefox/mcp-bridge/.token"
```

(Es wird beim Start außerdem auf **stderr** ausgegeben — bei Claude Desktop in
`~/Library/Logs/Claude/mcp-server-firefox-bridge.log`.)

## 4. Bridge in der Erweiterung aktivieren

1. Claude-Sidebar in Firefox öffnen → **⚙ Einstellungen**.
2. **„Auf allen Seiten erlauben"** ankreuzen (damit Claude auf Seiten agieren darf).
3. **„Mit Claude verbinden (MCP-Bridge)"** ankreuzen.
4. Das **Token** aus Schritt 3 in **„Bridge-Token"** einfügen → **Speichern**.
5. Status sollte **„verbunden ✓"** zeigen.

> ⚠️ Die **Sidebar muss offen bleiben**, solange Claude steuern soll — die WebSocket-Verbindung
> lebt nur im Sidebar-Dokument. Schließen = Verbindung weg (Tools melden dann „nicht verbunden").

## Sicherheit

- Server lauscht nur auf **127.0.0.1** (nichts von außen erreichbar).
- Verbindungen werden per **Origin-Check** (`moz-extension://…`) **und Token** autorisiert.
- MCP-getriebene Aktionen laufen durch dieselben Schranken wie der Agent (Host-Freigabe pro Seite,
  nur http(s)-Navigation). Hinweis: die **Einzel-Bestätigung** pro Aktion (`RISKY_TOOLS`) greift nur
  im Sidebar-Agenten, **nicht** bei MCP-Aufrufen — Claude-gesteuerte Aktionen laufen also
  automatisch (bewusst, da du die Bridge ausdrücklich aktivierst). Steuerbar bleibt es über die
  Host-Freigaben.

## Fehlersuche

- **„nicht verbunden"** in der Sidebar → Server läuft nicht / falsches Token / Sidebar geschlossen.
- **Claude zeigt Verbindungsfehler** → `node`-Pfad absolut? Port `8765` belegt? (`CLAUDE_BRIDGE_PORT` setzen.)
- **Stdout-Regel:** Der Server loggt ausschließlich nach stderr — niemals `console.log` ergänzen
  (würde den JSON-RPC-Stream zerstören).
