import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  default as importantThinking,
  filterThinking,
  preferencePath,
  scoreThinkingSegment,
} from "../.pi/extensions/important-thinking/index.js";

// Keep every test away from the real ~/.pi/agent directory.
const freshAgentDir = () => (process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "important-thinking-")));
freshAgentDir();

function fakePi() {
  const registered = { events: new Map() };
  const pi = {
    registerMarkdownTransformer(transformer) {
      registered.transformer = transformer;
    },
    registerCommand(name, command) {
      registered.command = { name, ...command };
    },
    on(name, handler) {
      registered.events.set(name, handler);
    },
  };
  importantThinking(pi);
  return registered;
}

function fakeContext(mode = "tui") {
  const statuses = [];
  const notifications = [];
  const ctx = {
    mode,
    ui: {
      setStatus(key, value) {
        statuses.push([key, value]);
      },
      notify(message, type) {
        notifications.push([message, type]);
      },
      setHiddenThinkingLabel() {},
    },
  };
  return { ctx, statuses, notifications };
}

test("balanced mode removes routine narration", () => {
  const input = [
    "Let me inspect the repository.",
    "I will read the package file now.",
    "The root cause is a missing null check in `src/parser.ts`.",
    "We should add a regression test before changing the parser.",
  ].join("\n");

  const result = filterThinking(input, "balanced");

  assert.doesNotMatch(result, /inspect the repository/i);
  assert.doesNotMatch(result, /read the package file/i);
  assert.match(result, /root cause/i);
  assert.match(result, /regression test/i);
});

test("strict mode keeps only high-signal items", () => {
  const input = [
    "The next step is to update the README.",
    "Tests fail because the config file is missing.",
  ].join("\n");

  const result = filterThinking(input, "strict");

  assert.doesNotMatch(result, /README/);
  assert.match(result, /Tests fail/);
});

test("full and off modes are exact", () => {
  const input = "Any unfiltered thinking.";
  assert.equal(filterThinking(input, "full"), input);
  assert.equal(filterThinking(input, "off"), "");
});

test("important findings about prompts are not silently blacklisted", () => {
  assert.match(filterThinking("The root cause is a missing system prompt."), /root cause/);
});

test("duplicate important items are collapsed", () => {
  const input = [
    "The root cause is a missing file.",
    "The root cause is a missing file.",
  ].join("\n");

  assert.equal(filterThinking(input, "balanced").split("\n").length, 1);
});

test("extension registers its transformer, command, and lifecycle hooks", async () => {
  freshAgentDir();
  const registered = fakePi();

  assert.equal(registered.command.name, "thinking-view");
  assert.equal(typeof registered.transformer, "function");
  assert.deepEqual([...registered.events.keys()], ["session_start", "session_shutdown"]);

  const { ctx, statuses, notifications } = fakeContext();
  await registered.command.handler("strict", ctx);
  assert.deepEqual(statuses.at(-1), ["important-thinking", "thinking view: strict"]);
  assert.match(notifications.at(-1)[0], /Thinking view: strict/);

  const filtered = registered.transformer(
    "I will inspect files. Tests fail because the config is missing.",
    { messageType: "assistant-thinking" },
  );
  assert.doesNotMatch(filtered, /inspect files/);
  assert.match(filtered, /Tests fail/);
});

test("repetition cannot crowd out a distinct important item", () => {
  const input = [
    ...Array(8).fill("The root cause is a missing file."),
    "We should update the README.",
  ].join("\n");
  const result = filterThinking(input);
  assert.equal(result.split("\n").length, 2);
  assert.match(result, /update the README/);
});

