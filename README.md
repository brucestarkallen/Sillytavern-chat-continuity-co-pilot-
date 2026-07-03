# Continuity Copilot (SillyTavern extension)

A lightweight chat panel inside SillyTavern where you talk to a "fixer" AI that can **directly edit your chat messages** to repair continuity errors.

Example: at turn 30 you notice the AI put Jillian on a train when she is at the academy. Open the panel, type:

> wait, why is Jillian on the train? she's at the academy — fix it

The copilot reads your story memory + chat, proposes exact find/replace edits with a red/green preview, and applies them to the real chat log when you press Apply. One-click Undo included.

Built as a minimal alternative to ST-Copilot's chat manager: no sessions, no themes, no stats — just the fixer.

## How it sees your story

Every request to the copilot includes:

1. **[STORY MEMORY]** — the live prompt injections from your memory extensions. It grabs every registered extension prompt whose key matches a regex (default: `summar|ception|memory|qvink`), which is exactly what Summaryception injects (snippets, audit), plus matching keys from chat metadata, plus the **Author's Note** (both the chat metadata value and the injected `2_floating_prompt`) — so notes kept in the Author's Note are visible too. Press the **Memory?** button in the panel to see exactly what it detected.
2. **[MESSAGE INDEX]** — one line per message: `#id [speaker] preview`. Ghosted/hidden messages are EXCLUDED by default (their content is represented by the snippets; a 200-message index would waste tokens). A settings toggle re-includes them, and the copilot can still fetch a ghosted message by id if you ask.
3. **[FULL MESSAGES]** — the last N messages in full (default 8, configurable).

If the copilot needs older messages in full, it replies with `<fetch>[12, 13]</fetch>` and the extension automatically sends those and re-asks (up to "Fetch rounds" times). This keeps token cost low even in long chats.

## How edits work

The copilot proposes edits in a strict block:

```
<edits>
[
  {"id": 27, "find": "she watched the countryside blur past the train window", "replace": "she watched the academy courtyard from the dormitory window", "reason": "Jillian is at the academy per PE"}
]
</edits>
```

The extension parses this into cards (red = before, green = after) with Apply / Skip / Apply all. Applying:

- exact substring match first, then a quote-normalized match, then a fuzzy word-window Levenshtein match (threshold 78%) if the model slightly misquoted the original;
- omitting `"find"` replaces the entire message;
- the previous version is backed up into `message.extra.cc_backups` (last 3 kept) and onto an in-session Undo stack;
- the chat is saved and `MESSAGE_EDITED` / `MESSAGE_UPDATED` events are emitted — so extensions that re-summarize on edit will react.

**Important:** after editing old messages, your Summaryception snippets covering those turns may still contain the old (wrong) fact and will re-inject the contradiction. Regenerate the affected snippets (or run your audit flow) after applying edits.

## Install

Option A — extension installer (recommended):
1. Put this folder in a GitHub repo (e.g. `continuity-copilot` with `manifest.json` at the repo root).
2. SillyTavern → Extensions (stacked blocks icon) → **Install extension** → paste the repo URL.

Option B — manual:
1. Copy the `continuity-copilot` folder into `SillyTavern/data/<your-user>/extensions/` (or `public/scripts/extensions/third-party/` on older layouts).
2. Restart SillyTavern / reload the page.

## Setup & usage

1. Open the wand menu (Extensions menu next to the chat input) → **Continuity Copilot**. Or type `/cc`.
2. Gear icon → pick an **LLM route**:
   - a Connection Profile (recommended — point it at a fast/cheap endpoint so it never touches your main RP connection), or
   - "Current API" fallback (raw generation on whatever is connected).
3. Type your complaint, or press **Audit chat** for a full continuity sweep.
4. Review the edit cards → Apply. **Undo** reverts the last applied batch.
5. **Memory?** opens a viewer listing every detected memory source by name (matched and skipped) plus the full memory text. **Context** opens the complete context block the copilot receives, with a char/token count — so you can see exactly what it knows and what's missing. Both have a Copy button.

