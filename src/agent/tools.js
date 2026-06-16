// Tool definitions (Anthropic `tools` schemas) + the agent system prompt.
//
// The model never sees the DOM directly. `read_page` returns a compact,
// numbered "ref snapshot" of interactive elements; every other tool refers to
// an element by its `ref` number from the most recent snapshot.

export const SYSTEM_PROMPT = `You are Claude, an agent operating inside a Firefox sidebar. You can read the
current web page and act on it on the user's behalf.

How you see pages:
- Call read_page to get a numbered snapshot of the visible, interactive
  elements (links, buttons, inputs, etc.). Each line looks like:
    [12] button "Sign in"
    [13] textbox "Email" value=""
- Refer to elements by their [ref] number. Refs are ONLY valid for the most
  recent snapshot of a given tab — after any click, type, navigation, or scroll
  the page may change, so call read_page again before acting on stale refs.

Operating rules:
- Read before you act. Take a fresh read_page after actions that change the page.
- Take the smallest action that makes progress, then observe the result.
- Be transparent: briefly say what you are about to do before doing it.
- Stop and ask the user when a step is ambiguous, destructive, involves money or
  credentials, or leaves the current site unexpectedly.
- Never enter passwords, payment details, or 2FA codes. Ask the user to do that.
- If you cannot find an element, scroll or re-read the page before giving up.
- To SEE the page visually — images, logos, charts, layout, colours, anything not
  in the text snapshot — use the screenshot tool when it is available. read_page
  returns text and interactive elements, NOT images. If the user asks whether you
  see an image / what something looks like / about a picture on the page, take a
  screenshot instead of saying you cannot see images. (If the screenshot fails for
  lack of permission, tell the user to enable "Auf allen Seiten erlauben".)
- The user can also attach an image to their message; if an image is present, look
  at it directly.
- Answer in the user's language.

When the task is informational (summarize, extract, compare), prefer reading the
page (and other tabs via list_tabs / read_tab) over taking actions.`;

/** Build the tools array. Some tools are gated by settings. */
export function buildTools(settings = {}) {
  const tools = [
    {
      name: "read_page",
      description:
        "Read the current tab and return a numbered snapshot of its interactive elements and visible text. Call this first, and again after any action that may change the page.",
      input_schema: {
        type: "object",
        properties: {
          include_text: {
            type: "boolean",
            description: "Also include the page's readable text content (default true).",
          },
        },
      },
    },
    {
      name: "click",
      description: "Click an element by its [ref] number from the latest read_page snapshot.",
      input_schema: {
        type: "object",
        properties: { ref: { type: "integer", description: "The element ref to click." } },
        required: ["ref"],
      },
    },
    {
      name: "type",
      description:
        "Type text into an input, textarea, or contenteditable element by its [ref]. Optionally submit (press Enter) afterwards. Do NOT use for passwords or payment fields.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "integer", description: "The input element ref." },
          text: { type: "string", description: "The text to type." },
          submit: { type: "boolean", description: "Press Enter after typing (default false)." },
          clear: { type: "boolean", description: "Clear the field first (default true)." },
        },
        required: ["ref", "text"],
      },
    },
    {
      name: "select",
      description: "Choose an option in a <select> dropdown by its [ref] and the option's visible text or value.",
      input_schema: {
        type: "object",
        properties: {
          ref: { type: "integer" },
          value: { type: "string", description: "Option label or value to select." },
        },
        required: ["ref", "value"],
      },
    },
    {
      name: "scroll",
      description: "Scroll the page or an element to reveal more content.",
      input_schema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
          ref: { type: "integer", description: "Optional element ref to scroll into view." },
        },
        required: ["direction"],
      },
    },
    {
      name: "navigate",
      description: "Navigate the current tab: open a URL, or go back/forward/reload.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["url", "back", "forward", "reload"] },
          url: { type: "string", description: "Required when action is 'url'. Must be http(s)." },
        },
        required: ["action"],
      },
    },
    {
      name: "list_tabs",
      description: "List the user's open tabs (id, title, url, active) so you can read across them.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "read_tab",
      description: "Read another open tab by its id (from list_tabs) and return its snapshot/text.",
      input_schema: {
        type: "object",
        properties: { tab_id: { type: "integer" } },
        required: ["tab_id"],
      },
    },
    {
      name: "wait",
      description: "Wait a number of milliseconds for the page to settle (e.g. after a navigation).",
      input_schema: {
        type: "object",
        properties: { ms: { type: "integer", description: "Milliseconds, max 10000." } },
        required: ["ms"],
      },
    },
  ];

  if (settings.visionScreenshots) {
    tools.push({
      name: "screenshot",
      description:
        "Capture a screenshot of the visible part of the current tab and analyze it visually. Use when the ref snapshot is insufficient (canvas, complex layout, charts).",
      input_schema: { type: "object", properties: {} },
    });
  }

  return tools;
}
