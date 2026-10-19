import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, InteractiveMode, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

// Test-only access to pinned Pi internals. The extension itself uses public APIs.
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extensionPath = fileURLToPath(new URL("../.pi/extensions/important-thinking/index.js", import.meta.url));
initTheme("dark", false);

async function harness() {
  const loaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  const statuses = new Map();
  const notifications = [];

  // Use Pi's real UI bridge and cache-invalidation path without starting a
  // terminal, loading user configuration, or making a provider request.
  const host = Object.assign(Object.create(InteractiveMode.prototype), {
    chatContainer: { children: [] },
    streamingComponent: undefined,
    defaultHiddenThinkingLabel: "Thinking...",
    hiddenThinkingLabel: "Thinking...",
    footerDataProvider: { setExtensionStatus: (key, value) => statuses.set(key, value) },
    ui: { requestRender() {} },
    showExtensionNotify: (message, type) => notifications.push({ message, type }),
  });
  const ctx = { mode: "tui", hasUI: true, ui: host.createExtensionUIContext() };
  const emit = async (name, context = ctx) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, context);
  };
  const command = (mode, context = ctx) => extension.commands.get("thinking-view").handler(mode, context);
  const add = (thinking, { hidden = false, streaming = false, answer = "Final answer." } = {}) => {
    const message = Object.freeze({
      role: "assistant",
      stopReason: "stop",
      content: Object.freeze([
        Object.freeze({ type: "thinking", thinking, thinkingSignature: "preserve-this" }),
        Object.freeze({ type: "text", text: answer }),
      ]),
    });
    const component = new AssistantMessageComponent(message, hidden, getMarkdownTheme(), host.hiddenThinkingLabel, 1, [extension.markdownTransformer]);
    if (streaming) {
      component.updateContent(message, true);
      host.streamingComponent = component;
    } else host.chatContainer.children.push(component);
    return { component, message, render: () => stripVTControlCharacters(component.render(100).join("\n")) };
  };
  await emit("session_start");
  return { extension, ctx, host, emit, command, add, statuses, notifications };
}

test("Pi loads the extension and refreshes cached transcript blocks on mode changes", async () => {
  const h = await harness();
  const row = h.add("Let me inspect the repository. The root cause is a missing file. We should update the README.");
  const original = JSON.stringify(row.message);
  assert.doesNotMatch(row.render(), /inspect the repository/);
  assert.match(row.render(), /update the README/);
  await h.command("strict");
  assert.doesNotMatch(row.render(), /update the README/);
  assert.match(row.render(), /missing file/);
  await h.command("off");
  assert.doesNotMatch(row.render(), /missing file|Thinking/);
  assert.match(row.render(), /Final answer/);
  await h.command("full");
  assert.match(row.render(), /inspect the repository/);
  assert.equal(JSON.stringify(row.message), original);
});

test("collapsed blocks hide their labels in off mode and restore Pi's default in full", async () => {
  const h = await harness();
  const row = h.add("Tests fail.", { hidden: true });
  assert.match(row.render(), /Thinking \(balanced/);
  await h.command("off");
  assert.doesNotMatch(row.render(), /Thinking|Tests fail/);
  await h.command("full");
  assert.match(row.render(), /Thinking\.\.\./);
  assert.doesNotMatch(row.render(), /Tests fail/);
  row.component.setHideThinkingBlock(false);
  assert.match(row.render(), /Tests fail/);
});

test("streaming rows refresh immediately and release unfinished text at message end", async () => {
  const h = await harness();
  const row = h.add("Tests fail. The root cause is a missing", { streaming: true });
  assert.match(row.render(), /Tests fail/);
  assert.doesNotMatch(row.render(), /root cause/);
  await h.command("off");
  assert.doesNotMatch(row.render(), /Tests fail/);
  await h.command("balanced");
  assert.match(row.render(), /Tests fail/);
  row.component.updateContent(row.message, false);
  assert.match(row.render(), /root cause/);
});

test("full and off never rewrite non-thinking messages", async () => {
  const h = await harness();
  for (const mode of ["balanced", "strict", "full", "off"]) {
    await h.command(mode);
    for (const messageType of ["assistant", "user"]) {
      const markdown = "**Keep the full answer.** Tests fail.\n```js\nconst error = 0;\n```";
      assert.equal(h.extension.markdownTransformer(markdown, { messageType, isStreaming: true, availableWidth: 80 }), markdown);
    }
  }
});

test("invalid arguments and help retain the current mode; shutdown removes status", async () => {
  const h = await harness();
  await h.command(" STRICT ");
  await h.command("ful");
  assert.equal(h.notifications.at(-1).type, "warning");
  await h.command("");
  assert.match(h.notifications.at(-1).message, /Thinking view: strict/);
  assert.equal(h.statuses.get("important-thinking"), "thinking view: strict");
  await h.emit("session_shutdown");
  assert.equal(h.statuses.get("important-thinking"), undefined);
  assert.equal(h.host.hiddenThinkingLabel, h.host.defaultHiddenThinkingLabel);
});

test("RPC and non-interactive lifecycle events do not touch terminal UI", async () => {
  const h = await harness();
  for (const mode of ["rpc", "json", "print"]) {
    const context = {
      mode,
      hasUI: mode === "rpc",
      ui: new Proxy({ notify() {} }, { get: (target, key) => {
        if (key in target) return target[key];
        throw new Error(`Unexpected terminal access in ${mode}: ${String(key)}`);
      } }),
    };
    await h.emit("session_start", context);
    await h.command("off", context);
    await h.emit("session_shutdown", context);
  }
  assert.equal(h.statuses.get("important-thinking"), "thinking view: balanced");
});
