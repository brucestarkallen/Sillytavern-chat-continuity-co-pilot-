/*
 * Continuity Copilot — a lightweight SillyTavern extension.
 *
 * A small chat panel where you talk to a "fixer" AI that can:
 *   - read your chat (message index + full text on demand),
 *   - read memory injections from extensions like Summaryception
 *     (snippets / audit / notes) as ground truth,
 *   - propose targeted find/replace edits to any message,
 *   - apply them directly to the chat log (with preview + undo).
 *
 * License: MIT. Edit-application-by-fuzzy-anchor idea inspired by
 * ST-Copilot (MIT, github.com/Supker/St-Copilot); code here is original.
 */

(() => {
    'use strict';

    const MODULE = 'continuityCopilot';
    const LOG = '[ContinuityCopilot]';
    const VERSION = '2.9.0';

    // ------------------------------------------------------------------
    // Defaults
    // ------------------------------------------------------------------

    const DEFAULT_SYSTEM_PROMPT = [
        'You are Continuity Copilot, the user\'s co-writer and repair assistant embedded in SillyTavern.',
        'The user runs a long roleplay chat. You help them in two ways:',
        'A) REPAIR: find and fix continuity, logic, and canon errors directly in the chat log.',
        'B) IDEAS: brainstorm plot directions, scene ideas, and character beats, and answer story questions — always consistent with [STORY MEMORY].',
        '',
        'Each request gives you:',
        '- [STORY MEMORY]: ground truth pulled from the user\'s memory extensions (summaries, snippets, audits, notes).',
        '- [MESSAGE INDEX]: one line per chat message: #id [speaker] preview.',
        '- [FULL MESSAGES]: complete text of some messages.',
        '- The user\'s request and your previous conversation with them.',
        '',
        'Rules:',
        '1. [STORY MEMORY] and the user\'s own statements outrank the chat text when they conflict.',
        '2. If you must read messages that were not given in full, reply with ONLY this block and nothing else:',
        '<fetch>[12, 13, 27]</fetch>',
        'Their full text will be sent to you, then you answer properly.',
        '3. To change chat messages, include exactly one block in your reply:',
        '<edits>',
        '[',
        '  {"id": 27, "find": "verbatim excerpt copied character-for-character from message 27", "replace": "corrected text", "reason": "short explanation"}',
        ']',
        '</edits>',
        '- "find" must be an exact substring of that message, long enough to be unique inside it.',
        '- Keep edits minimal and match the original prose style. Do not rewrite more than needed.',
        '- To replace an entire message, omit "find" and put the full new message in "replace".',
        '- Never invent message ids that are not in the index.',
        '4. USER_EDIT_RULE',
        '5. Outside those blocks, talk to the user naturally. Keep repair talk brief and concrete; for brainstorming and story discussion you may write more. Never paste whole chat messages back at them.',
    ].join('\n');

    const MEMEDIT_RULES = [
        'Memory editing:',
        '- [STORY MEMORY] comes from the user\'s memory extension and is directly editable. To correct it (notes, plot-essential, snippet text), include one block:',
        '<memedits>',
        '[{"find": "exact text copied character-for-character from [STORY MEMORY]", "replace": "corrected text", "reason": "short why"}]',
        '</memedits>',
        '- "find" must be verbatim from [STORY MEMORY] and long enough to be unique. Keep corrections minimal and in the same style.',
        '- To replace an ENTIRE memory field, use {"path": "summaryception.notepad", "replace": "new full text", "reason": "..."} with the exact path shown in [STORY MEMORY] section headers. Adding "find" alongside "path" replaces only within that field.',
        '- The Author\'s Note is writable at path "note_prompt" (created if absent). The visible editor-critique notes are writable at path "cc_critique"; full replace with "" deletes them.',
        '- LARGE CHANGES: if a replacement would be very long, split the work into SEVERAL smaller find/replace edits (section by section) in the same block instead of one huge replace \u2014 each edit\'s replace text must stay comfortably within the response budget, or the reply gets cut off.',
        '- Anchors ("find") must be UNIQUE across the entire memory \u2014 the applier REJECTS anchors that match multiple places. Extend the excerpt until it is unmistakable.',
        '- Only prose/text fields are editable. Never target structural fields (turnRange, timestamps, indices, counters).',
        '- Use <edits> only for chat messages and <memedits> only for memory. Never mix them.',
    ].join('\n');

    const CHAT_EDIT_EXTRAS = [
        'Additional chat-edit ability:',
        '- To HIDE a message from the AI context without deleting it (e.g. OOC/meta exchanges), use {"id": 12, "hide": true, "reason": "..."} inside <edits>. Use {"id": 12, "hide": false} to unhide. Hiding works on user messages too; the text stays visible in the log but leaves the AI context.',
        '- The [MESSAGE INDEX] tags hidden messages "(hidden)" and memory-ghosted ones "(ghosted by memory)". You may unhide "(hidden)" messages when asked; NEVER unhide "(ghosted by memory)" ones \u2014 their content lives in the memory snippets.',
        '- Messages you hid are remembered in a ledger even if another extension later makes them visible again (the index will note this). If the user asks to "re-hide my OOC", emit hide edits for every id in that note.',
        '- In explanations, refer to blocks WITHOUT angle brackets (write "edits block", "memedits block", "fetch"). The literal tags must appear ONLY wrapping the actual JSON, never inside prose.',
        '- Anchors ("find") must be UNIQUE within their target message \u2014 the applier REJECTS ambiguous anchors. When in doubt, extend the excerpt a few words on each side.',
        '- The user can discuss your proposals before applying them. If they ask you to reconsider or refine an edit, simply propose the improved version in a new edits/memedits block \u2014 it is added to the staging area alongside the earlier ones so they can compare and pick. You do not need to resend unchanged proposals.',
    ].join('\n');

    const AUDIT_PROMPT = 'Audit the whole chat against [STORY MEMORY]. Look for continuity and logic errors: wrong locations, wrong character knowledge (information quarantine breaks), timeline contradictions, dropped or duplicated plot state. Fetch full messages if you need them, then list what you found and propose fixes in an <edits> block, plus <memedits> wherever the memory itself is wrong.';

    const DEFAULT_SHORTCUTS = [
        '#s = Check the CURRENT session against [STORY MEMORY]. Use <fetch> to pull any listed messages you have not seen in full. Then find (1) events, facts, or state changes MISSING from the memory and (2) memory entries that are stale or contradicted by the chat. Propose every correction in a single <memedits> block with "find" copied verbatim from [STORY MEMORY]. Do NOT propose <edits> to chat messages unless I explicitly ask.',
        '#f = Check the chat against [STORY MEMORY] and fix every continuity error you find with a single <edits> block.',
        '#o = Scan the chat for OOC/meta exchanges (out-of-character notes, corrections, discussions in (( )), [brackets], or marked OOC). Use <fetch> as needed. For each lesson found: (1) propose <edits> fixing any story text it corrected, (2) propose <memedits> persisting the lesson into the notepad, Author\'s Note (path note_prompt), or editor notes (path cc_critique), and (3) propose hiding the pure-OOC messages from AI context with {"id": n, "hide": true} entries. Nothing is deleted \u2014 hidden text stays in the log.',
        '#a = FIDELITY audit of the memory. For each snippet, use its "(covers chat messages #x to #y)" note to <fetch> the original ghosted messages, then verify two things: does the snippet text capture every plot-relevant event, and does its audit/detail field preserve the concrete facts (names, numbers, objects, places, injuries, promises, who-knows-what)? Report anything LOST or DISTORTED and propose <memedits> restoring the missing details into the snippet text or its detail field. If the memory is large, process ONE snippet per run and tell me where you stopped so I can continue.',
        '#m = Audit the MEMORY itself for internal continuity errors. Cross-check [STORY MEMORY]: the notepad (PE) vs every snippet vs every audit/detail \u2014 contradictions between them (locations, timeline, character state, who-knows-what), duplicated or conflicting facts, and audits that contradict their own snippet. If two versions disagree, <fetch> the ghosted originals to verify which is true. Propose all corrections in a single <memedits> block. Do NOT propose <edits> to chat messages unless I explicitly ask.',
        '#i = Brainstorm what could happen next. Give 3-5 distinct directions for the upcoming scene(s), each consistent with [STORY MEMORY] and the current situation: a one-line hook plus what it would develop. Do not write the scene itself and do not propose <edits>.',
    ].join('\n');

    const DEFAULT_DIRECTOR_PROMPT = [
        'You are an expert story director for a long-form roleplay. Write a SECRET director\'s note for the storyteller AI. The player must never see it.',
        'Anchor in [STORY MEMORY]: established canon facts, characters, and world rules must stay accurate \u2014 never contradict or retcon them. Beyond that you have FULL creative authority: invent whatever the episode needs, minor or major \u2014 new characters (even significant ones), factions, locations, institutions, events, crowds, rumors, chance encounters. New creations are additive to canon, must fit the setting\'s logic and tone, and should earn their place: introduce a major new character only when the existing cast cannot serve the story as well.',
        'The note must contain:',
        '1. EPISODE PREMISE \u2014 one television-episode-quality premise rising naturally from existing threads.',
        '2. BEATS \u2014 3-5 escalation beats in order, each naming WHO or WHAT initiates and the pressure it puts on the player character. At least one beat must come from OUTSIDE the personal cast: the crowd/public, an institution or system, the environment, or chance.',
        '3. NPC & WORLD INITIATIVE \u2014 antagonists, NPCs, and the world itself act first, true to their established methods; the setting should feel alive beyond the main cast.',
        '4. LANDING \u2014 the natural end state of the episode and its consequence.',
        'Calibration: intensity = INTENSITY_LEVEL. Match the story\'s existing tone and realism; escalate the way good TV does \u2014 earned, in-character, no tonal whiplash, no gratuitous extremes. Vary pressure sources between episodes (personal, social, systemic, environmental).',
        'Be bold: prefer the daring, memorable choice over the safe one. The only success metric is whether the episode is masterpiece-level engaging for the player.',
        'Write beats as pressure the player must answer \u2014 confrontations, deadlines, temptations with costs \u2014 never events that resolve themselves off-screen.',
        'Honor any [editor notes] standing corrections present in the context \u2014 the episode you design must not repeat faults the editor has flagged.',
        'Rules: the note guides, never railroads \u2014 the storyteller must adapt beats to the player\'s choices; conclude naturally at the landing. Under 250 words. Output ONLY the director\'s note text, no preamble.',
    ].join('\n');

    const defaults = {
        profileId: '',
        recentFull: 8,
        fetchRounds: 3,
        maxTokens: 4096,
        thinkRetries: 2,
        wiEnable: false,
        wiBooks: '',
        wiFull: false,
        historyDepth: 12,
        memoryKeyPattern: 'summar|ception|memory|qvink',
        allowUserEdits: false,
        includeHidden: false,
        includeAuthorsNote: true,
        streaming: true,
        showThinking: true,
        directorIntensity: 'standard',
        directorAnchors: '',
        directorDepth: 4,
        directorPrompt: DEFAULT_DIRECTOR_PROMPT,
        critiqueDepth: 8,
        autoRehide: true,
        critiqueAuto: 0,
        directorAuto: false,
        ledgerAuto: 0,
        ledgerDepth: 6,
        ledgerWindow: 20,
        ledgerInject: true,
        shortcuts: DEFAULT_SHORTCUTS,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };

    let settings = null;
    let pendingEdits = [];   // [{id, find, replace, reason, status}]
    let editsCollapsed = false;
    let undoStack = [];      // [{label, items:[{id, before}]}]
    let running = false;
    let inited = false;
    let stopRequested = false;
    let abortCtl = null;

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function ctx() {
        return SillyTavern.getContext();
    }

    function esc(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function oneLine(s) {
        return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function toast(msg, type) {
        try {
            if (window.toastr) {
                (toastr[type || 'info'] || toastr.info)(msg, 'Continuity Copilot');
                return;
            }
        } catch (e) { /* ignore */ }
        console.log(LOG, msg);
    }

    // ------------------------------------------------------------------
    // Settings + per-chat state
    // ------------------------------------------------------------------

    function loadSettings() {
        const c = ctx();
        c.extensionSettings[MODULE] = Object.assign({}, defaults, c.extensionSettings[MODULE] || {});
        settings = c.extensionSettings[MODULE];
    }

    function persistSettings() {
        try { ctx().saveSettingsDebounced?.(); } catch (e) { /* ignore */ }
    }

    function metaRoot() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata;
        if (!md) return { sessions: [{ id: 1, name: 'Session 1', history: [] }], activeId: 1 };
        let m = md[MODULE];
        if (!m || !Array.isArray(m.sessions)) {
            const old = (m && Array.isArray(m.history)) ? m.history : [];
            m = {
                sessions: [{ id: 1, name: 'Session 1', history: old }],
                activeId: 1,
                director: (m && m.director) ? m.director : null,
                ccHidden: (m && Array.isArray(m.ccHidden)) ? m.ccHidden : [],
                directorEp: (m && Number.isFinite(m.directorEp)) ? m.directorEp : 0,
            };
            md[MODULE] = m;
        }
        if (!m.sessions.length) m.sessions.push({ id: 1, name: 'Session 1', history: [] });
        if (!m.sessions.some(x => x.id === m.activeId)) m.activeId = m.sessions[0].id;
        if (!Array.isArray(m.ccHidden)) m.ccHidden = [];
        if (!Number.isFinite(m.directorEp)) m.directorEp = (m.director && Number(m.director.episode)) || 0;
        return m;
    }

    function meta() {
        const m = metaRoot();
        return m.sessions.find(x => x.id === m.activeId);
    }

    function saveMeta() {
        const c = ctx();
        try {
            if (typeof c.saveMetadata === 'function') { c.saveMetadata(); return; }
            if (typeof c.saveMetadataDebounced === 'function') { c.saveMetadataDebounced(); return; }
        } catch (e) { /* ignore */ }
    }

    function pushHistory(role, content, think) {
        const m = meta();
        const entry = { role, content };
        if (think) entry.think = String(think).slice(0, 20000);
        m.history.push(entry);
        if (m.history.length > 80) m.history.splice(0, m.history.length - 80);
        saveMeta();
    }

    function renderSessions() {
        const sel = el('cc_sess');
        if (!sel) return;
        const m = metaRoot();
        sel.innerHTML = '';
        for (const x of m.sessions) {
            const o = document.createElement('option');
            o.value = String(x.id);
            o.textContent = x.name;
            sel.appendChild(o);
        }
        sel.value = String(m.activeId);
    }

    function switchSession(id) {
        const m = metaRoot();
        m.activeId = Number(id);
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
    }

    function newSession() {
        const m = metaRoot();
        const id = Math.max(0, ...m.sessions.map(x => x.id)) + 1;
        const used = new Set();
        for (const x of m.sessions) {
            const mm = /^Session (\d+)$/.exec(String(x.name || ''));
            if (mm) used.add(Number(mm[1]));
        }
        let n = 1;
        while (used.has(n)) n++;
        m.sessions.push({ id, name: 'Session ' + n, history: [] });
        m.activeId = id;
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
    }

    function branchSession() {
        const m = metaRoot();
        const cur = meta();
        const id = Math.max(0, ...m.sessions.map(x => x.id)) + 1;
        const name = (cur.name + ' (branch)').slice(0, 40);
        m.sessions.push({ id, name, history: JSON.parse(JSON.stringify(cur.history)) });
        m.activeId = id;
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
        addBubble('note', 'Branched from "' + cur.name + '" \u2014 this copy is independent of the original.');
    }

    function branchAt(idx) {
        const m = metaRoot();
        const cur = meta();
        if (!cur.history[idx]) return;
        const id = Math.max(0, ...m.sessions.map(x => x.id)) + 1;
        const name = (cur.name + ' @' + (idx + 1)).slice(0, 40);
        m.sessions.push({ id, name, history: JSON.parse(JSON.stringify(cur.history.slice(0, idx + 1))) });
        m.activeId = id;
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
        addBubble('note', 'Branched at message ' + (idx + 1) + ' from "' + cur.name + '".');
    }

    function renameSession() {
        const sess = meta();
        const n = prompt('Session name:', sess.name);
        if (n && n.trim()) {
            sess.name = n.trim().slice(0, 40);
            saveMeta();
            renderSessions();
        }
    }

    function deleteSession() {
        const m = metaRoot();
        if (m.sessions.length <= 1) {
            if (!confirm('Only one session exists \u2014 clear its conversation?')) return;
            meta().history = [];
            saveMeta();
            renderHistory();
            renderEditCards();
            return;
        }
        if (!confirm('Delete session "' + meta().name + '" and its conversation?')) return;
        m.sessions = m.sessions.filter(x => x.id !== m.activeId);
        m.activeId = m.sessions[0].id;
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
    }

    // ------------------------------------------------------------------
    // Context assembly: memory, index, full messages
    // ------------------------------------------------------------------

    function flattenStrings(node, path) {
        const out = [];
        const walk = (n, p2) => {
            if (typeof n === 'string') {
                if (n.trim().length >= 30) out.push('[' + p2 + ']\n' + n.trim());
                return;
            }
            if (Array.isArray(n)) { n.forEach((v2, i) => walk(v2, p2 + '[' + i + ']')); return; }
            if (n && typeof n === 'object') {
                if (Array.isArray(n.turnRange) && n.turnRange.length === 2) {
                    out.push('(' + p2 + ' covers chat messages #' + n.turnRange[0] + ' to #' + n.turnRange[1] + ')');
                }
                const entries = Object.entries(n);
                // Direct text fields first (e.g. notepad), nested structures after (e.g. layers).
                for (const [k, v2] of entries) { if (typeof v2 === 'string') walk(v2, p2 + '.' + k); }
                for (const [k, v2] of entries) { if (typeof v2 !== 'string') walk(v2, p2 + '.' + k); }
            }
        };
        walk(node, path);
        return out.join('\n\n');
    }

    // ------------------------------------------------------------------
    // Worldbook (SillyTavern World Info) bridge \u2014 fully gated
    // ------------------------------------------------------------------
    function wiApiAvailable() {
        const c = ctx();
        return typeof c.loadWorldInfo === 'function' && typeof c.saveWorldInfo === 'function';
    }

    function wiChosenBooks() {
        return String(settings.wiBooks || '').split(',').map(x => x.trim()).filter(Boolean);
    }

    function wiActive() {
        return !!settings.wiEnable && wiApiAvailable() && wiChosenBooks().length > 0;
    }

    async function wiLoad(book) {
        const c = ctx();
        try {
            const data = await c.loadWorldInfo(book);
            if (data && data.entries) return data;
        } catch (e) { console.warn(LOG, 'wiLoad failed', book, e); }
        return null;
    }

    async function wiSave(book, data) {
        const c = ctx();
        try { await c.saveWorldInfo(book, data, true); }
        catch (e) {
            try { await c.saveWorldInfo(book, data); }
            catch (e2) { console.warn(LOG, 'wiSave failed', book, e2); return false; }
        }
        try { c.updateWorldInfoList?.(); } catch (e) { /* ignore */ }
        try { c.reloadWorldInfoEditor?.(book); } catch (e) { /* ignore */ }
        return true;
    }

    function wiEntryList(data) {
        if (!data || !data.entries) return [];
        return Object.values(data.entries);
    }

    // Inspect the live ST state and report where Worldbooks live.
    function wiDiscover() {
        const c = ctx();
        const out = { character: null, chat: null, globals: [], all: [] };
        try {
            const ch = c.characters?.[c.characterId];
            out.character = ch?.data?.extensions?.world || ch?.data?.world || null;
        } catch (e) { /* ignore */ }
        try {
            const md = c.chatMetadata || c.chat_metadata || {};
            const cw = md.world_info;
            if (typeof cw === 'string') out.chat = cw;
            else if (cw && typeof cw === 'object') out.chat = cw.world || cw.name || null;
        } catch (e) { /* ignore */ }
        try {
            if (Array.isArray(c.world_names)) out.all = c.world_names.slice();
            else if (typeof window !== 'undefined' && Array.isArray(window.world_names)) out.all = window.world_names.slice();
            const sel = c.selected_world_info || (typeof window !== 'undefined' ? window.selected_world_info : null);
            if (Array.isArray(sel)) out.globals = sel.slice();
        } catch (e) { /* ignore */ }
        return out;
    }

    async function wiDetectReport() {
        if (!wiApiAvailable()) {
            addBubble('note', '\u26A0 This SillyTavern build does not expose the World Info API to extensions \u2014 Worldbook features unavailable.');
            return;
        }
        const d = wiDiscover();
        const lines = ['\uD83C\uDF10 Worldbook detection:'];
        lines.push('\u2022 Character-bound: ' + (d.character || '(none)'));
        lines.push('\u2022 Chat-bound: ' + (d.chat || '(none)'));
        lines.push('\u2022 Active global(s): ' + (d.globals.length ? d.globals.join(', ') : '(none/undetectable)'));
        if (d.all.length) lines.push('\u2022 All known books: ' + d.all.join(', '));
        const suggestions = [...new Set([d.character, d.chat, ...d.globals].filter(Boolean))];
        if (suggestions.length) lines.push('\nSuggested to manage: ' + suggestions.join(', ') + '  (put these in Settings \u2192 Worldbook \u2192 book names)');
        else lines.push('\nNo bound book auto-detected. Open ST\'s World Info panel, note the book name, and type it into Settings \u2192 Worldbook.');
        const txt = lines.join('\n');
        addBubble('note', txt);
        pushHistory('note', txt);
    }

    async function wiBuildContext() {
        // Returns a [WORLDBOOK] block for the pilot's context, respecting mode.
        if (!wiActive()) return '';
        const books = wiChosenBooks();
        const full = !!settings.wiFull;
        const parts = [];
        for (const book of books) {
            const data = await wiLoad(book);
            if (!data) { parts.push('(book "' + book + '" could not be loaded)'); continue; }
            const entries = wiEntryList(data);
            parts.push('=== Worldbook: ' + book + ' (' + entries.length + ' entries) ===');
            for (const e of entries) {
                const uid = e.uid;
                const title = (e.comment || '').trim() || '(untitled)';
                const keys = Array.isArray(e.key) ? e.key.join(', ') : '';
                const flags = [e.constant ? 'constant' : '', e.disable ? 'DISABLED' : '', e.vectorized ? 'vector' : ''].filter(Boolean).join(',');
                const head = 'WB[' + book + '#' + uid + '] "' + title + '"' + (keys ? ' {keys: ' + keys + '}' : '') + (flags ? ' [' + flags + ']' : '');
                if (full) {
                    parts.push(head + '\n' + String(e.content || ''));
                } else {
                    const snip = String(e.content || '').replace(/\s+/g, ' ').slice(0, 120);
                    parts.push(head + ' \u2014 ' + snip + (String(e.content || '').length > 120 ? '\u2026' : ''));
                }
            }
        }
        if (!parts.length) return '';
        const header = full
            ? '[WORLDBOOK \u2014 full entries; editable via wiedits by WB[book#uid]:]'
            : '[WORLDBOOK \u2014 catalog (titles/keys/snippet). Use <wifetch>["book#uid"] for full text; edit via wiedits:]';
        return header + '\n' + parts.join('\n');
    }

    function parseWiFetch(text) {
        const b = findBlock(text, 'wifetch');
        if (!b) return null;
        const m = b.inner.match(/\[[\s\S]*?\]/);
        if (!m) return null;
        try {
            const arr = JSON.parse(m[0]);
            return Array.isArray(arr) ? arr.map(String) : null;
        } catch (e) { return null; }
    }

    async function wiFullText(refs) {
        // refs: ["book#uid", ...]
        const byBook = {};
        for (const r of refs) {
            const mm = /^(.*)#(\d+)$/.exec(String(r).trim());
            if (!mm) continue;
            (byBook[mm[1]] = byBook[mm[1]] || []).push(Number(mm[2]));
        }
        const out = [];
        for (const [book, uids] of Object.entries(byBook)) {
            const data = await wiLoad(book);
            if (!data) { out.push('(book "' + book + '" not found)'); continue; }
            for (const e of wiEntryList(data)) {
                if (uids.includes(Number(e.uid))) {
                    out.push('WB[' + book + '#' + e.uid + '] "' + (e.comment || '').trim() + '"\n' + String(e.content || ''));
                }
            }
        }
        return out.join('\n\n') || '(no matching entries)';
    }

    function parseWiEdits(text) {
        const b = findBlock(text, 'wiedits');
        if (!b) return { edits: [] };
        let raw = b.inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        let arr;
        try { arr = JSON.parse(raw); } catch (e) { return { edits: [], error: e.message }; }
        if (!Array.isArray(arr)) arr = [arr];
        const edits = [];
        for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            const book = String(o.book || (wiChosenBooks()[0] || '')).trim();
            if (!book) continue;
            edits.push({
                kind: 'wi', book,
                uid: (o.uid === undefined || o.uid === null) ? null : Number(o.uid),
                find: (o.find === undefined) ? null : String(o.find),
                replace: o.replace !== undefined ? String(o.replace) : (o.replace_content !== undefined ? String(o.replace_content) : ''),
                setKeys: Array.isArray(o.set_keys) ? o.set_keys.map(String) : null,
                newEntry: !!o.new_entry,
                comment: o.comment !== undefined ? String(o.comment) : null,
                constant: o.constant,
                disable: o.disable,
                reason: o.reason ? String(o.reason) : '',
                status: 'pending',
            });
        }
        return { edits };
    }

    async function applyWiOne(edit) {
        const data = await wiLoad(edit.book);
        if (!data) return { ok: false, reason: 'book "' + edit.book + '" not found' };
        const before = JSON.parse(JSON.stringify(data));
        if (edit.newEntry) {
            let maxUid = -1;
            for (const e of wiEntryList(data)) maxUid = Math.max(maxUid, Number(e.uid));
            const uid = maxUid + 1;
            data.entries[String(uid)] = {
                uid, key: edit.setKeys || [], keysecondary: [], comment: edit.comment || 'New entry',
                content: edit.replace || '', constant: !!edit.constant, vectorized: false, selective: true,
                order: 100, position: 0, disable: !!edit.disable, addMemo: true, excludeRecursion: false,
                probability: 100, useProbability: true, group: '', groupOverride: false, scanDepth: null,
                caseSensitive: null, matchWholeWords: null, automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0,
            };
            const ok = await wiSave(edit.book, data);
            return ok ? { ok: true, book: edit.book, before, path: edit.book + '#' + uid + ' (new)' } : { ok: false, reason: 'save failed' };
        }
        const entry = wiEntryList(data).find(e => Number(e.uid) === edit.uid);
        if (!entry) return { ok: false, reason: 'entry uid ' + edit.uid + ' not found in ' + edit.book };
        const metaOnly = (edit.setKeys || edit.disable !== undefined || edit.constant !== undefined) && edit.find === null && (edit.replace === '' || edit.replace === undefined || edit.replace === null);
        if (edit.setKeys) entry.key = edit.setKeys;
        if (edit.disable !== undefined) entry.disable = !!edit.disable;
        if (edit.constant !== undefined) entry.constant = !!edit.constant;
        if (metaOnly) {
            // keys/flags only \u2014 leave content untouched
        } else if (edit.find === null) {
            entry.content = edit.replace;
        } else if (edit.find !== null) {
            const cur = String(entry.content || '');
            const cnt = cur.split(edit.find).length - 1;
            if (cnt === 0) return { ok: false, reason: 'find text not in entry (content changed?)' };
            if (cnt > 1) return { ok: false, reason: 'find matches ' + cnt + ' places \u2014 use a longer unique excerpt' };
            entry.content = cur.replace(edit.find, edit.replace);
        }
        const ok = await wiSave(edit.book, data);
        return ok ? { ok: true, book: edit.book, before, path: edit.book + '#' + edit.uid } : { ok: false, reason: 'save failed' };
    }

    function gatherMemory() {
        const c = ctx();
        const parts = [];
        let re;
        try { re = new RegExp(settings.memoryKeyPattern, 'i'); }
        catch (e) { re = /summar|ception|memory/i; }

        // 1) Live extension prompt injections (this is exactly what the main
        //    model sees from Summaryception: snippets, audit, notes, etc.)
        const mdKeys = new Set();
        // 1) Matching keys in chat metadata: the editable source of truth.
        try {
            const md = c.chatMetadata || c.chat_metadata || {};
            for (const [key, v] of Object.entries(md)) {
                if (key === MODULE || !re.test(key)) continue;
                let text = '';
                if (typeof v === 'string') text = v.trim();
                else if (v && typeof v === 'object') text = flattenStrings(v, key).trim();
                if (text) {
                    parts.push('--- memory: ' + key + ' ---\n' + text);
                    mdKeys.add(key.toLowerCase());
                }
            }
        } catch (e) { console.warn(LOG, 'chatMetadata read failed', e); }

        // 2) Live injections, unless the same-named metadata already covered them.
        try {
            const eps = c.extensionPrompts || {};
            for (const [key, p] of Object.entries(eps)) {
                const val = p && typeof p.value === 'string' ? p.value.trim() : '';
                if (!val || !re.test(key)) continue;
                if (mdKeys.has(key.toLowerCase())) continue; // metadata version is the editable truth
                parts.push('--- injection: ' + key + ' ---\n' + val);
            }
        } catch (e) { console.warn(LOG, 'extensionPrompts read failed', e); }

        // 3) Author's Note (some setups keep "notes" there, e.g. Summaryception forks).
        if (settings.includeAuthorsNote) {
            try {
                const md = c.chatMetadata || c.chat_metadata || {};
                const an = typeof md.note_prompt === 'string' ? md.note_prompt.trim() : '';
                if (an) parts.push("--- Author's Note (chat, writable at path note_prompt) ---\n" + an);
            } catch (e) { /* ignore */ }
            try {
                const fp = c.extensionPrompts?.['2_floating_prompt'];
                const val = fp && typeof fp.value === 'string' ? fp.value.trim() : '';
                if (val) parts.push("--- Author's Note (injected) ---\n" + val);
            } catch (e) { /* ignore */ }
        }

        try {
            const md3 = c.chatMetadata || c.chat_metadata || {};
            const crit = typeof md3.cc_critique === 'string' ? md3.cc_critique.trim() : '';
            if (crit) parts.push('--- editor notes (writable at path cc_critique) ---\n' + crit);
        } catch (e) { /* ignore */ }

        return parts.length ? parts.join('\n\n') : '(no memory extension data detected — pattern: ' + settings.memoryKeyPattern + ')';
    }

    function ghostedSet() {
        try {
            const md = ctx().chatMetadata || ctx().chat_metadata || {};
            const g = md.summaryception?.ghostedIndices;
            return new Set(Array.isArray(g) ? g.map(Number) : []);
        } catch (e) { return new Set(); }
    }

    function buildIndex() {
        const chat = ctx().chat || [];
        const ghosts = ghostedSet();
        const led = new Set((metaRoot().ccHidden || []).map(Number));
        const lines = [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m) continue;
            const who = m.is_user ? 'USER' : (m.name || 'AI');
            if (m.is_system) {
                const tag = led.has(i) ? '(hidden)' : (ghosts.has(i) ? '(ghosted by memory)' : '(hidden)');
                if (settings.includeHidden) {
                    lines.push('#' + i + ' [' + who + '] ' + tag + ': ' + oneLine(m.mes).slice(0, 150));
                } else {
                    lines.push('#' + i + ' [' + who + '] ' + tag);
                }
                continue;
            }
            lines.push('#' + i + ' [' + who + ']: ' + oneLine(m.mes).slice(0, 150));
        }
        const restored = [...led].filter(i2 => chat[i2] && !chat[i2].is_system);
        if (restored.length) {
            lines.push('NOTE: previously pilot-hidden but now visible again (another extension may have unhidden them): #' + restored.join(', #'));
        }
        return lines.join('\n') || '(chat is empty)';
    }

    function fullTextOf(ids) {
        const chat = ctx().chat || [];
        const out = [];
        for (const raw of ids) {
            const i = Number(raw);
            const m = chat[i];
            if (!m) { out.push('--- #' + raw + ' ---\n(no such message)'); continue; }
            const who = m.is_user ? 'USER' : (m.name || 'AI');
            out.push('--- #' + i + ' [' + who + '] ---\n' + String(m.mes || '').slice(0, 8000));
        }
        return out.join('\n\n');
    }

    function buildContextBlock() {
        const chat = ctx().chat || [];
        const n = Math.max(0, Math.min(100, Number(settings.recentFull) || 0));
        const ids = [];
        for (let i = Math.max(0, chat.length - n); i < chat.length; i++) ids.push(i);
        const base = [
            '[STORY MEMORY]',
            gatherMemory(),
            '',
            '[MESSAGE INDEX]',
            buildIndex(),
            '',
            '[FULL MESSAGES] (last ' + ids.length + ')',
            ids.length ? fullTextOf(ids) : '(none)',
        ].join('\n');
        return base;
    }

    const WI_RULES = [
        'WORLDBOOK (World Info) is shown in the [WORLDBOOK] block, referenced as WB[book#uid]. It is part of the world canon \u2014 audit it for continuity like [STORY MEMORY] (contradictions with the notepad, snippets, ledger, or chat).',
        'In catalog mode you see titles/keys/snippets; request full text with <wifetch>["book#uid", ...] (same loop as <fetch>).',
        'To edit the Worldbook, emit a <wiedits> block (JSON array). Ops:',
        '{"book":"Name","uid":3,"find":"verbatim excerpt","replace":"new text","reason":".."} \u2014 targeted edit; find must be unique in that entry.',
        '{"book":"Name","uid":3,"replace_content":"entire new entry text","reason":".."} \u2014 whole-entry replace.',
        '{"book":"Name","uid":3,"set_keys":["a","b"],"reason":".."} \u2014 update trigger keywords.',
        '{"book":"Name","new_entry":true,"comment":"Title","keys":["k"],"content":"..","constant":false,"reason":".."} \u2014 add an entry.',
        'Only edit the Worldbook when asked or when fixing a real continuity error. Keep [WORLDBOOK] and [STORY MEMORY] consistent with each other.',
    ].join('\n');

    function sysPrompt() {
        const rule = settings.allowUserEdits
            ? 'You may edit user-authored messages when the user asks for it.'
            : 'Never propose edits to user-authored messages; they are read-only.';
        let out = String(settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace('USER_EDIT_RULE', rule) + '\n\n' + CHAT_EDIT_EXTRAS + '\n\n' + MEMEDIT_RULES;
        if (wiActive()) out += '\n\n' + WI_RULES;
        return out;
    }

    // ------------------------------------------------------------------
    // LLM call (Connection Profile preferred, current API as fallback)
    // ------------------------------------------------------------------

    function getProfiles() {
        try {
            const list = ctx().extensionSettings?.connectionManager?.profiles;
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    function extractText(res) {
        if (res == null) return '';
        if (typeof res === 'string') return res;
        if (typeof res.content === 'string') return res.content;
        if (Array.isArray(res.content)) {
            return res.content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
        }
        if (typeof res.text === 'string') return res.text;
        try { return JSON.stringify(res); } catch (e) { return String(res); }
    }

    function grow(acc, chunk) {
        // Handles both cumulative and delta streaming chunks.
        if (!chunk) return acc;
        return chunk.startsWith(acc) ? chunk : acc + chunk;
    }

    async function callLLM(messages, onPartial) {
        const c = ctx();
        const pid = settings.profileId;
        const maxTok = Math.min(32768, Math.max(256, Number(settings.maxTokens) || 4096));
        stopRequested = false;
        try { abortCtl = new AbortController(); } catch (e) { abortCtl = null; }

        if (pid && c.ConnectionManagerRequestService?.sendRequest) {
            if (settings.streaming) {
                try {
                    const res = await c.ConnectionManagerRequestService.sendRequest(pid, messages, maxTok, { stream: true, signal: abortCtl?.signal });
                    if (typeof res === 'function') {
                        let acc = '';
                        let reasoning = '';
                        try {
                        for await (const chunk of res()) {
                            if (stopRequested) break;
                            if (typeof chunk === 'string') {
                                acc = grow(acc, chunk);
                            } else {
                                acc = grow(acc, String(chunk?.text ?? ''));
                                const r = chunk?.state?.reasoning ?? chunk?.reasoning;
                                if (typeof r === 'string') reasoning = grow(reasoning, r);
                            }
                            if (onPartial) onPartial(acc, reasoning);
                        }
                        } catch (se) { if (!stopRequested) throw se; }
                        if (reasoning && !/<think|<reasoning/i.test(acc)) {
                            return '<think>' + reasoning + '</think>\n' + acc;
                        }
                        return acc;
                    }
                    return extractText(res);
                } catch (e) {
                    console.warn(LOG, 'streaming failed, retrying without stream', e);
                }
            }
            try {
                const res = await c.ConnectionManagerRequestService.sendRequest(pid, messages, maxTok, { signal: abortCtl?.signal });
                return extractText(res);
            } catch (se) {
                if (stopRequested) return '';
                throw se;
            }
        }

        // Fallback: current connection, raw generation (no streaming here).
        const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const convo = messages
            .filter(m => m.role !== 'system')
            .map(m => (m.role === 'user' ? '[User]\n' : '[Copilot]\n') + m.content)
            .join('\n\n') + '\n\n[Copilot]\n';
        if (typeof c.generateRaw === 'function') {
            try {
                const res = await c.generateRaw({ prompt: convo, systemPrompt: sys });
                return extractText(res);
            } catch (se) {
                if (stopRequested) return '';
                throw se;
            }
        }
        throw new Error('No generation backend found. Pick a Connection Profile in the panel settings (gear icon).');
    }

    // ------------------------------------------------------------------
    // Reply parsing: <fetch> and <edits>
    // ------------------------------------------------------------------

    function findBlock(text, tag) {
        const src = String(text || '');
        const low = src.toLowerCase();
        const openTag = '<' + tag + '>';
        const closeTag = '</' + tag + '>';
        const opens = [];
        let oi = low.indexOf(openTag);
        while (oi !== -1) { opens.push(oi); oi = low.indexOf(openTag, oi + 1); }
        if (!opens.length) return null;
        let fallback = null;
        for (let k = opens.length - 1; k >= 0; k--) {
            const start = opens[k];
            const innerStart = start + openTag.length;
            const close = low.indexOf(closeTag, innerStart);
            if (close === -1) continue;
            const inner = src.slice(innerStart, close);
            const cand = { inner, start, end: close + closeTag.length };
            if (/^\s*(\[|\{|```)/.test(inner)) return cand;
            if (!fallback) fallback = cand;
        }
        return fallback;
    }

    function looksTruncated(text, tag) {
        const low = String(text || '').toLowerCase();
        const o = low.lastIndexOf('<' + tag + '>');
        if (o === -1) return false;
        return low.indexOf('</' + tag + '>', o) === -1;
    }

    function parseFetch(text) {
        const b = findBlock(text, 'fetch');
        if (!b) return null;
        const m = b.inner.match(/\[[\s\S]*?\]/);
        if (!m) return null;
        try {
            const arr = JSON.parse(m[0]);
            if (!Array.isArray(arr)) return null;
            const ids = arr.map(Number).filter(n => Number.isInteger(n) && n >= 0).slice(0, 15);
            return ids.length ? ids : null;
        } catch (e) { return null; }
    }

    function parseEdits(text) {
        const b = findBlock(text, 'edits');
        if (!b) return { edits: [] };
        let raw = b.inner.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return { edits: [], error: 'edits block is not a JSON array' };
            const edits = [];
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                const id = Number(e.id);
                if (!Number.isInteger(id) || id < 0) continue;
                edits.push({
                    kind: 'chat',
                    id,
                    hide: (typeof e.hide === 'boolean') ? e.hide : null,
                    find: (typeof e.find === 'string' && e.find.length) ? e.find : null,
                    replace: String(e.replace ?? ''),
                    reason: String(e.reason ?? ''),
                    status: 'pending',
                });
            }
            return { edits };
        } catch (err) {
            return { edits: [], error: 'could not parse edits JSON: ' + err.message };
        }
    }

    function parseMemEdits(text) {
        const b = findBlock(text, 'memedits');
        if (!b) return { edits: [] };
        let raw = b.inner.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return { edits: [], error: 'memedits block is not a JSON array' };
            const edits = [];
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                const path = (typeof e.path === 'string' && e.path.trim()) ? e.path.trim() : null;
                const find = (typeof e.find === 'string' && e.find.length) ? e.find : null;
                if (!find && !path) continue;
                edits.push({ kind: 'mem', path, find, replace: String(e.replace ?? ''), reason: String(e.reason ?? ''), status: 'pending' });
            }
            return { edits };
        } catch (err) {
            return { edits: [], error: 'could not parse memedits JSON: ' + err.message };
        }
    }

    function stripBlocks(text) {
        let out = String(text || '');
        const cut = (tag, label) => {
            const b = findBlock(out, tag);
            if (!b) return;
            out = out.slice(0, b.start) + (label || '') + out.slice(b.end);
        };
        cut('fetch', '');
        cut('edits', '[proposed edits below]');
        cut('memedits', '[proposed memory edits below]');
        return out.trim();
    }

    // ------------------------------------------------------------------
    // Locating text inside a message (exact -> normalized -> fuzzy)
    // ------------------------------------------------------------------

    function normChars(s) {
        // 1:1 length-preserving normalization, so indices stay valid.
        return String(s)
            .replace(/[\u2018\u2019\u02BC]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/\u00A0/g, ' ');
    }

    function normWord(s) {
        return normChars(s).toLowerCase();
    }

    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (!m) return n;
        if (!n) return m;
        let prev = new Array(n + 1);
        let cur = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            cur[0] = i;
            const ai = a[i - 1];
            for (let j = 1; j <= n; j++) {
                const cost = ai === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            const tmp = prev; prev = cur; cur = tmp;
        }
        return prev[n];
    }

    function countOccurrences(hay, needle) {
        if (!needle) return 0;
        return String(hay).split(needle).length - 1;
    }

    function hashText(t) {
        let h = 5381;
        const s2 = String(t || '');
        for (let i = 0; i < s2.length; i++) h = ((h << 5) + h + s2.charCodeAt(i)) >>> 0;
        return h + ':' + s2.length;
    }

    function memStrings(cb) {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata || {};
        let re;
        try { re = new RegExp(settings.memoryKeyPattern, 'i'); }
        catch (e) { re = /summar|ception|memory/i; }
        const visit = (node) => {
            if (typeof node === 'string') { cb(node); return; }
            if (Array.isArray(node)) { node.forEach(visit); return; }
            if (node && typeof node === 'object') { for (const v of Object.values(node)) visit(v); }
        };
        for (const [key, val] of Object.entries(md)) {
            if (key === MODULE) continue;
            const extra = key === 'note_prompt' || key === 'cc_critique';
            if (!re.test(key) && !extra) continue;
            visit(val);
        }
    }

    function memCountExact(needle) {
        let n = 0;
        memStrings(t => { n += countOccurrences(t, needle); });
        return n;
    }

    function resolveMemPath(path) {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata || {};
        const tokens = String(path).match(/[^.\[\]]+/g) || [];
        if (!tokens.length) return undefined;
        let node = md[tokens[0]];
        for (let t = 1; t < tokens.length; t++) {
            if (node == null || typeof node !== 'object') return undefined;
            const k = /^\d+$/.test(tokens[t]) ? Number(tokens[t]) : tokens[t];
            node = node[k];
        }
        return node;
    }

    function stampReviewState(list) {
        try {
            for (const e of list) {
                if (e.kind === 'mem') {
                    if (e.find) e.seenAtReview = memCountExact(e.find) > 0;
                    else if (e.path) {
                        const node = resolveMemPath(e.path);
                        e.reviewHash = (typeof node === 'string') ? hashText(node) : null;
                    }
                } else if (e.kind === 'chat' && e.find && Number.isInteger(e.id)) {
                    const m2 = ctx().chat?.[e.id];
                    e.seenAtReview = !!(m2 && countOccurrences(String(m2.mes || ''), e.find) > 0);
                }
            }
        } catch (e) { /* ignore */ }
    }

    function locate(hay, needle) {
        const exactCount = countOccurrences(hay, needle);
        if (exactCount > 1) return { ambiguous: exactCount };
        if (exactCount === 1) {
            const idx = hay.indexOf(needle);
            return { start: idx, end: idx + needle.length, fuzzy: false };
        }

        const hay2 = normChars(hay);
        const needle2 = normChars(needle);
        const normCount = countOccurrences(hay2, needle2);
        if (normCount > 1) return { ambiguous: normCount };
        if (normCount === 1) {
            const idx2 = hay2.indexOf(needle2);
            return { start: idx2, end: idx2 + needle2.length, fuzzy: false };
        }

        const tokens = [...hay.matchAll(/\S+/g)];
        if (!tokens.length || tokens.length > 4000) return null;
        const needleWords = needle2.split(/\s+/).filter(Boolean).map(w => w.toLowerCase());
        const nw = needleWords.length;
        if (nw < 3 || nw > 150) return null;

        const hayWords = tokens.map(t => normWord(t[0]));
        const widths = [...new Set([
            Math.max(1, Math.round(nw * 0.85)),
            Math.max(1, nw - 1),
            nw,
            nw + 1,
            Math.round(nw * 1.15),
        ])].filter(w => w >= 1 && w <= tokens.length);

        let best = null;
        let second = 0;
        for (const w of widths) {
            for (let s2 = 0; s2 + w <= tokens.length; s2++) {
                const cand = hayWords.slice(s2, s2 + w);
                const dist = levenshtein(cand, needleWords);
                const sim = 1 - dist / Math.max(cand.length, nw);
                if (!best || sim > best.sim) {
                    if (best && (s2 + w <= best.s || s2 >= best.s + best.w)) second = Math.max(second, best.sim);
                    best = { sim, s: s2, w };
                } else if (sim > second && (s2 + w <= best.s || s2 >= best.s + best.w)) {
                    second = sim;
                }
            }
        }
        if (best && best.sim >= 0.78) {
            if (second >= best.sim - 0.05) return { ambiguous: 'fuzzy' };
            const startTok = tokens[best.s];
            const endTok = tokens[best.s + best.w - 1];
            return {
                start: startTok.index,
                end: endTok.index + endTok[0].length,
                fuzzy: true,
                sim: best.sim,
            };
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Applying edits to the chat
    // ------------------------------------------------------------------

    function refreshMessage(i) {
        const c = ctx();
        const msg = c.chat[i];
        try {
            if (typeof c.updateMessageBlock === 'function') {
                c.updateMessageBlock(i, msg);
                return;
            }
        } catch (e) { /* fall through */ }
        try {
            const el = document.querySelector('#chat .mes[mesid="' + i + '"] .mes_text');
            if (el && typeof c.messageFormatting === 'function') {
                el.innerHTML = c.messageFormatting(msg.mes, msg.name, !!msg.is_system, !!msg.is_user, i);
            }
        } catch (e) { console.warn(LOG, 'DOM refresh failed for #' + i, e); }
    }

    async function commitChanges(changedIds) {
        const c = ctx();
        for (const i of changedIds) {
            try { await c.eventSource?.emit?.(c.event_types?.MESSAGE_EDITED, i); } catch (e) { /* ignore */ }
            try { await c.eventSource?.emit?.(c.event_types?.MESSAGE_UPDATED, i); } catch (e) { /* ignore */ }
        }
        try {
            if (typeof c.saveChat === 'function') await c.saveChat();
        } catch (e) {
            toast('Failed to save chat: ' + e.message, 'error');
        }
    }

    async function setHiddenState(i, hide) {
        const c = ctx();
        const msg = c.chat?.[i];
        if (!msg) return;
        if (typeof c.hideChatMessageRange === 'function') {
            try {
                await c.hideChatMessageRange(i, i, !hide);
                msg.is_system = !!hide;
                return;
            } catch (e) { /* fall through to manual */ }
        }
        msg.is_system = !!hide;
        try {
            const elm = document.querySelector('#chat .mes[mesid="' + i + '"]');
            if (elm) elm.setAttribute('is_system', String(!!hide));
        } catch (e) { /* ignore */ }
        refreshMessage(i);
    }

    async function applyOne(edit) {
        const c = ctx();
        const i = Number(edit.id);
        const msg = c.chat?.[i];
        if (!msg) return { ok: false, reason: 'no message #' + i };
        if (edit.hide !== null && edit.hide !== undefined) {
            const beforeSys = !!msg.is_system;
            if (beforeSys === !!edit.hide) return { ok: false, reason: edit.hide ? 'already hidden' : 'already visible' };
            if (!edit.hide && ghostedSet().has(i)) {
                return { ok: false, reason: 'ghosted by Summaryception \u2014 restore it via Summaryception instead' };
            }
            await setHiddenState(i, !!edit.hide);
            const led = metaRoot().ccHidden;
            const pos = led.indexOf(i);
            if (edit.hide && pos < 0) led.push(i);
            if (!edit.hide && pos >= 0) led.splice(pos, 1);
            saveMeta();
            return { ok: true, before: String(msg.mes || ''), beforeSys };
        }
        if (msg.is_user && !settings.allowUserEdits) {
            return { ok: false, reason: 'user message (locked in settings)' };
        }
        const beforeSys = !!msg.is_system;
        const before = String(msg.mes || '');
        let next;
        let fuzzyNote = '';
        if (edit.find == null) {
            next = String(edit.replace ?? '');
        } else {
            const loc = locate(before, edit.find);
            if (loc && loc.ambiguous) return { ok: false, reason: 'anchor matches ' + (typeof loc.ambiguous === 'number' ? loc.ambiguous + ' places' : 'multiple similar places') + ' in this message \u2014 give a longer unique excerpt' };
            if (!loc) return { ok: false, reason: edit.seenAtReview ? 'message changed since review \u2014 regenerate and apply fresh cards' : '"find" text not located (even fuzzy)' };
            next = before.slice(0, loc.start) + String(edit.replace ?? '') + before.slice(loc.end);
            if (loc.fuzzy) fuzzyNote = ' (fuzzy match ' + Math.round(loc.sim * 100) + '%)';
        }
        if (next === before) return { ok: false, reason: 'no change produced' };

        msg.mes = next;
        msg.extra = msg.extra || {};
        if (!Array.isArray(msg.extra.cc_backups)) msg.extra.cc_backups = [];
        msg.extra.cc_backups.push({ ts: Date.now(), mes: before });
        while (msg.extra.cc_backups.length > 3) msg.extra.cc_backups.shift();

        refreshMessage(i);
        return { ok: true, before, beforeSys, fuzzyNote };
    }

    function walkReplace(node, find, replace, path) {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') {
                    const loc = locate(v, find);
                    if (loc && loc.ambiguous) return { ambiguous: true };
                    if (loc) { node[i] = v.slice(0, loc.start) + replace + v.slice(loc.end); return { path: path + '[' + i + ']', fuzzy: !!loc.fuzzy }; }
                } else if (v && typeof v === 'object') {
                    const r = walkReplace(v, find, replace, path + '[' + i + ']');
                    if (r) return r;
                }
            }
            return null;
        }
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') {
                const loc = locate(v, find);
                if (loc && loc.ambiguous) return { ambiguous: true };
                if (loc) { node[k] = v.slice(0, loc.start) + replace + v.slice(loc.end); return { path: path + '.' + k, fuzzy: !!loc.fuzzy }; }
            } else if (v && typeof v === 'object') {
                const r = walkReplace(v, find, replace, path + '.' + k);
                if (r) return r;
            }
        }
        return null;
    }

    function applyMemOne(edit, keyBackups) {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata;
        if (!md) return { ok: false, reason: 'no chat metadata' };
        let re;
        try { re = new RegExp(settings.memoryKeyPattern, 'i'); }
        catch (e) { re = /summar|ception|memory/i; }
        if (edit.find && !edit.path) {
            const totalExact = memCountExact(edit.find);
            if (totalExact > 1) return { ok: false, reason: 'anchor matches ' + totalExact + ' places across memory \u2014 give a longer unique excerpt' };
        }
        if (edit.path) {
            const tokens = String(edit.path).match(/[^.\[\]]+/g) || [];
            if (!tokens.length) return { ok: false, reason: 'bad path' };
            const rootKey = tokens[0];
            const extraOk = rootKey === 'note_prompt' || rootKey === 'cc_critique';
            if (rootKey === MODULE || (!re.test(rootKey) && !extraOk)) {
                return { ok: false, reason: 'path not in memory scope' };
            }
            if (md[rootKey] == null) {
                if (extraOk && tokens.length === 1) md[rootKey] = '';
                else return { ok: false, reason: 'path not found' };
            }
            let parent = md;
            let key = rootKey;
            let node = md[rootKey];
            for (let t = 1; t < tokens.length; t++) {
                if (node == null || typeof node !== 'object') return { ok: false, reason: 'path not found' };
                parent = node;
                key = /^\d+$/.test(tokens[t]) ? Number(tokens[t]) : tokens[t];
                node = parent[key];
            }
            if (typeof node !== 'string') return { ok: false, reason: 'unknown memory path (no text field exists there)' };
            const backupVal = typeof md[rootKey] === 'object' ? JSON.parse(JSON.stringify(md[rootKey])) : md[rootKey];
            if (edit.find) {
                const loc = locate(node, edit.find);
                if (loc && loc.ambiguous) return { ok: false, reason: 'anchor matches multiple places in that field \u2014 give a longer unique excerpt' };
                if (!loc) return { ok: false, reason: '"find" text not located at that path' };
                if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, backupVal);
                parent[key] = node.slice(0, loc.start) + String(edit.replace ?? '') + node.slice(loc.end);
                return { ok: true, path: edit.path, fuzzy: !!loc.fuzzy };
            }
            if (edit.reviewHash && hashText(node) !== edit.reviewHash) {
                return { ok: false, reason: 'field changed since review \u2014 re-run the audit and apply fresh cards' };
            }
            if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, backupVal);
            parent[key] = String(edit.replace ?? '');
            return { ok: true, path: edit.path + ' (full replace)', fuzzy: false };
        }
        for (const [key, val] of Object.entries(md)) {
            if (key === MODULE || !re.test(key) || val == null) continue;
            if (typeof val === 'string') {
                const loc = locate(val, edit.find);
                if (loc && loc.ambiguous) return { ok: false, reason: 'anchor ambiguous (multiple similar places) \u2014 give a longer unique excerpt' };
                if (loc) {
                    if (!keyBackups.has(key)) keyBackups.set(key, val);
                    md[key] = val.slice(0, loc.start) + String(edit.replace ?? '') + val.slice(loc.end);
                    return { ok: true, path: key, fuzzy: !!loc.fuzzy };
                }
                continue;
            }
            if (typeof val === 'object') {
                const backup = JSON.parse(JSON.stringify(val));
                const hit = walkReplace(val, edit.find, String(edit.replace ?? ''), key);
                if (hit && hit.ambiguous) return { ok: false, reason: 'anchor ambiguous (multiple similar places) \u2014 give a longer unique excerpt' };
                if (hit) {
                    if (!keyBackups.has(key)) keyBackups.set(key, backup);
                    return { ok: true, path: hit.path, fuzzy: hit.fuzzy };
                }
            }
        }
        for (const exKey of ['note_prompt', 'cc_critique']) {
            const exVal = md[exKey];
            if (typeof exVal !== 'string' || !exVal) continue;
            const exLoc = locate(exVal, edit.find);
            if (exLoc && exLoc.ambiguous) return { ok: false, reason: 'anchor ambiguous (multiple similar places) \u2014 give a longer unique excerpt' };
            if (exLoc) {
                if (!keyBackups.has(exKey)) keyBackups.set(exKey, exVal);
                md[exKey] = exVal.slice(0, exLoc.start) + String(edit.replace ?? '') + exVal.slice(exLoc.end);
                return { ok: true, path: exKey, fuzzy: !!exLoc.fuzzy };
            }
        }
        return { ok: false, reason: edit.seenAtReview ? 'memory changed since review \u2014 re-run the audit and apply fresh cards' : '"find" text not located in memory' };
    }

    async function applyEdits(list) {
        const chatApplied = [];
        const memPaths = [];
        const keyBackups = new Map();
        const wiBackups = new Map();
        for (const edit of list) {
            if (edit.status !== 'pending') continue;
            if (edit.kind === 'mem') {
                const res = applyMemOne(edit, keyBackups);
                if (res.ok) {
                    edit.status = 'applied \u2192 ' + res.path + (res.fuzzy ? ' (fuzzy)' : '');
                    memPaths.push(res.path);
                } else {
                    edit.status = 'failed: ' + res.reason;
                }
            } else if (edit.kind === 'wi') {
                const res = await applyWiOne(edit);
                if (res.ok) {
                    edit.status = 'applied \u2192 WB ' + res.path;
                    if (!wiBackups.has(res.book)) wiBackups.set(res.book, res.before);
                } else {
                    edit.status = 'failed: ' + res.reason;
                }
            } else {
                const res = await applyOne(edit);
                if (res.ok) {
                    edit.status = 'applied' + (res.fuzzyNote || '');
                    chatApplied.push({ kind: 'chat', id: edit.id, before: res.before, beforeSys: res.beforeSys });
                } else {
                    edit.status = 'failed: ' + res.reason;
                }
            }
        }
        const items = [...chatApplied];
        for (const [key, before] of keyBackups.entries()) items.push({ kind: 'mem', key, before });
        for (const [book, before] of wiBackups.entries()) items.push({ kind: 'wi', book, before });
        if (items.length) {
            const labelParts = [];
            if (chatApplied.length) labelParts.push(chatApplied.map(a => '#' + a.id).join(', '));
            if (memPaths.length) labelParts.push('memory: ' + memPaths.join(', '));
            undoStack.push({ label: labelParts.join(' + '), items });
            if (chatApplied.length) await commitChanges(chatApplied.map(a => a.id));
            if (memPaths.length) { saveMeta(); applyCritiqueInjection(); }
            const note = 'Applied ' + (chatApplied.length + memPaths.length) + ' edit(s): ' + labelParts.join(' + ') + '.' + (memPaths.length ? ' Memory updated \u2014 Summaryception uses it from the next generation.' : '');
            addBubble('note', note);
            pushHistory('note', note);
            toast(note, 'success');
        }
        renderEditCards();
    }

    async function undoLast() {
        const batch = undoStack.pop();
        if (!batch) { toast('Nothing to undo.', 'warning'); return; }
        const c = ctx();
        const changed = [];
        let memRestored = false;
        for (const item of batch.items) {
            if (item.kind === 'mem') {
                const md = c.chatMetadata || c.chat_metadata;
                if (md) { md[item.key] = item.before; memRestored = true; }
                continue;
            }
            if (item.kind === 'wi') {
                await wiSave(item.book, item.before);
                continue;
            }
            const msg = c.chat?.[item.id];
            if (!msg) continue;
            msg.mes = item.before;
            if (typeof item.beforeSys === 'boolean') {
                await setHiddenState(item.id, item.beforeSys);
                const led = metaRoot().ccHidden;
                const pos = led.indexOf(item.id);
                if (item.beforeSys && pos < 0) led.push(item.id);
                if (!item.beforeSys && pos >= 0) led.splice(pos, 1);
            }
            refreshMessage(item.id);
            changed.push(item.id);
        }
        if (changed.length) await commitChanges(changed);
        if (memRestored) { saveMeta(); applyCritiqueInjection(); }
        const note = 'Undid edits on ' + batch.label + '.';
        addBubble('note', note);
        pushHistory('note', note);
    }

    // ------------------------------------------------------------------
    // Reasoning tags + shortcut commands
    // ------------------------------------------------------------------

    function splitThinking(text) {
        let think = '';
        let rest = String(text || '').replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, (m0, tag, body) => {
            const b = String(body).trim();
            if (b) think += (think ? '\n\n' : '') + b;
            return '';
        });
        rest = rest.replace(/<(think|thinking|reasoning)>([\s\S]*)$/i, (m0, tag, body) => {
            const b = String(body).trim();
            if (b) think += (think ? '\n\n' : '') + b;
            return '';
        });
        return { think, rest: rest.trim() };
    }

    async function callLLMSmart(messages, onPartial) {
        const trRaw = Number(settings.thinkRetries);
        const maxRe = Number.isFinite(trRaw) ? Math.max(0, Math.min(99, trRaw)) : 2;
        let raw = await callLLM(messages, onPartial);
        let sp = splitThinking(raw);

        // Phase A: thinking consumed the whole budget -> feed the reasoning back, demand transcription
        let attempts = 0;
        while (!stopRequested && !sp.rest && sp.think && attempts < maxRe) {
            attempts++;
            addBubble('note', '\u26A0 Answer consumed by thinking \u2014 recovery ' + attempts + '/' + maxRe + ': feeding your reasoning back, demanding the direct answer\u2026');
            const msgs2 = [...messages,
                { role: 'assistant', content: '<previous_reasoning>\n' + sp.think.slice(-20000) + '\n</previous_reasoning>' },
                { role: 'user', content: '[SYSTEM] Above is your own prior reasoning \u2014 the analysis is DONE. Do not reason further. Convert it into the final answer and required blocks NOW, directly.' }];
            raw = await callLLM(msgs2, onPartial);
            const sp2 = splitThinking(raw);
            if (!sp2.rest && !sp2.think) {
                addBubble('note', 'Recovery made no progress (empty response) \u2014 stopping retries.');
                break;
            }
            sp = { think: sp.think + (sp2.think ? '\n\n' + sp2.think : ''), rest: sp2.rest };
        }

        // Phase B: answer exists but was cut mid-block -> continue from the cut and stitch
        let cont = 0;
        while (!stopRequested && sp.rest && cont < maxRe &&
               (looksTruncated(sp.rest, 'edits') || looksTruncated(sp.rest, 'memedits') || looksTruncated(sp.rest, 'ledgerops'))) {
            cont++;
            addBubble('note', '\u26A0 Output cut mid-block \u2014 auto-continuing (' + cont + '/' + maxRe + ')\u2026');
            const msgs3 = [...messages,
                { role: 'assistant', content: sp.rest },
                { role: 'user', content: '[SYSTEM] Your output was cut off mid-block. Continue EXACTLY from the character where you stopped. Output ONLY the remainder \u2014 no repetition, no preamble, no further reasoning.' }];
            raw = await callLLM(msgs3, onPartial);
            const sp3 = splitThinking(raw);
            if (!sp3.rest) {
                addBubble('note', 'Continuation returned nothing \u2014 stopping.');
                break;
            }
            sp = { think: sp.think + (sp3.think ? '\n\n' + sp3.think : ''), rest: sp.rest + sp3.rest };
        }
        return sp;
    }

    function parseShortcuts() {
        const map = {};
        String(settings.shortcuts || '').split('\n').forEach(line => {
            const m = line.match(/^\s*(#\S+)\s*=\s*(.+)$/);
            if (m) map[m[1].toLowerCase()] = m[2].trim();
        });
        return map;
    }

    function expandShortcut(text) {
        const m = String(text).match(/^(#\S+)\s*([\s\S]*)$/);
        if (!m) return text;
        const prompt = parseShortcuts()[m[1].toLowerCase()];
        if (!prompt) return text;
        const rest = m[2].trim();
        return rest ? prompt + '\n\nAdditional instruction from the user: ' + rest : prompt;
    }

    // ------------------------------------------------------------------
    // Send flow (with <fetch> tool loop)
    // ------------------------------------------------------------------

    function historyForLLM(uptoIdx) {
        const depth = Math.max(2, Number(settings.historyDepth) || 12);
        const base = Number.isInteger(uptoIdx) ? meta().history.slice(0, uptoIdx) : meta().history;
        return base
            .slice(-depth)
            .map(h => h.role === 'note'
                ? { role: 'user', content: '[STATE] ' + h.content }
                : { role: h.role, content: h.content });
    }

    function requestStop() {
        if (!running) return;
        stopRequested = true;
        try { abortCtl?.abort(); } catch (e) { /* ignore */ }
        try { ctx().stopGeneration?.(); } catch (e) { /* ignore */ }
        toast('Stopping\u2026', 'info');
    }

    async function send(userText) {
        userText = String(userText || '').trim();
        if (!userText || running) return;
        const c = ctx();
        if (!Array.isArray(c.chat) || !c.chat.length) {
            toast('No chat is loaded.', 'warning');
            return;
        }
        const dm = userText.match(/^#d\s+([\s\S]+)$/i);
        if (dm) {
            addBubble('user', userText);
            pushHistory('note', '\uD83C\uDFAC Player direction given: ' + dm[1].trim().slice(0, 300));
            await directorEdit(dm[1].trim());
            return;
        }
        if (/^#d$/i.test(userText)) {
            toast('Usage: #d your direction \u2014 e.g. "#d make Silas corner Jovan at the duel field this episode"', 'info');
            return;
        }
        const expanded = expandShortcut(userText);
        pushHistory('user', expanded);
        addBubble('user', userText, meta().history.length - 1);
        if (expanded !== userText) addBubble('note', 'shortcut expanded');

        await runGeneration();
    }

    async function runGeneration(opts = {}) {
        if (running) return;
        running = true;
        setBusy(true);
        const sessAtStart = metaRoot().activeId;
        const busy = addBubble('busy', Number.isInteger(opts.swipeIdx)
            ? 'regenerating \u2014 new alternative (old answer kept as a swipe)\u2026'
            : 'thinking\u2026');
        const live = (acc, reasoning) => {
            const log = el('cc_log');
            const pinned = !log || (log.scrollHeight - log.scrollTop - log.clientHeight) < 60;
            const head = (settings.showThinking && reasoning) ? '[thinking]\n' + reasoning + '\n\n' : '';
            const shown = (head + acc).trim();
            if (shown) busy.className = 'cc_bubble cc_ai';
            busy.innerHTML = esc(shown.slice(-3500) || 'thinking…');
            if (log && pinned) log.scrollTop = log.scrollHeight;
        };
        try {
            const messages = [
                { role: 'system', content: sysPrompt() },
                { role: 'system', content: buildContextBlock() },
                ...historyForLLM(Number.isInteger(opts.swipeIdx) ? opts.swipeIdx : undefined),
            ];
            if (wiActive()) {
                try {
                    const wb = await wiBuildContext();
                    if (wb) messages.splice(2, 0, { role: 'system', content: wb });
                } catch (e) { console.warn(LOG, 'wi context failed', e); }
            }

            let reply = '';
            let think = '';
            const rounds = Math.max(0, Math.min(6, Number(settings.fetchRounds) || 0));
            const fetchedIds = new Set();
            for (let round = 0; round <= rounds; round++) {
                if (round > 0) busy.innerHTML = esc('thinking\u2026 (call ' + (round + 1) + ' of ' + (rounds + 1) + ')');
                const split = await callLLMSmart(messages, live);
                reply = split.rest;
                think = split.think;
                if (stopRequested) {
                    addBubble('note', 'Generation stopped \u2014 partial reply kept.');
                    pushHistory('note', 'Generation stopped \u2014 partial reply kept.');
                    break;
                }
                const wiRefs = wiActive() ? parseWiFetch(reply) : null;
                if (wiRefs && wiRefs.length && round < rounds) {
                    const note = '\uD83C\uDF10 Copilot read full Worldbook entries: ' + wiRefs.join(', ');
                    addBubble('note', note); pushHistory('note', note);
                    messages.push({ role: 'assistant', content: reply });
                    messages.push({ role: 'user', content: '[WORLDBOOK ENTRIES]\n' + await wiFullText(wiRefs) });
                    continue;
                }
                const ids = parseFetch(reply);
                if (!ids || round === rounds) break;
                const fresh = ids.filter(x => !fetchedIds.has(Number(x)));
                ids.forEach(x => fetchedIds.add(Number(x)));
                messages.push({ role: 'assistant', content: reply });
                if (fresh.length) {
                    const note = 'Copilot read full text of #' + fresh.join(', #') + ' (fetch ' + (round + 1) + '/' + rounds + ')' + (fresh.length < ids.length ? ' \u2014 skipped ' + (ids.length - fresh.length) + ' already-fetched' : '');
                    addBubble('note', note);
                    pushHistory('note', note);
                    let payload = '[FETCHED MESSAGES]\n' + fullTextOf(fresh);
                    if (round === rounds - 1) payload += '\n\n(This was your final fetch \u2014 produce your complete answer now; further fetch requests will not be served.)';
                    messages.push({ role: 'user', content: payload });
                } else {
                    const note = 'Copilot re-requested already-fetched messages \u2014 told it to answer now.';
                    addBubble('note', note);
                    pushHistory('note', note);
                    messages.push({ role: 'user', content: '[FETCHED MESSAGES]\n(All requested ids were already provided earlier in this conversation \u2014 re-read them above instead of re-fetching. If you need DIFFERENT messages, fetch those; otherwise produce your complete final answer.)' });
                }
            }
            const exhausted = parseFetch(reply);

            busy.remove();
            if (Number.isInteger(opts.swipeIdx)) {
                if (metaRoot().activeId !== sessAtStart) {
                    addBubble('note', 'Swipe result discarded \u2014 session changed during generation.');
                    return;
                }
                const entry = meta().history[opts.swipeIdx];
                if (entry && entry.role === 'assistant') {
                    ensureSwipes(entry);
                    entry.swipes.push({ content: reply, think: think || '' });
                    entry.swipeId = entry.swipes.length - 1;
                    entry.content = reply;
                    entry.think = think || '';
                    saveMeta();
                }
            } else {
                pushHistory('assistant', reply, think);
            }
            renderHistory();

            if (exhausted) {
                const warn = '\u26A0 Ran out of fetch rounds while the copilot was still requesting messages \u2014 the answer may be incomplete. Raise "Fetch rounds" in settings, or narrow the request (e.g. one snippet/layer at a time).';
                addBubble('note', warn);
                pushHistory('note', warn);
            }
            if (!reply && think && !stopRequested) {
                const twarn2 = '\u26A0 The model spent its entire output budget on thinking and produced no answer, even after automatic recoveries. Raise "Max output tokens" in settings, lower the reasoning effort in this Connection Profile\'s preset, or narrow the request. The thinking is preserved above so the tokens were not wasted.';
                addBubble('note', twarn2);
                pushHistory('note', twarn2);
            }
            if (looksTruncated(reply, 'edits') || looksTruncated(reply, 'memedits')) {
                const twarn = '\u26A0 The reply looks cut off mid-edit block (response budget too small). Raise "Max output tokens" toward your provider\'s output limit, or tell the copilot to split the change into several smaller edits.';
                addBubble('note', twarn);
                pushHistory('note', twarn);
            }

            const parsed = parseEdits(reply);
            const parsedMem = parseMemEdits(reply);
            if (parsed.error) addBubble('note', 'Edit block error: ' + parsed.error + ' — ask the copilot to resend valid JSON.');
            if (parsedMem.error) addBubble('note', 'Memory edit block error: ' + parsedMem.error + ' — ask the copilot to resend valid JSON.');
            const parsedWi = wiActive() ? parseWiEdits(reply) : { edits: [] };
            if (parsedWi.error) addBubble('note', 'Worldbook edit block error: ' + parsedWi.error + ' \u2014 ask the copilot to resend valid JSON.');
            const allEdits = [...parsed.edits, ...parsedMem.edits, ...parsedWi.edits];
            if (allEdits.length) {
                editsCollapsed = false;
                stampReviewState(allEdits);
                const batchNo = (pendingEdits.reduce((mx, e) => Math.max(mx, e.batch || 0), 0)) + 1;
                allEdits.forEach(e => { e.batch = batchNo; });
                if (pendingEdits.length) {
                    pendingEdits = pendingEdits.concat(allEdits);
                    addBubble('note', '\u2795 ' + allEdits.length + ' new proposal(s) added below your ' + (pendingEdits.length - allEdits.length) + ' still-pending one(s). Review all together, or Dismiss to clear.');
                } else {
                    pendingEdits = allEdits;
                }
                renderEditCards();
            }
        } catch (err) {
            busy.remove();
            console.error(LOG, err);
            addBubble('note', 'Error: ' + (err?.message || err));
            toast(String(err?.message || err), 'error');
        } finally {
            running = false;
            setBusy(false);
        }
    }

    function ensureSwipes(entry) {
        if (!Array.isArray(entry.swipes) || !entry.swipes.length) {
            entry.swipes = [{ content: entry.content, think: entry.think || '' }];
            entry.swipeId = 0;
        }
        if (!Number.isInteger(entry.swipeId) || entry.swipeId < 0 || entry.swipeId >= entry.swipes.length) {
            entry.swipeId = entry.swipes.length - 1;
        }
    }

    async function swipeAssistant(idx, dir) {
        if (running) return;
        const h = meta().history;
        const entry = h[idx];
        if (!entry || entry.role !== 'assistant' || idx !== h.length - 1) return;
        ensureSwipes(entry);
        const target = entry.swipeId + dir;
        if (target < 0) return;
        if (target < entry.swipes.length) {
            entry.swipeId = target;
            entry.content = entry.swipes[target].content;
            entry.think = entry.swipes[target].think || '';
            saveMeta();
            renderHistory();
            const pe = parseEdits(entry.content);
            const pm = parseMemEdits(entry.content);
            editsCollapsed = false;
            const swiped = [...pe.edits, ...pm.edits];
            stampReviewState(swiped);
            swiped.forEach(e => { e.batch = 1; });
            pendingEdits = swiped;
            renderEditCards();
            return;
        }
        await runGeneration({ swipeIdx: idx });
    }

    async function retryLast() {
        if (running) return;
        const h = meta().history;
        let i = h.length - 1;
        while (i >= 0 && h[i].role !== 'assistant') i--;
        if (i < 0) { toast('Nothing to retry yet.', 'warning'); return; }
        if (i === h.length - 1) { await swipeAssistant(i, +1); return; }
        h.splice(i);
        saveMeta();
        pendingEdits = [];
        renderHistory();
        renderEditCards();
        await runGeneration();
    }

    async function deleteLastExchange() {
        if (running) return;
        const h = meta().history;
        let i = h.length - 1;
        while (i >= 0 && h[i].role !== 'user') i--;
        if (i < 0) { toast('Nothing to delete.', 'warning'); return; }
        h.splice(i);
        saveMeta();
        pendingEdits = [];
        renderHistory();
        renderEditCards();
    }

    function startEditUserMessage(idx) {
        if (running) return;
        const h = meta().history;
        if (!h[idx] || h[idx].role !== 'user') return;
        if (idx < h.length - 1 && !confirm('Edit this message? Everything after it in this session will be removed.')) return;
        const text = h[idx].content;
        h.splice(idx);
        saveMeta();
        pendingEdits = [];
        renderHistory();
        renderEditCards();
        const input = el('cc_input');
        if (input) { input.value = text; input.focus(); }
        addBubble('note', 'Editing \u2014 press Send to continue from here.');
    }

    function deleteMessageAt(idx) {
        if (running) return;
        const h = meta().history;
        if (!h[idx]) return;
        if (!confirm('Delete this message from the copilot conversation?')) return;
        h.splice(idx, 1);
        saveMeta();
        renderHistory();
    }

    // ------------------------------------------------------------------
    // Director: secret episode directive injected into the storyteller
    // ------------------------------------------------------------------

    const DIRECTOR_KEY = 'cc_director';

    function applyDirectorInjection() {
        const c = ctx();
        const d = metaRoot().director;
        const depth = Number(settings?.directorDepth) || 4;
        const role = c.extension_prompt_roles?.SYSTEM ?? 0;
        try {
            const value = (d && d.text)
                ? "[Director's Note \u2014 secret from the player. Use it to give NPCs initiative and shape the episode, while always adapting to the player's choices instead of forcing outcomes. When the LANDING state is fully reached and the episode is complete, append the exact marker [EPISODE_END] at the very end of your reply.]\n" + d.text
                : '';
            c.setExtensionPrompt(DIRECTOR_KEY, value, 1, depth, false, role);
        } catch (e) { console.warn(LOG, 'director injection failed', e); }
    }

    function applyCritiqueInjection() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata || {};
        const text = typeof md.cc_critique === 'string' ? md.cc_critique.trim() : '';
        const depth = Number(settings?.critiqueDepth) || 8;
        const role = c.extension_prompt_roles?.SYSTEM ?? 0;
        try {
            const value = text
                ? "[Editor's Standing Notes \u2014 craft corrections the storyteller must keep applying:]\n" + text
                : '';
            c.setExtensionPrompt('cc_critique_inject', value, 1, depth, false, role);
        } catch (e) { console.warn(LOG, 'critique injection failed', e); }
    }

    function applyInjections() {
        applyDirectorInjection();
        applyCritiqueInjection();
        applyLedgerInjection();
    }

    function critiqueItems(t) {
        return String(t || '').split('\n')
            .map(l => l.trim())
            .filter(l => /^\d+[\.\)]\s/.test(l))
            .map(l => l.replace(/^\d+[\.\)]\s*/, ''));
    }

    function itemSim(a, b) {
        const wa = a.toLowerCase().split(/\s+/).filter(Boolean);
        const wb = b.toLowerCase().split(/\s+/).filter(Boolean);
        if (!wa.length || !wb.length) return 0;
        const dist = levenshtein(wa, wb);
        return 1 - dist / Math.max(wa.length, wb.length);
    }

    function critiqueDiff(oldText, newText) {
        const oldItems = critiqueItems(oldText);
        const newItems = critiqueItems(newText);
        if (!oldItems.length) return newItems.length + ' item(s).';
        const removed = [];
        let kept = 0;
        for (const o of oldItems) {
            let best = 0;
            for (const n of newItems) best = Math.max(best, itemSim(o, n));
            if (best >= 0.55) kept++;
            else removed.push(o);
        }
        const added = Math.max(0, newItems.length - kept);
        let out = '+' + added + ' new, ' + kept + ' kept, \u2212' + removed.length + ' removed.';
        if (removed.length) {
            out += ' Removed: ' + removed.map(r => '\u201C' + r.slice(0, 80) + (r.length > 80 ? '\u2026' : '') + '\u201D').join(' | ');
        }
        return out;
    }

    async function generateCritique(isAuto) {
        if (running) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', isAuto ? 'auto-editor reviewing the story\u2026' : 'the editor is reviewing\u2026');
        try {
            const c = ctx();
            const md = c.chatMetadata || c.chat_metadata || {};
            const cur = typeof md.cc_critique === 'string' ? md.cc_critique : '';
            const sys = [
                'You are a ruthless story editor reviewing a long-form roleplay. Produce STANDING NOTES for the storyteller AI: concrete, reusable craft corrections that fix systemic weaknesses.',
                'Analyze for: claustrophobia (everything orbiting the MC), dropped characters or props (people who vanish mid-scene), missing ambient world life (background events, crowds, random encounters, off-screen agendas), repeated mistakes, contradictions with the world\'s own rules, and stale pacing.',
                'Also mine any OOC/meta exchanges in the chat (corrections in (( )), [brackets], or marked OOC) for lessons the storyteller was already told.',
                'Discipline: only add a correction you can tie to concrete evidence in the context. If the story has not meaningfully changed since [CURRENT NOTES], or no genuine new weakness exists, return the current notes unchanged apart from removing items the storyteller has demonstrably fixed. NEVER invent problems to fill space \u2014 an unchanged or shorter list is a good answer.',
                'Standing notes are for SYSTEMIC patterns only; do not add a note for a one-off slip that a single chat edit could fix.',
                'Write numbered standing corrections \u2014 as many as the story genuinely needs, no maximum. Each must be actionable and general enough to keep applying (e.g. "Track every named character present in a scene until they visibly exit"). Carry forward still-relevant items from [CURRENT NOTES] if provided. Optimize for perfection, immersion, engagement, and realism \u2014 while staying token-efficient: no padding, no repetition, no filler; every line must earn its place. Output ONLY the notes.',
            ].join('\n');
            const user = buildContextBlock() + (cur ? '\n\n[CURRENT NOTES]\n' + cur : '') + '\n\nWrite the standing notes now.';
            const sp = await callLLMSmart([
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ]);
            if (stopRequested) { addBubble('note', 'Stopped \u2014 critique unchanged.'); return; }
            const text = sp.rest.trim();
            if (!text) throw new Error(sp.think ? 'answer consumed by thinking \u2014 raise Max output tokens or lower reasoning effort' : 'empty critique');
            md.cc_critique = text;
            undoStack.push({ label: 'critique update', items: [{ kind: 'mem', key: 'cc_critique', before: cur }] });
            saveMeta();
            applyCritiqueInjection();
            const note = (isAuto ? '\uD83D\uDCDD Auto-critique: ' : '\uD83D\uDCDD Critique updated: ') + critiqueDiff(cur, text) + ' (Undo restores the previous version; \uD83D\uDCDD Peek to view or edit.)';
            addBubble('note', note);
            pushHistory('note', note);
        } catch (err) {
            addBubble('note', 'Critique error: ' + (err?.message || err));
        } finally {
            busyNote.remove();
            running = false;
            setBusy(false);
        }
    }

    function peekCritique() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata || {};
        const cur = typeof md.cc_critique === 'string' ? md.cc_critique : '';
        showViewer('\uD83D\uDCDD Editor critique (edit + Save; save empty to delete)', cur, (t) => {
            const md2 = ctx().chatMetadata || ctx().chat_metadata;
            if (!md2) return;
            const txt = String(t || '').trim();
            md2.cc_critique = txt;
            saveMeta();
            applyCritiqueInjection();
            const note = txt ? '\uD83D\uDCDD Critique manually edited.' : '\uD83D\uDCDD Critique deleted.';
            addBubble('note', note);
            pushHistory('note', note);
        });
    }

    function directorAuthorPrompt(mode) {
        const intensity = settings.directorIntensity || 'standard';
        const anchors = String(settings.directorAnchors || '').trim();
        let base = String(settings.directorPrompt || DEFAULT_DIRECTOR_PROMPT).replace('INTENSITY_LEVEL', intensity);
        const extra = [];
        if (anchors) {
            extra.push('Pacing reference (RHYTHM and episode structure ONLY \u2014 never import their characters, names, plots, or lines): ' + anchors);
        }
        if (mode === 'next') {
            extra.push('A previous episode directive is provided; treat it as concluded and write the NEXT episode, carrying its consequences forward. Vary the pressure mix compared to the previous episode.');
        }
        if (mode === 'edit') {
            extra.push('The CURRENT directive and the player\'s direction instruction are provided. Rewrite the directive to incorporate the player\'s direction while preserving whatever still works. Keep the same episode. If no current directive is provided, write a fresh one built around the player\'s direction.');
        }
        return base + (extra.length ? '\n' + extra.join('\n') : '');
    }

    async function generateDirective(mode, isAuto) {
        if (running) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', mode === 'next' ? 'directing the next episode\u2026' : 'directing\u2026');
        try {
            const prev = metaRoot().director;
            const user = buildContextBlock().replace(/\[EPISODE_END\]/g, '')
                + (mode === 'next' && prev?.text ? '\n\n[PREVIOUS EPISODE DIRECTIVE \u2014 concluded]\n' + prev.text : '')
                + '\n\nWrite the director\'s note now.';
            const sp = await callLLMSmart([
                { role: 'system', content: directorAuthorPrompt(mode) },
                { role: 'user', content: user },
            ]);
            if (stopRequested) { addBubble('note', 'Stopped \u2014 directive unchanged.'); return; }
            const text = sp.rest.trim();
            if (!text) throw new Error(sp.think ? 'answer consumed by thinking \u2014 raise Max output tokens or lower reasoning effort' : 'empty directive');
            const ep = mode === 'next'
                ? (Math.max(Number(prev?.episode) || 0, Number(metaRoot().directorEp) || 0) + 1)
                : (Number(prev?.episode) || 1);
            metaRoot().director = { text, episode: ep, ts: Date.now() };
            metaRoot().directorEp = Math.max(Number(metaRoot().directorEp) || 0, ep);
            saveMeta();
            applyInjections();
            const note = (isAuto ? '\uD83C\uDFAC Auto \u2014 directive set (episode ' : '\uD83C\uDFAC Directive set (episode ') + ep + '). Content hidden \u2014 just keep playing.';
            addBubble('note', note);
            pushHistory('note', note);
            updateSub();
        } catch (err) {
            addBubble('note', 'Director error: ' + (err?.message || err));
        } finally {
            busyNote.remove();
            running = false;
            setBusy(false);
        }
    }

    function clearDirective() {
        if (!metaRoot().director) { toast('No directive active.', 'warning'); return; }
        if (!confirm('Remove the secret directive?')) return;
        metaRoot().director = null;
        saveMeta();
        applyInjections();
        const note = '\uD83C\uDFAC Directive cleared.';
        addBubble('note', note);
        pushHistory('note', note);
        updateSub();
    }

    async function directorEdit(instruction) {
        if (running) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', 'revising the directive\u2026');
        try {
            const prev = metaRoot().director;
            const user = buildContextBlock().replace(/\[EPISODE_END\]/g, '')
                + (prev?.text ? '\n\n[CURRENT DIRECTIVE]\n' + prev.text : '')
                + '\n\n[PLAYER\'S DIRECTION INSTRUCTION]\n' + instruction
                + '\n\nWrite the revised director\'s note now. Output ONLY the note text.';
            const sp = await callLLMSmart([
                { role: 'system', content: directorAuthorPrompt('edit') },
                { role: 'user', content: user },
            ]);
            if (stopRequested) { addBubble('note', 'Stopped \u2014 directive unchanged.'); return; }
            const text = sp.rest.trim();
            if (!text) throw new Error(sp.think ? 'answer consumed by thinking \u2014 raise Max output tokens or lower reasoning effort' : 'empty directive');
            const ep = prev?.episode || 1;
            metaRoot().director = { text, episode: ep, ts: Date.now() };
            metaRoot().directorEp = Math.max(Number(metaRoot().directorEp) || 0, ep);
            saveMeta();
            applyInjections();
            const note = '\uD83C\uDFAC Directive revised around your direction (episode ' + ep + '). Beats stay hidden \u2014 \uD83C\uDFAC Peek to view.';
            addBubble('note', note);
            pushHistory('note', note);
            updateSub();
        } catch (err) {
            addBubble('note', 'Director edit error: ' + (err?.message || err));
        } finally {
            busyNote.remove();
            running = false;
            setBusy(false);
        }
    }

    async function directorStatus() {
        const d = metaRoot().director;
        if (!d) { toast('No directive active.', 'warning'); return; }
        if (d.concluded) {
            addBubble('note', '\uD83C\uDFAC Episode ' + d.episode + ' already concluded \u2014 press \uD83C\uDFAC Next when ready.');
            return;
        }
        if (running) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', 'checking episode progress\u2026');
        try {
            const sys = 'You are checking secret episode progress for a roleplay director. You receive the SECRET DIRECTIVE and the story context. Judge whether the episode\'s LANDING has been reached based only on actual narrated story events; ignore any literal [EPISODE_END] marker text. Reply with EXACTLY one line, spoiler-free, in one of these formats: "ONGOING \u2014 <short vague progress hint, no spoilers>" or "CONCLUDED \u2014 <short line>" or "DERAILED \u2014 <short line>". Never quote or reveal the directive contents.';
            const user = buildContextBlock().replace(/\[EPISODE_END\]/g, '') + '\n\n[SECRET DIRECTIVE]\n' + d.text + '\n\nJudge the progress now.';
            const sp = await callLLMSmart([
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ]);
            if (stopRequested) { addBubble('note', 'Stopped.'); return; }
            const line = (sp.rest.trim().split('\n')[0] || (sp.think ? 'UNKNOWN \u2014 answer consumed by thinking; raise Max output tokens' : '')).slice(0, 200);
            addBubble('note', '\uD83C\uDFAC ' + line);
            pushHistory('note', '\uD83C\uDFAC ' + line);
            if (/^CONCLUDED/i.test(line)) {
                metaRoot().director.concluded = true;
                saveMeta();
                updateSub();
            }
        } catch (err) {
            addBubble('note', 'Director status error: ' + (err?.message || err));
        } finally {
            busyNote.remove();
            running = false;
            setBusy(false);
        }
    }

    function peekDirective() {
        const d = metaRoot().director;
        if (!d) { toast('No directive active.', 'warning'); return; }
        if (!confirm('Reveal the secret directive for episode ' + d.episode + '? This spoils the surprise.')) return;
        showViewer('\uD83C\uDFAC Episode ' + d.episode + ' directive (edit + Save)', d.text, (t) => {
            t = String(t || '').trim();
            const dd = metaRoot().director;
            if (!dd) return;
            if (!t) { toast('Directive left unchanged (empty text).', 'warning'); return; }
            dd.text = t;
            dd.ts = Date.now();
            saveMeta();
            applyInjections();
            const note = '\uD83C\uDFAC Directive manually edited.';
            addBubble('note', note);
            pushHistory('note', note);
        });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    function el(id) { return document.getElementById(id); }

    async function copyText(t) {
        try { await navigator.clipboard.writeText(t); return true; } catch (e) { /* insecure origin etc. */ }
        try {
            const ta = document.createElement('textarea');
            ta.value = t;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }

    function showViewer(title, text, onSave) {
        let backdrop = el('cc_viewer');
        let box = el('cc_viewer_win');
        if (!box) {
            backdrop = document.createElement('div');
            backdrop.id = 'cc_viewer';
            backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9998;display:none;background:rgba(0,0,0,0.5);';
            document.body.appendChild(backdrop);

            box = document.createElement('div');
            box.id = 'cc_viewer_win';
            box.style.cssText = 'position:fixed;z-index:9999;display:none;flex-direction:column;border-radius:10px;border:1px solid rgba(255,255,255,0.3);background:#1e1e1e;color:#dddddd;box-shadow:0 8px 30px rgba(0,0,0,0.6);overflow:hidden;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.2);flex:0 0 auto;cursor:move;user-select:none;touch-action:none;background:rgba(255,255,255,0.05);';

            const titleEl = document.createElement('span');
            titleEl.id = 'cc_viewer_title';
            titleEl.style.cssText = 'flex:1 1 auto;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const btnStyle = 'cursor:pointer;border:1px solid rgba(255,255,255,0.35);background:rgba(255,255,255,0.10);color:inherit;border-radius:6px;padding:8px 16px;font-size:0.95em;flex:0 0 auto;';
            const copyBtn = document.createElement('button');
            copyBtn.textContent = 'Copy';
            copyBtn.className = 'cc_hbtn';
            copyBtn.style.cssText = btnStyle;
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'cc_hbtn';
            closeBtn.style.cssText = btnStyle + 'background:rgba(220,90,90,0.3);';

            const pre = document.createElement('pre');
            pre.id = 'cc_viewer_pre';
            pre.style.cssText = 'flex:1 1 auto;overflow:auto;margin:0;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:0.85em;';

            const ta = document.createElement('textarea');
            ta.id = 'cc_viewer_ta';
            ta.style.cssText = 'flex:1 1 auto;display:none;margin:0;padding:10px;background:rgba(0,0,0,0.25);color:inherit;border:none;outline:none;resize:none;font-size:0.9em;font-family:monospace;';

            const saveBtn = document.createElement('button');
            saveBtn.id = 'cc_viewer_save';
            saveBtn.textContent = 'Save';
            saveBtn.className = 'cc_hbtn';
            saveBtn.style.cssText = btnStyle + 'background:rgba(80,200,120,0.3);display:none;';

            head.appendChild(titleEl);
            head.appendChild(saveBtn);
            head.appendChild(copyBtn);
            head.appendChild(closeBtn);
            box.appendChild(head);
            box.appendChild(pre);
            box.appendChild(ta);
            document.body.appendChild(box);

            const hide = () => { backdrop.style.display = 'none'; box.style.display = 'none'; };
            closeBtn.addEventListener('click', hide);
            backdrop.addEventListener('click', hide);
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && box.style.display !== 'none') hide();
            });
            copyBtn.addEventListener('click', async () => {
                const src = (ta.style.display !== 'none') ? ta.value : pre.textContent;
                const ok = await copyText(src);
                toast(ok ? 'Copied to clipboard.' : 'Copy failed — select the text manually.', ok ? 'success' : 'error');
            });

            saveBtn.addEventListener('click', () => {
                const cb = box._onSave;
                backdrop.style.display = 'none';
                box.style.display = 'none';
                if (typeof cb === 'function') cb(ta.value);
            });

            // Same drag mechanism as the main panel.
            makeDraggable(box, head);
        }

        // Snap to a safe on-screen spot and size every time it opens.
        box.style.left = '3vw';
        box.style.top = '90px';
        box.style.right = 'auto';
        box.style.bottom = 'auto';
        box.style.width = '94vw';
        box.style.height = '62vh';

        el('cc_viewer_title').textContent = title + ' \u2014 v' + VERSION;
        const taEl = el('cc_viewer_ta');
        const preEl = el('cc_viewer_pre');
        const saveEl = el('cc_viewer_save');
        box._onSave = (typeof onSave === 'function') ? onSave : null;
        if (box._onSave) {
            taEl.value = text;
            taEl.style.display = '';
            preEl.style.display = 'none';
            saveEl.style.display = '';
        } else {
            preEl.textContent = 'Continuity Copilot v' + VERSION + ' \u2014 drag me by this top bar. Close: the Close button, tapping the dark area, or Esc.\n\n' + text;
            taEl.style.display = 'none';
            preEl.style.display = '';
            saveEl.style.display = 'none';
        }
        backdrop.style.display = 'block';
        box.style.display = 'flex';
    }

    function memoryReport() {
        const c = ctx();
        let re;
        try { re = new RegExp(settings.memoryKeyPattern, 'i'); }
        catch (e) { re = /summar|ception|memory/i; }
        const matched = [];
        const ignored = [];
        const dupes = [];
        const mdMatched = new Set();
        try {
            const md0 = c.chatMetadata || c.chat_metadata || {};
            for (const key of Object.keys(md0)) {
                if (key !== MODULE && re.test(key)) mdMatched.add(key.toLowerCase());
            }
        } catch (e) { /* ignore */ }
        try {
            for (const [key, p] of Object.entries(c.extensionPrompts || {})) {
                const val = p && typeof p.value === 'string' ? p.value.trim() : '';
                if (!val || key === '2_floating_prompt') continue;
                if (re.test(key)) {
                    if (mdMatched.has(key.toLowerCase())) dupes.push('injection: ' + key + '  (' + val.length + ' chars)');
                    else matched.push('injection: ' + key + '  (' + val.length + ' chars)');
                } else {
                    ignored.push('injection: ' + key + '  (' + val.length + ' chars)');
                }
            }
        } catch (e) { /* ignore */ }
        try {
            const md = c.chatMetadata || c.chat_metadata || {};
            const anKeys = ['note_prompt', 'note_interval', 'note_position', 'note_depth'];
            for (const [key, v] of Object.entries(md)) {
                if (key === MODULE || anKeys.includes(key) || key === 'cc_critique') continue;
                let text = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch (e2) { return ''; } })();
                text = String(text || '').trim();
                if (!text || text === '{}' || text === '[]') continue;
                if (re.test(key)) {
                    matched.push('metadata: ' + key + '  (' + text.length + ' chars) \u2014 editable source');
                } else {
                    ignored.push('metadata: ' + key + '  (' + text.length + ' chars)');
                }
            }
        } catch (e) { /* ignore */ }

        const lines = [];
        lines.push('MATCHED SOURCES (included in story memory):');
        lines.push(matched.length ? matched.map(s => '  - ' + s).join('\n') : '  (none)');
        if (settings.includeAuthorsNote) lines.push("  - Author's Note (included when set)");
        try {
            const mdC = c.chatMetadata || c.chat_metadata || {};
            if (typeof mdC.cc_critique === 'string' && mdC.cc_critique.trim()) lines.push('  - Editor notes (cc_critique \u2014 included)');
        } catch (e) { /* ignore */ }
        if (dupes.length) {
            lines.push('');
            lines.push('SKIPPED (injection duplicating the editable metadata source, saves tokens):');
            lines.push(dupes.map(s2 => '  - ' + s2).join('\n'));
        }
        lines.push('');
        lines.push('VISIBLE BUT NOT MATCHED — to include one, copy a word from its name');
        lines.push('into the "Memory source words" box (words separated by |):');
        lines.push(ignored.length ? ignored.map(s => '  - ' + s).join('\n') : '  (none)');
        lines.push('');
        lines.push('================ FULL STORY MEMORY TEXT ================');
        lines.push(gatherMemory());
        return lines.join('\n');
    }

    function buildPanel() {
        if (el('cc_panel')) return;
        const panel = document.createElement('div');
        panel.id = 'cc_panel';
        panel.innerHTML = [
            '<div id="cc_header">',
            '  <span class="cc_title">Continuity Copilot</span>',
            '  <span class="cc_sub" id="cc_sub"></span>',
            '  <span class="cc_hbtn" id="cc_gear" title="Settings"><i class="fa-solid fa-gear"></i></span>',
            '  <span class="cc_hbtn" id="cc_close" title="Close"><i class="fa-solid fa-xmark"></i></span>',
            '</div>',
            '<div id="cc_sessbar" style="display:flex;gap:6px;padding:6px 10px;align-items:center;flex-wrap:wrap;flex:0 0 auto;border-bottom:1px solid rgba(255,255,255,0.15);">',
            '  <select id="cc_sess" style="flex:1 1 auto;min-width:0;background:rgba(0,0,0,0.25);color:inherit;border:1px solid rgba(255,255,255,0.25);border-radius:5px;padding:4px 6px;font-size:0.85em;"></select>',
            '  <button class="cc_btn" id="cc_sessnew" title="New session (fresh context for a new problem)">+ New</button>',
            '  <button class="cc_btn" id="cc_sessbr" title="Branch: copy this session into a new one">Branch</button>',
            '  <button class="cc_btn" id="cc_sessren" title="Rename this session">Ren</button>',
            '  <button class="cc_btn" id="cc_sessdel" title="Delete this session">Del</button>',
            '</div>',
            '<div id="cc_settings"></div>',
            '<div id="cc_log"></div>',
            '<div id="cc_edits"></div>',
            '<div id="cc_composer">',
            '  <div id="cc_quick">',
            '    <div style="display:flex;gap:6px;flex-wrap:wrap;">',
            '      <button class="cc_btn" id="cc_audit" title="Full continuity audit">\uD83D\uDD0D Audit</button>',
            '      <button class="cc_btn" id="cc_dirnew" title="Set or replace the secret episode directive">\uD83C\uDFAC New</button>',
            '      <button class="cc_btn" id="cc_dirnext" title="Conclude this episode and direct the next">\uD83C\uDFAC Next</button>',
            '      <button class="cc_btn" id="cc_dirstat" title="Spoiler-free episode progress check">\uD83C\uDFAC ?</button>',
            '      <button class="cc_btn" id="cc_critique" title="Editor pass: update standing craft notes">\uD83D\uDCDD Critique</button>',
            '    </div>',
            '    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px;align-items:center;">',
            '      <button class="cc_btn" id="cc_retry" title="Regenerate the last copilot reply">\u21BB Retry</button>',
            '      <button class="cc_btn" id="cc_dellast" title="Delete the last question + answer">\u232B Del last</button>',
            '      <button class="cc_btn" id="cc_undo" title="Undo last applied batch">\u21B6 Undo</button>',
            '      <div id="cc_more_wrap" style="position:relative;display:inline-block;">',
            '        <button class="cc_btn" id="cc_more" title="More tools">\u22EE More</button>',
            '        <div id="cc_more_menu" style="display:none;position:absolute;bottom:110%;right:0;background:#1e1e1e;border:1px solid rgba(255,255,255,0.3);border-radius:8px;padding:6px;z-index:60;min-width:170px;box-shadow:0 6px 18px rgba(0,0,0,0.55);">',
            '          <button class="cc_btn" id="cc_dirpeek" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Reveal the directive (spoiler!)">\uD83C\uDFAC Peek directive</button>',
            '          <button class="cc_btn" id="cc_diroff" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Remove the directive">\uD83C\uDFAC Director off</button>',
            '          <button class="cc_btn" id="cc_critpeek" style="display:block;width:100%;margin:3px 0;text-align:left;" title="View or hand-edit the critique">\uD83D\uDCDD Peek critique</button>',
            '          <button class="cc_btn" id="cc_memcheck" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Show detected memory sources">\uD83E\uDDE0 Memory?</button>',
            '          <button class="cc_btn" id="cc_context" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Show the full context the copilot receives">\uD83D\uDCE6 Context</button>',
            '          <button class="cc_btn" id="cc_ledger_now" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Run a character-ledger update pass now">\uD83E\uDDEC Ledger: update</button>',
            '          <button class="cc_btn" id="cc_ledger_peek" style="display:block;width:100%;margin:3px 0;text-align:left;" title="View or hand-edit the ledger JSON">\uD83E\uDDEC Ledger: peek/edit</button>',
            '          <button class="cc_btn" id="cc_ledger_restore" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Restore the most recent ledger backup">\uD83E\uDDEC Ledger: restore</button>',
            '          <button class="cc_btn" id="cc_wi_detect" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Inspect ST and report where your Worldbooks live">\uD83C\uDF10 Worldbook: detect</button>',
            '          <button class="cc_btn" id="cc_clear" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Clear copilot conversation">\uD83E\uDDF9 Clear session</button>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </div>',
            '  <div id="cc_inputrow">',
            '    <textarea id="cc_input" placeholder="e.g. wait, why is Jillian on the train? she is at the academy — fix it"></textarea>',
            '    <button class="cc_btn cc_primary" id="cc_send">Send</button>',
            '  </div>',
            '</div>',
        ].join('\n');
        document.body.appendChild(panel);

        buildSettingsUI();
        makeDraggable(panel, el('cc_header'));

        el('cc_close').addEventListener('click', () => togglePanel(false));
        el('cc_gear').addEventListener('click', () => {
            el('cc_settings').classList.toggle('cc_open');
            refreshProfileSelect();
        });
        el('cc_send').addEventListener('click', () => {
            if (running) { requestStop(); return; }
            const t = el('cc_input').value;
            el('cc_input').value = '';
            send(t);
        });
        el('cc_input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!running) el('cc_send').click();
            }
        });
        el('cc_audit').addEventListener('click', () => send(AUDIT_PROMPT));
        el('cc_retry').addEventListener('click', () => retryLast());
        el('cc_dellast').addEventListener('click', () => deleteLastExchange());
        el('cc_dirnew').addEventListener('click', () => generateDirective('new'));
        el('cc_dirnext').addEventListener('click', () => generateDirective('next'));
        el('cc_diroff').addEventListener('click', () => clearDirective());
        el('cc_dirstat').addEventListener('click', () => directorStatus());
        el('cc_dirpeek').addEventListener('click', () => peekDirective());
        el('cc_critique').addEventListener('click', () => generateCritique());
        el('cc_critpeek').addEventListener('click', () => peekCritique());
        el('cc_ledger_now').addEventListener('click', () => runLedgerUpdate(false));
        el('cc_ledger_peek').addEventListener('click', () => ledgerPeek());
        el('cc_ledger_restore').addEventListener('click', () => ledgerRestore());
        el('cc_wi_detect').addEventListener('click', () => wiDetectReport());
        el('cc_more').addEventListener('click', () => {
            const mm = el('cc_more_menu');
            if (mm) mm.style.display = mm.style.display === 'none' ? 'block' : 'none';
        });
        el('cc_more_menu').addEventListener('click', () => {
            setTimeout(() => { const mm = el('cc_more_menu'); if (mm) mm.style.display = 'none'; }, 60);
        });
        el('cc_sess').addEventListener('change', () => switchSession(el('cc_sess').value));
        el('cc_sessnew').addEventListener('click', () => newSession());
        el('cc_sessbr').addEventListener('click', () => branchSession());
        el('cc_sessren').addEventListener('click', () => renameSession());
        el('cc_sessdel').addEventListener('click', () => deleteSession());
        el('cc_undo').addEventListener('click', () => undoLast());
        el('cc_clear').addEventListener('click', () => {
            if (!confirm('Clear the copilot conversation for this chat?')) return;
            meta().history = [];
            saveMeta();
            pendingEdits = [];
            renderHistory();
            renderEditCards();
        });
        el('cc_memcheck').addEventListener('click', () => {
            showViewer('Story memory — what the copilot sees', memoryReport());
        });
        el('cc_context').addEventListener('click', () => {
            const t = buildContextBlock();
            const head = 'Total: ' + t.length + ' chars ≈ ' + Math.round(t.length / 3.6) + ' tokens\n' +
                '(system prompt + your conversation are added on top)\n\n';
            showViewer('Full context sent to the copilot', head + t);
        });
    }

    function buildSettingsUI() {
        const box = el('cc_settings');
        box.innerHTML = [
            '<div style="margin:2px 0;font-weight:600;opacity:0.75;">Connection & generation</div>',
            '<label>LLM route (Connection Profile)</label>',
            '<select id="cc_profile"></select>',
            '<div class="cc_row">',
            '  <div><label>Recent msgs sent in full</label><input type="number" id="cc_recent" min="0" max="100"></div>',
            '  <div><label>Fetch rounds</label><input type="number" id="cc_rounds" min="0" max="6"></div>',
            '  <div><label>Max output tokens</label><input type="number" id="cc_maxtok" min="256" max="32768" step="256"></div>',
            '</div>',
            '<div style="font-size:0.78em;opacity:0.65;margin-top:2px;">Max output = your provider\'s response limit (GLM providers: usually 8k\u201316k). Asking for more than the provider allows rejects the whole request \u2014 bigger is not better.</div>',
            '<label>Auto-recovery retries (answer eaten by thinking / cut mid-block; 0 = off; stops on its own when a round adds nothing; Stop button always works)</label>',
            '<input type="number" id="cc_think_retries" min="0" max="99">',
            '<label>Memory source words (any source whose name contains one of these is included; separate with |)</label>',
            '<input type="text" id="cc_pattern">',
            '<div class="cc_check"><input type="checkbox" id="cc_stream"><span>Streaming (needs a Connection Profile)</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_showthink"><span>Show thinking blocks</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_userok"><span>Allow editing my (user) messages</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_hidden"><span>Full text previews for hidden/ghosted in index (token heavy; off = one-line stubs)</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_rehide"><span>Auto re-hide pilot-hidden messages when a chat/branch loads</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_an"><span>Include Author\'s Note in story memory</span></div>',
            '<div style="margin:10px 0 2px;font-weight:600;opacity:0.75;">Director & Editor</div>',
            '<div class="cc_row">',
            '  <div><label>Director intensity</label><select id="cc_dir_int"><option value="slow-burn">slow-burn</option><option value="standard">standard</option><option value="intense">intense</option></select></div>',
            '  <div><label>Director depth</label><input type="number" id="cc_dir_depth" min="0" max="20"></div>',
            '  <div><label>Critique depth</label><input type="number" id="cc_crit_depth" min="0" max="30"></div>',
            '</div>',
            '<label>Director style anchors (optional pacing references)</label>',
            '<input type="text" id="cc_dir_anchors" placeholder="e.g. Classroom of the Elite, Kaguya-sama">',
            '<label>Auto-critique: run the editor every N storyteller replies (0 = off; needs a Connection Profile)</label>',
            '<input type="number" id="cc_crit_auto" min="0" max="100">',
            '<div class="cc_check"><input type="checkbox" id="cc_dir_auto"><span>Auto-director: keep a secret episode running (auto-starts E1, auto-chains Next on conclusion; needs a Connection Profile)</span></div>',
            '<label>Character ledger: auto-update every N storyteller replies (0 = off)</label>',
            '<input type="number" id="cc_led_auto" min="0" max="100">',
            '<div class="cc_row">',
            '  <div><label>Ledger injection depth</label><input type="number" id="cc_led_depth" min="0" max="30"></div>',
            '  <div><label>Ledger active window (msgs)</label><input type="number" id="cc_led_win" min="1" max="100"></div>',
            '</div>',
            '<div class="cc_check"><input type="checkbox" id="cc_led_inject"><span>Inject [CHARACTER CONTINUITY] into the storyteller</span></div>',
            '<div style="margin:10px 0 2px;font-weight:600;opacity:0.75;">Worldbook (World Info) \u2014 optional</div>',
            '<div class="cc_check"><input type="checkbox" id="cc_wi_enable"><span>Let the copilot see & edit Worldbook entries (off = ignored entirely)</span></div>',
            '<label>Book name(s) to manage (comma-separated; use \u201CWorldbook: detect\u201D in the \u22EE menu to find them)</label>',
            '<input type="text" id="cc_wi_books" placeholder="e.g. Mithraic Academy Lore">',
            '<div class="cc_check"><input type="checkbox" id="cc_wi_full"><span>Load FULL entry text into the copilot (token heavy; off = catalog + fetch-on-demand)</span></div>',
            '<div style="font-size:0.78em;opacity:0.65;margin-top:2px;">Off = the copilot sees a lightweight catalog (titles, keys, snippets) and pulls full entries only when it needs them \u2014 safe for large books. On = every managed entry\'s full text every message.</div>',
            '<label>Director system prompt (INTENSITY_LEVEL is replaced automatically)</label>',
            '<textarea id="cc_dir_prompt"></textarea>',
            '<div style="margin:10px 0 2px;font-weight:600;opacity:0.75;">Prompts & shortcuts</div>',
            '<label>Shortcut commands (one per line: #tag = prompt)</label>',
            '<textarea id="cc_shortcuts"></textarea>',
            '<label>System prompt (USER_EDIT_RULE is replaced automatically)</label>',
            '<textarea id="cc_sysprompt"></textarea>',
            '<div style="margin-top:6px; display:flex; gap:6px;">',
            '  <button class="cc_btn" id="cc_saveset">Save settings</button>',
            '  <button class="cc_btn" id="cc_resetprompt">Reset prompt</button>',
            '  <button class="cc_btn" id="cc_dirreset">Reset director prompt</button>',
            '  <button class="cc_btn" id="cc_shortreset">Reset shortcuts</button>',
            '  <button class="cc_btn" id="cc_dumpsc">Raw memory data</button>',
            '</div>',
        ].join('\n');

        el('cc_recent').value = settings.recentFull;
        el('cc_rounds').value = settings.fetchRounds;
        el('cc_maxtok').value = settings.maxTokens;
        el('cc_think_retries').value = Number.isFinite(Number(settings.thinkRetries)) ? settings.thinkRetries : 2;
        el('cc_pattern').value = settings.memoryKeyPattern;
        el('cc_userok').checked = !!settings.allowUserEdits;
        el('cc_hidden').checked = !!settings.includeHidden;
        el('cc_rehide').checked = !!settings.autoRehide;
        el('cc_an').checked = !!settings.includeAuthorsNote;
        el('cc_stream').checked = !!settings.streaming;
        el('cc_showthink').checked = !!settings.showThinking;
        el('cc_dir_int').value = settings.directorIntensity || 'standard';
        el('cc_dir_depth').value = settings.directorDepth;
        el('cc_crit_depth').value = settings.critiqueDepth;
        el('cc_dir_anchors').value = settings.directorAnchors || '';
        el('cc_crit_auto').value = settings.critiqueAuto;
        el('cc_dir_auto').checked = !!settings.directorAuto;
        el('cc_led_auto').value = settings.ledgerAuto;
        el('cc_led_depth').value = settings.ledgerDepth;
        el('cc_led_win').value = settings.ledgerWindow;
        el('cc_led_inject').checked = !!settings.ledgerInject;
        el('cc_wi_enable').checked = !!settings.wiEnable;
        el('cc_wi_books').value = settings.wiBooks || '';
        el('cc_wi_full').checked = !!settings.wiFull;
        el('cc_dir_prompt').value = settings.directorPrompt || DEFAULT_DIRECTOR_PROMPT;
        el('cc_shortcuts').value = settings.shortcuts;
        el('cc_sysprompt').value = settings.systemPrompt;
        refreshProfileSelect();

        el('cc_saveset').addEventListener('click', () => {
            settings.profileId = el('cc_profile').value;
            settings.recentFull = Number(el('cc_recent').value) || 0;
            settings.fetchRounds = Number(el('cc_rounds').value) || 0;
            settings.maxTokens = Math.min(32768, Math.max(256, Number(el('cc_maxtok').value) || 4096));
            const trv = Number(el('cc_think_retries').value);
            settings.thinkRetries = Number.isFinite(trv) ? Math.max(0, Math.min(99, trv)) : 2;
            settings.memoryKeyPattern = el('cc_pattern').value || defaults.memoryKeyPattern;
            settings.allowUserEdits = el('cc_userok').checked;
            settings.includeHidden = el('cc_hidden').checked;
            settings.autoRehide = el('cc_rehide').checked;
            settings.includeAuthorsNote = el('cc_an').checked;
            settings.streaming = el('cc_stream').checked;
            settings.showThinking = el('cc_showthink').checked;
            settings.directorIntensity = el('cc_dir_int').value || 'standard';
            settings.directorDepth = Number(el('cc_dir_depth').value) || 4;
            settings.critiqueDepth = Number(el('cc_crit_depth').value) || 8;
            settings.directorAnchors = el('cc_dir_anchors').value;
            settings.critiqueAuto = Math.max(0, Number(el('cc_crit_auto').value) || 0);
            settings.directorAuto = el('cc_dir_auto').checked;
            settings.ledgerAuto = Math.max(0, Number(el('cc_led_auto').value) || 0);
            settings.ledgerDepth = Number(el('cc_led_depth').value) || 6;
            settings.ledgerWindow = Math.max(1, Number(el('cc_led_win').value) || 20);
            settings.ledgerInject = el('cc_led_inject').checked;
            settings.wiEnable = el('cc_wi_enable').checked;
            settings.wiBooks = el('cc_wi_books').value;
            settings.wiFull = el('cc_wi_full').checked;
            settings.directorPrompt = el('cc_dir_prompt').value || DEFAULT_DIRECTOR_PROMPT;
            settings.shortcuts = el('cc_shortcuts').value;
            applyInjections();
            settings.systemPrompt = el('cc_sysprompt').value || DEFAULT_SYSTEM_PROMPT;
            persistSettings();
            toast('Settings saved.', 'success');
        });
        el('cc_resetprompt').addEventListener('click', () => {
            el('cc_sysprompt').value = DEFAULT_SYSTEM_PROMPT;
        });
        el('cc_dirreset').addEventListener('click', () => {
            el('cc_dir_prompt').value = DEFAULT_DIRECTOR_PROMPT;
        });
        el('cc_shortreset').addEventListener('click', () => {
            el('cc_shortcuts').value = DEFAULT_SHORTCUTS;
        });
        el('cc_dumpsc').addEventListener('click', () => {
            const c = ctx();
            const md = c.chatMetadata || c.chat_metadata || {};
            let re;
            try { re = new RegExp(settings.memoryKeyPattern, 'i'); }
            catch (e) { re = /summar|ception|memory/i; }
            const out = {};
            for (const [k, v2] of Object.entries(md)) {
                if (k !== MODULE && re.test(k)) out[k] = v2;
            }
            let txt;
            try { txt = JSON.stringify(out, null, 2); } catch (e) { txt = 'Could not serialize: ' + e.message; }
            showViewer('Raw memory data \u2014 Copy and paste this to Claude', txt);
        });
    }

    function refreshProfileSelect() {
        const sel = el('cc_profile');
        if (!sel) return;
        const profiles = getProfiles();
        sel.innerHTML = '';
        const opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = 'Current API (raw generation)';
        sel.appendChild(opt0);
        for (const p of profiles) {
            const o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.name || p.id;
            sel.appendChild(o);
        }
        sel.value = settings.profileId || '';
    }

    function setBusy(b) {
        const btn = el('cc_send');
        if (btn) {
            btn.textContent = b ? 'Stop' : 'Send';
            btn.style.background = b ? 'rgba(220,90,90,0.85)' : '';
        }
        const au = el('cc_audit');
        if (au) au.disabled = b;
        const rt = el('cc_retry');
        if (rt) rt.disabled = b;
    }

    function mdLite(text) {
        let t = esc(text);
        t = t.replace(/`([^`\n]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:0 4px;border-radius:4px;">$1</code>');
        t = t.replace(/\*\*([^*\n][^*]*?)\*\*/g, '<b>$1</b>');
        t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<i>$2</i>');
        t = t.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');
        t = t.replace(/^\s*[-\u2022]\s+/gm, '\u2003\u2022 ');
        t = t.replace(/\n/g, '<br>');
        return t;
    }

    function attachMsgIcons(div, kind, hidx) {
        if (!Number.isInteger(hidx)) return;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:14px;justify-content:flex-end;margin-top:6px;opacity:0.5;font-size:0.85em;user-select:none;';
        const mk = (txt, title, fn) => {
            const sp = document.createElement('span');
            sp.textContent = txt;
            sp.title = title;
            sp.style.cssText = 'cursor:pointer;';
            sp.addEventListener('click', fn);
            row.appendChild(sp);
        };
        if (kind === 'user') mk('\u270E', 'Edit this message and continue from here', () => startEditUserMessage(hidx));
        mk('\uD83D\uDCCB', 'Copy message text', async () => {
            const h = meta().history[hidx];
            const ok = await copyText(String(h?.content ?? ''));
            toast(ok ? 'Copied.' : 'Copy failed.', ok ? 'success' : 'error');
        });
        mk('\uD83C\uDF3F', 'Branch: new session starting from this message', () => branchAt(hidx));
        mk('\u2715', 'Delete this message', () => deleteMessageAt(hidx));
        div.appendChild(row);
    }

    function addBubble(kind, text, hidx) {
        const log = el('cc_log');
        const div = document.createElement('div');
        const cls = kind === 'user' ? 'cc_user' : kind === 'assistant' || kind === 'ai' ? 'cc_ai' : kind === 'busy' ? 'cc_busy' : 'cc_note';
        div.className = 'cc_bubble ' + cls;
        div.style.padding = '8px 12px';
        div.style.lineHeight = '1.45';
        div.style.borderRadius = '12px';
        div.innerHTML = esc(text);
        attachMsgIcons(div, kind, hidx);
        const pinned = kind === 'user' || (log.scrollHeight - log.scrollTop - log.clientHeight) < 60;
        log.appendChild(div);
        if (pinned) log.scrollTop = log.scrollHeight;
        return div;
    }

    function addAiBubble(rest, think, hidx) {
        const log = el('cc_log');
        const div = document.createElement('div');
        div.className = 'cc_bubble cc_ai';
        div.style.padding = '8px 12px';
        div.style.lineHeight = '1.5';
        div.style.borderRadius = '12px';
        let html = '';
        if (settings.showThinking && think) {
            html += '<details class="cc_think"><summary>thinking</summary><div>' + esc(think) + '</div></details>';
        }
        html += mdLite(stripBlocks(rest) || '(no text)');
        div.innerHTML = html;
        attachMsgIcons(div, 'ai', hidx);
        const pinned = (log.scrollHeight - log.scrollTop - log.clientHeight) < 60;
        log.appendChild(div);
        if (pinned) log.scrollTop = log.scrollHeight;
        return div;
    }

    function renderHistory() {
        const log = el('cc_log');
        if (!log) return;
        log.innerHTML = '';
        const hist = meta().history;
        let lastDiv = null;
        let lastIdx = -1;
        for (let i = 0; i < hist.length; i++) {
            const h = hist[i];
            if (h.role === 'assistant') {
                lastDiv = addAiBubble(h.content, h.think, i);
                lastIdx = i;
            }
            else if (h.role === 'user') addBubble('user', h.content, i);
            else addBubble('note', h.content, i);
        }
        if (lastDiv && lastIdx === hist.length - 1) {
            const entry = hist[lastIdx];
            const total = Array.isArray(entry.swipes) && entry.swipes.length ? entry.swipes.length : 1;
            const cur = (Number.isInteger(entry.swipeId) ? entry.swipeId : total - 1) + 1;
            const bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;opacity:0.75;user-select:none;';
            const mkArrow = (txt, dir, title) => {
                const b = document.createElement('span');
                b.textContent = txt;
                b.title = title;
                b.style.cssText = 'cursor:pointer;padding:0 10px;font-size:1.25em;';
                b.addEventListener('click', () => swipeAssistant(lastIdx, dir));
                return b;
            };
            bar.appendChild(mkArrow('\u2039', -1, 'Previous answer'));
            const cnt = document.createElement('span');
            cnt.textContent = cur + ' / ' + total;
            cnt.style.cssText = 'font-size:0.85em;';
            bar.appendChild(cnt);
            bar.appendChild(mkArrow('\u203A', 1, 'Next answer / generate new alternative'));
            lastDiv.appendChild(bar);
        }
        log.scrollTop = log.scrollHeight;
        updateSub();
    }

    function batchLabel(n) {
        return n > 1 ? ('Batch ' + n) : 'Proposed';
    }

    function renderEditCards() {
        const box = el('cc_edits');
        if (!box) return;
        if (!pendingEdits.length) {
            box.classList.remove('cc_open');
            box.innerHTML = '';
            return;
        }
        box.classList.add('cc_open');
        const chat = ctx().chat || [];
        const frag = document.createDocumentFragment();

        const head = document.createElement('div');
        head.className = 'cc_edits_head';
        head.innerHTML = '<span>Proposed edits: ' + pendingEdits.length + '</span>' +
            '<button class="cc_btn" id="cc_toggleedits">' + (editsCollapsed ? 'Show' : 'Hide') + '</button>' +
            '<button class="cc_btn cc_primary" id="cc_applyall">Apply all pending</button>' +
            '<button class="cc_btn" id="cc_dismissall">Dismiss</button>';
        frag.appendChild(head);

        const list = document.createElement('div');
        if (editsCollapsed) list.style.display = 'none';

        const maxBatch = pendingEdits.reduce((mx, e) => Math.max(mx, e.batch || 1), 1);
        let lastBatch = null;
        pendingEdits.forEach((edit, idx) => {
            const isMem = edit.kind === 'mem';
            const isWi = edit.kind === 'wi';
            const msg = (isMem || isWi) ? null : chat[edit.id];
            const who = (isMem || isWi) ? '' : (msg ? (msg.is_user ? 'USER' : (msg.name || 'AI')) : '?');
            const label = isWi ? ('\uD83C\uDF10 WB ' + esc(edit.book + '#' + (edit.newEntry ? 'new' : edit.uid))) : (isMem ? 'MEMORY' : ('#' + edit.id + ' ' + esc(who)));
            if (maxBatch > 1 && (edit.batch || 1) !== lastBatch) {
                lastBatch = edit.batch || 1;
                const div = document.createElement('div');
                div.style.cssText = 'font-size:0.75em;opacity:0.6;margin:6px 0 3px;text-transform:uppercase;letter-spacing:0.05em;';
                div.textContent = batchLabel(lastBatch) + (lastBatch === maxBatch ? ' (newest)' : '');
                list.appendChild(div);
            }
            const card = document.createElement('div');
            card.className = 'cc_card';
            const findShown = isWi
                ? (edit.newEntry ? '(new entry: ' + (edit.comment || '') + ')' : (edit.setKeys ? '(set keys: ' + edit.setKeys.join(', ') + ')' : (edit.find == null ? '(replace entry content)' : edit.find)))
                : (!isMem && edit.hide !== null && edit.hide !== undefined)
                ? (edit.hide ? '(hide message from AI context \u2014 text stays in log)' : '(unhide message)')
                : edit.find == null
                    ? (isMem ? '(replace entire field: ' + (edit.path || '?') + ')' : '(replace entire message)')
                    : edit.find;
            card.innerHTML =
                '<div class="cc_card_top"><b>' + label + '</b><span>' + esc(edit.reason || '') + '</span>' +
                (edit.status === 'pending'
                    ? '<button class="cc_btn" data-cc-apply="' + idx + '">Apply</button><button class="cc_btn" data-cc-skip="' + idx + '">Skip</button>'
                    : '') +
                '</div>' +
                '<div class="cc_diff cc_before">' + esc(findShown) + '</div>' +
                '<div class="cc_diff cc_after">' + esc(edit.replace) + '</div>' +
                (edit.status !== 'pending' ? '<div class="cc_card_status">' + esc(edit.status) + '</div>' : '');
            list.appendChild(card);
        });

        frag.appendChild(list);

        box.innerHTML = '';
        box.appendChild(frag);

        el('cc_applyall')?.addEventListener('click', () => applyEdits(pendingEdits));
        el('cc_dismissall')?.addEventListener('click', () => {
            pendingEdits = [];
            renderEditCards();
        });
        el('cc_toggleedits')?.addEventListener('click', () => {
            editsCollapsed = !editsCollapsed;
            renderEditCards();
        });
        box.querySelectorAll('[data-cc-apply]').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = Number(btn.getAttribute('data-cc-apply'));
                applyEdits([pendingEdits[i]]);
            });
        });
        box.querySelectorAll('[data-cc-skip]').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = Number(btn.getAttribute('data-cc-skip'));
                pendingEdits[i].status = 'skipped';
                renderEditCards();
            });
        });
    }

    function updateSub() {
        const sub = el('cc_sub');
        if (!sub) return;
        const c = ctx();
        const count = Array.isArray(c.chat) ? c.chat.length : 0;
        const d = metaRoot().director;
        sub.textContent = 'v' + VERSION + ' · ' + count + ' messages' + (d ? ' · \uD83C\uDFAC E' + d.episode + (d.concluded ? ' \u2713' : '') : '');
    }

    function togglePanel(force) {
        const panel = el('cc_panel');
        if (!panel) return;
        const open = typeof force === 'boolean' ? force : !panel.classList.contains('cc_open');
        panel.classList.toggle('cc_open', open);
        if (open) {
            renderSessions();
            renderHistory();
            renderEditCards();
        }
    }

    function makeDraggable(panel, handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.cc_hbtn')) return;
            dragging = true;
            sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect();
            ox = r.left; oy = r.top;
            handle.setPointerCapture?.(e.pointerId);
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const nx = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - 80);
            const ny = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 40);
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        const stop = () => { dragging = false; };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
    }

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('cc_menu_item')) return;
        const div = document.createElement('div');
        div.id = 'cc_menu_item';
        div.className = 'list-group-item flex-container flexGap5 interactable';
        div.title = 'Toggle Continuity Copilot';
        div.innerHTML = '<i class="fa-solid fa-user-pen"></i><span>Continuity Copilot</span>';
        div.addEventListener('click', () => togglePanel());
        menu.appendChild(div);
    }

    function registerSlash() {
        const c = ctx();
        const handler = async (_named, text) => {
            togglePanel(true);
            const t = typeof text === 'string' ? text.trim() : '';
            if (t) await send(t);
            return '';
        };
        try {
            if (typeof c.registerSlashCommand === 'function') {
                c.registerSlashCommand('cc', handler, [], '<span>— toggle Continuity Copilot / send it a request</span>', true, true);
                return;
            }
        } catch (e) { /* ignore */ }
        try {
            if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
                c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                    name: 'cc',
                    callback: handler,
                    helpString: 'Toggle Continuity Copilot, or send it a request: /cc why is Jillian on the train, fix it',
                }));
            }
        } catch (e) { console.warn(LOG, 'slash registration failed', e); }
    }

    async function reconcileHidden() {
        if (!settings.autoRehide) return;
        try {
            const c = ctx();
            const chat = c.chat;
            if (!Array.isArray(chat) || !chat.length) return;
            const led = metaRoot().ccHidden || [];
            let n = 0;
            for (const id of led) {
                const msg = chat[id];
                if (msg && !msg.is_system) {
                    await setHiddenState(id, true);
                    n++;
                }
            }
            if (n) {
                try { if (typeof c.saveChat === 'function') await c.saveChat(); } catch (e) { /* ignore */ }
                toast('\uD83D\uDD12 Re-hid ' + n + ' pilot-hidden message(s) after load.', 'info');
            }
        } catch (e) { console.warn(LOG, 'reconcile failed', e); }
    }

    const LEDGER_KEY = 'cc_memory_ledger';
    const LEDGER_BK = 'cc_memory_ledger_backups';

    function ledgerGet() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata;
        if (!md) return { lastProcessedTurn: -1, characters: {} };
        let L = md[LEDGER_KEY];
        if (!L || typeof L !== 'object' || Array.isArray(L)) {
            L = { lastProcessedTurn: -1, characters: {} };
            md[LEDGER_KEY] = L;
        }
        if (!Number.isInteger(L.lastProcessedTurn)) L.lastProcessedTurn = -1;
        if (!L.characters || typeof L.characters !== 'object') L.characters = {};
        return L;
    }

    function ledgerBackup() {
        const c = ctx();
        const md = c.chatMetadata || c.chat_metadata;
        if (!md) return;
        if (!Array.isArray(md[LEDGER_BK])) md[LEDGER_BK] = [];
        md[LEDGER_BK].push(JSON.parse(JSON.stringify(ledgerGet())));
        while (md[LEDGER_BK].length > 3) md[LEDGER_BK].shift();
    }

    function ledgerResolveName(L, name) {
        const n = String(name || '').trim();
        if (!n) return null;
        const low = n.toLowerCase();
        for (const [canon, ch] of Object.entries(L.characters)) {
            if (canon.toLowerCase() === low) return canon;
            if (Array.isArray(ch.aliases) && ch.aliases.some(a => String(a).toLowerCase() === low)) return canon;
        }
        for (const [canon, ch] of Object.entries(L.characters)) {
            const cands = [canon, ...(Array.isArray(ch.aliases) ? ch.aliases : [])];
            for (const cand of cands) {
                if (itemSim(String(cand), n) >= 0.78) return canon;
            }
        }
        return null;
    }

    function ledgerEnsureChar(L, name) {
        const found = ledgerResolveName(L, name);
        if (found) return found;
        const canon = String(name).trim().slice(0, 60);
        L.characters[canon] = { aliases: [], alwaysInject: false, state: '', relationships: {}, knowledge: { knows: [], doesNotKnow: [] }, arc: [] };
        return canon;
    }

    function applyLedgerOps(ops) {
        const L = ledgerGet();
        const counts = { chars: new Set(), rel: 0, arc: 0, know: 0, alias: 0, created: [] };
        const clip = (t, n2) => String(t == null ? '' : t).trim().slice(0, n2);
        for (const op of Array.isArray(ops) ? ops : []) {
            if (!op || typeof op !== 'object' || typeof op.op !== 'string' || !op.name) continue;
            const existed = !!ledgerResolveName(L, op.name);
            const canon = ledgerEnsureChar(L, op.name);
            if (!existed) counts.created.push(canon);
            const ch = L.characters[canon];
            counts.chars.add(canon);
            if (op.op === 'upsert_char') {
                if (op.state != null) ch.state = clip(op.state, 260);
            } else if (op.op === 'add_arc') {
                const note = clip(op.note, 160);
                if (note) {
                    ch.arc.push({ atTurn: Number(op.atTurn) || 0, note });
                    if (ch.arc.length > 12) {
                        const a2 = ch.arc.shift();
                        const b2 = ch.arc.shift();
                        ch.arc.unshift({ atTurn: a2.atTurn, note: 'T' + a2.atTurn + ': ' + a2.note + '; T' + b2.atTurn + ': ' + b2.note });
                    }
                    counts.arc++;
                }
            } else if (op.op === 'set_relationship' && op.target) {
                const tgt = ledgerEnsureChar(L, op.target);
                const trend = ['warming', 'cooling', 'stable'].includes(op.trend) ? op.trend : 'stable';
                ch.relationships[tgt] = { label: clip(op.label, 90), trend, sinceTurn: Number(op.sinceTurn) || (ctx().chat?.length || 0) };
                counts.rel++;
            } else if (op.op === 'set_knowledge') {
                const norm = (arr) => (Array.isArray(arr) ? arr : []).map(x => clip(x, 90)).filter(Boolean).slice(0, 12);
                if (op.knows != null) ch.knowledge.knows = norm(op.knows);
                if (op.doesNotKnow != null) ch.knowledge.doesNotKnow = norm(op.doesNotKnow);
                counts.know++;
            } else if (op.op === 'merge_alias' && op.alias) {
                const al = clip(op.alias, 60);
                if (al && !ch.aliases.some(a => a.toLowerCase() === al.toLowerCase())) { ch.aliases.push(al); counts.alias++; }
            }
        }
        return counts;
    }

    function buildLedgerInput(fromTurn) {
        const chat = ctx().chat || [];
        const parts = [];
        for (let i = Math.max(0, fromTurn + 1); i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            const who = m.is_user ? 'USER' : (m.name || 'AI');
            parts.push('--- #' + i + ' [' + who + '] ---\n' + String(m.mes || '').slice(0, 8000));
        }
        let text = parts.join('\n\n');
        while (text.length > 60000 && parts.length > 1) { parts.shift(); text = parts.join('\n\n'); }
        return text;
    }

    function applyLedgerInjection() {
        const c = ctx();
        const depth = Number(settings?.ledgerDepth) || 6;
        const role = c.extension_prompt_roles?.SYSTEM ?? 0;
        try {
            if (!settings?.ledgerInject) { c.setExtensionPrompt(LEDGER_KEY, '', 1, depth, false, role); return; }
            const L = ledgerGet();
            const names = Object.keys(L.characters);
            if (!names.length) { c.setExtensionPrompt(LEDGER_KEY, '', 1, depth, false, role); return; }
            const chat = c.chat || [];
            const M = Math.max(1, Number(settings.ledgerWindow) || 20);
            let recent = '';
            for (let i = Math.max(0, chat.length - M); i < chat.length; i++) {
                const m = chat[i];
                if (m && !m.is_system) recent += ' ' + String(m.mes || '').toLowerCase();
            }
            const lines = [];
            for (const canon of names) {
                const ch = L.characters[canon];
                const keys = [canon, ...(Array.isArray(ch.aliases) ? ch.aliases : [])];
                const active = ch.alwaysInject || keys.some(k => k && recent.includes(String(k).toLowerCase()));
                if (!active) continue;
                let line = canon + ' \u2014 ' + (ch.state || 'present');
                const rels = Object.entries(ch.relationships || {}).map(([t, r]) => t + ': ' + r.label + ' (' + r.trend + ')');
                if (rels.length) line += ' | Relations: ' + rels.join('; ');
                if (ch.knowledge?.knows?.length) line += ' | Knows: ' + ch.knowledge.knows.join(', ');
                if (ch.knowledge?.doesNotKnow?.length) line += ' | Does NOT know: ' + ch.knowledge.doesNotKnow.join(', ') + ' \u2014 never let them act on these.';
                lines.push(line);
                if (lines.join('\n').length > 1800) break;
            }
            const value = lines.length ? '[CHARACTER CONTINUITY \u2014 current qualitative state; knowledge boundaries are hard rules:]\n' + lines.join('\n') : '';
            c.setExtensionPrompt(LEDGER_KEY, value, 1, depth, false, role);
        } catch (e) { console.warn(LOG, 'ledger injection failed', e); }
    }

    async function runLedgerUpdate(isAuto) {
        if (running) return;
        const c = ctx();
        if (!Array.isArray(c.chat) || !c.chat.length) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', (isAuto ? 'auto-' : '') + 'updating character ledger\u2026');
        try {
            const L = ledgerGet();
            const input = buildLedgerInput(L.lastProcessedTurn);
            if (!input.trim()) { addBubble('note', '\uD83E\uDDEC Ledger: nothing new to process.'); return; }
            const sys = [
                'You maintain a qualitative CHARACTER LEDGER for a long roleplay. You receive the current ledger JSON and the new messages since the last pass.',
                'Output ONLY a block: <ledgerops>[ ...patch ops... ]</ledgerops> \u2014 a STRICT JSON array of ops, never a full rewrite. Allowed ops:',
                '{"op":"upsert_char","name":"..","state":"1-2 line current qualitative state"}',
                '{"op":"add_arc","name":"..","atTurn":123,"note":"turning point, one line"}',
                '{"op":"set_relationship","name":"..","target":"..","label":"e.g. rivals\u2192grudging allies","trend":"warming|cooling|stable","sinceTurn":123}',
                '{"op":"set_knowledge","name":"..","knows":["fact"],"doesNotKnow":["secret"]}',
                '{"op":"merge_alias","name":"CanonicalName","alias":"Nickname"}',
                'Rules: qualitative continuity ONLY \u2014 never numeric stats (P/R/S etc.). Only characters actually present or affected in the new messages. Knowledge entries are short factual phrases. Use existing canonical names/aliases; never invent duplicates for the same person. Only record real changes; an empty array [] is a valid answer.',
            ].join('\n');
            const user = '[CURRENT LEDGER]\n' + JSON.stringify(L) + '\n\n[NEW MESSAGES]\n' + input + '\n\nEmit the ledgerops block now.';
            let sp = await callLLMSmart([{ role: 'system', content: sys }, { role: 'user', content: user }]);
            if (stopRequested) { addBubble('note', 'Stopped \u2014 ledger unchanged.'); return; }
            let b = findBlock(sp.rest, 'ledgerops');
            let ops = null;
            try { ops = b ? JSON.parse(b.inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')) : null; } catch (e) { ops = null; }
            if (!Array.isArray(ops)) {
                sp = await callLLMSmart([
                    { role: 'system', content: sys },
                    { role: 'user', content: user },
                    { role: 'assistant', content: sp.rest.slice(0, 4000) || '(no answer \u2014 all reasoning)' },
                    { role: 'user', content: 'That was not a valid ledgerops JSON array. Resend ONLY the <ledgerops>[...]</ledgerops> block with valid JSON, with minimal deliberation.' },
                ]);
                if (stopRequested) { addBubble('note', 'Stopped \u2014 ledger unchanged.'); return; }
                b = findBlock(sp.rest, 'ledgerops');
                try { ops = b ? JSON.parse(b.inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')) : null; } catch (e) { ops = null; }
            }
            if (!Array.isArray(ops)) { toast('\uD83E\uDDEC Ledger update failed to parse \u2014 ledger unchanged.', 'error'); addBubble('note', '\uD83E\uDDEC Ledger update failed to parse twice \u2014 unchanged.'); return; }
            const md = c.chatMetadata || c.chat_metadata;
            const before = JSON.parse(JSON.stringify(ledgerGet()));
            ledgerBackup();
            const counts = applyLedgerOps(ops);
            ledgerGet().lastProcessedTurn = c.chat.length - 1;
            undoStack.push({ label: 'ledger update', items: [{ kind: 'mem', key: LEDGER_KEY, before }] });
            saveMeta();
            applyLedgerInjection();
            const note = '\uD83E\uDDEC Ledger updated' + (isAuto ? ' (auto)' : '') + ': ' + counts.chars.size + ' character(s), ' + counts.rel + ' relationship(s), ' + counts.arc + ' arc, ' + counts.know + ' knowledge' + (counts.created.length ? ' \u2014 new: ' + counts.created.join(', ') : '') + '. Undo restores.';
            addBubble('note', note);
            pushHistory('note', note);
        } catch (err) {
            addBubble('note', 'Ledger error: ' + (err?.message || err));
        } finally {
            busyNote.remove();
            running = false;
            setBusy(false);
        }
    }

    function maybeAutoLedger() {
        try {
            const n = Number(settings.ledgerAuto) || 0;
            if (n <= 0) return;
            const m = metaRoot();
            m.ledgerAutoCount = (Number(m.ledgerAutoCount) || 0) + 1;
            saveMeta();
            if (m.ledgerAutoCount < n) return;
            if (running) return;
            if (!settings.profileId) return;
            m.ledgerAutoCount = 0;
            saveMeta();
            runLedgerUpdate(true);
        } catch (e) { /* ignore */ }
    }

    function ledgerPeek() {
        const L = ledgerGet();
        showViewer('\uD83E\uDDEC Character ledger (edit JSON + Save)', JSON.stringify(L, null, 2), (t) => {
            try {
                const parsed = JSON.parse(t);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object');
                if (!parsed.characters || typeof parsed.characters !== 'object') throw new Error('missing characters object');
                ledgerBackup();
                const md = ctx().chatMetadata || ctx().chat_metadata;
                md[LEDGER_KEY] = parsed;
                saveMeta();
                applyLedgerInjection();
                addBubble('note', '\uD83E\uDDEC Ledger manually edited.');
            } catch (e) {
                toast('Ledger not saved \u2014 invalid JSON: ' + e.message, 'error');
            }
        });
    }

    function ledgerRestore() {
        const md = ctx().chatMetadata || ctx().chat_metadata;
        if (!md || !Array.isArray(md[LEDGER_BK]) || !md[LEDGER_BK].length) { toast('No ledger backups yet.', 'warning'); return; }
        if (!confirm('Restore the most recent ledger backup? (' + md[LEDGER_BK].length + ' available)')) return;
        md[LEDGER_KEY] = md[LEDGER_BK].pop();
        saveMeta();
        applyLedgerInjection();
        addBubble('note', '\uD83E\uDDEC Ledger restored from backup.');
    }

    function maybeAutoDirector() {
        try {
            if (!settings.directorAuto) return;
            if (running) return;
            if (!settings.profileId) return;
            const d = metaRoot().director;
            if (!d) { generateDirective('new', true); return; }
            if (d.concluded) generateDirective('next', true);
        } catch (e) { /* ignore */ }
    }

    function maybeAutoCritique() {
        try {
            const n = Number(settings.critiqueAuto) || 0;
            if (n <= 0) return;
            const m = metaRoot();
            m.critAutoCount = (Number(m.critAutoCount) || 0) + 1;
            saveMeta();
            if (m.critAutoCount < n) return;
            if (running) return; // stay pending; next reply retries
            if (!settings.profileId) return; // never hijack the main API for background work
            m.critAutoCount = 0;
            saveMeta();
            generateCritique(true);
        } catch (e) { /* ignore */ }
    }

    function scrubEpisodeMarkers() {
        try {
            const c = ctx();
            const chat = c.chat;
            if (!Array.isArray(chat)) return;
            let n = 0;
            const clean = (t) => String(t).replace(/\s*\[EPISODE_END\]\s*/g, ' ').trim();
            for (let i = 0; i < chat.length; i++) {
                const m = chat[i];
                if (!m) continue;
                let touched = false;
                if (typeof m.mes === 'string' && m.mes.includes('[EPISODE_END]')) {
                    m.mes = clean(m.mes);
                    touched = true;
                }
                if (Array.isArray(m.swipes)) {
                    for (let k = 0; k < m.swipes.length; k++) {
                        if (typeof m.swipes[k] === 'string' && m.swipes[k].includes('[EPISODE_END]')) {
                            m.swipes[k] = clean(m.swipes[k]);
                            touched = true;
                        }
                    }
                }
                if (touched) { refreshMessage(i); n++; }
            }
            if (n) {
                try { c.saveChat?.(); } catch (e) { /* ignore */ }
                console.log(LOG, 'scrubbed EPISODE_END from', n, 'message(s)');
            }
        } catch (e) { /* ignore */ }
    }

    function bindEvents() {
        const c = ctx();
        try {
            c.eventSource?.on?.(c.event_types?.CHAT_CHANGED, () => {
                pendingEdits = [];
                undoStack = [];
                if (el('cc_panel')?.classList.contains('cc_open')) {
                    renderSessions();
                    renderHistory();
                    renderEditCards();
                }
                reconcileHidden();
                scrubEpisodeMarkers();
                applyInjections();
                updateSub();
            });
            c.eventSource?.on?.(c.event_types?.MESSAGE_RECEIVED, async (i) => {
                try {
                    reconcileHidden();
                    const msg = ctx().chat?.[Number(i)];
                    if (!msg || msg.is_user || typeof msg.mes !== 'string') return;
                    maybeAutoCritique();
                    maybeAutoDirector();
                    maybeAutoLedger();
                    if (!msg.mes.includes('[EPISODE_END]')) return;
                    msg.mes = msg.mes.replace(/\s*\[EPISODE_END\]\s*$/, '').replace(/\[EPISODE_END\]/g, '').trim();
                    refreshMessage(Number(i));
                    try { await ctx().saveChat?.(); } catch (e2) { /* ignore */ }
                    const d = metaRoot().director;
                    if (!d || d.concluded) return;
                    d.concluded = true;
                    saveMeta();
                    updateSub();
                    const note = '\uD83C\uDFAC Episode ' + d.episode + ' concluded' + (settings.directorAuto ? ' \u2014 auto-directing the next episode.' : ' \u2014 press \uD83C\uDFAC Next when ready.');
                    toast(note, 'success');
                    addBubble('note', note);
                    pushHistory('note', note);
                    maybeAutoDirector();
                } catch (e2) { /* ignore */ }
            });
            if (c.event_types?.GENERATION_STARTED) {
                c.eventSource.on(c.event_types.GENERATION_STARTED, () => { reconcileHidden(); });
            }
            if (c.event_types?.MESSAGE_SWIPED) {
                c.eventSource.on(c.event_types.MESSAGE_SWIPED, () => { scrubEpisodeMarkers(); });
            }
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    function init() {
        if (inited) return;
        inited = true;
        try {
            loadSettings();
            buildPanel();
            applyInjections();
            addMenuButton();
            bindEvents();
            registerSlash();
            console.log(LOG, 'ready', 'v' + VERSION);
        } catch (e) {
            console.error(LOG, 'init failed', e);
        }
    }

    try {
        const c = SillyTavern.getContext();
        if (c?.eventSource && c?.event_types?.APP_READY) {
            c.eventSource.on(c.event_types.APP_READY, init);
        }
    } catch (e) { /* ignore */ }

    // Fallback in case APP_READY already fired or is unavailable.
    setTimeout(init, 3000);
})();
