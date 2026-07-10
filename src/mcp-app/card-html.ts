/**
 * A self-contained MCP Apps view. The template is static: saved content is
 * accepted only through the host bridge and inserted with DOM `textContent`.
 * This keeps arbitrary Markdown and HTML from becoming executable markup.
 */
export const CUTLINE_CARD_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
    >
    <title>DraftRelay saved output</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f5ef;
        --panel: #fffdf8;
        --panel-soft: #f1eee5;
        --ink: #1e211d;
        --muted: #6e716a;
        --line: #ded9cd;
        --accent: #2f6f54;
        --accent-ink: #f7fff9;
        --code: #ebe7dc;
        --danger: #9c3f38;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      :root[data-theme="dark"] {
        --bg: #171915;
        --panel: #20231e;
        --panel-soft: #292c26;
        --ink: #f2f0e8;
        --muted: #a9ada3;
        --line: #3a3e36;
        --accent: #76bd91;
        --accent-ink: #102318;
        --code: #2b2f29;
        --danger: #f09a92;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        min-width: 0;
        background: transparent;
        color: var(--ink);
      }

      body { padding: 10px; }

      .card {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        box-shadow: 0 12px 30px rgba(35, 37, 31, 0.08);
      }

      .header { padding: 16px 18px 13px; }

      .eyebrow {
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
        align-items: center;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
        letter-spacing: 0.025em;
      }

      .saved-mark {
        display: inline-flex;
        gap: 5px;
        align-items: center;
        color: var(--accent);
      }

      .saved-dot {
        width: 7px;
        height: 7px;
        border-radius: 99px;
        background: currentColor;
      }

      h1 {
        margin: 0;
        font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
        font-size: clamp(20px, 4vw, 28px);
        font-weight: 620;
        line-height: 1.12;
        overflow-wrap: anywhere;
      }

      .metadata {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 11px;
      }

      .chip {
        max-width: 100%;
        padding: 4px 8px;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        background: var(--panel-soft);
        font-size: 11px;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .body {
        max-height: min(55vh, 460px);
        padding: 15px 18px 18px;
        overflow: auto;
        border-top: 1px solid var(--line);
        line-height: 1.55;
        scrollbar-gutter: stable;
      }

      .body > :first-child { margin-top: 0; }
      .body > :last-child { margin-bottom: 0; }
      .body h2, .body h3, .body h4 { line-height: 1.25; }
      .body h2 { margin: 1.1em 0 0.45em; font-size: 1.25rem; }
      .body h3 { margin: 1em 0 0.4em; font-size: 1.08rem; }
      .body h4 { margin: 0.9em 0 0.35em; font-size: 1rem; }
      .body p { margin: 0.65em 0; white-space: pre-wrap; }
      .body ul, .body ol { margin: 0.65em 0; padding-left: 1.4em; }
      .body li { margin: 0.25em 0; white-space: pre-wrap; }
      .body blockquote {
        margin: 0.8em 0;
        padding: 0.15em 0 0.15em 0.85em;
        border-left: 3px solid var(--accent);
        color: var(--muted);
      }
      .body pre {
        margin: 0.8em 0;
        padding: 11px 12px;
        overflow: auto;
        border-radius: 9px;
        background: var(--code);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .body code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.9em;
      }
      .body hr { border: 0; border-top: 1px solid var(--line); }

      .empty {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }

      .footer {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 12px 14px;
        border-top: 1px solid var(--line);
        background: var(--panel-soft);
      }

      button {
        min-height: 34px;
        padding: 7px 11px;
        border: 1px solid var(--line);
        border-radius: 9px;
        color: var(--ink);
        background: var(--panel);
        font: inherit;
        font-size: 12px;
        font-weight: 650;
        cursor: pointer;
      }

      button.primary {
        border-color: var(--accent);
        color: var(--accent-ink);
        background: var(--accent);
      }

      button:hover:not(:disabled) { filter: brightness(0.98); }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button:disabled { cursor: default; opacity: 0.48; }

      .status {
        min-width: 0;
        margin-left: auto;
        color: var(--muted);
        font-size: 11px;
      }

      .status[data-tone="error"] { color: var(--danger); }

      .fallback-copy {
        position: fixed;
        left: -10000px;
        top: 0;
        width: 1px;
        height: 1px;
        opacity: 0;
      }

      @media (max-width: 480px) {
        body { padding: 6px; }
        .header, .body { padding-left: 14px; padding-right: 14px; }
        .status { width: 100%; margin-left: 0; }
      }
    </style>
  </head>
  <body>
    <main class="card" aria-labelledby="item-title">
      <header class="header">
        <div class="eyebrow">
          <span class="saved-mark"><span class="saved-dot"></span>DraftRelay</span>
          <span id="kind">Saved output</span>
          <span aria-hidden="true">·</span>
          <span id="project">Waiting for item</span>
        </div>
        <h1 id="item-title">Saved to DraftRelay</h1>
        <div id="metadata" class="metadata" aria-label="Item metadata"></div>
      </header>

      <article id="content" class="body">
        <p class="empty">The saved output will appear here when the tool finishes.</p>
      </article>

      <footer class="footer">
        <button id="copy-body" class="primary" type="button" disabled>Copy body</button>
        <button id="copy-markdown" type="button" disabled>Copy Markdown</button>
        <button id="open-item" type="button" disabled>Open in DraftRelay</button>
        <span id="status" class="status" role="status" aria-live="polite">Connecting…</span>
      </footer>
    </main>

    <textarea id="fallback-copy" class="fallback-copy" tabindex="-1" aria-hidden="true"></textarea>

    <script>
      (function () {
        "use strict";

        var PROTOCOL_VERSION = "2026-01-26";
        var nextRequestId = 1;
        var pendingRequests = new Map();
        var resizeObserver = null;
        var state = {
          initialized: false,
          hostCapabilities: {},
          input: {},
          result: null,
          item: null
        };

        var titleElement = document.getElementById("item-title");
        var kindElement = document.getElementById("kind");
        var projectElement = document.getElementById("project");
        var metadataElement = document.getElementById("metadata");
        var contentElement = document.getElementById("content");
        var copyBodyButton = document.getElementById("copy-body");
        var copyMarkdownButton = document.getElementById("copy-markdown");
        var openItemButton = document.getElementById("open-item");
        var fallbackCopyElement = document.getElementById("fallback-copy");
        var statusElement = document.getElementById("status");

        function isRecord(value) {
          return value !== null && typeof value === "object" && !Array.isArray(value);
        }

        function boundedText(value, maximum, fallback) {
          if (typeof value !== "string") return fallback;
          var normalized = value.trim();
          if (!normalized) return fallback;
          return normalized.slice(0, maximum);
        }

        function safeUrl(value) {
          if (typeof value !== "string") return "";
          try {
            var parsed = new URL(value);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
            return parsed.toString();
          } catch (_error) {
            return "";
          }
        }

        function normalizedTags(value) {
          if (!Array.isArray(value)) return [];
          return value
            .filter(function (tag) { return typeof tag === "string"; })
            .map(function (tag) { return tag.trim().slice(0, 32); })
            .filter(Boolean)
            .slice(0, 8);
        }

        function extractItem() {
          var structured = isRecord(state.result) && isRecord(state.result.structuredContent)
            ? state.result.structuredContent
            : {};
          var resultItem = isRecord(structured.item) ? structured.item : structured;
          var input = isRecord(state.input) ? state.input : {};
          var markdown = typeof resultItem.contentMarkdown === "string"
            ? resultItem.contentMarkdown
            : typeof input.contentMarkdown === "string"
              ? input.contentMarkdown
              : "";

          if (!markdown.trim()) return null;

          return {
            id: boundedText(resultItem.id, 100, ""),
            title: boundedText(resultItem.title, 120, boundedText(input.title, 120, "Saved output")),
            contentMarkdown: markdown.slice(0, 12000),
            kind: boundedText(resultItem.kind, 32, boundedText(input.kind, 32, "note")),
            project: boundedText(resultItem.project, 80, boundedText(input.project, 80, "General")),
            tags: normalizedTags(resultItem.tags).length
              ? normalizedTags(resultItem.tags)
              : normalizedTags(input.tags),
            createdAt: boundedText(resultItem.createdAt, 40, ""),
            url: safeUrl(resultItem.url || structured.url)
          };
        }

        function element(name, text, className) {
          var node = document.createElement(name);
          if (className) node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        }

        function renderMarkdownSafely(markdown) {
          var fragment = document.createDocumentFragment();
          var lines = markdown.replace(/\r\n?/g, "\n").split("\n");
          var index = 0;

          while (index < lines.length) {
            var line = lines[index];
            var trimmed = line.trim();

            if (!trimmed) {
              index += 1;
              continue;
            }

            if (trimmed.indexOf("\x60\x60\x60") === 0) {
              var codeLines = [];
              index += 1;
              while (index < lines.length && lines[index].trim().indexOf("\x60\x60\x60") !== 0) {
                codeLines.push(lines[index]);
                index += 1;
              }
              if (index < lines.length) index += 1;
              var pre = document.createElement("pre");
              pre.appendChild(element("code", codeLines.join("\n")));
              fragment.appendChild(pre);
              continue;
            }

            var heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
            if (heading) {
              fragment.appendChild(element("h" + (heading[1].length + 1), heading[2]));
              index += 1;
              continue;
            }

            if (/^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
              fragment.appendChild(document.createElement("hr"));
              index += 1;
              continue;
            }

            var unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
            if (unordered) {
              var list = document.createElement("ul");
              while (index < lines.length) {
                var listMatch = /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
                if (!listMatch) break;
                var itemText = listMatch[1]
                  .replace(/^\[x\]\s*/i, "☑ ")
                  .replace(/^\[ \]\s*/, "☐ ");
                list.appendChild(element("li", itemText));
                index += 1;
              }
              fragment.appendChild(list);
              continue;
            }

            var ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
            if (ordered) {
              var orderedList = document.createElement("ol");
              while (index < lines.length) {
                var orderedMatch = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]);
                if (!orderedMatch) break;
                orderedList.appendChild(element("li", orderedMatch[1]));
                index += 1;
              }
              fragment.appendChild(orderedList);
              continue;
            }

            var quote = /^>\s?(.*)$/.exec(trimmed);
            if (quote) {
              var quoteLines = [];
              while (index < lines.length) {
                var quoteMatch = /^\s*>\s?(.*)$/.exec(lines[index]);
                if (!quoteMatch) break;
                quoteLines.push(quoteMatch[1]);
                index += 1;
              }
              fragment.appendChild(element("blockquote", quoteLines.join("\n")));
              continue;
            }

            var paragraphLines = [line];
            index += 1;
            while (index < lines.length && lines[index].trim()) {
              var candidate = lines[index].trim();
              if (/^(#{1,3})\s+/.test(candidate) ||
                  /^[-*+]\s+/.test(candidate) ||
                  /^\d+[.)]\s+/.test(candidate) ||
                  /^>\s?/.test(candidate) ||
                  candidate.indexOf("\x60\x60\x60") === 0) break;
              paragraphLines.push(lines[index]);
              index += 1;
            }
            fragment.appendChild(element("p", paragraphLines.join("\n")));
          }

          contentElement.replaceChildren(fragment);
        }

        function addChip(text) {
          metadataElement.appendChild(element("span", text, "chip"));
        }

        function render() {
          state.item = extractItem();
          if (!state.item) return;

          titleElement.textContent = state.item.title;
          kindElement.textContent = state.item.kind.charAt(0).toUpperCase() + state.item.kind.slice(1);
          projectElement.textContent = state.item.project;
          metadataElement.replaceChildren();

          state.item.tags.forEach(function (tag) { addChip("#" + tag); });
          if (state.item.createdAt) {
            var created = new Date(state.item.createdAt);
            if (!Number.isNaN(created.getTime())) addChip(created.toLocaleString());
          }

          renderMarkdownSafely(state.item.contentMarkdown);
          copyBodyButton.disabled = false;
          copyMarkdownButton.disabled = false;
          openItemButton.disabled = !state.item.url;
          setStatus(isRecord(state.result) && state.result.isError ? "Save failed" : "Saved", state.result && state.result.isError ? "error" : "normal");
        }

        function setStatus(message, tone) {
          statusElement.textContent = message;
          statusElement.dataset.tone = tone === "error" ? "error" : "normal";
        }

        function fallbackCopy(text) {
          fallbackCopyElement.value = text;
          fallbackCopyElement.focus();
          fallbackCopyElement.select();
          var copied = document.execCommand("copy");
          fallbackCopyElement.blur();
          if (!copied) throw new Error("Clipboard unavailable");
        }

        async function copyText(text) {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(text);
            return;
          }
          fallbackCopy(text);
        }

        copyMarkdownButton.addEventListener("click", function () {
          if (!state.item) return;
          copyText(state.item.contentMarkdown)
            .then(function () { setStatus("Markdown copied", "normal"); })
            .catch(function () { setStatus("Could not access clipboard", "error"); });
        });

        copyBodyButton.addEventListener("click", function () {
          if (!state.item) return;
          var plainText = contentElement.innerText || state.item.contentMarkdown;
          var canCopyRich = navigator.clipboard &&
            typeof navigator.clipboard.write === "function" &&
            typeof window.ClipboardItem === "function";

          var operation;
          if (canCopyRich) {
            var clipboardItem = new window.ClipboardItem({
              "text/html": new Blob([contentElement.innerHTML], { type: "text/html" }),
              "text/plain": new Blob([plainText], { type: "text/plain" })
            });
            operation = navigator.clipboard.write([clipboardItem]);
          } else {
            operation = copyText(plainText);
          }

          operation
            .then(function () { setStatus("Body copied", "normal"); })
            .catch(function () { setStatus("Could not access clipboard", "error"); });
        });

        function post(message) {
          window.parent.postMessage(message, "*");
        }

        function sendNotification(method, params) {
          post({ jsonrpc: "2.0", method: method, params: params || {} });
        }

        function sendRequest(method, params) {
          var id = nextRequestId;
          nextRequestId += 1;

          return new Promise(function (resolve, reject) {
            var timeout = window.setTimeout(function () {
              pendingRequests.delete(id);
              reject(new Error("Host request timed out"));
            }, 10000);

            pendingRequests.set(id, {
              resolve: resolve,
              reject: reject,
              timeout: timeout
            });
            post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
          });
        }

        function settleResponse(message) {
          var pending = pendingRequests.get(message.id);
          if (!pending) return false;
          pendingRequests.delete(message.id);
          window.clearTimeout(pending.timeout);
          if (message.error) pending.reject(new Error(message.error.message || "Host request failed"));
          else pending.resolve(message.result || {});
          return true;
        }

        function applyHostContext(context) {
          if (!isRecord(context)) return;
          if (context.theme === "dark" || context.theme === "light") {
            document.documentElement.dataset.theme = context.theme;
          }
        }

        function stopResizeObserver() {
          if (resizeObserver) resizeObserver.disconnect();
          resizeObserver = null;
        }

        function notifySize() {
          if (!state.initialized) return;
          sendNotification("ui/notifications/size-changed", {
            width: Math.ceil(window.innerWidth),
            height: Math.ceil(document.documentElement.scrollHeight)
          });
        }

        function startResizeObserver() {
          if (typeof window.ResizeObserver !== "function") return;
          resizeObserver = new ResizeObserver(function () {
            window.requestAnimationFrame(notifySize);
          });
          resizeObserver.observe(document.documentElement);
          resizeObserver.observe(document.body);
          notifySize();
        }

        window.addEventListener("message", function (event) {
          if (event.source !== window.parent) return;
          var message = event.data;
          if (!isRecord(message) || message.jsonrpc !== "2.0") return;

          if (Object.prototype.hasOwnProperty.call(message, "id") &&
              (Object.prototype.hasOwnProperty.call(message, "result") || message.error)) {
            settleResponse(message);
            return;
          }

          if (message.method === "ui/notifications/tool-input" && isRecord(message.params)) {
            state.input = isRecord(message.params.arguments) ? message.params.arguments : {};
            render();
            return;
          }

          if (message.method === "ui/notifications/tool-result" && isRecord(message.params)) {
            state.result = message.params;
            render();
            return;
          }

          if (message.method === "ui/notifications/host-context-changed") {
            applyHostContext(message.params);
            return;
          }

          if (message.method === "ui/resource-teardown" &&
              Object.prototype.hasOwnProperty.call(message, "id")) {
            stopResizeObserver();
            post({ jsonrpc: "2.0", id: message.id, result: {} });
          }
        });

        openItemButton.addEventListener("click", function () {
          if (!state.item || !state.item.url) return;
          if (!state.initialized || !state.hostCapabilities.openLinks) {
            setStatus("This host cannot open links", "error");
            return;
          }

          sendRequest("ui/open-link", { url: state.item.url })
            .then(function () { setStatus("Opened in DraftRelay", "normal"); })
            .catch(function () { setStatus("Could not open DraftRelay", "error"); });
        });

        if (window.parent === window) {
          setStatus("Open through an MCP Apps host", "error");
          return;
        }

        sendRequest("ui/initialize", {
          appInfo: { name: "DraftRelay review card", version: "0.3.0" },
          appCapabilities: {},
          protocolVersion: PROTOCOL_VERSION
        })
          .then(function (result) {
            state.initialized = true;
            state.hostCapabilities = isRecord(result.hostCapabilities) ? result.hostCapabilities : {};
            applyHostContext(result.hostContext);
            sendNotification("ui/notifications/initialized", {});
            startResizeObserver();
            if (!state.item) setStatus("Waiting for saved output…", "normal");
          })
          .catch(function () {
            setStatus("MCP Apps connection failed", "error");
          });
      })();
    </script>
  </body>
</html>`;

export function getCutlineCardHtml(): string {
  return CUTLINE_CARD_HTML;
}