`/cc some request` opens the panel and sends the request in one step.

## Shortcut commands

Type a `#tag` as the first word in the panel input and it expands into a full prompt (editable in settings, one per line as `#tag = prompt`). Built-ins:

- `#s` — **memory audit**: checks the CURRENT session (live messages) against Summaryception, then reports (1) things that happened in the chat but are missing from the snippets/audit/notes, and (2) memory entries that are stale or contradicted — each with the exact text to put into Summaryception. You copy the corrections into Summaryception yourself; the extension does not write into Summaryception's storage (needs the fork's schema; can be added later).
- `#f` — **chat fix**: sweep the chat against story memory and propose an `<edits>` block for every continuity error.

- `#i` — **ideas**: brainstorm 3-5 directions for what happens next, grounded in story memory.

Anything typed after the tag is passed along as an extra instruction, e.g. `#s focus on Stella's injury timeline` or `#i something involving the academy festival`.

## Not just repairs

The copilot is a co-writer: ask it anything about the story — "give me ideas for the next arc", "what would this character realistically do here", "is this twist consistent with canon". It answers from the same full context (memory + chat), no edits involved unless you ask.

## Running alongside ST-Copilot

No conflict — you can keep ST-Copilot installed for its other features (lorebook/character managers, stats). But note its weight loads with the page even when its window is closed, so if SillyTavern feels slow, disable ST-Copilot in Manage Extensions and re-enable only when you need it.

## Scope: chats and branches

- Settings (profile, prompts, shortcuts) are global.
- The copilot conversation is stored per chat (in chat metadata), so every chat has its own copilot history — and a branch inherits a copy of it at the moment of branching, then diverges independently, same as your Summaryception data.

## Streaming and thinking models

- **Streaming** is on by default and works when an LLM route (Connection Profile) is selected — the reply streams live into the panel. The "Current API" raw fallback cannot stream. If streaming misbehaves with your backend, untick it in settings; it silently falls back to whole-reply mode on errors.
- **Thinking** is shown, not hidden: `<think>`/`<thinking>`/`<reasoning>` blocks (or reasoning streamed by the backend) appear live while generating, then collapse into a tappable "thinking" section on the finished reply. Thinking is excluded from the copilot's saved history (keeps the next turn's tokens low) and from edit-JSON parsing (so it can never break the edit applier). Untick "Show thinking blocks" to hide it.

## Settings

- **Recent msgs sent in full** — how many latest messages go in verbatim (default 8, up to 100).
- **Fetch rounds** — how many times the copilot may request older messages (default 3).
- **Memory source words** — not code: just words separated by `|`. Any memory source whose NAME contains one of the words is included. Example: your fork stores notes under a source named `bruce_notes` → add `|notes` (or `|bruce`) to the box. The **Memory?** viewer lists sources it can see but skipped, so you copy the word straight from there.
- **Include ghosted/hidden messages in index** — off by default to save tokens; the snippets stand in for them.
- **Allow editing my (user) messages** — off by default; user messages are read-only.
- **System prompt** — fully editable; the `USER_EDIT_RULE` token is swapped automatically based on the checkbox.

## Troubleshooting

- **"No generation backend found"** — pick a Connection Profile in the gear settings, or update SillyTavern (the fallback needs a recent `generateRaw`).
- **Memory shows "(no memory extension data detected)"** — make sure Summaryception's injection is enabled for this chat, then press **Memory?** again; if its key doesn't match the pattern, widen the regex (e.g. add `|bruce`).
- **Edit fails with "find text not located"** — the model misquoted too heavily; tell it "resend the edits, copy find verbatim".
- **Panel doesn't appear** — check the browser console (F12) for `[ContinuityCopilot]` errors and report them.

## License

MIT. The fuzzy-anchor edit-application idea is inspired by [ST-Copilot](https://github.com/Supker/St-Copilot) (MIT); all code here is written from scratch. Reading Summaryception's runtime data does not make this a derivative work of that (AGPL-3.0) extension — but if you ever copy code from it into this project, relicense this project as AGPL-3.0.
