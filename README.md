# Pi Important Thinking

A small [Pi](https://pi.dev) extension that shows useful thinking excerpts: decisions, findings, risks, errors, and next steps.

## Install

Requires a compatible Pi installation (tested with **Pi 1.3.0**) and **Node.js 22.19+**.

```sh
pi install git:github.com/tusharra0/pi-important-thinking
```

Start Pi, or run `/reload` in an existing session.

**Manual download:** [Download ZIP](https://github.com/tusharra0/pi-important-thinking/archive/refs/heads/main.zip), extract it, and copy `.pi/extensions/important-thinking` into `~/.pi/agent/extensions/important-thinking`. Then run `/reload`. No build or npm install is needed for the extension.

## Usage

Run one of these commands inside Pi:

| Command | What you see |
| --- | --- |
| `/thinking-view balanced` | Up to five useful excerpts per block (default). |
| `/thinking-view strict` | Up to three stronger findings or problems. |
| `/thinking-view full` | Original, unfiltered thinking. |
| `/thinking-view off` | Hide thinking text and collapsed labels. |

Changes apply immediately. Run `/thinking-view` to check the mode. The mode resets to `balanced` when the extension reloads or the session changes.

If thinking is collapsed, press **Ctrl+T** to expand it. The filter uses English keywords and can miss useful content; `full` lets you inspect everything. Long excerpts end in an ellipsis.

Filtering only affects the terminal display. Session files and model context keep the original content. No extra model calls or network requests.

## Update or remove

```sh
pi update --extensions
pi remove git:github.com/tusharra0/pi-important-thinking
```

## Development

```sh
git clone https://github.com/tusharra0/pi-important-thinking.git
cd pi-important-thinking
npm ci
npm test
```

Tests cover filtering and Pi's actual loader, renderer, streaming, and mode changes. No API key is required.
