/*
 * Chat Assistant — a lightweight SillyTavern extension.
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
    const LOG = '[ChatAssistant]';
    const VERSION = '2.23.0';

    // ------------------------------------------------------------------
    // Defaults
    // ------------------------------------------------------------------

    const BEHAVIOR_RULES = [
        'HOW YOU CARRY YOURSELF \u2014 this overrides any instinct to please:',
        '- When the user questions, checks, doubts, or pokes holes in the STORY, its logic, its characters, or a memory entry, they are stress-testing the STORY \u2014 NOT criticizing you. Do NOT apologize, do NOT say "you\'re right, I was wrong", do NOT grovel or get defensive. Read every such message as: "is there a real story problem here?" Investigate it honestly, and if there is one, fix it.',
        '- Apologize or self-correct ONLY for something YOU actually got wrong (a malformed edit block, a mis-quoted anchor, an id that does not exist). A flaw in the STORY is not your mistake to apologize for \u2014 catching and repairing it is your JOB.',
        '- Be decisive. The instant you identify a concrete continuity, logic, or canon problem, PROPOSE the specific fix as an <edits> / <memedits> / <wiedits> block in the SAME reply. Do NOT end with "want me to adjust?" or "should I propose changes?" \u2014 just propose them. The user has per-fix Apply/Skip cards and one-tap Undo, so a proposal costs them nothing. Ask first ONLY when the fix is genuinely ambiguous (several valid directions) or irreversible \u2014 and even then, give a concrete recommended default and propose it.',
        '- Do not flip-flop to match a perceived mood. If the user pushes back, re-examine the evidence: if you were right, hold your ground and show why; if you were genuinely wrong, correct it cleanly and move on \u2014 no self-flagellation either way.',
        '- You are a confident showrunner and editor, not an assistant fishing for approval. Diagnose, decide, propose \u2014 always grounded in [STORY MEMORY] and the chat.',
    ].join('\n');

    const DEFAULT_SYSTEM_PROMPT = [
        'You are Chat Assistant, the user\'s co-writer and repair assistant embedded in SillyTavern.',
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
        '- CRITICAL for "find": copy the excerpt CHARACTER-FOR-CHARACTER from the [STORY MEMORY] block \u2014 do NOT paraphrase, reword, summarize, or quote from the chat/story text instead. Even a few reworded words can make it fail to match. If you are not certain of the exact wording, do a whole-field replace with "path" instead of a find/replace.',
        '- To replace an ENTIRE memory field, use {"path": "summaryception.notepad", "replace": "new full text", "reason": "..."} with the exact path shown in [STORY MEMORY] section headers. Adding "find" alongside "path" replaces only within that field.',
        '- The Author\'s Note is writable at path "note_prompt" (created if absent). The visible editor-critique notes are writable at path "cc_critique"; full replace with "" deletes them.',
        '- LARGE CHANGES: if a replacement would be very long, split the work into SEVERAL smaller find/replace edits (section by section) in the same block instead of one huge replace \u2014 each edit\'s replace text must stay comfortably within the response budget, or the reply gets cut off.',
        '- Anchors ("find") must be UNIQUE across the entire memory \u2014 the applier REJECTS anchors that match multiple places. Extend the excerpt until it is unmistakable.',
        '- Only prose/text fields are editable. Never target structural fields (turnRange, timestamps, indices, counters).',
        '- A character ledger entry is NOT one text block: its state, its arc, and EACH thread are stored SEPARATELY. A find/replace "find" must NEVER span two of them, and find/replace can ONLY change text that already exists verbatim. To ADD or RESTRUCTURE, use a STRUCTURAL edit: (a) rewrite a whole list/object field by giving "replace" as a JSON value \u2014 e.g. {"path": "summaryception.ledger.Renjiro.threads", "replace": ["thread one", "thread two"]}; (b) add ONE item without rewriting the rest with "append" \u2014 e.g. {"path": "summaryception.ledger.Renjiro.threads", "append": "new thread"}; "append" also works on a text field like the notepad to add a line. For a small wording fix use a tiny find/replace on the ONE wrong field/thread. Never try to add or restructure with find/replace.',
        '- "find" must be ONE contiguous run of text that appears EXACTLY in [STORY MEMORY]. Do NOT put location or structural descriptions inside "find" \u2014 never write things like "layer 0[10]", "in the summary", or "message 27" unless those exact characters are in the stored text \u2014 and do NOT stitch two separate excerpts together with connective words like "and" / "then". If the same fix applies in two places, emit TWO separate edits. Keep "find" to the SMALLEST span that uniquely covers the change (ideally just the corrected value plus a little real text around it).',
        '- The [bracketed.path] lines in [STORY MEMORY] (e.g. [summaryception.ledger.Jovan.state]) are SECTION LABELS the tool adds to show which field each block of text belongs to \u2014 they are NOT part of the stored text. NEVER put a [bracketed.path] label inside a "find" or "replace"; quote ONLY the actual content that appears below the label. Do not try to "fix", remove, or de-duplicate the labels themselves \u2014 they are display-only.',
        '- When SEVERAL fixes touch the SAME memory field, prefer ONE consolidated edit (a single find/replace that covers them, or a whole-field "path" replace) over many small ones \u2014 applying one edit changes the text, which can make a later edit\'s "find" no longer match. Fewer, larger edits per field apply far more reliably.',
        '- Use <edits> only for chat messages and <memedits> only for memory. Never mix them.',
    ].join('\n');

    const CHAT_EDIT_EXTRAS = [
        'Additional chat-edit ability:',
        '- HARD RULE \u2014 fetch before you edit: NEVER propose an <edits> change to a chat message unless its FULL text is already present above (in [FULL MESSAGES] or a fetch result). If you only have its one-line [MESSAGE INDEX] preview, you MUST <fetch> that id FIRST, wait for its text, and THEN copy the "find" verbatim from it. Reconstructing or guessing the wording of a message you have not fetched will not match and will fail \u2014 fetch, never guess.',
        '- To HIDE a message from the AI context without deleting it (e.g. OOC/meta exchanges), use {"id": 12, "hide": true, "reason": "..."} inside <edits>. Use {"id": 12, "hide": false} to unhide. Hiding works on user messages too; the text stays visible in the log but leaves the AI context.',
        '- The [MESSAGE INDEX] tags hidden messages "(hidden)" and memory-ghosted ones "(ghosted by memory)". You may unhide "(hidden)" messages when asked; NEVER unhide "(ghosted by memory)" ones \u2014 their content lives in the memory snippets.',
        '- Messages you hid are remembered in a ledger even if another extension later makes them visible again (the index will note this). If the user asks to "re-hide my OOC", emit hide edits for every id in that note.',
        '- In explanations, refer to blocks WITHOUT angle brackets (write "edits block", "memedits block", "fetch"). The literal tags must appear ONLY wrapping the actual JSON, never inside prose.',
        '- Anchors ("find") must be UNIQUE within their target message \u2014 the applier REJECTS ambiguous anchors. When in doubt, extend the excerpt a few words on each side.',
        '- The user can discuss your proposals before applying them. If they ask you to reconsider or refine an edit, simply propose the improved version in a new edits/memedits block \u2014 it is added to the staging area alongside the earlier ones so they can compare and pick. You do not need to resend unchanged proposals.',
        '- VALID JSON is required in every edits / memedits / wiedits block: property names and string values in double quotes; write EVERY line break inside a value as \\n (never a real line break); escape any double-quote inside a value as \\" or use single quotes instead; no comments, no trailing commas, no markdown fences. A single stray character makes the whole block unparseable \u2014 keep each value on one line where you can.',
    ].join('\n');

    const AUDIT_PROMPT = 'Audit the whole chat against [STORY MEMORY]. Look for continuity and logic errors: wrong locations, wrong character knowledge (information quarantine breaks), timeline contradictions, dropped or duplicated plot state. Fetch full messages if you need them, then list what you found and propose fixes in an <edits> block, plus <memedits> wherever the memory itself is wrong.';

    const PSYCH_SHORTCUT = '#p = Analyze the psychology of the character I name (or the most active one if none is named). Use only [STORY MEMORY] and the chat. Cover: (1) core drives, fears, and formative wounds as established in canon; (2) internal contradictions in how the character is written; (3) consistency: does recent behavior match the established characterization? Flag any out-of-character drift, citing the specific turns; (4) what the character would plausibly do next under the current pressure, and what would ring false. Ground every claim in something concrete. Do not propose edits unless I ask.';
    const DEFAULT_SHORTCUTS = [
        '#s = Check the CURRENT session against [STORY MEMORY]. Use <fetch> to pull any listed messages you have not seen in full. Then find (1) events, facts, or state changes MISSING from the memory and (2) memory entries that are stale or contradicted by the chat. Propose every correction in a single <memedits> block with "find" copied verbatim from [STORY MEMORY]. Do NOT propose <edits> to chat messages unless I explicitly ask.',
        '#f = Check the chat against [STORY MEMORY] and fix every continuity error you find with a single <edits> block.',
        '#o = Scan the chat for OOC/meta exchanges (out-of-character notes, corrections, discussions in (( )), [brackets], or marked OOC). Use <fetch> as needed. For each lesson found: (1) propose <edits> fixing any story text it corrected, (2) propose <memedits> persisting the lesson into the notepad, Author\'s Note (path note_prompt), or editor notes (path cc_critique), and (3) propose hiding the pure-OOC messages from AI context with {"id": n, "hide": true} entries. Nothing is deleted \u2014 hidden text stays in the log.',
        '#a = FIDELITY audit of the memory. For each snippet, use its "(covers chat messages #x to #y)" note to <fetch> the original ghosted messages, then verify two things: does the snippet text capture every plot-relevant event, and does its audit/detail field preserve the concrete facts (names, numbers, objects, places, injuries, promises, who-knows-what)? Report anything LOST or DISTORTED and propose <memedits> restoring the missing details into the snippet text or its detail field. If the memory is large, process ONE snippet per run and tell me where you stopped so I can continue.',
        '#m = Audit the MEMORY itself for internal continuity errors. Cross-check [STORY MEMORY]: the notepad (PE) vs every snippet vs every audit/detail \u2014 contradictions between them (locations, timeline, character state, who-knows-what), duplicated or conflicting facts, and audits that contradict their own snippet. If two versions disagree, <fetch> the ghosted originals to verify which is true. Propose all corrections in a single <memedits> block. Do NOT propose <edits> to chat messages unless I explicitly ask.',
        '#i = Brainstorm what could happen next. Give 3-5 distinct directions for the upcoming scene(s), each consistent with [STORY MEMORY] and the current situation: a one-line hook plus what it would develop. Do not write the scene itself and do not propose <edits>.',
        PSYCH_SHORTCUT,
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
                (toastr[type || 'info'] || toastr.info)(msg, 'Chat Assistant');
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
        try {
            if (typeof settings.shortcuts === 'string' && settings.shortcuts.trim() && !/^\s*#p\s*=/m.test(settings.shortcuts)) {
                settings.shortcuts = settings.shortcuts.replace(/\s*$/, '') + '\n' + PSYCH_SHORTCUT;
            }
        } catch (e) { /* ignore */ }
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

    // Read the "Active World(s) for all chats" <select id="world_info"> dropdown directly.
    function wiReadSelectDom() {
        const out = { all: [], active: [] };
        try {
            if (typeof document === 'undefined') return out;
            const el = document.getElementById('world_info');
            if (!el || !el.options) return out;
            for (const opt of el.options) {
                const name = String(opt.textContent || opt.text || '').trim();
                if (!name) continue;
                out.all.push(name);
                if (opt.selected) out.active.push(name);
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    // Books the copilot will actually manage: manual list if given, else the active dropdown selection.
    function wiEffectiveBooks() {
        const manual = wiChosenBooks();
        if (manual.length) return manual;
        try {
            const dom = wiReadSelectDom();
            if (dom.active.length) return dom.active;
        } catch (e) { /* ignore */ }
        return [];
    }

    function wiActive() {
        return !!settings.wiEnable && wiApiAvailable() && wiEffectiveBooks().length > 0;
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
    function wiFirstArray(cands) {
        for (const v of cands) { if (Array.isArray(v) && v.length) return v.slice(); }
        for (const v of cands) { if (Array.isArray(v)) return v.slice(); }
        return null;
    }

    function wiDiscover() {
        const c = ctx();
        const W = (typeof window !== 'undefined') ? window : {};
        const st = c.extensionSettings || c.extension_settings || W.extension_settings || {};
        const powerUser = c.powerUserSettings || W.power_user || {};
        const out = { character: null, chat: null, globals: [], all: [] };
        // Character-bound
        try {
            const ch = c.characters?.[c.characterId];
            out.character = ch?.data?.extensions?.world || ch?.data?.world || ch?.world || null;
        } catch (e) { /* ignore */ }
        // Chat-bound (metadata key is 'world_info')
        try {
            const md = c.chatMetadata || c.chat_metadata || {};
            const cw = md.world_info;
            if (typeof cw === 'string') out.chat = cw;
            else if (cw && typeof cw === 'object') out.chat = cw.world || cw.name || null;
        } catch (e) { /* ignore */ }
        // Active GLOBAL selection \u2014 probe every known location
        try {
            const sel = wiFirstArray([
                c.selected_world_info,
                W.selected_world_info,
                st.world_info?.globalSelect,
                st.selected_world_info,
                st.world_info,
                powerUser.world_info?.globalSelect,
            ]);
            if (sel) out.globals = sel.map(x => (typeof x === 'string' ? x : (x && (x.name || x.world)))).filter(Boolean);
        } catch (e) { /* ignore */ }
        // All known book names
        try {
            const all = wiFirstArray([ c.world_names, W.world_names, st.world_names ]);
            if (all) out.all = all.slice();
        } catch (e) { /* ignore */ }
        // AUTHORITATIVE: read the visible "Active World(s)" <select id=world_info> dropdown.
        try {
            const dom = wiReadSelectDom();
            if (dom.all.length && !out.all.length) out.all = dom.all;
            if (dom.active.length) out.globals = dom.active;
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
        const manual = wiChosenBooks();
        const eff = wiEffectiveBooks();
        if (manual.length) {
            lines.push('\nManaging (from settings): ' + manual.join(', '));
        } else if (eff.length) {
            lines.push('\n\u2705 Auto-using the ACTIVE book(s) from your dropdown: ' + eff.join(', ') + '  \u2014 no setup needed. (To pin a specific book instead, type its name in Settings \u2192 Worldbook.)');
        } else if (d.all.length) {
            lines.push('\nBooks available: ' + d.all.join(', ') + '. Select one in ST\'s \u201CActive World(s)\u201D dropdown, or type its name in Settings \u2192 Worldbook.');
        } else {
            lines.push('\nNo books found. Open ST\'s World Info panel and select a book, or type its name in Settings \u2192 Worldbook.');
        }
        // Raw inspection \u2014 dump what actually exists so detection can be fixed with facts.
        try {
            const pc = ctx();
            const W = (typeof window !== 'undefined') ? window : {};
            const probes = [];
            const safe = (fn) => { try { return fn(); } catch (e) { return '<err>'; } };
            const note = (label, getter) => {
                const v = safe(getter);
                if (v === '<err>') { probes.push(label + ' = <inaccessible>'); return; }
                if (v === undefined) { probes.push(label + ' = undefined'); return; }
                if (v === null) { probes.push(label + ' = null'); return; }
                if (Array.isArray(v)) { probes.push(label + ' = [' + v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 10).join(', ') + ']'); return; }
                if (typeof v === 'object') { probes.push(label + ' = {' + Object.keys(v).slice(0, 14).join(', ') + '}'); return; }
                probes.push(label + ' = ' + String(v));
            };
            note('ctx.world_names', () => pc.world_names);
            note('win.world_names', () => W.world_names);
            note('ctx.selected_world_info', () => pc.selected_world_info);
            note('win.selected_world_info', () => W.selected_world_info);
            note('ctx.world_info', () => pc.world_info);
            note('win.world_info', () => W.world_info);
            const st = safe(() => pc.extensionSettings || pc.extension_settings || W.extension_settings);
            note('extensionSettings keys', () => st);
            if (st && typeof st === 'object') { note('  extSettings.world_info', () => st.world_info); note('  extSettings.world_names', () => st.world_names); }
            note('power_user.world_info', () => (pc.powerUserSettings || W.power_user || {}).world_info);
            const diag = '\uD83D\uDD0E Raw WI probe (screenshot this):\n' + probes.join('\n');
            addBubble('note', diag);
            pushHistory('note', diag);
        } catch (e) { addBubble('note', 'probe error: ' + (e && e.message)); }
        // Verify the chosen book(s) actually load, since that is what matters for editing.
        const chosen = wiEffectiveBooks();
        if (chosen.length) {
            lines.push('');
            for (const b of chosen) {
                const data = await wiLoad(b);
                if (data) lines.push('\u2713 "' + b + '" loads OK (' + wiEntryList(data).length + ' entries) \u2014 the copilot can read & edit it.');
                else lines.push('\u2717 "' + b + '" did NOT load \u2014 check the exact spelling against ST\'s World Info selector.');
            }
        }
        const txt = lines.join('\n');
        addBubble('note', txt);
        pushHistory('note', txt);
    }

    async function wiBuildContext() {
        // Returns a [WORLDBOOK] block for the pilot's context, respecting mode.
        if (!wiActive()) return '';
        const books = wiEffectiveBooks();
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

    // Escape raw newlines/tabs that appear INSIDE JSON string values — the #1 cause
    // of "Expected ',' or '}'" parse failures (a model pastes a multi-line find/replace
    // with real line breaks instead of \n). Adapted from the Plot-Essential extension.
    // Content is preserved: an escaped \n parses back into a real newline.
    function escapeRawControlsInStrings(s) {
        let out = '', inStr = false, esc = false;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (esc) { out += c; esc = false; continue; }
            if (c === '\\') { out += c; esc = true; continue; }
            if (c === '"') { inStr = !inStr; out += c; continue; }
            if (inStr) {
                if (c === '\n') { out += '\\n'; continue; }
                if (c === '\r') { out += '\\r'; continue; }
                if (c === '\t') { out += '\\t'; continue; }
            }
            out += c;
        }
        return out;
    }

    // Parse JSON, repairing the common LLM slips if the first parse fails, in order:
    // (1) drop trailing commas, (2) escape raw control chars inside strings. Throws the
    // ORIGINAL error if still unparseable (its reported position is the most useful).
    function parseJsonLoose(raw) {
        try { return JSON.parse(raw); }
        catch (e0) {
            const noTrail = String(raw).replace(/,\s*([\]}])/g, '$1');
            try { return JSON.parse(noTrail); } catch (e1) { /* try next repair */ }
            try { return JSON.parse(escapeRawControlsInStrings(noTrail)); } catch (e2) { /* give up */ }
            throw e0;
        }
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
        try { arr = parseJsonLoose(raw); } catch (e) { return { edits: [], error: e.message }; }
        if (!Array.isArray(arr)) arr = [arr];
        const edits = [];
        for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            const book = String(o.book || (wiEffectiveBooks()[0] || '')).trim();
            if (!book) continue;
            void 0;
            const hasContent = (o.replace !== undefined) || (o.replace_content !== undefined) || (o.content !== undefined);
            edits.push({
                kind: 'wi', book,
                uid: (o.uid === undefined || o.uid === null) ? null : Number(o.uid),
                find: (o.find === undefined) ? null : String(o.find),
                hasContent,
                replace: o.replace !== undefined ? String(o.replace) : (o.replace_content !== undefined ? String(o.replace_content) : (o.content !== undefined ? String(o.content) : '')),
                setKeys: Array.isArray(o.set_keys) ? o.set_keys.map(String) : (Array.isArray(o.keys) ? o.keys.map(String) : null),
                setSecondaryKeys: Array.isArray(o.set_secondary_keys) ? o.set_secondary_keys.map(String) : (Array.isArray(o.keysecondary) ? o.keysecondary.map(String) : null),
                newEntry: !!o.new_entry,
                deleteEntry: !!(o.delete_entry || o.delete),
                createBook: !!(o.create_book || o.new_book),
                comment: o.comment !== undefined ? String(o.comment) : null,
                status_type: o.status !== undefined && ['normal','constant','vectorized'].includes(String(o.status)) ? String(o.status) : null,
                constant: o.constant,
                disable: o.disable,
                position: o.position !== undefined ? o.position : null,
                depth: o.depth !== undefined ? o.depth : null,
                order: o.order !== undefined ? Number(o.order) : null,
                probability: o.trigger !== undefined ? Number(o.trigger) : (o.probability !== undefined ? Number(o.probability) : null),
                role: o.role !== undefined ? o.role : null,
                reason: o.reason ? String(o.reason) : '',
                editStatus: 'pending',
            });
        }
        return { edits };
    }

    // status: 'constant' (\uD83D\uDD35 blue always-on) | 'normal' (\uD83D\uDFE2 green keyword) | 'vectorized' (\uD83D\uDD17 chain)
    function applyWiStatus(entry, statusType) {
        if (statusType === 'constant') { entry.constant = true; entry.vectorized = false; }
        else if (statusType === 'vectorized') { entry.constant = false; entry.vectorized = true; }
        else if (statusType === 'normal') { entry.constant = false; entry.vectorized = false; }
    }
    // position: accept named ('before_char'|'after_char'|'an_top'|'an_bottom'|'at_depth') or raw number.
    const WI_POS = { before_char: 0, after_char: 1, an_top: 2, an_bottom: 3, at_depth: 4 };
    function applyWiPosition(entry, pos, depth) {
        if (pos !== null && pos !== undefined) {
            if (typeof pos === 'number') entry.position = pos;
            else if (WI_POS[String(pos)] !== undefined) entry.position = WI_POS[String(pos)];
        }
        if (depth !== null && depth !== undefined && depth !== '') {
            const d = Number(depth);
            if (Number.isFinite(d)) entry.depth = d;
        }
    }
    function applyWiFields(entry, edit) {
        if (edit.comment !== null && edit.comment !== undefined) entry.comment = edit.comment;
        if (edit.setKeys) entry.key = edit.setKeys;
        if (edit.setSecondaryKeys) entry.keysecondary = edit.setSecondaryKeys;
        if (edit.status_type) applyWiStatus(entry, edit.status_type);
        if (edit.constant !== undefined && edit.constant !== null) entry.constant = !!edit.constant;
        if (edit.disable !== undefined && edit.disable !== null) entry.disable = !!edit.disable;
        applyWiPosition(entry, edit.position, edit.depth);
        if (edit.order !== null && edit.order !== undefined && Number.isFinite(edit.order)) entry.order = edit.order;
        if (edit.probability !== null && edit.probability !== undefined && Number.isFinite(edit.probability)) {
            entry.probability = edit.probability; entry.useProbability = true;
        }
        if (edit.role !== null && edit.role !== undefined) entry.role = edit.role;
    }

    async function wiCreateBook(name, firstEntry) {
        const c = ctx();
        const clean = String(name || '').trim();
        if (!clean) return { ok: false, reason: 'book name required' };
        // Refuse if it already exists (avoid clobbering).
        try {
            const existing = await c.loadWorldInfo(clean);
            if (existing && existing.entries) return { ok: false, reason: 'a book named "' + clean + '" already exists' };
        } catch (e) { /* not found = good */ }
        const data = { entries: {} };
        if (firstEntry && (firstEntry.content || firstEntry.comment)) {
            data.entries['0'] = {
                uid: 0, key: Array.isArray(firstEntry.keys) ? firstEntry.keys.map(String) : [], keysecondary: [],
                comment: String(firstEntry.comment || 'Entry'), content: String(firstEntry.content || ''),
                constant: !!firstEntry.constant, vectorized: false, selective: true, order: 100, position: 0,
                disable: false, addMemo: true, excludeRecursion: false, probability: 100, useProbability: true,
                group: '', groupOverride: false, scanDepth: null, caseSensitive: null, matchWholeWords: null,
                automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0, depth: 4,
            };
        }
        const ok = await wiSave(clean, data);
        if (!ok) return { ok: false, reason: 'save failed' };
        // Register in the global "Active World(s)" selection so it takes effect.
        try {
            const el = (typeof document !== 'undefined') && document.getElementById('world_info');
            if (el && !Array.from(el.options).some(o => (o.textContent || '').trim() === clean)) {
                try { c.updateWorldInfoList?.(); } catch (e) { /* ignore */ }
            }
            // Try the slash command to select it globally (most reliable cross-version).
            if (typeof c.executeSlashCommandsWithOptions === 'function') {
                await c.executeSlashCommandsWithOptions('/world silent=true ' + clean);
            } else if (typeof c.executeSlashCommands === 'function') {
                await c.executeSlashCommands('/world silent=true ' + clean);
            }
        } catch (e) { console.warn(LOG, 'book activation note', e); }
        return { ok: true, created: clean };
    }

    async function applyWiOne(edit) {
        if (edit.createBook) {
            const res = await wiCreateBook(edit.book, edit.hasContent || edit.comment ? { keys: edit.setKeys, comment: edit.comment, content: edit.replace, constant: edit.status_type === 'constant' } : null);
            if (!res.ok) return { ok: false, reason: res.reason };
            return { ok: true, book: edit.book, before: { __newbook: edit.book }, path: 'NEW BOOK "' + edit.book + '"' + (edit.hasContent || edit.comment ? ' + first entry' : '') };
        }
        const data = await wiLoad(edit.book);
        if (!data) return { ok: false, reason: 'book "' + edit.book + '" not found' };
        const before = JSON.parse(JSON.stringify(data));
        if (edit.deleteEntry) {
            if (edit.uid === null || edit.uid === undefined) return { ok: false, reason: 'delete needs a uid' };
            let foundKey = null;
            for (const [k, e] of Object.entries(data.entries)) {
                if (Number(e.uid) === Number(edit.uid)) { foundKey = k; break; }
            }
            if (foundKey === null) return { ok: false, reason: 'entry uid ' + edit.uid + ' not found in ' + edit.book };
            const title = String(data.entries[foundKey].comment || '').trim() || '(untitled)';
            delete data.entries[foundKey];
            const ok = await wiSave(edit.book, data);
            return ok ? { ok: true, book: edit.book, before, path: edit.book + '#' + edit.uid + ' DELETED "' + title + '"' } : { ok: false, reason: 'save failed' };
        }
        if (edit.newEntry) {
            let maxUid = -1;
            for (const e of wiEntryList(data)) maxUid = Math.max(maxUid, Number(e.uid));
            const uid = maxUid + 1;
            const entry = {
                uid, key: [], keysecondary: [], comment: 'New entry',
                content: '', constant: false, vectorized: false, selective: true,
                order: 100, position: 0, disable: false, addMemo: true, excludeRecursion: false,
                probability: 100, useProbability: true, group: '', groupOverride: false, scanDepth: null,
                caseSensitive: null, matchWholeWords: null, automationId: '', role: null, sticky: 0, cooldown: 0, delay: 0, depth: 4,
            };
            if (edit.hasContent) entry.content = edit.replace || '';
            applyWiFields(entry, edit);
            data.entries[String(uid)] = entry;
            const ok = await wiSave(edit.book, data);
            return ok ? { ok: true, book: edit.book, before, path: edit.book + '#' + uid + ' (new)' } : { ok: false, reason: 'save failed' };
        }
        const entry = wiEntryList(data).find(e => Number(e.uid) === edit.uid);
        if (!entry) return { ok: false, reason: 'entry uid ' + edit.uid + ' not found in ' + edit.book };
        // content edit only when explicitly provided
        if (edit.hasContent && edit.find === null) {
            entry.content = edit.replace;
        } else if (edit.find !== null) {
            const cur = String(entry.content || '');
            const cnt = cur.split(edit.find).length - 1;
            if (cnt === 0) return { ok: false, reason: 'find text not in entry (content changed?)' };
            if (cnt > 1) return { ok: false, reason: 'find matches ' + cnt + ' places \u2014 use a longer unique excerpt' };
            entry.content = cur.replace(edit.find, edit.replace);
        }
        applyWiFields(entry, edit);
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
        'WORLDBOOK (World Info) is shown in the [WORLDBOOK] block, referenced as WB[book#uid]. It is part of the world canon \u2014 audit it for continuity like [STORY MEMORY] (contradictions with the notepad, snippets, or chat).',
        'In catalog mode you see titles/keys/snippets; request full text with <wifetch>["book#uid", ...] (same loop as <fetch>).',
        'To edit the Worldbook, emit a <wiedits> block (JSON array). Ops:',
        '{"book":"Name","uid":3,"find":"verbatim excerpt","replace":"new text","reason":".."} \u2014 targeted edit; find must be unique in that entry.',
        '{"book":"Name","uid":3,"replace_content":"entire new entry text","reason":".."} \u2014 whole-entry replace.',
        '{"book":"Name","uid":3,"set_keys":["a","b"],"reason":".."} \u2014 update trigger keywords.',
        '{"book":"Name","new_entry":true,"comment":"Title","keys":["k"],"content":"..","status":"normal","reason":".."} \u2014 add an entry.',
        '{"book":"Name","uid":3,"delete_entry":true,"reason":".."} \u2014 permanently remove an entry (reversible via Undo). Use only when the user asks to delete, or an entry is a genuine duplicate/obsolete \u2014 never delete lore just to tidy.',
        '{"book":"New Book Name","create_book":true,"comment":"Title","keys":["k"],"content":"..","reason":".."} \u2014 create a brand-NEW lorebook file (comment/keys/content optionally seed a first entry; status:"constant" makes it always-on). Use ONLY when the user explicitly wants a SEPARATE new book. To add lore to the existing active book instead, use new_entry.',
        'You can also set entry CONFIG (include only the fields you want to change):',
        '  "comment":"new title" \u2014 rename the entry (organizational label only; NOT sent to the story).',
        '  "status":"constant"|"normal"|"vectorized".',
        '  "position":"before_char"|"after_char"|"an_top"|"an_bottom"|"at_depth", plus "depth":N when position is at_depth.',
        '  "order":N, "trigger":N (0-100), "set_keys":[..], "set_secondary_keys":[..], "disable":true/false.',
        '',
        'WHAT EACH SETTING MEANS (use this to judge whether an entry is in the CORRECT place / config):',
        '\u2022 STATUS \u2014 how an entry activates. constant (\uD83D\uDD35): injected EVERY turn no matter what; costs tokens permanently; correct ONLY for always-relevant spine lore (core world rules, the ranking system, the current premise). normal (\uD83D\uDFE2, default): injected ONLY when one of its keywords appears in recent messages; correct for most entries \u2014 specific characters, places, factions, items that matter only when mentioned. vectorized (\uD83D\uDD17): keyless; activates by semantic similarity (needs the Vector Storage extension); correct for lore that should surface by topic even when the exact keyword is not spoken.',
        '\u2022 KEYS \u2014 the trigger words for normal entries. An entry only fires if a key literally appears in the scanned text. Keys must cover the ways the subject is actually referred to (name + aliases + epithets). MISSING keys = the entry silently never fires. Only content is sent to the model; keys and title are not.',
        '\u2022 POSITION \u2014 where in the prompt the content is inserted. before_char / after_char sit around the character definition (good for background lore). an_top / an_bottom ride with the Author\'s Note. at_depth + depth:N injects N messages deep in the chat (depth 0 = very bottom / most recent); low depth = the model weighs it more heavily and immediately. Use at_depth low for rules that must be obeyed RIGHT NOW; use before/after_char for ambient background.',
        '\u2022 ORDER \u2014 tie-break priority when several entries are inserted at the same spot; higher order is placed later (closer to the prompt end = usually more influence). Raise it for entries that must win over competing lore.',
        '\u2022 TRIGGER % \u2014 activation probability. 100 = always fires when keys match (correct for lore). Below 100 = random chance; only for flavor/variety entries, never for hard canon.',
        '\u2022 DISABLE \u2014 entry is off entirely.',
        '',
        'AUDIT HEURISTICS \u2014 flag an entry as MISCONFIGURED when:',
        '  \u2013 It is spine/always-relevant lore but status is normal or keyworded (should be constant), OR it is niche lore but status is constant (wasting tokens every turn \u2014 should be normal).',
        '  \u2013 A normal entry\'s keys omit obvious aliases/epithets the story uses for that subject (it will silently fail to fire). Propose set_keys adding them.',
        '  \u2013 A must-obey rule sits at before/after_char or high depth where the model underweights it (consider at_depth with low depth), or trivial background sits at low depth crowding recent context.',
        '  \u2013 trigger < 100 on canonical lore (should be 100).',
        '  \u2013 Content contradicts [STORY MEMORY] or the chat \u2014 fix the content.',
        '  \u2013 Duplicate/overlapping entries competing for the same subject with conflicting order.',
        'Report WHY an entry is misconfigured and what the correct setting is. Do NOT churn config that is already reasonable \u2014 only propose a change you can justify. When the user asks \u201Cis this the right place/settings?\u201D, walk the entry against these heuristics and answer plainly, proposing wiedits only where a real problem exists.',
    ].join('\n');

    function sysPrompt() {
        const rule = settings.allowUserEdits
            ? 'You may edit user-authored messages when the user asks for it.'
            : 'Never propose edits to user-authored messages; they are read-only.';
        let out = String(settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace('USER_EDIT_RULE', rule) + '\n\n' + BEHAVIOR_RULES + '\n\n' + CHAT_EDIT_EXTRAS + '\n\n' + MEMEDIT_RULES;
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
            .map(m => (m.role === 'user' ? '[User]\n' : '[Assistant]\n') + m.content)
            .join('\n\n') + '\n\n[Assistant]\n';
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
            const arr = parseJsonLoose(raw);
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
            const arr = parseJsonLoose(raw);
            if (!Array.isArray(arr)) return { edits: [], error: 'memedits block is not a JSON array' };
            const edits = [];
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                const path = (typeof e.path === 'string' && e.path.trim()) ? e.path.trim() : null;
                const find = (typeof e.find === 'string' && e.find.length) ? e.find : null;
                if (!find && !path) continue;
                const structured = (e.replace != null && typeof e.replace === 'object');
                edits.push({ kind: 'mem', path, find, replace: structured ? e.replace : String(e.replace ?? ''), append: (e.append !== undefined ? e.append : undefined), reason: String(e.reason ?? ''), status: 'pending' });
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
        cut('supersede', '');
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
            let loc = locate(before, edit.find);
            let effReplace = String(edit.replace ?? '');
            if (!loc) {
                const md = minimalDiff(edit.find, effReplace);
                if (md) {
                    const loc2 = locate(before, md.coreFind);
                    if (loc2 && !loc2.ambiguous) { loc = loc2; effReplace = md.coreReplace; }
                }
            }
            if (loc && loc.ambiguous) return { ok: false, reason: 'anchor matches ' + (typeof loc.ambiguous === 'number' ? loc.ambiguous + ' places' : 'multiple similar places') + ' in this message \u2014 give a longer unique excerpt' };
            if (!loc) return { ok: false, reason: edit.seenAtReview ? 'message changed since review \u2014 regenerate and apply fresh cards' : '"find" text not located (even fuzzy)' };
            next = before.slice(0, loc.start) + effReplace + before.slice(loc.end);
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

    function stripMemLabels(text) {
        // [bracketed.path] lines are display labels gatherMemory adds to show which field text belongs to;
        // they are NOT stored content. Strip them from find/replace so the excerpt matches the real text
        // (and so a label never gets inserted into the stored memory).
        return String(text == null ? '' : text)
            .split('\n')
            .filter(function (ln) { return !/^\s*\[[^\n]*\.[^\n]*\]\s*$/.test(ln); })
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\n+|\n+$/g, '');
    }

    // From a find/replace pair, isolate the minimal span that actually changed (strip the common
    // prefix + suffix). Salvages anchors the model padded with location text or stitched together.
    function minimalDiff(find, replace) {
        if (typeof find !== 'string' || typeof replace !== 'string' || find === replace) return null;
        let p = 0;
        const maxP = Math.min(find.length, replace.length);
        while (p < maxP && find.charCodeAt(p) === replace.charCodeAt(p)) p++;
        let s = 0;
        const maxS = Math.min(find.length - p, replace.length - p);
        while (s < maxS && find.charCodeAt(find.length - 1 - s) === replace.charCodeAt(replace.length - 1 - s)) s++;
        const coreFind = find.slice(p, find.length - s);
        const coreReplace = replace.slice(p, replace.length - s);
        if (!coreFind || coreFind === find) return null;
        if (coreFind.trim().length < 3) return null;
        return { coreFind: coreFind, coreReplace: coreReplace };
    }

    function applyMemOne(edit, keyBackups) {
        const res = applyMemOneInner(edit, keyBackups);
        if (res.ok || !edit || edit._reduced || typeof edit.find !== 'string') return res;
        // Salvage: the model padded the anchor with location text (e.g. "in layer 0[10]") or stitched two
        // separate entries with a connective word. Reduce to the minimal changed span and retry ONCE.
        // applyMemOneInner keeps its uniqueness/ambiguity guards, so this only applies on a unique match
        // (it can turn a clean failure into a correct edit, never corrupt or mis-apply).
        const md = minimalDiff(edit.find, String(edit.replace == null ? '' : edit.replace));
        if (!md) return res;
        const reduced = Object.assign({}, edit, { find: md.coreFind, replace: md.coreReplace, path: undefined, _reduced: true });
        const res2 = applyMemOneInner(reduced, keyBackups);
        return res2.ok ? res2 : res;
    }

    function applyMemOneInner(edit, keyBackups) {
        if (typeof edit.find === 'string') edit.find = stripMemLabels(edit.find);
        if (typeof edit.replace === 'string') edit.replace = stripMemLabels(edit.replace);
        if (typeof edit.append === 'string') edit.append = stripMemLabels(edit.append);
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
            if (typeof node === 'string') {
                const backupVal = typeof md[rootKey] === 'object' ? JSON.parse(JSON.stringify(md[rootKey])) : md[rootKey];
                if (edit.append !== undefined) {
                    if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, backupVal);
                    const tail = String(typeof edit.append === 'object' ? JSON.stringify(edit.append) : edit.append);
                    parent[key] = node + (node.replace(/\s+$/, '').length ? '\n\n' : '') + tail;
                    return { ok: true, path: edit.path + ' (appended to field)' };
                }
                if (edit.find) {
                    const loc = locate(node, edit.find);
                    if (loc && !loc.ambiguous) {
                        if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, backupVal);
                        parent[key] = node.slice(0, loc.start) + String(edit.replace ?? '') + node.slice(loc.end);
                        return { ok: true, path: edit.path, fuzzy: !!loc.fuzzy };
                    }
                    // excerpt not uniquely in that exact field \u2014 fall through to the memory-wide search below
                } else {
                    if (edit.reviewHash && hashText(node) !== edit.reviewHash) return { ok: false, reason: 'field changed since review \u2014 re-run the audit and apply fresh cards' };
                    if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, backupVal);
                    parent[key] = String(edit.replace ?? '');
                    return { ok: true, path: edit.path + ' (full replace)', fuzzy: false };
                }
            } else if (edit.append !== undefined && Array.isArray(node)) {
                const bkp = typeof md[rootKey] === 'object' ? JSON.parse(JSON.stringify(md[rootKey])) : md[rootKey];
                if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, bkp);
                node.push(edit.append);
                return { ok: true, path: edit.path + ' (appended 1 item)' };
            } else if (!edit.find) {
                let val = edit.replace;
                if (typeof val === 'string' && val.trim()) { try { const pj = JSON.parse(val); if (pj && typeof pj === 'object') val = pj; } catch (e) { /* not json */ } }
                if (val != null && typeof val === 'object') {
                    const bkp = typeof md[rootKey] === 'object' ? JSON.parse(JSON.stringify(md[rootKey])) : md[rootKey];
                    if (!keyBackups.has(rootKey)) keyBackups.set(rootKey, bkp);
                    parent[key] = val;
                    return { ok: true, path: edit.path + ' (structural replace)' };
                }
                return { ok: false, reason: 'that path is a list/object \u2014 to change it, give "replace" as a JSON array/object (e.g. "replace": ["thread one","thread two"]) or "append" a value; find/replace cannot edit a structured field' };
            }
            // Path did not land on an editable text field (e.g. a Summaryception ledger threads array), or the
            // excerpt was not uniquely in the named field. Since we have a "find", fall through to the memory-wide
            // search below, which recursively locates the excerpt anywhere in memory (including inside lists).
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
        const wiApplied = [];
        const keyBackups = new Map();
        const wiBackups = new Map();
        for (const edit of list) {
            const st = edit.kind === 'wi' ? edit.editStatus : edit.status;
            if (st !== 'pending') continue;
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
                    edit.editStatus = 'applied \u2192 WB ' + res.path;
                    wiApplied.push(res.path);
                    if (!wiBackups.has(res.book)) wiBackups.set(res.book, res.before);
                } else {
                    edit.editStatus = 'failed: ' + res.reason;
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
            if (wiApplied.length) labelParts.push('worldbook: ' + wiApplied.join(', '));
            undoStack.push({ label: labelParts.join(' + '), items });
            if (chatApplied.length) await commitChanges(chatApplied.map(a => a.id));
            if (memPaths.length) { saveMeta(); applyCritiqueInjection(); }
            const total = chatApplied.length + memPaths.length + wiApplied.length;
            const note = 'Applied ' + total + ' edit(s): ' + labelParts.join(' + ') + '.' + (memPaths.length ? ' Memory updated \u2014 Summaryception uses it from the next generation.' : '') + (wiApplied.length ? ' Worldbook saved.' : '');
            addBubble('note', note);
            pushHistory('note', note);
            toast(note, 'success');
        }
        else {
            // Nothing was applied \u2014 tell the user why instead of silently doing nothing.
            const anyPending = list.some(e => (e.kind === 'wi' ? e.editStatus : e.status) === 'pending');
            const anyFailed = list.some(e => String(e.kind === 'wi' ? e.editStatus : e.status).startsWith('failed'));
            if (!anyPending && anyFailed) {
                addBubble('note', 'No edits applied \u2014 the proposed change(s) failed (likely the target text changed, or a stale card). Ask the copilot to re-propose against the current text.');
            } else if (!list.length) {
                addBubble('note', 'No pending edits to apply.');
            }
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
                if (item.before && item.before.__newbook) {
                    // Undo of a created book: empty it (best effort \u2014 ST keeps no getContext book-delete).
                    await wiSave(item.book, { entries: {} });
                    memRestored = false;
                } else {
                    await wiSave(item.book, item.before);
                }
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
               (looksTruncated(sp.rest, 'edits') || looksTruncated(sp.rest, 'memedits'))) {
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
            const pend = pendingProposalsBlock();
            if (pend) messages.splice(2, 0, { role: 'system', content: pend });

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
                    const note = '\uD83C\uDF10 Assistant read full Worldbook entries: ' + wiRefs.join(', ');
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
                    const note = 'Assistant read full text of #' + fresh.join(', #') + ' (fetch ' + (round + 1) + '/' + rounds + ')' + (fresh.length < ids.length ? ' \u2014 skipped ' + (ids.length - fresh.length) + ' already-fetched' : '');
                    addBubble('note', note);
                    pushHistory('note', note);
                    let payload = '[FETCHED MESSAGES]\n' + fullTextOf(fresh);
                    if (round === rounds - 1) payload += '\n\n(This was your final fetch \u2014 produce your complete answer now; further fetch requests will not be served.)';
                    messages.push({ role: 'user', content: payload });
                } else {
                    const note = 'Assistant re-requested already-fetched messages \u2014 told it to answer now.';
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
            let didSupersede = 0;
            const supersedeLabels = parseSupersede(reply);
            if (supersedeLabels.length && pendingEdits.length) {
                const labeledNow = labelForEdits(pendingEdits);
                for (const lbl of supersedeLabels) {
                    const norm = lbl.trim().toLowerCase();
                    const hit = labeledNow.find(x => x.label.toLowerCase() === norm);
                    if (hit) { if (hit.edit.kind === 'wi') hit.edit.editStatus = 'skipped'; else hit.edit.status = 'skipped'; didSupersede++; }
                }
            }
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
            }
            if (didSupersede) addBubble('note', '\u21A9 Auto-skipped ' + didSupersede + ' proposal(s) the assistant replaced \u2014 "Apply all" will ignore them.');
            if (allEdits.length || didSupersede) renderEditCards();
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
            preEl.textContent = 'Chat Assistant v' + VERSION + ' \u2014 drag me by this top bar. Close: the Close button, tapping the dark area, or Esc.\n\n' + text;
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
            '  <span class="cc_title">Chat Assistant</span>',
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
            '          <button class="cc_btn" id="cc_wi_detect" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Inspect ST and report where your Worldbooks live">\uD83C\uDF10 Worldbook: detect</button>',
            '          <button class="cc_btn" id="cc_namechat" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Read the thread and suggest a descriptive name for this chat file (good for telling branches apart), then rename it">\uD83C\uDFF7\uFE0F Auto-name this chat</button>',
            '          <button class="cc_btn" id="cc_renamechat" style="display:block;width:100%;margin:3px 0;text-align:left;" title="Type a new name for the current chat file">\u270F\uFE0F Rename this chat</button>',
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
        el('cc_wi_detect').addEventListener('click', () => wiDetectReport());
        el('cc_namechat').addEventListener('click', () => nameChatAuto());
        el('cc_renamechat').addEventListener('click', () => renameChatManual());
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

    function resetAllSettings() {
        try { if (!confirm('Reset ALL Chat Assistant settings to their tested defaults?\n\nThis restores every prompt, toggle, cadence, and number to baseline. Your Connection Profile stays selected, and your chats, memory, director state, and critique notes are NOT touched. This cannot be undone.')) return; } catch (e) { return; }
        const c = ctx();
        const keepProfile = settings.profileId;
        const fresh = JSON.parse(JSON.stringify(defaults));
        fresh.profileId = keepProfile;
        c.extensionSettings[MODULE] = fresh;
        settings = fresh;
        try { persistSettings(); } catch (e) { /* ignore */ }
        try { buildSettingsUI(); } catch (e) { /* ignore */ }
        try { applyInjections(); } catch (e) { /* ignore */ }
        toast('All settings reset to tested defaults (Connection Profile kept).', 'success');
        addBubble('note', '\u267B\uFE0F All settings reset to their tested defaults. Your Connection Profile, chats, memory, director, and critique are unchanged.');
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
            '  <button class="cc_btn" id="cc_resetall" style="border-color:rgba(220,120,60,0.7);color:#f0b080;">\u267B\uFE0F Reset ALL settings to defaults</button>',
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
        el('cc_resetall').addEventListener('click', () => resetAllSettings());
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

    // Consistent per-kind labels for pending edits: "Chat fix 1", "Memory fix 1", "Worldbook fix 1".
    // Used identically by the cards, the assistant-awareness block, and supersede matching.
    function labelForEdits(list) {
        let cN = 0, mN = 0, wN = 0;
        return list.map(function (edit) {
            let label;
            if (edit.kind === 'wi') { wN++; label = 'Worldbook fix ' + wN; }
            else if (edit.kind === 'mem') { mN++; label = 'Memory fix ' + mN; }
            else { cN++; label = 'Chat fix ' + cN; }
            return { edit: edit, label: label };
        });
    }

    // Context block that makes the assistant AWARE of its own not-yet-applied proposals,
    // so it references them by label and marks any it replaces via <supersede>.
    function pendingProposalsBlock() {
        if (!pendingEdits.length) return '';
        const clip = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, 70); };
        const lines = labelForEdits(pendingEdits).map(function (x) {
            const edit = x.edit;
            let target, summary;
            if (edit.kind === 'wi') {
                target = edit.book || 'worldbook';
                summary = edit.createBook ? 'create book' : (edit.deleteEntry ? 'delete entry' : (edit.newEntry ? 'new entry' : 'edit entry #' + (edit.uid != null ? edit.uid : '?')));
            } else if (edit.kind === 'mem') {
                target = edit.path || 'memory';
                summary = (edit.find == null) ? 'replace whole field' : ('"' + clip(edit.find) + '" \u2192 "' + clip(edit.replace) + '"');
            } else {
                target = 'message #' + edit.id;
                summary = (edit.hide !== null && edit.hide !== undefined) ? (edit.hide ? 'hide from AI context' : 'unhide') : ((edit.find == null) ? 'replace whole message' : ('"' + clip(edit.find) + '" \u2192 "' + clip(edit.replace) + '"'));
            }
            const status = (edit.kind === 'wi') ? edit.editStatus : edit.status;
            return x.label + ' [' + target + ']' + (status && status !== 'pending' ? ' (' + status + ')' : '') + ': ' + summary + (edit.reason ? ' \u2014 ' + edit.reason : '');
        });
        const failed = labelForEdits(pendingEdits).filter(function (x) {
            const stx = (x.edit.kind === 'wi') ? x.edit.editStatus : x.edit.status;
            return typeof stx === 'string' && stx.indexOf('failed') === 0;
        }).map(function (x) { return x.label; });
        const failNote = failed.length
            ? ('\n\nSOME PROPOSALS FAILED TO APPLY: ' + failed.join(', ') + '. They failed because the "find" excerpt did not match the source text exactly \u2014 either it was paraphrased instead of copied, OR it tried to do too much at once. To fix each: for a CHAT edit, if you do NOT already have that message\'s FULL text above, <fetch> that message first and copy the "find" verbatim; for a MEMORY edit, copy the "find" CHARACTER-FOR-CHARACTER from [STORY MEMORY]. Never paraphrase. CRUCIAL: keep each edit TINY \u2014 correct only the specific wrong words. A "find" must be ONE contiguous run that ALREADY EXISTS verbatim: do NOT stitch two fields or two thread entries together (they are stored separately and can never match as one block), and find/replace can NEVER add new sentences or new threads (it only changes text that is already there). If a big change is needed, break it into several tiny edits or a single whole-field "path" replace. If unsure, the one wrong word can be the whole "find" (e.g. find "Two-fourteen", replace "Two-thirty-eight"). Do not drop them silently.')
            : '';
        return '[PENDING PROPOSALS \u2014 you already proposed these; they are NOT yet applied and are awaiting the user]\n' +
            lines.join('\n') +
            failNote +
            '\n\nWhen you next propose edits: only propose NEW fixes. If you are CORRECTING or REPLACING any pending proposal above, do NOT re-list it as-is \u2014 name its exact label(s) in a <supersede> block (e.g. <supersede>Memory fix 1, Chat fix 2</supersede>) and give the corrected version as a fresh edit; the superseded ones are auto-skipped so "Apply all" stays clean. Refer to these by their labels when you talk to the user.';
    }

    // Parse a <supersede> block: pending-proposal labels the new reply replaces.
    function parseSupersede(text) {
        const b = findBlock(text, 'supersede');
        if (!b) return [];
        let raw = String(b.inner || '').trim();
        if (!raw) return [];
        try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr.map(String).map(function (s) { return s.trim(); }).filter(Boolean); } catch (e) { /* not JSON */ }
        return raw.split(/[,\n;]+/).map(function (s) { return s.trim().replace(/^["'\[]+|["'\]]+$/g, '').trim(); }).filter(Boolean);
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

        const labeled = labelForEdits(pendingEdits);
        const maxBatch = pendingEdits.reduce((mx, e) => Math.max(mx, e.batch || 1), 1);
        let lastBatch = null;
        pendingEdits.forEach((edit, idx) => {
            const isMem = edit.kind === 'mem';
            const isWi = edit.kind === 'wi';
            const msg = (isMem || isWi) ? null : chat[edit.id];
            const who = (isMem || isWi) ? '' : (msg ? (msg.is_user ? 'USER' : (msg.name || 'AI')) : '?');
            let label, wiDetail = '', cfgStr = '';
            if (isWi) {
                const act = edit.createBook ? '\uD83D\uDCD5 CREATE BOOK' : (edit.deleteEntry ? ('\uD83D\uDDD1 delete #' + edit.uid) : (edit.newEntry ? 'new entry' : ('edit #' + edit.uid)));
                label = '\uD83C\uDF10 ' + esc(act);
                wiDetail = esc(edit.book);
            } else {
                label = isMem ? 'MEMORY' : ('#' + edit.id + ' ' + esc(who));
            }
            label = '<span style="background:rgba(120,150,255,0.18);padding:1px 6px;border-radius:4px;font-size:0.9em;white-space:nowrap;">' + esc(labeled[idx].label) + '</span> ' + label;
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
                ? (edit.createBook ? '(create new lorebook "' + edit.book + '"' + (edit.hasContent || edit.comment ? ' with a first entry' : ' empty') + ')' : (edit.deleteEntry ? '\u26A0 DELETE this entry permanently (Undo restores it)' : (edit.newEntry ? '(new entry: ' + (edit.comment || '') + ')' : (edit.setKeys ? '(set keys: ' + edit.setKeys.join(', ') + ')' : (edit.find == null ? '(replace entry content)' : edit.find)))))
                : (!isMem && edit.hide !== null && edit.hide !== undefined)
                ? (edit.hide ? '(hide message from AI context \u2014 text stays in log)' : '(unhide message)')
                : edit.find == null
                    ? (isMem ? (edit.append !== undefined ? '(append to ' + (edit.path || '?') + ')' : '(replace field: ' + (edit.path || '?') + ')') : '(replace entire message)')
                    : edit.find;
            const replaceShown = (edit.append !== undefined)
                ? (typeof edit.append === 'object' ? JSON.stringify(edit.append, null, 2) : String(edit.append))
                : (edit.replace != null && typeof edit.replace === 'object' ? JSON.stringify(edit.replace, null, 2) : String(edit.replace == null ? '' : edit.replace));
            if (isWi) {
                const cfg = [];
                if (edit.status_type) cfg.push('status=' + edit.status_type);
                if (edit.comment !== null && edit.comment !== undefined) cfg.push('title="' + edit.comment + '"');
                if (edit.position !== null) cfg.push('pos=' + edit.position);
                if (edit.depth !== null) cfg.push('depth=' + edit.depth);
                if (edit.order !== null) cfg.push('order=' + edit.order);
                if (edit.probability !== null) cfg.push('trigger=' + edit.probability + '%');
                if (edit.setSecondaryKeys) cfg.push('2nd-keys');
                if (edit.disable !== undefined && edit.disable !== null) cfg.push(edit.disable ? 'DISABLE' : 'ENABLE');
                if (cfg.length) { cfgStr = cfg.join(' \u00b7 '); }
            }
            const st = isWi ? edit.editStatus : edit.status;
            const sstr = typeof st === 'string' ? st : '';
            if (sstr.indexOf('applied') === 0) card.style.cssText = 'border-left:3px solid rgba(90,200,130,0.9);opacity:0.58;';
            else if (sstr.indexOf('failed') === 0) card.style.cssText = 'border-left:3px solid rgba(235,150,55,0.95);background:rgba(235,150,55,0.07);';
            else if (sstr === 'skipped') card.style.cssText = 'opacity:0.5;';
            // Which cards support inline replacement-text editing: anything with a replace/content payload.
            const canEditText = !edit.deleteEntry && !(edit.hide !== null && edit.hide !== undefined && edit.find == null && !edit.replace) && (edit.replace !== undefined);
            card.innerHTML =
                '<div class="cc_card_top"><b>' + label + '</b>' + (wiDetail ? '<i style="opacity:0.85;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + wiDetail + '</i>' : '') + '<span style="flex:1 1 auto;"></span>' +
                (st === 'pending'
                    ? '<button class="cc_btn" data-cc-apply="' + idx + '">Apply</button>' + (canEditText ? '<button class="cc_btn" data-cc-editcard="' + idx + '" title="Hand-edit the new text before applying">\u270E</button>' : '') + '<button class="cc_btn" data-cc-skip="' + idx + '">Skip</button>'
                    : '') +
                '</div>' +
                (edit.reason ? '<div style="opacity:0.9;margin:3px 0 5px;line-height:1.35;word-break:break-word;">' + esc(edit.reason) + '</div>' : '') +
                (isWi && cfgStr ? '<div class="cc_card_status" style="opacity:0.8;">config: ' + esc(cfgStr) + '</div>' : '') +
                ((isWi && (edit.deleteEntry || (!edit.hasContent && edit.find === null))) ? (edit.deleteEntry ? '<div class="cc_diff cc_before" style="max-height:110px;overflow:hidden;">' + esc(findShown) + '</div>' : '') : '<div class="cc_diff cc_before" style="max-height:110px;overflow:hidden;">' + esc(findShown) + '</div><div class="cc_diff cc_after">' + esc(replaceShown) + '</div>') +
                (edit.edited ? '<div class="cc_card_status" style="opacity:0.7;">\u270E edited by you</div>' : '') +
                (st !== 'pending' ? '<div class="cc_card_status"' + (sstr.indexOf('failed')===0?' style="color:#f2ad5e;font-weight:600;"':sstr.indexOf('applied')===0?' style="color:#7ad39a;"':'') + '>' + (sstr.indexOf('failed')===0?'\u26A0 ':sstr.indexOf('applied')===0?'\u2713 ':'') + esc(st) + '</div>' : '');
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
        box.querySelectorAll('[data-cc-editcard]').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = Number(btn.getAttribute('data-cc-editcard'));
                const e = pendingEdits[i];
                if (!e) return;
                const title = '\u270E Edit the replacement text before applying';
                showViewer(title, String(e.replace ?? ''), (t) => {
                    e.replace = String(t);
                    e.edited = true;
                    if (e.kind === 'wi' && e.find === null) e.hasContent = true;
                    renderEditCards();
                    addBubble('note', 'Proposal edited \u2014 apply it when ready.');
                });
            });
        });
        box.querySelectorAll('[data-cc-skip]').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = Number(btn.getAttribute('data-cc-skip'));
                if (pendingEdits[i].kind === 'wi') pendingEdits[i].editStatus = 'skipped';
                else pendingEdits[i].status = 'skipped';
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
        div.title = 'Toggle Chat Assistant';
        div.innerHTML = '<i class="fa-solid fa-user-pen"></i><span>Chat Assistant</span>';
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
                c.registerSlashCommand('cc', handler, [], '<span>— toggle Chat Assistant / send it a request</span>', true, true);
                return;
            }
        } catch (e) { /* ignore */ }
        try {
            if (c.SlashCommandParser?.addCommandObject && c.SlashCommand?.fromProps) {
                c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                    name: 'cc',
                    callback: handler,
                    helpString: 'Toggle Chat Assistant, or send it a request: /cc why is Jillian on the train, fix it',
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

    function sanitizeChatName(raw) {
        return String(raw || '')
            .replace(/[\\/:*?"<>|{}\[\]\n\r\t]+/g, ' ')
            .replace(/^[\/\s.]+/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80)
            .trim();
    }

    async function renameChatFile(rawName) {
        const c = ctx();
        const name = sanitizeChatName(rawName);
        if (!name) { toast('Empty or invalid name \u2014 not renamed.', 'error'); return false; }
        // ST quirk (issue #3236): /renamechat can revert msg 0 or error unless the chat was just saved.
        try { if (typeof c.saveChat === 'function') await c.saveChat(); } catch (e) { /* ignore */ }
        await new Promise(function (r) { setTimeout(r, 150); });
        try {
            if (typeof c.executeSlashCommandsWithOptions === 'function') {
                await c.executeSlashCommandsWithOptions('/renamechat ' + name);
            } else if (typeof c.executeSlashCommands === 'function') {
                await c.executeSlashCommands('/renamechat ' + name);
            } else {
                toast('This SillyTavern build does not expose slash execution \u2014 cannot rename from here.', 'error');
                return false;
            }
        } catch (e) {
            toast('Rename failed (' + (e && e.message ? e.message : e) + '). If it says the name is unchanged, pick a different one.', 'error');
            return false;
        }
        toast('\uD83C\uDFF7\uFE0F Chat renamed to: ' + name, 'info');
        addBubble('note', '\uD83C\uDFF7\uFE0F Renamed this chat file to \u201C' + name + '\u201D.');
        return name;
    }

    async function suggestChatName() {
        const c = ctx();
        const mem = gatherMemory();
        const chat = c.chat || [];
        const ids = [];
        for (let i = Math.max(0, chat.length - 12); i < chat.length; i++) ids.push(i);
        const recent = ids.length ? fullTextOf(ids) : '';
        const sys = 'You name a roleplay chat file so different branches and checkpoints are easy to tell apart at a glance. Read the story below and produce ONE concise, specific title of 3 to 8 words capturing what is DISTINCTIVE about THIS particular thread \u2014 the pivotal event, decision, turn, or current situation \u2014 not a generic series name. Plain words, spaces and hyphens only; no quotes, colons, slashes, or emojis. Output ONLY the title on a single line, nothing else.';
        const user = '[STORY MEMORY]\n' + (mem || '(none)') + '\n\n[RECENT MESSAGES]\n' + (recent || '(none)') + '\n\nTitle:';
        const sp = await callLLMSmart([{ role: 'system', content: sys }, { role: 'user', content: user }]);
        let t = (sp && sp.rest ? sp.rest : '').trim();
        const lines = t.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        return sanitizeChatName(lines.length ? lines[0] : '');
    }

    async function nameChatAuto() {
        if (running) return;
        const c = ctx();
        if (!Array.isArray(c.chat)) { toast('No chat loaded.', 'error'); return; }
        if (!settings.profileId) { toast('Set a Connection Profile first (gear settings) to auto-name.', 'error'); return; }
        running = true; setBusy(true);
        const busyNote = addBubble('busy', 'reading the thread to suggest a chat name\u2026');
        let suggestion = '';
        try { suggestion = await suggestChatName(); }
        catch (e) { addBubble('note', 'Name suggestion failed: ' + (e && e.message ? e.message : e)); }
        finally { busyNote.remove(); running = false; setBusy(false); }
        if (!suggestion) { toast('Could not generate a name \u2014 use Rename this chat to type one.', 'error'); return; }
        const chosen = prompt('Rename this chat file to (edit if you like):', suggestion);
        if (chosen === null) return;
        await renameChatFile(chosen);
    }

    async function renameChatManual() {
        const chosen = prompt('Rename this chat file to:', '');
        if (chosen === null) return;
        await renameChatFile(chosen);
    }

    function purgeCharacterLedger() {
        // The character-ledger feature was removed; drop its leftover chat metadata so it
        // cannot linger as stale memory (its key matched the memory regex) or waste space.
        try {
            const md = ctx().chatMetadata || ctx().chat_metadata;
            if (!md) return;
            let changed = false;
            if ('cc_memory_ledger' in md) { delete md.cc_memory_ledger; changed = true; }
            if ('cc_memory_ledger_backups' in md) { delete md.cc_memory_ledger_backups; changed = true; }
            if (changed) saveMeta();
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
                purgeCharacterLedger();
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
            purgeCharacterLedger();
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
