/**
 * Pi Important Thinking
 *
 * A display-only filter for assistant thinking blocks. The original message is
 * left untouched, so the model and the session still retain the full content.
 * The chosen view mode is remembered in Pi's agent directory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const MODES = new Set(["balanced", "strict", "full", "off"]);
const DEFAULT_MODE = "balanced";
const PREFERENCE_FILE = "important-thinking.json";

const MODE_DESCRIPTIONS = {
  balanced: "showing decisions, findings, risks, and next steps",
  strict: "showing only high-signal findings and problems",
  full: "showing unfiltered thinking in expanded blocks",
  off: "hiding thinking text",
};

const MODE_SETTINGS = {
  balanced: { threshold: 3, maxItems: 5 },
  strict: { threshold: 5, maxItems: 3 },
};

const SIGNALS = [
  {
    weight: 6,
    pattern:
      /\b(errors?|fail(?:s|ed|ures?)?|block(?:ed|ers?)?|risks?|warnings?|unsafe|security|destructive|conflicts?|invalid|regressions?|bugs?|cannot|can[’']t|unable|missing)\b/i,
  },
  {
    weight: 5,
    pattern:
      /\b(root cause|found|discovered|confirmed|verified|turns out|test(?:s)? (?:pass|fail)|because|caused by|due to)\b/i,
  },
  {
    weight: 4,
    pattern:
      /\b(decid(?:e|ed|ing)|chose|choose|trade-?off|recommend|best option|approach|solution)\b/i,
  },
  {
    weight: 3,
    pattern:
      /\b(must|should|need to|will|next|plan|implement|change|update|remove|add|fix|refactor)\b/i,
  },
  {
    weight: 2,
    pattern: /\b(likely|unlikely|suspect|uncertain|maybe|could|option|alternative|assumption)\b/i,
  },
  { weight: 2, pattern: /`[^`]+`|(?:^|\s)[\w.-]+[\\/][\w./\\-]+/ },
];

const ROUTINE_OPENERS =
  /^(?:okay|ok|hmm|so|now|first|then|let me|i(?:'ll| will) (?:look|inspect|check|read|search)|we need to|i need to|the user (?:wants|asked))\b/i;

function cleanSegment(segment) {
  return segment
    .replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapContainers(line) {
  let body = line;
  let quoteDepth = 0;
  let listIndent = 0;
  let quoteIndent = 0;
  const columns = (text) => text.replace(/\t/g, "    ").length;
  let indent;
  while (true) {
    const quote = /^([ \t]*)>[ \t]?/.exec(body);
    if (quote) {
      quoteDepth++;
      quoteIndent += columns(quote[1]);
      body = body.slice(quote[0].length);
      continue;
    }
    indent ??= quoteIndent + columns(/^[ \t]*/.exec(body)[0]);
    const list = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.exec(body);
    if (!list) break;
    listIndent += columns(list[0]);
    body = body.slice(list[0].length);
  }
  return { body, quoteDepth, listIndent, indent };
}

