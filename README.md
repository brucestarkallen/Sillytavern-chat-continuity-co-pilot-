# Chat Assistant (SillyTavern extension)

A floating AI panel inside SillyTavern where you talk to a **second "assistant" model** that can surgically edit your story — chat messages, memory, and worldbook — to keep a long roleplay consistent, and that also runs two autonomous showrunner systems (a hidden **Director** and a standing **Editor**) to keep the storytelling sharp.

> Formerly "Continuity Copilot." Inspired by the concept of **ST-Copilot** (MIT, github.com/Supker/St-Copilot), but the code here is original and the scope has grown far past a chat manager: this is a continuity auditor, co-writer, and editor in one.

## The one-line idea

Instead of hand-editing your chat log and juggling separate tools for memory and worldbook, you get **one assistant that sees all your story data at once and edits it surgically** — with a red/green diff preview, fuzzy matching so it doesn't have to quote perfectly, and one-click Undo for everything. Keeping those stores mutually consistent is the whole point.

It runs on a **separate Connection Profile** (never your main roleplay model), so auditing never touches story generation.

## What it can do

**Talk to it in plain language.** *"Why is Jillian on the train? She's at the academy — fix it."* It reads your memory + chat, proposes exact find/replace edits as cards, and applies them on Apply.

**Edit three data stores, kept consistent:**
- **Chat messages** — find/replace or whole-message rewrites, hide/unhide (OOC cleanup).
- **Memory** — your Summaryception (or other memory-extension) data: the Plot-Essential notepad and summary snippets, via find/replace or whole-field replace.
- **Worldbook (World Info)** — read, create, edit, delete entries plus their keys and config, all from chat.

**Shortcut commands** (type the tag; all editable in settings):
- `#f` — check the chat against memory and fix continuity errors.
- `#s` — check the current session against memory.
- `#m` — audit the memory itself for internal contradictions.
- `#a` — fidelity audit: do the memory snippets match what actually happened?
- `#o` — harvest OOC/meta asides from the chat and hide them.
- `#i` — brainstorm distinct directions for what happens next.
- `#p` — psychology read of a character: drives, contradictions, consistency vs. canon, likely next move.
- `#d <text>` — steer the Director mid-episode.
- `#s <text>` — co-write: seed the next episode with your own premise; the Director expands it into a hidden episode built around it.

**Two autonomous systems** (opt-in, run on a cadence on the assistant's profile, never on your main model):
- **Director** — writes secret per-episode directives (hidden `[EPISODE_END]` markers) that give NPCs and the world their own initiative and give pacing an arc, injected into your storyteller so the world acts *on* the protagonist. Three modes: **Auto** (AI invents and chains episodes on its own), **Co-writer** (each episode grows from *your* one-line seed via `#s`/🎬 Seed — the AI drafts the hidden beats around it, and 💡 Seed ideas proposes three doors when you're blank), and **Off** (manual buttons only). Peek/edit/`#d` work in every mode.
- **Editor** — standing craft notes injected each turn that correct systemic weaknesses (scenes circling the protagonist, characters/props vanishing, dead ambient world, stale pacing).

**Chat-file naming** — *Auto-name this chat* reads the thread and suggests a distinctive title so branches/checkpoints are tellable apart; *Rename this chat* for a manual name. (Uses ST's `/renamechat`.)

**Safety net** — *Reset ALL settings to defaults* restores the tested baseline in one click (keeps your Connection Profile; never touches chats or memory).

**Everything is undoable** — chat, memory, and worldbook edits each push a typed Undo entry that restores byte-for-byte.

## How it sees your story (context built per request)

1. **[STORY MEMORY]** — every registered memory-extension prompt whose key matches a regex (default `summar|ception|memory|qvink`, i.e. what Summaryception injects), plus matching chat-metadata keys, plus the Author's Note.
2. **[MESSAGE INDEX]** — one line per message (`#id [speaker] preview`); hidden/ghosted messages excluded by default.
3. **[FULL MESSAGES]** — the last N messages in full (default 8).

If it needs older messages it replies with `<fetch>[12, 13]</fetch>`; the extension auto-sends those and re-asks (up to "Fetch rounds" times), keeping token cost low in long chats.

## How edits work

The assistant proposes a strict block, e.g.:

```
<edits>
[{"id": 27, "find": "she watched the countryside blur past", "replace": "she watched the academy courtyard", "reason": "Jillian is at the academy"}]
</edits>
```

parsed into red/green cards with Apply / Skip / Apply-all / edit. Matching is exact -> quote-normalized -> fuzzy word-window Levenshtein (78% threshold), so a slight misquote still lands. Omitting `find` replaces the whole message. Memory uses `<memedits>`; worldbook uses `<wiedits>` / `<wifetch>`; each with the same diff-card + Undo flow.

## How it differs from ST-Copilot (the inspiration)

ST-Copilot is a broad chat manager (sessions, themes, stats, and more). Chat Assistant took the "AI that edits your chat" idea in a different direction: **original code, focused entirely on continuity and craft**, then extended into memory + worldbook editing, the Director and Editor showrunner systems, character-psychology analysis, and chat-file naming. It's designed to sit *alongside* a memory extension (like Summaryception), not replace it: **memory holds the developmental record; this assistant audits, repairs, and directs.**

## For a future maintainer (architecture at a glance)

- **Single IIFE, no imports** — everything via `SillyTavern.getContext()`. Inits on `APP_READY` + a `setTimeout` fallback, guarded by an `inited` flag.
- **Storage:** settings live in `extensionSettings.continuityCopilot`; per-chat state (director, hidden-message ledger, session history) in `chatMetadata.continuityCopilot`. **`continuityCopilot` is the internal MODULE id — do not rename it; that would orphan every user's saved settings and per-chat data.** Memory is *read* from other extensions, not owned here.
- **LLM routing:** `ConnectionManagerRequestService.sendRequest(profileId, ...)` with a `generateRaw` fallback, wrapped in `callLLMSmart()`, which recovers from models that spend their whole budget "thinking" (feeds the reasoning back and demands the answer) and auto-continues cut-off blocks.
- **Block parsing:** `findBlock(text, tag)` takes the LAST opening tag that has a closer and prefers JSON-leading content, so prose that merely names a tag doesn't break parsing. Tags: `fetch`, `edits`, `memedits`, `wifetch`, `wiedits`, `think`.
- **Injections** (Director / Editor) are cleared and re-applied on `CHAT_CHANGED`; `[EPISODE_END]` markers are scrubbed from messages and swipes on load / receive / swipe.
- **UI:** a floating, pointer-draggable panel with inline styles (mobile-safe); every mutation prints a receipt; version is stamped in the panel header and console.
- **Target environment:** Android/Termux via a mobile browser — hence inline styles, `position:fixed` sizing, and native `prompt()`/`confirm()` for inputs. The `/cc` slash command and all `cc_*` identifiers are internal and unchanged by the display name.

## Setup

1. Install as a SillyTavern extension: **Extensions -> Install extension**, paste this repo's Git URL.
2. Open the panel: wand menu -> **Chat Assistant**, or the `/cc` slash command.
3. In the gear settings, pick a **Connection Profile** for the assistant (separate from your roleplay model) — required for it to run.
4. Optional: enable the Director / Editor cadence, turn on the Worldbook bridge, tune the numbers.

## Notes

- Mobile caching is aggressive — after updating, reload the page and confirm the version in the panel header.
- Only the *displayed* name is "Chat Assistant"; the storage key, slash command, and internal identifiers are unchanged, so updating from an older "Continuity Copilot" install keeps all your settings and memory.