test("short failures and inflected error words are retained", () => {
  for (const input of ["Tests fail.", "Error: EIO.", "Bug!", "The connection may fail during startup.", "Errors occurred."]) {
    assert.match(filterThinking(input, "strict"), new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("routine openers match whole words", () => {
  assert.equal(scoreThinkingSegment("Solution: retry once."), 4);
  assert.match(filterThinking("Solution: retry once."), /Solution/);
});

test("backtick and tilde fences, including unfinished ones, omit code", () => {
  for (const fence of ["```", "````", "~~~", "~~~~"]) {
    for (const closed of [true, false]) {
      const input = [
        "The root cause is a missing config.",
        `${fence}js`,
        'const error = "failed because of a fake bug";',
        ...(closed ? [fence, "We should update the documentation."] : []),
      ].join("\n");
      const result = filterThinking(input);
      assert.match(result, /missing config/);
      assert.doesNotMatch(result, /fake bug/);
      if (closed) assert.match(result, /update the documentation/);
    }
  }
});

test("shorter and mismatched fences do not prematurely close code", () => {
  const input = "````js\n```\n~~~\nconst error = 'fail';\n````\nTests fail.";
  assert.equal(filterThinking(input), "- Tests fail.");
});

test("nested fences omit code without swallowing subsequent findings", () => {
  const examples = [
    '- ```js\n  const error = "fake failure";\n  ```',
    '1. ~~~js\n   const error = "fake failure";\n   ~~~',
    '> ```js\n> const error = "fake failure";\n> ```',
    '> - ```js\n>   const error = "fake failure";\n>   ```',
    '- > ```js\n  > const error = "fake failure";\n  > ```',
    '- - ```js\n    const error = "fake failure";\n    ```',
    '- Example:\n  ```js\n  const error = "fake failure";\n  ```',
  ];
  for (const example of examples) {
    const result = filterThinking(`${example}\n\nThe root cause is a missing config.`);
    assert.doesNotMatch(result, /fake failure/, example);
    assert.match(result, /missing config/, example);
  }
});

test("unclosed nested fences stop at the end of their container", () => {
  for (const example of [
    '> ```js\n> const error = "fake failure";',
    '- ```js\n  const error = "fake failure";',
  ]) {
    const result = filterThinking(`${example}\n\nThe root cause is a missing config.`);
    assert.doesNotMatch(result, /fake failure/);
    assert.match(result, /missing config/);
  }
});

test("container-looking text inside a code fence cannot close it", () => {
  const input = [
    "```markdown",
    "> ```",
    'const error = "first fake failure";',
    "- ```",
    'const error = "second fake failure";',
    "```",
    "The root cause is a missing config.",
  ].join("\n");
  const result = filterThinking(input);
  assert.doesNotMatch(result, /fake failure/);
  assert.match(result, /missing config/);
});

test("streaming waits for complete thoughts and retains the last thought on completion", () => {
  const partial = "Tests fail. The root cause is a missing";
  assert.equal(filterThinking(partial, "balanced", { isStreaming: true }), "- Tests fail.");
  assert.match(filterThinking(partial), /root cause is a missing/);
  assert.equal(filterThinking("The root cause is a missing", "balanced", { isStreaming: true }), "");
  assert.match(filterThinking(`${partial} file.`, "balanced", { isStreaming: true }), /missing file/);
});

test("soft-wrapped qualifiers are retained", () => {
  const input = "The root cause is a missing permission,\nnot a server failure.";
  assert.match(filterThinking(input), /missing permission, not a server failure/);
});

test("sentence boundaries in inline code do not lose the surrounding claim", () => {
  const input = "The error is in `Foo. Bar` during startup.";
  assert.equal(filterThinking(input), `- ${input}`);
});

test("mode limits apply to unique items and keep their source order", () => {
  const input = Array.from({ length: 10 }, (_, i) => `Error ${i}: failure in module ${i}.`).join("\n");
  for (const [mode, count] of [["balanced", 5], ["strict", 3]]) {
    const lines = filterThinking(input, mode).split("\n");
    assert.equal(lines.length, count);
    lines.forEach((line, i) => assert.match(line, new RegExp(`Error ${i}:`)));
  }
});

test("long excerpts remain bounded without splitting a surrogate pair", () => {
  const result = filterThinking(`Error: ${"😀".repeat(300)}.`);
  assert.ok(Array.from(result).length <= 242);
  assert.ok(result.endsWith("…"));
  assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});

test("older Pi APIs produce an actionable compatibility error", () => {
  assert.throws(() => importantThinking({}), /requires Pi's registerMarkdownTransformer API/);
});

test("headings are separate excerpts and do not absorb the next sentence", () => {
  const input = "## Root cause\nThe parser fails on empty input.\n# Plan\n# Risks\nThe migration is destructive.";
  const result = filterThinking(input);
  assert.match(result, /^- The parser fails on empty input\.$/m);
  assert.match(result, /^- The migration is destructive\.$/m);
  assert.doesNotMatch(result, /Root cause The parser|Risks The migration/);
});

test("abbreviations and lowercase continuations do not split sentences", () => {
  const cases = [
    "The fix is e.g. a null check, otherwise tests fail.",
    "Compare this vs. the old parser, which fails on empty input.",
    "This takes approx. 5 retries before the request fails.",
    "See the docs (i.e. the README) because the build fails.",
  ];
  for (const input of cases) assert.equal(filterThinking(input), `- ${input}`, input);
  assert.equal(filterThinking("The parser fails.  the second sentence is a bug."), "- The parser fails.  the second sentence is a bug.".replace(/\s+/g, " "));
  assert.deepEqual(filterThinking("Tests fail. The root cause is a missing file.").split("\n"), [
    "- Tests fail.",
    "- The root cause is a missing file.",
  ]);
});

test("curly apostrophes match negation signals", () => {
  assert.equal(scoreThinkingSegment("We can’t ship this."), scoreThinkingSegment("We can't ship this."));
  assert.match(filterThinking("We can’t ship this.", "strict"), /can’t ship/);
});

test("the chosen mode is saved and restored across extension loads", async () => {
  const dir = freshAgentDir();
  const first = fakePi();
  const { ctx, notifications } = fakeContext();
  await first.command.handler("strict", ctx);
  assert.equal(notifications.at(-1)[1], "info");
  assert.equal(preferencePath(), join(dir, "important-thinking.json"));
  assert.deepEqual(JSON.parse(readFileSync(preferencePath(), "utf8")), { mode: "strict" });

  const second = fakePi();
  const routine = "The next step is to update the README.";
  assert.equal(second.transformer(routine, { messageType: "assistant-thinking" }), "");
  assert.equal(filterThinking(routine, "balanced"), `- ${routine}`);

  await second.command.handler("off", ctx);
  assert.equal(fakePi().transformer("Tests fail.", { messageType: "assistant-thinking" }), "");
  await second.command.handler("balanced", ctx);
  assert.equal(fakePi().transformer("Tests fail.", { messageType: "assistant-thinking" }), "- Tests fail.");
});

test("corrupt or unknown saved preferences fall back to balanced", () => {
  const routine = "The next step is to update the README.";
  for (const contents of ["{not json", '{"mode":"verbose"}', '{"mode":5}', "[]", ""]) {
    freshAgentDir();
    writeFileSync(preferencePath(), contents);
    assert.equal(fakePi().transformer(routine, { messageType: "assistant-thinking" }), `- ${routine}`, contents);
  }
});

test("a mode change still applies when the preference cannot be saved", async () => {
  const dir = freshAgentDir();
  // Point the agent directory at a regular file so the directory cannot be created.
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  process.env.PI_CODING_AGENT_DIR = blocker;

  const registered = fakePi();
  const { ctx, notifications } = fakeContext();
  await registered.command.handler("strict", ctx);
  assert.equal(notifications.at(-1)[1], "warning");
  assert.match(notifications.at(-1)[0], /Thinking view: strict/);
  assert.match(notifications.at(-1)[0], /Could not save/);
  assert.equal(registered.transformer("The next step is to update the README.", { messageType: "assistant-thinking" }), "");
  freshAgentDir();
});