function splitThinking(markdown, isStreaming) {
  const pieces = [];
  let fence;
  let paragraph = "";

  const flush = (complete) => {
    // Skip sentence boundaries inside inline code (including multiple
    // backticks), after common abbreviations, and before lowercase text.
    let start = 0;
    const tokens =
      /(`+)[\s\S]*?\1(?!`)|(?<!\b(?:[Ee]\.g|[Ii]\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|Fig|al))[.!?]["'’”)*_`]*\s+(?![\s\p{Ll}])/gu;
    for (const match of paragraph.matchAll(tokens)) {
      if (match[1]) continue;
      const end = match.index + match[0].length;
      pieces.push(cleanSegment(paragraph.slice(start, end)));
      start = end;
    }
    const tail = paragraph.slice(start);
    if (complete || /[.!?]["'’”)*_`]*\s*$/.test(tail)) {
      pieces.push(cleanSegment(tail));
    }
    paragraph = "";
  };

  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const context = unwrapContainers(line);
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(context.body);
    // An unclosed nested fence ends with its enclosing quote/list container.
    if (fence && (
      context.quoteDepth < fence.quoteDepth ||
      (line.trim() && context.indent < fence.listIndent)
    )) fence = undefined;
    if (fence) {
      if (
        marker && context.quoteDepth === fence.quoteDepth && !context.listIndent &&
        marker[1][0] === fence.marker[0] &&
        marker[1].length >= fence.marker.length && !marker[2].trim()
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      flush(true);
      fence = { marker: marker[1], quoteDepth: context.quoteDepth, listIndent: context.listIndent };
      continue;
    }
    if (!context.body.trim()) {
      flush(true);
      continue;
    }
    // Keep soft-wrapped prose together so qualifying clauses are not lost,
    // but list items and headings always start a new block.
    const heading = /^\s*#{1,6}\s+/.test(context.body);
    if (context.listIndent || heading) flush(true);
    paragraph += `${paragraph ? " " : ""}${context.body.trim()}`;
    if (heading) flush(true);
  }
  flush(!isStreaming);
  return pieces.filter(Boolean);
}

export function scoreThinkingSegment(segment) {
  let score = 0;
  for (const signal of SIGNALS) {
    if (signal.pattern.test(segment)) score += signal.weight;
  }

  if (ROUTINE_OPENERS.test(segment)) score -= 3;
  if (segment.length > 360) score -= 1;
  return score;
}

function shorten(segment, maxLength = 240) {
  const characters = Array.from(segment);
  if (characters.length <= maxLength) return segment;
  const prefix = characters.slice(0, maxLength - 1).join("");
  const boundary = prefix.lastIndexOf(" ");
  return `${(boundary > maxLength / 2 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

export function filterThinking(markdown, mode = "balanced", { isStreaming = false } = {}) {
  if (mode === "full") return markdown;
  if (mode === "off" || !markdown.trim()) return "";

  const settings = Object.hasOwn(MODE_SETTINGS, mode) ? MODE_SETTINGS[mode] : MODE_SETTINGS.balanced;
  const seen = new Set();
  const important = splitThinking(markdown, isStreaming)
    .map((text, index) => ({ text, index, score: scoreThinkingSegment(text) }))
    .filter((item) => item.score >= settings.threshold)
    .filter((item) => {
      const key = item.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, settings.maxItems)
    .sort((a, b) => a.index - b.index);

  if (important.length === 0) return "";
  return important.map((item) => `- ${shorten(item.text)}`).join("\n");
}

export function preferencePath() {
  return join(getAgentDir(), PREFERENCE_FILE);
}

function loadMode() {
  try {
    const { mode } = JSON.parse(readFileSync(preferencePath(), "utf8"));
    return MODES.has(mode) ? mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function saveMode(mode) {
  try {
    const path = preferencePath();
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ mode }, null, 2)}\n`);
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

function usage() {
  return "Usage: /thinking-view balanced | strict | full | off";
}

export default function importantThinking(pi) {
  if (typeof pi.registerMarkdownTransformer !== "function") {
    throw new Error(
      "Important Thinking requires Pi's registerMarkdownTransformer API. " +
      "Tested with @earendil-works/pi-coding-agent 1.3.0; update Pi to a compatible release.",
    );
  }

  let mode = loadMode();

  const refresh = (ctx) => {
    if (ctx.mode !== "tui") return;
    // Pi 1.3.0 rebuilds existing and streaming assistant components here,
    // invalidating Markdown's cache. A footer update alone doesn't do that.
    const label = mode === "off" ? "" : mode === "full" ? undefined : `Thinking (${mode}; expand to view)`;
    ctx.ui.setHiddenThinkingLabel(label);
    ctx.ui.setStatus("important-thinking", `thinking view: ${mode}`);
  };

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "assistant-thinking") return markdown;
    return filterThinking(markdown, mode, context);
  });

  pi.registerCommand("thinking-view", {
    description: "Choose how much model thinking is displayed",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Thinking view only affects Pi's interactive terminal.", "info");
        return;
      }
      const requested = args.trim().toLowerCase();

      if (!requested) {
        ctx.ui.notify(`Thinking view: ${mode}. ${usage()}`, "info");
        return;
      }

      if (!MODES.has(requested)) {
        ctx.ui.notify(usage(), "warning");
        return;
      }

      mode = requested;
      refresh(ctx);
      const saved = saveMode(mode);
      ctx.ui.notify(
        `Thinking view: ${mode} — ${MODE_DESCRIPTIONS[mode]}.` +
          (saved ? "" : ` Could not save this preference to ${preferencePath()}; it applies to this session only.`),
        saved ? "info" : "warning",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") {
      ctx.ui.setHiddenThinkingLabel();
      ctx.ui.setStatus("important-thinking", undefined);
    }
  });
}
