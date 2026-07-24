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
- `#e <text>` — co-write: seed the next episode with your own premise; the Director expands it into a hidden episode built around it.

**Two autonomous systems** (opt-in, run on a cadence on the assistant's profile, never on your main model):
- **Director** — writes secret per-episode directives (hidden `[EPISODE_END]` markers) that give NPCs and the world their own initiative and give pacing an arc, injected into your storyteller so the world acts *on* the protagonist. Three modes: **Auto** (AI invents and chains episodes on its own), **Co-writer** (each episode grows from *your* one-line seed via `#e`/🎬 Seed — the AI drafts the hidden beats around it, and 💡 Seed ideas proposes three doors when you're blank), and **Off** (manual buttons only). Peek/edit/`#d` work in every mode. **Restart** — with a live directive the `🎬 New` button becomes `🎬 Restart`: it throws out the current episode's directive and rewrites that episode from scratch, keeping its number. The rejected directive is shown to the model as *never aired and not canon*, with an explicit brief to take the road not taken — a different premise, centerpiece, shape, and dilemma — so a restart never hands back a variation of what you just rejected. Directives are **sovereignty-planned** for choice-driven play: the premise names an open **EPISODE QUESTION**, beats are written as the world's half of the collision and stop at the player's decision point ("the bullies corner the transfer student in front of you" is a beat; "you step in" is a stolen choice — and so is "your power slips out involuntarily": the plan may never make the player the subject of a sentence, voluntary or not, body, mouth, or mask; it schedules world events and choreographs only the NPC half of them), and the landing maps consequences **per possible answer** instead of scripting one outcome — the episode ends when the player has answered the question on screen, whichever way they answer. (Use `#d <direction>` instead when you want to *re-aim* the current episode while keeping what works.) Every directive is written in **two passes** (on by default): a first draft, then a **showrunner review** that interrogates it against the best episodes ever aired — is this the most interesting version of the premise, where is the scene the audience will retell, which established character is wasted or missing, where does it play safe — and rewrites it. The rule-based laws catch known failure classes; the showrunner pass is what catches the ones nobody enumerated. On reasoning models the passes split the thinking like a real room splits the work: the draft runs in declared **fast-draft mode** (full format, every law, no extended deliberation — the deep pass is coming) and the showrunner review is where the deep thought goes, roughly halving two-pass wall-clock without touching the quality gate. Single-pass mode (toggle off) keeps full deliberation on its only pass. Since v2.65 directives also obey a **recognition grammar**: every episode names an audience whose current reading of the protagonist is wrong, stale, or unformed (sourced from story-memory stances when any exist), lets that old reading score first in front of witnesses, then plays the room's repricing **on screen** instead of summarizing it into aftermath — shifts partial and in-character, hardening allowed and banked as future fuel. A low-stakes **ambient interlude** shape (strangers or minor cast, wagers no heavier than pride and taste, no institution, no dilemma) is legalized roughly every fourth or fifth episode, so small conversions — the disgust-turned-delight scene — are full episodes, not filler, and the trials have breath between them.
- **Editor** — standing craft notes injected each turn. It patrols the defect floor (scenes circling the protagonist, characters/props vanishing, dead ambient world, agency theft, same-voice NPCs, rushed resolutions, phrase tics) **and** holds the story to a masterpiece bar (dead scenes that don't turn, on-the-nose dialogue, wasted dramatic irony, unpaid setups, escalation-by-volume, frictionless success, furniture characters — named presences with no want and no move, or stakeholders missing from their own jurisdiction). Every pass opens with one **NORTH STAR** line — the single highest-leverage improvement — followed by the numbered standing notes. It can run on a reply cadence *and* (on by default) **automatically when an episode concludes**: the editor reviews the aired episode first, and in Auto director mode the next episode is then designed with the fresh notes in hand — a writers'-room review→plan loop.

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

**Pause without losing anything** — two settings checkboxes, `⏸ Pause Director injection` and `⏸ Pause Editor-notes injection`: the directive / standing notes stay stored (Peek still shows them, the copilot can still read them) but are actively cleared from the storyteller's prompt until unpaused — cleared, not skipped, because a previously set extension prompt persists until overwritten. The panel sub-line shows `🎬⏸` / `📝⏸` while paused so a silent pause can't be mistaken for a broken director. While a channel is paused its automation stands down too — auto-director, auto-critique, and the episode-end editor pass all skip rather than burn reasoning calls on content the storyteller cannot see, and manual generations carry an explicit PAUSED warning. Automation resumes on the first reply after unpausing.

**Reasoning models, tamed not disabled** — the director/showrunner/critique prompts carry explicit deliberation discipline (the token budget is shared between private reasoning and the answer; settle, commit, write), and the think-consumed recovery is structurally fixed: it retries in an **enlarged pot** (2× base, capped 32k) with a one-sentence escape hatch for forced reasoning phases and the reasoning transcript fed back for transcription — because a same-size recovery over a longer input was mathematically doomed to be consumed again, which is what "thinking and thinking for 40k" was. Thinking models keep their depth; they just stop starving the answer.

**End season, scope-honest** — `🏁 End season` clears only the final episode's directive and says exactly that to the residue audit, with a deterministic played-state the extension computes itself: **NEVER PLAYED** (zero storyteller replies since the directive was set — the audit is told chat absence is expected and forbidden from hunting for missing beats), **PARTIALLY PLAYED — about N replies** (what aired is history and stays; only the unaired remainder is scrubbed), **CONCLUDED**, or UNKNOWN for directives from older versions. Earlier episodes of the season are explicitly fenced off as real history, and the audit has a mandated clean exit: nothing found = one line, zero cards. Ending a season to reset or clear corruption no longer sends the model spiraling over beats that were never played.

**Liveness readout** — every busy state (directing, showrunner pass, editor, seeds, status, edit) is a live ticker, not a static label: elapsed seconds, streamed character counts (`1240 chars (+3100 thinking)`) that climb chunk by chunk, the current phase (`draft` → `showrunner second draft`), and an `auto-abort in Ns` countdown showing exactly when the stall watchdog will give up. Directive secrecy holds — the readout is counts only, never content. With streaming off it says so and points at the setting.

**Reliability** — every LLM transport await (stream start, each stream chunk, plain requests, the fallback backend) runs under a stall watchdog (`LLM stall timeout`, default 300s, 0 = off): a provider request that never settles is aborted with a loud error instead of holding the extension's `running` flag forever — which previously turned one hung request into every button on every model silently doing nothing until reload. ⏹ Stop now also force-unblocks the in-flight await even against backends that ignore AbortSignal. And pressing any action while another is in flight tells you so with a toast instead of silently returning.

## For a future maintainer (architecture at a glance)

- **⚠️ THE GATE — run before every push: `node load_test.mjs` (exit 0 or DO NOT PUSH).** SillyTavern loads `index.js` as an **ES module**; `node --check index.js` parses CommonJS and silently accepts what ESM rejects. This repo was gated on syntax alone until v2.51.0. The gate really executes the module against a mocked SillyTavern, drives `init()` through `APP_READY`, asserts the panel built and every event handler bound, and carries source-witness assertions for the shipped invariants: the cross-chat contamination guards (`sameChat` in the ask loop, apply run, undo, and episode conclusion), the v2.52 craft doctrine in the director/seed/critique prompts, the episode-end review→plan chain ordering, and the v2.63 player-sovereignty format (stop-at-the-player beat grammar, open landing with per-answer consequences, showrunner SOVEREIGNTY interrogation, question-answered episode end), and the v2.64 version lock (the in-code header stamp must equal the manifest version) plus the total-subject sovereignty law (the involuntary loophole, premise presupposition, and world-staged TURN/MOMENT), and the v2.65 recognition grammar (RECOGNITION LAW with resistance-first staging and on-screen reprice, ambient-interlude DILEMMA exemption, showrunner interrogation 7, and a sha256-pinned V264 freeze that fails on any byte of drift) — if a refactor removes one, the gate fails until the replacement is proven and the witness updated.
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
