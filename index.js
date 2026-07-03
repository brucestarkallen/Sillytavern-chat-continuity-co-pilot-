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
    const VERSION = '1.2.0';

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
        '- Use <edits> only for chat messages and <memedits> only for memory. Never mix them.',
    ].join('\n');

    const AUDIT_PROMPT = 'Audit the whole chat against [STORY MEMORY]. Look for continuity and logic errors: wrong locations, wrong character knowledge (information quarantine breaks), timeline contradictions, dropped or duplicated plot state. Fetch full messages if you need them, then list what you found and propose fixes in an <edits> block.';

    const DEFAULT_SHORTCUTS = [
        '#s = Check the CURRENT session against [STORY MEMORY]. Use <fetch> to pull any listed messages you have not seen in full. Then find (1) events, facts, or state changes MISSING from the memory and (2) memory entries that are stale or contradicted by the chat. Propose every correction in a single <memedits> block with "find" copied verbatim from [STORY MEMORY]. Do NOT propose <edits> to chat messages unless I explicitly ask.',
        '#f = Check the chat against [STORY MEMORY] and fix every continuity error you find with a single <edits> block.',
        '#i = Brainstorm what could happen next. Give 3-5 distinct directions for the upcoming scene(s), each consistent with [STORY MEMORY] and the current situation: a one-line hook plus what it would develop. Do not write the scene itself and do not propose <edits>.',
    ].join('\n');

    const defaults = {
        profileId: '',
        recentFull: 8,
        fetchRounds: 3,
        maxTokens: 2048,
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
        shortcuts: DEFAULT_SHORTCUTS,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
    };

    let settings = null;
    let pendingEdits = [];   // [{id, find, replace, reason, status}]
    let undoStack = [];      // [{label, items:[{id, before}]}]
    let running = false;
    let inited = false;

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
            m = { sessions: [{ id: 1, name: 'Session 1', history: old }], activeId: 1 };
            md[MODULE] = m;
        }
        if (!m.sessions.length) m.sessions.push({ id: 1, name: 'Session 1', history: [] });
        if (!m.sessions.some(x => x.id === m.activeId)) m.activeId = m.sessions[0].id;
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
        m.sessions.push({ id, name: 'Session ' + id, history: [] });
        m.activeId = id;
        saveMeta();
        pendingEdits = [];
        undoStack = [];
        renderSessions();
        renderHistory();
        renderEditCards();
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
                const entries = Object.entries(n);
                // Direct text fields first (e.g. notepad), nested structures after (e.g. layers).
                for (const [k, v2] of entries) { if (typeof v2 === 'string') walk(v2, p2 + '.' + k); }
                for (const [k, v2] of entries) { if (typeof v2 !== 'string') walk(v2, p2 + '.' + k); }
            }
        };
        walk(node, path);
        return out.join('\n\n');
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
                if (an) parts.push("--- Author's Note (chat) ---\n" + an);
            } catch (e) { /* ignore */ }
            try {
                const fp = c.extensionPrompts?.['2_floating_prompt'];
                const val = fp && typeof fp.value === 'string' ? fp.value.trim() : '';
                if (val) parts.push("--- Author's Note (injected) ---\n" + val);
            } catch (e) { /* ignore */ }
        }

        return parts.length ? parts.join('\n\n') : '(no memory extension data detected — pattern: ' + settings.memoryKeyPattern + ')';
    }

    function buildIndex() {
        const chat = ctx().chat || [];
        const lines = [];
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m) continue;
            if (m.is_system && !settings.includeHidden) continue;
            const who = m.is_user ? 'USER' : (m.name || 'AI');
            const flag = m.is_system ? ' (hidden)' : '';
            lines.push('#' + i + ' [' + who + ']' + flag + ': ' + oneLine(m.mes).slice(0, 150));
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
        return [
            '[STORY MEMORY]',
            gatherMemory(),
            '',
            '[MESSAGE INDEX]',
            buildIndex(),
            '',
            '[FULL MESSAGES] (last ' + ids.length + ')',
            ids.length ? fullTextOf(ids) : '(none)',
        ].join('\n');
    }

    function sysPrompt() {
        const rule = settings.allowUserEdits
            ? 'You may edit user-authored messages when the user asks for it.'
            : 'Never propose edits to user-authored messages; they are read-only.';
        return String(settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace('USER_EDIT_RULE', rule) + '\n\n' + MEMEDIT_RULES;
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
        const maxTok = Number(settings.maxTokens) || 2048;

        if (pid && c.ConnectionManagerRequestService?.sendRequest) {
            if (settings.streaming) {
                try {
                    const res = await c.ConnectionManagerRequestService.sendRequest(pid, messages, maxTok, { stream: true });
                    if (typeof res === 'function') {
                        let acc = '';
                        let reasoning = '';
                        for await (const chunk of res()) {
                            if (typeof chunk === 'string') {
                                acc = grow(acc, chunk);
                            } else {
                                acc = grow(acc, String(chunk?.text ?? ''));
                                const r = chunk?.state?.reasoning ?? chunk?.reasoning;
                                if (typeof r === 'string') reasoning = grow(reasoning, r);
                            }
                            if (onPartial) onPartial(acc, reasoning);
                        }
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
            const res = await c.ConnectionManagerRequestService.sendRequest(pid, messages, maxTok);
            return extractText(res);
        }

        // Fallback: current connection, raw generation (no streaming here).
        const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
        const convo = messages
            .filter(m => m.role !== 'system')
            .map(m => (m.role === 'user' ? '[User]\n' : '[Copilot]\n') + m.content)
            .join('\n\n') + '\n\n[Copilot]\n';
        if (typeof c.generateRaw === 'function') {
            const res = await c.generateRaw({ prompt: convo, systemPrompt: sys });
            return extractText(res);
        }
        throw new Error('No generation backend found. Pick a Connection Profile in the panel settings (gear icon).');
    }

    // ------------------------------------------------------------------
    // Reply parsing: <fetch> and <edits>
    // ------------------------------------------------------------------

    function parseFetch(text) {
        const m = String(text || '').match(/<fetch>\s*(\[[\s\S]*?\])\s*<\/fetch>/i);
        if (!m) return null;
        try {
            const arr = JSON.parse(m[1]);
            if (!Array.isArray(arr)) return null;
            const ids = arr.map(Number).filter(n => Number.isInteger(n) && n >= 0).slice(0, 15);
            return ids.length ? ids : null;
        } catch (e) { return null; }
    }

    function parseEdits(text) {
        const m = String(text || '').match(/<edits>\s*([\s\S]*?)\s*<\/edits>/i);
        if (!m) return { edits: [] };
        let raw = m[1].trim()
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
        const m = String(text || '').match(/<memedits>\s*([\s\S]*?)\s*<\/memedits>/i);
        if (!m) return { edits: [] };
        let raw = m[1].trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return { edits: [], error: 'memedits block is not a JSON array' };
            const edits = [];
            for (const e of arr) {
                if (!e || typeof e !== 'object') continue;
                if (typeof e.find !== 'string' || !e.find.length) continue;
                edits.push({ kind: 'mem', find: e.find, replace: String(e.replace ?? ''), reason: String(e.reason ?? ''), status: 'pending' });
            }
            return { edits };
        } catch (err) {
            return { edits: [], error: 'could not parse memedits JSON: ' + err.message };
        }
    }

    function stripBlocks(text) {
        return String(text || '')
            .replace(/<fetch>[\s\S]*?<\/fetch>/gi, '')
            .replace(/<edits>[\s\S]*?<\/edits>/gi, '[proposed edits below]')
            .replace(/<memedits>[\s\S]*?<\/memedits>/gi, '[proposed memory edits below]')
            .trim();
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

    function locate(hay, needle) {
        // 1) exact
        let idx = hay.indexOf(needle);
        if (idx >= 0) return { start: idx, end: idx + needle.length, fuzzy: false };

        // 2) quote/nbsp-normalized exact (length-preserving, indices map 1:1)
        const hay2 = normChars(hay);
        const needle2 = normChars(needle);
        idx = hay2.indexOf(needle2);
        if (idx >= 0) return { start: idx, end: idx + needle2.length, fuzzy: false };

        // 3) fuzzy sliding window over words (Levenshtein on word arrays)
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
        for (const w of widths) {
            for (let s = 0; s + w <= tokens.length; s++) {
                const cand = hayWords.slice(s, s + w);
                const dist = levenshtein(cand, needleWords);
                const sim = 1 - dist / Math.max(cand.length, nw);
                if (!best || sim > best.sim) best = { sim, s, w };
            }
        }
        if (best && best.sim >= 0.78) {
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

    function applyOne(edit) {
        const c = ctx();
        const i = Number(edit.id);
        const msg = c.chat?.[i];
        if (!msg) return { ok: false, reason: 'no message #' + i };
        if (msg.is_user && !settings.allowUserEdits) {
            return { ok: false, reason: 'user message (locked in settings)' };
        }
        const before = String(msg.mes || '');
        let next;
        let fuzzyNote = '';
        if (edit.find == null) {
            next = String(edit.replace ?? '');
        } else {
            const loc = locate(before, edit.find);
            if (!loc) return { ok: false, reason: '"find" text not located (even fuzzy)' };
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
        return { ok: true, before, fuzzyNote };
    }

    function walkReplace(node, find, replace, path) {
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') {
                    const loc = locate(v, find);
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
        for (const [key, val] of Object.entries(md)) {
            if (key === MODULE || !re.test(key) || val == null) continue;
            if (typeof val === 'string') {
                const loc = locate(val, edit.find);
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
                if (hit) {
                    if (!keyBackups.has(key)) keyBackups.set(key, backup);
                    return { ok: true, path: hit.path, fuzzy: hit.fuzzy };
                }
            }
        }
        return { ok: false, reason: '"find" text not located in memory' };
    }

    async function applyEdits(list) {
        const chatApplied = [];
        const memPaths = [];
        const keyBackups = new Map();
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
            } else {
                const res = applyOne(edit);
                if (res.ok) {
                    edit.status = 'applied' + (res.fuzzyNote || '');
                    chatApplied.push({ kind: 'chat', id: edit.id, before: res.before });
                } else {
                    edit.status = 'failed: ' + res.reason;
                }
            }
        }
        const items = [...chatApplied];
        for (const [key, before] of keyBackups.entries()) items.push({ kind: 'mem', key, before });
        if (items.length) {
            const labelParts = [];
            if (chatApplied.length) labelParts.push(chatApplied.map(a => '#' + a.id).join(', '));
            if (memPaths.length) labelParts.push('memory: ' + memPaths.join(', '));
            undoStack.push({ label: labelParts.join(' + '), items });
            if (chatApplied.length) await commitChanges(chatApplied.map(a => a.id));
            if (memPaths.length) saveMeta();
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
            const msg = c.chat?.[item.id];
            if (!msg) continue;
            msg.mes = item.before;
            refreshMessage(item.id);
            changed.push(item.id);
        }
        if (changed.length) await commitChanges(changed);
        if (memRestored) saveMeta();
        const note = 'Undid edits on ' + batch.label + '.';
        addBubble('note', note);
        pushHistory('note', note);
    }

    // ------------------------------------------------------------------
    // Reasoning tags + shortcut commands
    // ------------------------------------------------------------------

    function splitThinking(text) {
        let think = '';
        const rest = String(text || '').replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi, (m0, tag, body) => {
            const b = String(body).trim();
            if (b) think += (think ? '\n\n' : '') + b;
            return '';
        }).trim();
        return { think, rest };
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

    function historyForLLM() {
        const depth = Math.max(2, Number(settings.historyDepth) || 12);
        return meta().history
            .slice(-depth)
            .map(h => h.role === 'note'
                ? { role: 'user', content: '[STATE] ' + h.content }
                : { role: h.role, content: h.content });
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

    async function runGeneration() {
        if (running) return;
        running = true;
        setBusy(true);
        const busy = addBubble('busy', 'thinking…');
        const live = (acc, reasoning) => {
            const head = (settings.showThinking && reasoning) ? '[thinking]\n' + reasoning + '\n\n' : '';
            const shown = (head + acc).trim();
            if (shown) busy.className = 'cc_bubble cc_ai';
            busy.innerHTML = esc(shown.slice(-3500) || 'thinking…');
            const log = el('cc_log');
            if (log) log.scrollTop = log.scrollHeight;
        };
        try {
            const messages = [
                { role: 'system', content: sysPrompt() },
                { role: 'system', content: buildContextBlock() },
                ...historyForLLM(),
            ];

            let reply = '';
            let think = '';
            const rounds = Math.max(0, Math.min(6, Number(settings.fetchRounds) || 0));
            for (let round = 0; round <= rounds; round++) {
                const raw = await callLLM(messages, live);
                const split = splitThinking(raw);
                reply = split.rest;
                think = split.think;
                const ids = parseFetch(reply);
                if (!ids || round === rounds) break;
                addBubble('note', 'Copilot read full text of #' + ids.join(', #'));
                messages.push({ role: 'assistant', content: reply });
                messages.push({ role: 'user', content: '[FETCHED MESSAGES]\n' + fullTextOf(ids) });
            }

            busy.remove();
            pushHistory('assistant', reply, think);
            addAiBubble(reply, think);

            const parsed = parseEdits(reply);
            const parsedMem = parseMemEdits(reply);
            if (parsed.error) addBubble('note', 'Edit block error: ' + parsed.error + ' — ask the copilot to resend valid JSON.');
            if (parsedMem.error) addBubble('note', 'Memory edit block error: ' + parsedMem.error + ' — ask the copilot to resend valid JSON.');
            const allEdits = [...parsed.edits, ...parsedMem.edits];
            if (allEdits.length) {
                pendingEdits = allEdits;
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

    async function retryLast() {
        if (running) return;
        const h = meta().history;
        let i = h.length - 1;
        while (i >= 0 && h[i].role !== 'assistant') i--;
        if (i < 0) { toast('Nothing to retry yet.', 'warning'); return; }
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

    function directorAuthorPrompt(mode) {
        const intensity = settings.directorIntensity || 'standard';
        const anchors = String(settings.directorAnchors || '').trim();
        const lines = [
            'You are an expert story director for a long-form roleplay. Write a SECRET director\'s note for the storyteller AI. The player must never see it.',
            'Ground everything in [STORY MEMORY] and the current scene: use only established characters, motives, and world rules.',
            'The note must contain:',
            '1. EPISODE PREMISE \u2014 one television-episode-quality premise that rises naturally from existing threads.',
            '2. BEATS \u2014 3-5 escalation beats in order, each naming WHO initiates and what pressure it puts on the player character.',
            '3. NPC INITIATIVE \u2014 antagonists and NPCs act first, with agency and menace true to their established methods.',
            '4. LANDING \u2014 the natural end state of the episode and its consequence.',
            'Calibration: intensity = ' + intensity + '. Match the story\'s existing tone and realism; escalate the way good TV does \u2014 earned, in-character, no tonal whiplash, no gratuitous extremes.',
        ];
        if (anchors) {
            lines.push('Pacing reference (RHYTHM and episode structure ONLY \u2014 never import their characters, names, plots, or lines): ' + anchors);
        }
        lines.push('Rules: the note guides, never railroads \u2014 the storyteller must adapt beats to the player\'s choices; conclude naturally at the landing. Under 250 words. Output ONLY the director\'s note text, no preamble.');
        if (mode === 'next') {
            lines.push('A previous episode directive is provided; treat it as concluded and write the NEXT episode, carrying its consequences forward.');
        }
        if (mode === 'edit') {
            lines.push('The CURRENT directive and the player\'s direction instruction are provided. Rewrite the directive to incorporate the player\'s direction while preserving whatever still works. Keep the same episode. If no current directive is provided, write a fresh one built around the player\'s direction.');
        }
        return lines.join('\n');
    }

    async function generateDirective(mode) {
        if (running) return;
        running = true;
        setBusy(true);
        const busyNote = addBubble('busy', mode === 'next' ? 'directing the next episode\u2026' : 'directing\u2026');
        try {
            const prev = metaRoot().director;
            const user = buildContextBlock()
                + (mode === 'next' && prev?.text ? '\n\n[PREVIOUS EPISODE DIRECTIVE \u2014 concluded]\n' + prev.text : '')
                + '\n\nWrite the director\'s note now.';
            const raw = await callLLM([
                { role: 'system', content: directorAuthorPrompt(mode) },
                { role: 'user', content: user },
            ]);
            const text = splitThinking(raw).rest.trim();
            if (!text) throw new Error('empty directive');
            const ep = mode === 'next' ? ((prev?.episode || 0) + 1) : (prev?.episode || 1);
            metaRoot().director = { text, episode: ep, ts: Date.now() };
            saveMeta();
            applyDirectorInjection();
            const note = '\uD83C\uDFAC Directive set (episode ' + ep + '). Content hidden \u2014 just keep playing.';
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
        applyDirectorInjection();
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
            const user = buildContextBlock()
                + (prev?.text ? '\n\n[CURRENT DIRECTIVE]\n' + prev.text : '')
                + '\n\n[PLAYER\'S DIRECTION INSTRUCTION]\n' + instruction
                + '\n\nWrite the revised director\'s note now. Output ONLY the note text.';
            const raw = await callLLM([
                { role: 'system', content: directorAuthorPrompt('edit') },
                { role: 'user', content: user },
            ]);
            const text = splitThinking(raw).rest.trim();
            if (!text) throw new Error('empty directive');
            const ep = prev?.episode || 1;
            metaRoot().director = { text, episode: ep, ts: Date.now() };
            saveMeta();
            applyDirectorInjection();
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
            const sys = 'You are checking secret episode progress for a roleplay director. You receive the SECRET DIRECTIVE and the story context. Judge whether the episode\'s LANDING has been reached. Reply with EXACTLY one line, spoiler-free, in one of these formats: "ONGOING \u2014 <short vague progress hint, no spoilers>" or "CONCLUDED \u2014 <short line>" or "DERAILED \u2014 <short line>". Never quote or reveal the directive contents.';
            const user = buildContextBlock() + '\n\n[SECRET DIRECTIVE]\n' + d.text + '\n\nJudge the progress now.';
            const raw = await callLLM([
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ]);
            const line = splitThinking(raw).rest.trim().split('\n')[0].slice(0, 200);
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
        showViewer('\uD83C\uDFAC Episode ' + d.episode + ' directive (spoiler)', d.text);
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

    function showViewer(title, text) {
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

            head.appendChild(titleEl);
            head.appendChild(copyBtn);
            head.appendChild(closeBtn);
            box.appendChild(head);
            box.appendChild(pre);
            document.body.appendChild(box);

            const hide = () => { backdrop.style.display = 'none'; box.style.display = 'none'; };
            closeBtn.addEventListener('click', hide);
            backdrop.addEventListener('click', hide);
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && box.style.display !== 'none') hide();
            });
            copyBtn.addEventListener('click', async () => {
                const ok = await copyText(pre.textContent);
                toast(ok ? 'Copied to clipboard.' : 'Copy failed — select the text manually.', ok ? 'success' : 'error');
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
        el('cc_viewer_pre').textContent = 'Continuity Copilot v' + VERSION + ' \u2014 drag me by this top bar. Close: the Close button, tapping the dark area, or Esc.\n\n' + text;
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
                if (key === MODULE || anKeys.includes(key)) continue;
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
            '<div id="cc_sessbar" style="display:flex;gap:6px;padding:6px 10px;align-items:center;flex:0 0 auto;border-bottom:1px solid rgba(255,255,255,0.15);">',
            '  <select id="cc_sess" style="flex:1 1 auto;min-width:0;background:rgba(0,0,0,0.25);color:inherit;border:1px solid rgba(255,255,255,0.25);border-radius:5px;padding:4px 6px;font-size:0.85em;"></select>',
            '  <button class="cc_btn" id="cc_sessnew" title="New session (fresh context for a new problem)">+ New</button>',
            '  <button class="cc_btn" id="cc_sessren" title="Rename this session">Ren</button>',
            '  <button class="cc_btn" id="cc_sessdel" title="Delete this session">Del</button>',
            '</div>',
            '<div id="cc_settings"></div>',
            '<div id="cc_log"></div>',
            '<div id="cc_edits"></div>',
            '<div id="cc_composer">',
            '  <div id="cc_quick">',
            '    <button class="cc_btn" id="cc_audit" title="Full continuity audit">Audit chat</button>',
            '    <button class="cc_btn" id="cc_retry" title="Regenerate the last copilot reply">Retry</button>',
            '    <button class="cc_btn" id="cc_dellast" title="Delete the last question + answer">Del last</button>',
            '    <button class="cc_btn" id="cc_dirnew" title="Set or replace the secret episode directive">\uD83C\uDFAC New</button>',
            '    <button class="cc_btn" id="cc_dirnext" title="Conclude this episode and direct the next">\uD83C\uDFAC Next</button>',
            '    <button class="cc_btn" id="cc_diroff" title="Remove the directive">\uD83C\uDFAC Off</button>',
            '    <button class="cc_btn" id="cc_dirstat" title="Spoiler-free episode progress check">\uD83C\uDFAC ?</button>',
            '    <button class="cc_btn" id="cc_dirpeek" title="Reveal the directive (spoiler!)">\uD83C\uDFAC Peek</button>',
            '    <button class="cc_btn" id="cc_undo" title="Undo last applied batch">Undo</button>',
            '    <button class="cc_btn" id="cc_memcheck" title="Show detected memory sources">Memory?</button>',
            '    <button class="cc_btn" id="cc_context" title="Show the full context the copilot receives">Context</button>',
            '    <button class="cc_btn" id="cc_clear" title="Clear copilot conversation">Clear</button>',
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
            const t = el('cc_input').value;
            el('cc_input').value = '';
            send(t);
        });
        el('cc_input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                el('cc_send').click();
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
        el('cc_sess').addEventListener('change', () => switchSession(el('cc_sess').value));
        el('cc_sessnew').addEventListener('click', () => newSession());
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
            '<label>LLM route (Connection Profile)</label>',
            '<select id="cc_profile"></select>',
            '<div class="cc_row">',
            '  <div><label>Recent msgs sent in full</label><input type="number" id="cc_recent" min="0" max="100"></div>',
            '  <div><label>Fetch rounds</label><input type="number" id="cc_rounds" min="0" max="6"></div>',
            '  <div><label>Max tokens</label><input type="number" id="cc_maxtok" min="256" max="16384" step="256"></div>',
            '</div>',
            '<label>Memory source words (any source whose name contains one of these is included; separate with |)</label>',
            '<input type="text" id="cc_pattern">',
            '<div class="cc_check"><input type="checkbox" id="cc_stream"><span>Streaming (needs a Connection Profile)</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_showthink"><span>Show thinking blocks</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_userok"><span>Allow editing my (user) messages</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_hidden"><span>Include ghosted/hidden messages in index (token heavy)</span></div>',
            '<div class="cc_check"><input type="checkbox" id="cc_an"><span>Include Author\'s Note in story memory</span></div>',
            '<div class="cc_row">',
            '  <div><label>Director intensity</label><select id="cc_dir_int"><option value="slow-burn">slow-burn</option><option value="standard">standard</option><option value="intense">intense</option></select></div>',
            '  <div><label>Director depth</label><input type="number" id="cc_dir_depth" min="0" max="20"></div>',
            '</div>',
            '<label>Director style anchors (optional pacing references)</label>',
            '<input type="text" id="cc_dir_anchors" placeholder="e.g. Classroom of the Elite, Kaguya-sama">',
            '<label>Shortcut commands (one per line: #tag = prompt)</label>',
            '<textarea id="cc_shortcuts"></textarea>',
            '<label>System prompt (USER_EDIT_RULE is replaced automatically)</label>',
            '<textarea id="cc_sysprompt"></textarea>',
            '<div style="margin-top:6px; display:flex; gap:6px;">',
            '  <button class="cc_btn" id="cc_saveset">Save settings</button>',
            '  <button class="cc_btn" id="cc_resetprompt">Reset prompt</button>',
            '  <button class="cc_btn" id="cc_dumpsc">Raw memory data</button>',
            '</div>',
        ].join('\n');

        el('cc_recent').value = settings.recentFull;
        el('cc_rounds').value = settings.fetchRounds;
        el('cc_maxtok').value = settings.maxTokens;
        el('cc_pattern').value = settings.memoryKeyPattern;
        el('cc_userok').checked = !!settings.allowUserEdits;
        el('cc_hidden').checked = !!settings.includeHidden;
        el('cc_an').checked = !!settings.includeAuthorsNote;
        el('cc_stream').checked = !!settings.streaming;
        el('cc_showthink').checked = !!settings.showThinking;
        el('cc_dir_int').value = settings.directorIntensity || 'standard';
        el('cc_dir_depth').value = settings.directorDepth;
        el('cc_dir_anchors').value = settings.directorAnchors || '';
        el('cc_shortcuts').value = settings.shortcuts;
        el('cc_sysprompt').value = settings.systemPrompt;
        refreshProfileSelect();

        el('cc_saveset').addEventListener('click', () => {
            settings.profileId = el('cc_profile').value;
            settings.recentFull = Number(el('cc_recent').value) || 0;
            settings.fetchRounds = Number(el('cc_rounds').value) || 0;
            settings.maxTokens = Number(el('cc_maxtok').value) || 2048;
            settings.memoryKeyPattern = el('cc_pattern').value || defaults.memoryKeyPattern;
            settings.allowUserEdits = el('cc_userok').checked;
            settings.includeHidden = el('cc_hidden').checked;
            settings.includeAuthorsNote = el('cc_an').checked;
            settings.streaming = el('cc_stream').checked;
            settings.showThinking = el('cc_showthink').checked;
            settings.directorIntensity = el('cc_dir_int').value || 'standard';
            settings.directorDepth = Number(el('cc_dir_depth').value) || 4;
            settings.directorAnchors = el('cc_dir_anchors').value;
            settings.shortcuts = el('cc_shortcuts').value;
            applyDirectorInjection();
            settings.systemPrompt = el('cc_sysprompt').value || DEFAULT_SYSTEM_PROMPT;
            persistSettings();
            toast('Settings saved.', 'success');
        });
        el('cc_resetprompt').addEventListener('click', () => {
            el('cc_sysprompt').value = DEFAULT_SYSTEM_PROMPT;
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
        if (btn) btn.disabled = b;
        const au = el('cc_audit');
        if (au) au.disabled = b;
        const rt = el('cc_retry');
        if (rt) rt.disabled = b;
    }

    function addBubble(kind, text, hidx) {
        const log = el('cc_log');
        const div = document.createElement('div');
        const cls = kind === 'user' ? 'cc_user' : kind === 'assistant' || kind === 'ai' ? 'cc_ai' : kind === 'busy' ? 'cc_busy' : 'cc_note';
        div.className = 'cc_bubble ' + cls;
        div.innerHTML = esc(text);
        if (kind === 'user' && Number.isInteger(hidx)) {
            const pen = document.createElement('span');
            pen.textContent = '\u270E';
            pen.title = 'Edit this message and continue from here';
            pen.style.cssText = 'margin-left:8px;cursor:pointer;opacity:0.6;font-size:0.95em;';
            pen.addEventListener('click', () => startEditUserMessage(hidx));
            div.appendChild(pen);
        }
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
        return div;
    }

    function addAiBubble(rest, think) {
        const log = el('cc_log');
        const div = document.createElement('div');
        div.className = 'cc_bubble cc_ai';
        let html = '';
        if (settings.showThinking && think) {
            html += '<details class="cc_think"><summary>thinking</summary><div>' + esc(think) + '</div></details>';
        }
        html += esc(stripBlocks(rest) || '(no text)');
        div.innerHTML = html;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
        return div;
    }

    function renderHistory() {
        const log = el('cc_log');
        if (!log) return;
        log.innerHTML = '';
        const hist = meta().history;
        for (let i = 0; i < hist.length; i++) {
            const h = hist[i];
            if (h.role === 'assistant') addAiBubble(h.content, h.think);
            else if (h.role === 'user') addBubble('user', h.content, i);
            else addBubble('note', h.content);
        }
        updateSub();
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
            '<button class="cc_btn cc_primary" id="cc_applyall">Apply all pending</button>' +
            '<button class="cc_btn" id="cc_dismissall">Dismiss</button>';
        frag.appendChild(head);

        pendingEdits.forEach((edit, idx) => {
            const isMem = edit.kind === 'mem';
            const msg = isMem ? null : chat[edit.id];
            const who = isMem ? '' : (msg ? (msg.is_user ? 'USER' : (msg.name || 'AI')) : '?');
            const label = isMem ? 'MEMORY' : ('#' + edit.id + ' ' + esc(who));
            const card = document.createElement('div');
            card.className = 'cc_card';
            const findShown = edit.find == null ? '(replace entire message)' : edit.find;
            card.innerHTML =
                '<div class="cc_card_top"><b>' + label + '</b><span>' + esc(edit.reason || '') + '</span>' +
                (edit.status === 'pending'
                    ? '<button class="cc_btn" data-cc-apply="' + idx + '">Apply</button><button class="cc_btn" data-cc-skip="' + idx + '">Skip</button>'
                    : '') +
                '</div>' +
                '<div class="cc_diff cc_before">' + esc(findShown) + '</div>' +
                '<div class="cc_diff cc_after">' + esc(edit.replace) + '</div>' +
                (edit.status !== 'pending' ? '<div class="cc_card_status">' + esc(edit.status) + '</div>' : '');
            frag.appendChild(card);
        });

        box.innerHTML = '';
        box.appendChild(frag);

        el('cc_applyall')?.addEventListener('click', () => applyEdits(pendingEdits));
        el('cc_dismissall')?.addEventListener('click', () => {
            pendingEdits = [];
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
                applyDirectorInjection();
                updateSub();
            });
            c.eventSource?.on?.(c.event_types?.MESSAGE_RECEIVED, async (i) => {
                try {
                    const d = metaRoot().director;
                    if (!d || d.concluded) return;
                    const msg = ctx().chat?.[Number(i)];
                    if (!msg || msg.is_user || typeof msg.mes !== 'string') return;
                    if (!msg.mes.includes('[EPISODE_END]')) return;
                    msg.mes = msg.mes.replace(/\s*\[EPISODE_END\]\s*$/, '').replace(/\[EPISODE_END\]/g, '').trim();
                    refreshMessage(Number(i));
                    try { await ctx().saveChat?.(); } catch (e2) { /* ignore */ }
                    d.concluded = true;
                    saveMeta();
                    updateSub();
                    const note = '\uD83C\uDFAC Episode ' + d.episode + ' concluded \u2014 press \uD83C\uDFAC Next when ready.';
                    toast(note, 'success');
                    addBubble('note', note);
                    pushHistory('note', note);
                } catch (e2) { /* ignore */ }
            });
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
            applyDirectorInjection();
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
