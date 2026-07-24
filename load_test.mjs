#!/usr/bin/env node
/**
 * Chat Assistant — MODULE INTEGRITY GATE.  Run:  node load_test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * SillyTavern loads index.js as an ES MODULE. `node --check index.js` parses a
 * .js file as CommonJS, which silently ACCEPTS things ESM rejects (a duplicate
 * top-level `let`, most importantly). That exact false pass shipped a
 * Summaryception release that failed to load for three versions while every
 * check reported green. This repo was gated on syntax alone until v2.51.0 —
 * the weakest possible gate. This file really EXECUTES the module against a
 * mocked SillyTavern, drives init, and asserts the extension wired itself up.
 *
 * It also carries the source-witness assertions for shipped invariants: the
 * cross-chat contamination guards must stay where they are.
 *
 * Exit code 0 = safe to ship. Non-zero = DO NOT PUSH.
 */
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};

// ── Forgiving DOM mock ───────────────────────────────────────────────
// Every element supports the operations the panel builder uses; children are
// tracked so querySelector/getElementById can find what init created.
const byId = new Map();
function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [], style: {}, dataset: {},
        _class: new Set(),
        classList: {
            add: (...c) => c.forEach(x => el._class.add(x)),
            remove: (...c) => c.forEach(x => el._class.delete(x)),
            toggle: (c, f) => { (f === undefined ? !el._class.has(c) : f) ? el._class.add(c) : el._class.delete(c); },
            contains: (c) => el._class.has(c),
        },
        attributes: {},
        setAttribute: (k, v) => { el.attributes[k] = String(v); if (k === 'id') byId.set(String(v), el); },
        getAttribute: (k) => (k in el.attributes ? el.attributes[k] : null),
        removeAttribute: (k) => { delete el.attributes[k]; },
        appendChild: (c) => { el.children.push(c); if (c && c._id) byId.set(c._id, c); return c; },
        append: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.push(c); }),
        prepend: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.unshift(c); }),
        removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
        remove: () => {},
        insertBefore: (c) => { el.children.unshift(c); return c; },
        _on: new Map(),
        addEventListener: (t, fn) => { if (!el._on.has(t)) el._on.set(t, []); el._on.get(t).push(fn); },
        removeEventListener: (t, fn) => { const a = el._on.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatch: (t, ev) => { for (const fn of (el._on.get(t) || []).slice()) fn(ev || { target: el, preventDefault() {}, stopPropagation() {} }); },
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, focus: () => {}, blur: () => {},
        click: () => el.dispatch('click'),
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }),
        scrollIntoView: () => {},
        options: [], value: '', checked: false, disabled: false, selected: false,
        offsetWidth: 100, offsetHeight: 100, scrollTop: 0, scrollHeight: 0, clientHeight: 100,
        textContent: '', innerText: '',
    };
    // The panel is innerHTML-built and then addressed by id. Registering every
    // id declared in assigned markup makes those lookups work without a real
    // HTML parser; ids never declared still return null, so genuinely missing
    // elements still fail the way they should.
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) {
            _html = String(v);
            for (const m of _html.matchAll(/id="([^"]+)"/g)) {
                if (!byId.has(m[1])) byId.set(m[1], makeEl('div'));
            }
        },
    });
    Object.defineProperty(el, 'id', {
        get() { return el._id || ''; },
        set(v) { el._id = String(v); byId.set(el._id, el); },
    });
    return el;
}
const documentMock = {
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => byId.get(String(id)) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
};
globalThis.document = documentMock;
globalThis.window = globalThis;
try { globalThis.navigator = { userAgent: 'gate' }; } catch (e) { /* node >= 21 exposes a read-only navigator — good enough */ }
// Toasts are user-visible feedback; capture them so 'loud, never silent'
// behavior is provable instead of vanishing into a no-op.
const toasts = [];
// Dialogs: confirm/prompt were previously undefined — End season was
// undriveable in the harness. Auto-accept and record.
const confirms = [];
globalThis.confirm = (m) => { confirms.push(String(m)); return true; };
globalThis.prompt = globalThis.prompt || (() => '');
const _t = (m) => { toasts.push(String(m)); };
globalThis.toastr = { info: _t, success: _t, warning: _t, error: _t, clear: () => {} };
globalThis.localStorage = {
    _d: new Map(),
    get length() { return this._d.size; },
    key(i) { return [...this._d.keys()][i] ?? null; },
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
};
const chain = new Proxy(function () {}, { get: (_t, p) => (p === 'length' ? 0 : chain), apply: () => chain });
globalThis.$ = new Proxy(function () { return chain; }, { get: () => chain, apply: () => chain });
globalThis.jQuery = globalThis.$;

const event_types = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED', MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_DELETED: 'MESSAGE_DELETED', APP_READY: 'APP_READY',
};
const handlers = new Map();
const ctx = {
    chat: [], chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0,
    name1: 'Player', name2: 'Narrator', chatId: 'gate.jsonl',
    eventSource: {
        on: (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); },
        emit: () => {}, removeListener: () => {},
    },
    event_types,
    saveSettingsDebounced: () => {}, saveMetadata: () => {}, saveMetadataDebounced: () => {},
    // Injections are the extension's primary output channel — capture them so
    // pause/unpause behavior is provable instead of vanishing into a no-op.
    extPrompts: new Map(),
    setExtensionPrompt(key, value) { ctx.extPrompts.set(String(key), String(value ?? '')); },
    getCurrentChatId: () => 'gate.jsonl',
    registerSlashCommand: () => {},
    SlashCommandParser: { addCommandObject: () => {} },
    SlashCommand: { fromProps: () => ({}) },
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
    ARGUMENT_TYPE: { STRING: 'string' },
    executeSlashCommandsWithOptions: async () => ({}),
    generateQuietPrompt: async () => '',
    substituteParams: (s) => s,
    saveChat: async () => {},
    extensionPrompts: {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.structuredClone = globalThis.structuredClone ?? ((o) => JSON.parse(JSON.stringify(o)));

const realError = console.error;
const realLog = console.log;
const errors = [];
const logs = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const logCap = (...a) => { logs.push(a.map(String).join(' ')); };

process.on('unhandledRejection', (e) => {
    console.error = realError;
    realLog('  ✗ unhandled rejection during load: ' + (e && e.message));
    process.exit(1);
});

const dir = mkdtempSync(join(tmpdir(), 'ca-load-'));
copyFileSync(join(HERE, 'index.js'), join(dir, 'index.js'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

console.log('== module integrity ==');
let loaded = false, loadErr = '';
console.log = logCap;
try {
    await import(pathToFileURL(join(dir, 'index.js')).href);
    loaded = true;
} catch (e) {
    loadErr = (e && e.message) || String(e);
}
console.log = realLog;
ok(loaded, 'index.js loads as an ES module and executes' + (loaded ? '' : ' — ' + loadErr));

// Drive init through the same path SillyTavern uses.
const ready = handlers.get('APP_READY') || [];
ok(ready.length >= 1, 'APP_READY handler registered at module scope');
console.log = logCap;
try { for (const f of ready) f(); } catch (e) { errors.push('init threw: ' + (e && e.message)); }
console.log = realLog;

const initErrors = errors.filter(x => x.includes('init failed'));
ok(initErrors.length === 0, 'init completed without "init failed"' + (initErrors.length ? ' — ' + initErrors[0] : ''));
ok(logs.some(x => x.includes('ready')), 'init logged ready (panel built, events bound, slash registered)');

console.log('== event wiring ==');
for (const e of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED']) {
    ok((handlers.get(e) || []).length >= 1, e + ' handler bound');
}

// The handlers must survive being INVOKED against a bare context.
let threw = '';
try { for (const f of handlers.get('CHAT_CHANGED') || []) f(); } catch (e) { threw = e && e.message; }
ok(!threw, 'CHAT_CHANGED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));
threw = '';
try { for (const f of handlers.get('MESSAGE_SWIPED') || []) f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_SWIPED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));

console.log('== shipped invariants (source witnesses) ==');
// v2.51.0 — cross-chat contamination fixes. These strings are load-bearing:
// if a refactor removes them, prove the replacement and update the witness.
ok(SRC.includes('const chatAt = chatRef();\n        const chatApplied = [];'), 'applyEdits captures chat identity at entry');
ok(SRC.includes("edit.status = 'chat changed mid-run \\u2014 not applied';"), 'applyEdits: a mid-run chat switch voids remaining cards instead of fuzzy-matching them into the new chat');
ok(SRC.includes('// ALL state writes happen synchronously with the event'), 'episode conclusion: director state is written before any await');
ok(SRC.includes("if (!justConcluded) return;   // a stale marker on an already-concluded episode stays silent, as before"), 'episode conclusion: stale markers stay silent; only a genuine conclusion announces');
ok(SRC.includes('const led = rootAt.ccHidden;'), 'undo: hidden-ledger writes go through the CAPTURED chat root, never a post-await metaRoot()');
ok(SRC.includes("toast('Chat changed mid-undo"), 'undo: a mid-undo chat switch is surfaced, not silently half-saved');
const guardCount = (SRC.match(/if \(!sameChat\(chatAt\)\)/g) || []).length;
ok(guardCount >= 12, 'sameChat guards present across LLM/apply/undo flows (found ' + guardCount + ', need >= 12)');

console.log('== v2.52.0 invariants (craft doctrine + episode-end editor chain) ==');
// The doctrine lines are load-bearing prompt content: if a refactor drops one,
// the feature silently degrades to the pre-2.52 generic behavior.
ok(SRC.includes('CRAFT \\u2014 the difference between competent and masterpiece'), 'director default carries the CRAFT doctrine (cause / value turns / irony / payoff debt / competent opposition / concrete scale)');
ok(SRC.includes('STACK MEANING before the centerpiece'), 'seed mode expands premises showrunner-style (meaning stack / phases / population / reprice)');
ok(SRC.includes('NORTH STAR:'), 'critique output contract opens with the single highest-leverage NORTH STAR lever');
ok(SRC.includes('FRICTIONLESS SUCCESS'), 'critique holds the story to the masterpiece bar, not only the defect floor');
ok(SRC.includes('LEGACY_DIRECTOR_PROMPT_V257, LEGACY_DIRECTOR_PROMPT_V262, LEGACY_DIRECTOR_PROMPT_V263, LEGACY_DIRECTOR_PROMPT_V264, LEGACY_DIRECTOR_PROMPT_V265, LEGACY_DIRECTOR_PROMPT_V266];'), 'stored 2.49-2.66 defaults auto-upgrade to the current default');
ok(SRC.includes('DELIBERATION \\u2014 if you reason privately'), 'director default carries deliberation discipline for reasoning models');
ok((SRC.match(/Deliberate efficiently \\u2014 the token budget is shared/g) || []).length === 2, 'showrunner and critique prompts carry deliberation discipline');
ok(SRC.includes('raw = await callLLM(msgs2, onPartial, bigPot);'), 'think-consumed recovery runs in an ENLARGED pot — same-size recovery over longer input is mathematically doomed');
ok(SRC.includes('keep it to a single sentence'), 'recovery gives forced reasoning phases an explicit escape hatch');
ok(SRC.includes('FIRST-DRAFT MODE \\u2014 a showrunner second-draft pass will interrogate'), 'with two-pass on, the draft declares fast-draft mode — deep thought moves to the review');
ok(SRC.includes('directorInjectPaused: false') && SRC.includes('critiqueInjectPaused: false'), 'both pause toggles exist and default OFF');
ok(SRC.includes('!settings.directorInjectPaused && d && d.text') && SRC.includes('!settings.critiqueInjectPaused && text'), 'both injectors gate on their pause flag and actively clear when paused');
ok(SRC.includes('never burn directive calls the storyteller cannot see'), 'auto-director skips while its channel is paused');
ok(SRC.includes("don't count toward a trigger the storyteller cannot receive"), 'auto-critique neither counts nor fires while paused');
ok(SRC.includes('&& !settings.critiqueInjectPaused) {'), 'the episode-end editor pass respects the pause');
ok(SRC.includes('if (clearedText.trim()) {'), 'a whitespace-only directive is treated as empty by the end-season audit');
ok(SRC.includes('CAST \\u2014 before writing beats, sweep the established cast'), 'director default carries the CAST law (stake sweep, jurisdiction-by-definition, no furniture placement)');
ok(SRC.includes('FURNITURE CHARACTERS'), 'critique bar catches furniture characters and absent stakeholders');
ok(SRC.includes('SHOWRUNNER running the second-draft pass'), 'directives get a showrunner second-draft pass (premise ambition, the memorable moment, wasted cast, safety, logic)');
ok(SRC.includes('directorTwoPass: true'), 'the second-draft pass defaults ON');
ok(SRC.includes("const isRestart = mode === 'new' && !!String(prev?.text || '').trim();"), 'New over a live directive is treated as a restart');
ok(SRC.includes('The player RESTARTED this episode'), 'restart carries its own prompt contract (never aired / genuinely different)');
ok(SRC.includes('function raceTransport('), 'every transport await runs under the stall watchdog');
ok((SRC.match(/raceTransport\(/g) || []).length >= 5, 'watchdog covers stream start, stream chunks, plain request, and the fallback backend (found ' + (SRC.match(/raceTransport\(/g) || []).length + ' uses, need >= 5)');
ok(SRC.includes('llmTimeoutSec: 300'), 'stall timeout defaults to 300s and is configurable (0 = off)');
ok(SRC.includes('function busyTicker('), 'busy bubbles carry a liveness ticker');
ok((SRC.match(/busyTicker\(busyNote/g) || []).length === 5, 'all five LLM flows (directive, critique, status, seeds, edit) tick (found ' + (SRC.match(/busyTicker\(busyNote/g) || []).length + ', need 5)');
ok((SRC.match(/\], tick(C|X)?\.onPartial\);/g) || []).length >= 6, 'every ticked flow forwards live stream progress into the readout');
ok(SRC.includes('PLAYED-STATE: NEVER PLAYED'), 'end-season audit declares an unplayed directive as such (anti-spiral)');
ok(SRC.includes('a clean audit is a successful audit'), 'the audit has an explicit clean exit so it never manufactures findings');
ok((SRC.match(/msgAt:/g) || []).length === 2, 'both directive stores record where playtime starts (found ' + (SRC.match(/msgAt:/g) || []).length + ', need 2)');
ok(!/if \(running\) return;\s*\n\s*running = true/.test(SRC), 'no user-initiated entry can die silently at the running flag any more');
ok(SRC.includes('critiqueOnEpisode: true'), 'episode-end auto-critique defaults ON');
const fnAt = SRC.indexOf('async function onEpisodeConcluded(chatAt)');
ok(fnAt > -1, 'episode conclusion routes through onEpisodeConcluded');
const critAt = SRC.indexOf("await generateCritique(true, 'episode');", fnAt);
const dirAt = SRC.indexOf('maybeAutoDirector();', fnAt);
ok(critAt > -1 && dirAt > -1 && critAt < dirAt, 'inside the chain, the editor pass is AWAITED before the next episode is directed (review -> plan order)');
ok((SRC.match(/onEpisodeConcluded\(chatAt\);/g) || []).length === 2, 'both conclusion paths (episode marker + status check) run the chain');
ok(SRC.includes('if (concluded) onEpisodeConcluded(chatAt);'), 'status-check path fires the chain AFTER its finally releases the running lock (fired inside it, both steps self-skip)');
ok(!SRC.includes('maybeAutoDirector(); // auto mode: chain the next episode immediately'), 'no conclusion path bypasses the editor by auto-directing directly');
// Live-settings proof: init actually installed the new default and flag.
const CA = ctx.extensionSettings['continuityCopilot'] || {};
ok(CA.critiqueOnEpisode === true, 'live settings after init: critiqueOnEpisode is true');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CRAFT \u2014 the difference between competent and masterpiece'), 'live settings after init: director prompt is the CRAFT default');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CAST \u2014 before writing beats'), 'live settings after init: director prompt carries the CAST law');
ok(CA.directorTwoPass === true, 'live settings after init: directorTwoPass is true');
// The MESSAGE_RECEIVED handler (which hosts the conclusion chain) must survive a bare invoke.
threw = '';
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_RECEIVED handler runs against an empty chat' + (threw ? ' \u2014 threw: ' + threw : ''));

console.log('== v2.52.0 behavior: conclusion runs review -> plan through the real code paths ==');
// Arrange: live profile, auto director, an unconcluded episode, then a
// storyteller reply carrying [EPISODE_END]. The mock transport records WHICH
// prompt arrived WHEN — proving execution order, not just source order.
const llmCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('NORTH STAR')) { llmCalls.push('critique'); return 'NORTH STAR: play the irony gap harder.\n1. Track every named character present until they visibly exit.'; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { llmCalls.push('review'); return 'Intensity: standard\nSHOWRUNNER CUT: the rematch everyone bet against — now with the registrar in the ring.'; }
        if (sys.includes('expert story director')) { llmCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE — the rematch everyone bet against.'; }
        llmCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.profileId = 'gate-profile';
CA.directorMode = 'auto';
CA.streaming = false;
CA.critiqueOnEpisode = true;
CA.critiqueAuto = 0;
CA.directorWatcherPass = false; // legacy flow sections prove the two-pass contract; the three-pass path has its own section below
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'SECRET: episode one beats', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'The duel ends and the crowd goes silent. [EPISODE_END]' });
console.log = logCap;
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1); } catch (e) { errors.push('sim handler threw: ' + (e && e.message)); }
await new Promise(r => setTimeout(r, 200)); // the chain is fire-and-forget from the handler; let it drain
console.log = realLog;
ok(!errors.some(x => x.includes('sim handler threw')), 'conclusion handler ran the sim without throwing');
ok(llmCalls[0] === 'critique', 'the EDITOR pass fired first (got order: ' + llmCalls.join(', ') + ')');
ok(llmCalls[1] === 'directive', 'the NEXT directive fired second — designed with the fresh notes already saved');
ok(llmCalls[2] === 'review', 'the showrunner pass fired third — draft in, cut out');
ok(String(ctx.chatMetadata.cc_critique || '').startsWith('NORTH STAR:'), 'the review landed in cc_critique under the NORTH STAR contract');
const dNow = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dNow.episode === 2 && !dNow.concluded, 'auto mode chained to a live episode 2 after the review (got E' + dNow.episode + (dNow.concluded ? ' concluded' : '') + ')');
ok(String(dNow.text || '').includes('SHOWRUNNER CUT'), 'the STORED directive is the showrunner cut, not the first draft');

console.log('== v2.55.0 behavior: restart keeps the episode, discards the old take ==');
// Arrange: a live, unconcluded E2 directive, then press New (= Restart).
// The mock records the SYSTEM and USER prompts of both passes so we can prove
// what the model was actually told, not merely what the source says.
llmCalls.length = 0;
let capturedDraft = null, capturedReview = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[1] && messages[1].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) {
            llmCalls.push('review'); capturedReview = { sys, usr };
            return 'Intensity: intense\nRESTARTED CUT: the tribunal nobody called for.';
        }
        llmCalls.push('directive'); capturedDraft = { sys, usr };
        return 'Intensity: intense\n1. EPISODE PREMISE — a tribunal, not a duel.';
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'OLD E2: the duel on the welcome-day grounds.', episode: 2, concluded: false, ts: 5 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // refresh the label from the live directive
ok(document.getElementById('cc_dirnew').textContent.includes('Restart'), 'with a live directive the button reads Restart');
console.log = logCap;
try { document.getElementById('cc_dirnew').click(); await new Promise(r => setTimeout(r, 250)); } catch (e) { errors.push('restart click threw: ' + (e && e.message)); }
console.log = realLog;
ok(!errors.some(x => x.includes('restart click threw')), 'the New/Restart button ran without throwing');
ok(capturedDraft && capturedDraft.sys.includes('The player RESTARTED this episode'), 'restart draft used the restart prompt contract, not the plain new-episode prompt');
ok(capturedDraft && capturedDraft.usr.includes('[DISCARDED DIRECTIVE') && capturedDraft.usr.includes('OLD E2: the duel'), 'the rejected directive WAS shown to the model (without it, a restart can return the same episode)');
ok(capturedDraft && !capturedDraft.usr.includes('[PREVIOUS EPISODE DIRECTIVE'), 'the discarded episode is NOT passed as concluded history — it never aired');
ok(capturedReview && capturedReview.sys.includes('This episode is a RESTART'), 'the showrunner pass inherits the restart contract and cannot drift back to the rejected episode');
const dR = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dR.episode === 2, 'restart KEPT the episode number (got E' + dR.episode + ', want E2)');
ok(!dR.concluded, 'restart leaves the episode live, not concluded');
ok(String(dR.text || '').includes('RESTARTED CUT'), 'the restarted directive replaced the old text');
// Label honesty: the same button must read Restart while a directive is live.
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // the real refresh path
ok(document.getElementById('cc_dirnew').textContent.includes('New'), 'with no directive the same button reads New');

console.log('== v2.56.0 behavior: a hung provider cannot wedge the extension ==');
// The reported symptom: one request never settles -> `running` held forever ->
// every later click on every model dies silently. Prove the watchdog releases
// it AND that the very next click works.
llmCalls.length = 0;
CA.llmTimeoutSec = 1;           // 1s deadline for the test
CA.streaming = false;
let hangs = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: (pid, messages) => { hangs++; return new Promise(() => {}); },   // never settles
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 live directive.', episode: 2, concluded: false, ts: 9 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('cc_dirnew').click();               // restart against the hung provider
await new Promise(r => setTimeout(r, 300));
const busyDuringHang = true;                                 // op in flight; second click must be LOUD, not silent
const toastsBefore = toasts.length;
document.getElementById('cc_dirnew').click();
const gotBusyToast = toasts.length > toastsBefore && /Another operation is still running/.test(String(toasts[toasts.length - 1]));
await new Promise(r => setTimeout(r, 1400));                 // let the 1s watchdog fire
console.log = realLog;
ok(gotBusyToast, 'clicking during an in-flight operation is LOUD (busy toast), never a silent return');
ok(hangs === 1, 'the hung request was made exactly once (got ' + hangs + ')');
ok((ctx.chatMetadata['continuityCopilot'].director || {}).text === 'E2 live directive.', 'the directive was left unchanged by the timed-out attempt');
// Self-heal: the very next click, now against a working transport, must succeed.
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) return 'Intensity: standard\nHEALED CUT: the extension recovered.';
        return 'Intensity: standard\n1. EPISODE PREMISE — recovery.';
    },
};
console.log = logCap;
document.getElementById('cc_dirnew').click();
await new Promise(r => setTimeout(r, 300));
console.log = realLog;
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('HEALED CUT'), 'after the watchdog fired, the NEXT click succeeded — running was released, no reload needed');

console.log('== v2.57.0 behavior: the busy bubble proves the extension is alive ==');
// Streaming transport that yields chunks with real gaps; the bubble must show
// climbing character counts, the phase change to the showrunner pass, and the
// auto-abort countdown — counts only, never directive content.
llmCalls.length = 0;
CA.llmTimeoutSec = 60;
CA.streaming = true;
const bubbleSnapshots = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok, opts) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const isReview = sys.includes('SHOWRUNNER running the second-draft pass');
        if (!isReview) globalThis.__draftSys = sys;
        return function stream() {
            return (async function* () {
                const words = isReview ? ['Intensity: standard\n', 'TICKED CUT: ', 'alive and streaming.'] : ['Intensity: standard\n', '1. EPISODE ', 'PREMISE — liveness.'];
                for (const w of words) { await sleep(40); yield { text: w }; }
            })();
        };
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 to restart with ticks.', episode: 2, concluded: false, ts: 11 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const logEl = document.getElementById('cc_log');
const snap = () => {
    const kids = (logEl && logEl.children) || [];
    for (const k of kids) if (k && k.className && String(k.className).includes('cc_busy') && k.textContent) bubbleSnapshots.push(k.textContent);
};
const snapIv = setInterval(snap, 25);
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(700);
console.log = realLog;
clearInterval(snapIv);
snap();
const sawWaiting = bubbleSnapshots.some(t => /waiting for the first token/.test(t));
const sawChars = bubbleSnapshots.some(t => /\b\d+ chars/.test(t));
const sawPhase2 = bubbleSnapshots.some(t => /showrunner second draft/.test(t));
const sawCountdown = bubbleSnapshots.some(t => /auto-abort in \d+s/.test(t));
const leakedContent = bubbleSnapshots.some(t => /PREMISE|TICKED CUT/.test(t));
ok(sawWaiting || sawChars, 'the ticker rendered (waiting state or live counts) — got ' + bubbleSnapshots.length + ' snapshots');
ok(sawChars, 'character counts climbed on stream chunks — liveness is visible');
ok(sawPhase2, 'the phase label flipped to the showrunner second draft mid-flow');
ok(sawCountdown, 'the watchdog countdown is visible, so a silent provider has a visible fuse');
ok(!leakedContent, 'secrecy held: the readout showed counts, never directive content');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('TICKED CUT'), 'the streamed restart completed and stored the showrunner cut');
ok(/FIRST-DRAFT MODE/.test(String(globalThis.__draftSys || '')), 'two-pass draft ran in declared fast-draft mode');

console.log('== v2.58.0 behavior: end-season audit knows how much actually aired ==');
// Case 1: the directive stored by the previous sim was never played (no
// storyteller replies were appended after it was set). Ending the season must
// tell the audit NEVER PLAYED and forbid chat-searching.
let auditPrompt = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (/PLAYED-STATE:/.test(usr)) auditPrompt = usr;
        return 'Nothing references the dead plan.';
    },
};
console.log = logCap;
document.getElementById('cc_diroff').click();
await sleep(400);
console.log = realLog;
ok(confirms.length > 0, 'End season asked for confirmation through the real dialog');
ok(auditPrompt !== null, 'the residue audit fired through the normal pipeline');
ok(/PLAYED-STATE: NEVER PLAYED/.test(String(auditPrompt)), 'an unplayed directive is declared NEVER PLAYED to the audit');
ok(/do not search the chat for them/.test(String(auditPrompt)), 'the audit is told chat absence is expected — no spiraling on missing beats');
ok(/episode 2/.test(String(auditPrompt)), 'the audit names the exact cleared episode, not "the season"');
ok(/earlier episodes of this season genuinely aired/i.test(String(auditPrompt)), 'season history is fenced off from the audit scope');
ok((ctx.chatMetadata['continuityCopilot'] || {}).director === null, 'the directive was cleared');
// Case 2: a partially played directive — two storyteller replies after set.
auditPrompt = null;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E1 partial plan.', episode: 1, concluded: false, ts: 12, msgAt: ctx.chat.length }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'Reply one under the plan.' });
ctx.chat.push({ is_user: false, mes: 'Reply two under the plan.' });
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('cc_diroff').click();
await sleep(400);
console.log = realLog;
ok(/PLAYED-STATE: PARTIALLY PLAYED \u2014 about 2 storyteller replies/.test(String(auditPrompt)), 'a half-played directive reports its real reply count to the audit');
ok(/narrated on screen is history and stays/.test(String(auditPrompt)), 'partial audits protect what actually aired');

console.log('== v2.59.0 behavior: think-consumed recovery gets a bigger pot and succeeds ==');
// A reasoning model burns the whole pot on <think>. The recovery call must
// arrive with an ENLARGED maxTok and the transcription demand, then succeed.
CA.maxTokens = 4096;            // -> bigPot = min(32768, max(8192, 6144)) = 8192
CA.directorTwoPass = false;     // isolate Phase A
CA.thinkRetries = 2;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const potCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok) => {
        const last = (messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        potCalls.push({ maxTok, recovery: /Transcribe the decisions above/.test(last), fastDraft: /FIRST-DRAFT MODE/.test((messages[0] && messages[0].content) || '') });
        if (potCalls.length === 1) return '<think>endless deliberation about the perfect premise, forty thousand tokens of it</think>';
        return 'Intensity: standard\n1. EPISODE PREMISE — transcribed from the finished reasoning.';
    },
};
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(potCalls.length === 2, 'exactly one recovery round was needed (got ' + potCalls.length + ' calls)');
ok(potCalls[0] && potCalls[0].maxTok === 4096 && !potCalls[0].recovery, 'first attempt ran at the configured budget');
ok(potCalls[0] && !potCalls[0].fastDraft, 'single-pass mode keeps full deliberation — fast-draft only when a review will follow');
ok(potCalls[1] && potCalls[1].maxTok === 8192, 'the recovery ran in the enlarged pot (got ' + (potCalls[1] && potCalls[1].maxTok) + ', want 8192)');
ok(potCalls[1] && potCalls[1].recovery, 'the recovery demanded transcription of the finished reasoning');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'the directive was recovered and stored — the thinking was not wasted');

console.log('== v2.61.0 behavior: pause clears the live injection, storage stays ==');
// State from the previous sim: a live directive. Seed editor notes too, then
// pause both, re-apply via the real refresh path, and prove: slots cleared,
// storage intact, Peek-able; unpause restores both slots verbatim.
ctx.chatMetadata.cc_critique = 'NORTH STAR: keep the irony taut.\n1. Track every named presence.';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const dirSlot = () => String(ctx.extPrompts.get('cc_director') || '');
const critSlot = () => String(ctx.extPrompts.get('cc_critique_inject') || '');
ok(dirSlot().includes('transcribed from the finished reasoning'), 'unpaused: the directive is live in its injection slot');
ok(critSlot().includes('NORTH STAR: keep the irony taut.'), 'unpaused: the editor notes are live in their injection slot');
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot() === '', 'paused: the director slot is actively cleared, not merely skipped');
ok(critSlot() === '', 'paused: the editor-notes slot is actively cleared');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'paused: the directive itself is still stored untouched');
ok(String(ctx.chatMetadata.cc_critique || '').includes('NORTH STAR'), 'paused: the editor notes are still stored untouched');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().includes('transcribed from the finished reasoning') && critSlot().includes('NORTH STAR'), 'unpause restores both live slots verbatim from storage');

console.log('== v2.62.0 behavior: paused channels burn zero background calls ==');
let bgCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { bgCalls++; return 'Intensity: standard\n1. EPISODE PREMISE — should not exist while paused.'; } };
CA.directorMode = 'auto';
CA.directorInjectPaused = true;
CA.critiqueAuto = 1;
CA.critiqueInjectPaused = true;
CA.directorTwoPass = false;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ctx.chat.push({ is_user: false, mes: 'A reply lands while both channels are paused.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls === 0, 'paused: neither auto-director nor auto-critique burned a call (got ' + bgCalls + ')');
ok(!(ctx.chatMetadata['continuityCopilot'] || {}).director, 'paused: no invisible directive was generated');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
ctx.chat.push({ is_user: false, mes: 'A reply lands after unpausing.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls > 0, 'unpaused: automation resumed on the very next reply (got ' + bgCalls + ' calls)');


console.log('== v2.63.0 behavior: player sovereignty — the plan cannot pre-decide the player ==');
// The complaint this closes: directives were written as destiny ("MC does not
// help") instead of premise ("bullying erupts in front of the MC — the answer
// is theirs"). The fix is structural: the FORMAT can no longer express a
// predetermined outcome. These assertions hold that shape in place.
CA.directorMode = 'off';
// (a) The shipping default (migrated into live settings at init) carries the new spine.
ok(String(CA.directorPrompt || '').includes('THE PLAN STOPS AT THE PLAYER'), 'default prompt carries the stop-at-the-player beat grammar law');
ok(String(CA.directorPrompt || '').includes('EPISODE QUESTION'), 'default prompt anchors the episode on a player-facing EPISODE QUESTION');
ok(String(CA.directorPrompt || '').includes('is a stolen choice'), 'the grammar law teaches by example: the world half is a beat, the player half is a stolen choice');
ok(!String(CA.directorPrompt || '').includes('natural end state of the episode'), 'the fixed-outcome landing definition is gone from the shipping default');
ok(String(CA.directorPrompt || '').includes('one line per likely answer naming how the world responds'), 'landing maps consequences per answer instead of scripting one outcome');
ok(String(CA.directorPrompt || '').includes('(7) THEME'), 'craft doctrine gained the THEME law (value under test, felt not announced)');
// (b) The showrunner pass hunts sovereignty violations and cannot sharpen into illogic.
ok(SRC.includes('6. SOVEREIGNTY \\u2014 hunt every sentence that decides FOR the player'), 'showrunner pass carries the SOVEREIGNTY interrogation');
ok(SRC.includes('settle your seven interrogations'), 'showrunner deliberation counts all seven interrogations');
ok(SRC.includes('scripts the player\\\'s half of a collision is a downgrade'), 'sharpening has an explicit truth/freedom counterweight');
ok(SRC.includes('plausible causation \\u2014 would a skeptical viewer accept why each beat happens now'), 'LOGIC interrogation now checks causal plausibility, not just rule compliance');
// (c) The live storyteller wrapper: episode ends on the ANSWERED question, never on reaching a scripted landing.
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E9 sovereignty plan.', episode: 9, concluded: false, ts: 1, msgAt: ctx.chat.length }, directorEp: 9 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap = dirSlot();
ok(wrap.includes('STOP AT THE PLAYER'), 'wrapper orders the storyteller to stop at the player\u2019s decision point');
ok(wrap.includes('unchosen branches never happened'), 'wrapper quarantines unchosen consequence branches from canon');
ok(wrap.includes('When the EPISODE QUESTION has been answered by the player on screen'), 'wrapper ends the episode on the answered question');
ok(!wrap.includes('When the LANDING state is fully reached'), 'the old reach-the-landing teleology is gone from the wrapper');
// (d) Migration mechanics, executed with the real values: the v2.62 default was
// frozen verbatim, differs from the new default, upgrades when stored, and a
// customized copy is left alone.
const hookM = SRC.match(/const HOOK_LINE = ('(?:[^'\\]|\\.)*');/);
const v262M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V262 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
const defM = SRC.match(/const DEFAULT_DIRECTOR_PROMPT = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!(hookM && v262M && defM), 'HOOK_LINE, frozen V262, and new default are all extractable from source');
let v262 = '', dflt = '';
try {
    const HOOK = new Function('return ' + hookM[1])();
    v262 = new Function('HOOK_LINE', 'return ' + v262M[1])(HOOK);
    dflt = new Function('HOOK_LINE', 'return ' + defM[1])(HOOK);
} catch (e) { ok(false, 'evaluating the prompt constants threw: ' + (e && e.message)); }
ok(v262.includes('natural end state of the episode') && v262.includes('conclude naturally at the landing'), 'the freeze preserved the old v2.62 text verbatim (stored copies will match it)');
ok(v262.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.62 default');
const migrates = (stored) => [v262].some(pp => stored.trim() === pp.trim());
ok(migrates(v262 + '\n'), 'migration predicate: an untouched stored v2.62 default upgrades');
ok(!migrates(v262 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

console.log('== v2.64.0 behavior: total sovereignty — no seam left for the plan to script the player ==');
// v2.63 banned the player as "author of a response" and a live directive
// promptly scripted the player's ENTIRE duel as involuntary events ("his
// Reaving surfaces involuntarily"), scripted his dialogue ("Fine."), and
// presupposed the reveal at premise level ("the question isn't whether his
// tier comes out"). Each seam is now closed, and the version stamp that
// silently stayed at 2.62.0 is now locked to the manifest.
// (a) Version lock: the in-code header stamp can never drift from the manifest again.
const verM = SRC.match(/const VERSION = '([^']+)';/);
let maniVer = '';
try { maniVer = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')).version; } catch (e) {}
ok(!!verM && !!maniVer && verM[1] === maniVer, 'in-code VERSION stamp matches manifest.json (' + (verM && verM[1]) + ' vs ' + maniVer + ')');
// (b) The shipping default carries the total-subject ban.
const dp = String(CA.directorPrompt || '');
ok(dp.includes('never be the SUBJECT of a planned sentence'), 'beats law: the player may never be the subject of any planned sentence');
ok(dp.includes('involuntary is still theirs'), 'the involuntary loophole is named and closed');
ok(dp.includes('"his real tier comes out" is a stolen choice'), 'the reveal-by-plan case is taught by example');
ok(dp.includes("the question isn't whether the player does X"), 'premise-level presupposition is banned with its tell named');
ok(dp.includes("The TURN is the WORLD's move"), 'the TURN must be an NPC/world move, never a player performance');
ok(dp.includes('choreograph ONLY the NPC'), 'scheduled events choreograph only the NPC half — every player answer stays blank');
ok(!dp.includes('never as the author of a response'), 'the old response-only phrasing (the seam) is gone from the shipping default');
// (c) Showrunner pass hunts the whole class.
ok(SRC.includes('theft with an alibi'), 'SOVEREIGNTY names involuntary scripting as theft with an alibi');
ok(SRC.includes('even one scripted word'), 'SOVEREIGNTY catches scripted player dialogue');
ok(SRC.includes('STAGED by the world and completed by the player'), 'THE MOMENT must be world-staged, never a scripted player action');
// (d) Live wrapper: the storyteller is told slips belong to the player too.
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap64 = dirSlot();
ok(wrap64.includes('neither are their slips'), 'wrapper: player slips are player events');
ok(wrap64.includes('let the player decide what breaks'), 'wrapper: pressure is staged, breakage is played');
// (e) Migration: v2.63 default frozen verbatim, upgrades, customization untouched.
const v263M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V263 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v263M, 'frozen V263 default is extractable from source');
let v263 = '';
try {
    const HOOK2 = new Function('return ' + hookM[1])();
    v263 = new Function('HOOK_LINE', 'return ' + v263M[1])(HOOK2);
} catch (e) { ok(false, 'evaluating V263 threw: ' + (e && e.message)); }
ok(v263.includes('never as the author of a response'), 'the freeze preserved the v2.63 text verbatim (stored copies will match it)');
ok(v263.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.63 default');
const migrates64 = (stored) => [v262, v263].some(pp => stored.trim() === pp.trim());
ok(migrates64(v263 + '\n'), 'migration predicate: an untouched stored v2.63 default upgrades');
ok(!migrates64(v263 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

// (f) v2.65 recognition grammar: V264 frozen verbatim, upgrades, and the new laws exist.
const v264M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V264 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v264M, 'frozen V264 default is extractable from source');
let v264 = '';
try {
    const HOOK4 = new Function('return ' + hookM[1])();
    v264 = new Function('HOOK_LINE', 'return ' + v264M[1])(HOOK4);
} catch (e) { ok(false, 'evaluating V264 threw: ' + (e && e.message)); }
ok(v264.includes('Plan the temptation, never the yielding'), 'the freeze preserved the v2.64 text verbatim (stored copies will match it)');
ok(!v264.includes('RECOGNITION LAW'), 'the V264 freeze is genuinely the pre-recognition text, not a copy of the new default');
ok(createHash('sha256').update(v264).digest('hex') === '0acbd3b073a0f7ed69de16da2465ccab52580d7d5a4eec78845ece753067482c', 'V264 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v264.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.64 default');
const migrates65 = (stored) => [v262, v263, v264].some(pp => stored.trim() === pp.trim());
ok(migrates65(v264 + '\n'), 'migration predicate: an untouched stored v2.64 default upgrades');
ok(!migrates65(v264 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.64 prompt is never overwritten');
ok(dflt.includes('real screen time instead of a summary line'), 'delights palette demands screen time for repricing payoffs');
ok(dflt.includes('AMBIENT INTERLUDE') && dflt.includes('AMBIENT EXCEPTION'), 'ambient interlude shape exists and is exempted from the DILEMMA');
ok(dflt.includes('dismissed\u2192reckoned-with'), 'turn-the-value vocabulary includes recognition flips');
ok(SRC.includes('7. PAYOFF ON SCREEN') && SRC.includes('A payoff summarized into aftermath is a skipped payoff'), 'showrunner interrogates payoff staging as craft');

// (g) v2.66 audience balance: V265 frozen verbatim + hash, rotation, either-direction, warm register.
const v265M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V265 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v265M, 'frozen V265 default is extractable from source');
let v265 = '';
try {
    const HOOK5 = new Function('return ' + hookM[1])();
    v265 = new Function('HOOK_LINE', 'return ' + v265M[1])(HOOK5);
} catch (e) { ok(false, 'evaluating V265 threw: ' + (e && e.message)); }
ok(v265.includes('lands in full before anything answers it'), 'the freeze preserved the v2.65 text verbatim (stored copies will match it)');
ok(!v265.includes('never the same audience two episodes running'), 'the V265 freeze is genuinely the pre-rotation text, not a copy of the new default');
ok(createHash('sha256').update(v265).digest('hex') === '025e5429b3a43fa61acf38a472c4ca9edf75c75f47b7b953f467c8f40bc2e8ef', 'V265 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v265.includes('RECOGNITION LAW') && v265.includes('the OLD reading scores first'), 'recognition-era freeze carries the law (historical witness)');
ok(v265.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.65 default');
const migrates66 = (stored) => [v262, v263, v264, v265].some(pp => stored.trim() === pp.trim());
ok(migrates66(v265 + '\n'), 'migration predicate: an untouched stored v2.65 default upgrades');
ok(!migrates66(v265 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.65 prompt is never overwritten');
ok(!dflt.includes('RECOGNITION LAW') && !dflt.includes('never the same audience two episodes running'), 'v2.67 default carries no recognition legislation \u2014 the insight moved to taste');
ok(dflt.includes('cold (the room that muttered who-is-this-guy') && dflt.includes('or warm (a best friend re-seeing'), 'delights palette names cold and warm registers as equals');
ok(dflt.includes('a masterpiece owes the player nothing but itself'), 'delights are a palette, not a quota \u2014 delight-free episodes are lawful');
ok(dflt.includes('taste knowledge, not a quota'), 'palette is explicitly taste, not law');

// (h) v2.67 three-layer room: V266 frozen + hashed, watcher pass exists, wired, sovereign, minimal-cut.
const v266M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V266 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v266M, 'frozen V266 default is extractable from source');
let v266 = '';
try {
    const HOOK6 = new Function('return ' + hookM[1])();
    v266 = new Function('HOOK_LINE', 'return ' + v266M[1])(HOOK6);
} catch (e) { ok(false, 'evaluating V266 threw: ' + (e && e.message)); }
ok(createHash('sha256').update(v266).digest('hex') === '56360487bed0a38f4bd3f6ad8f0046b71c301e184c695da226c1d16ac984426e', 'V266 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v266.includes('never the same audience two episodes running'), 'V266 freeze carries the rotation law (historical witness)');
ok(v266.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.66 default');
const migrates67 = (stored) => [v262, v263, v264, v265, v266].some(pp => stored.trim() === pp.trim());
ok(migrates67(v266 + '\n'), 'migration predicate: an untouched stored v2.66 default upgrades');
ok(!migrates67(v266 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.66 prompt is never overwritten');
ok(SRC.includes('const WATCHER_PASS_PROMPT'), 'watcher pass prompt exists');
ok(SRC.includes('MINIMAL CUT') && SRC.includes('if the episode already airs, output it unchanged'), 'watcher is a minimal final cut, not a third rewrite');
ok(SRC.includes('wish for situations, never for answers'), 'watcher sovereignty: enjoyment may never script the player');
ok(SRC.includes('slow is welcome when slow is what the story is hungry for'), 'watcher legitimizes slow episodes by taste, not schedule');
ok(SRC.includes("tick.phase('watcher final cut')") && SRC.includes('directorWatcherPass') && SRC.includes('shipping the showrunner cut'), 'watcher pass is wired into the directive flow with empty-fallback');
ok(SRC.includes('directorWatcherPass: true,'), 'watcher pass defaults on');
ok(SRC.includes("el('cc_dir_watcher').checked = settings.directorWatcherPass !== false;") && SRC.includes("settings.directorWatcherPass = el('cc_dir_watcher').checked;"), 'watcher toggle load/save round-trips');
ok(!dflt.includes('every fourth or fifth episode') && dflt.includes('available whenever the story is hungry for breath'), 'ambient interlude is available on demand, not on a schedule');

console.log('== v2.67.0 behavior: the watcher third pass ==');
const wCalls = [];
let watcherReturn = 'Intensity: standard\nWATCHER AIRED ONE: same cut, one delight staged.';
let srReturn = 'Intensity: standard\nSHOWRUNNER CUT ONE: the rematch, sharpened.';
globalThis.__watcherSys = ''; globalThis.__watcherUsr = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (sys.includes('THE WATCHER')) { wCalls.push('watcher'); globalThis.__watcherSys = sys; globalThis.__watcherUsr = usr; return watcherReturn; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { wCalls.push('review'); return srReturn; }
        if (sys.includes('expert story director')) { wCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE: the rematch.'; }
        wCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.directorWatcherPass = true;
CA.directorTwoPass = true;
CA.directorMode = 'off';
CA.streaming = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
const w1 = wCalls.join(',');
ok(w1 === 'directive,review,watcher', 'three-pass order: maker, showrunner, watcher (got: ' + w1 + ')');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED ONE'), 'the STORED directive is the watcher final cut');
ok(globalThis.__watcherUsr.includes('[SCREENING COPY') && globalThis.__watcherUsr.includes('SHOWRUNNER CUT ONE'), 'the showrunner cut travels to the couch as the screening copy');
ok(globalThis.__watcherSys.includes('MINIMAL CUT') && !globalThis.__watcherSys.includes('This episode is a RESTART'), 'fresh episode: watcher briefed for minimal cut, no restart addendum');
// empty watcher output ships the showrunner cut
wCalls.length = 0; watcherReturn = ''; srReturn = 'Intensity: standard\nSHOWRUNNER CUT TWO: fallback proof.';
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
const dW2 = String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '');
ok(wCalls.join(',') === 'directive,review,watcher' && dW2.includes('SHOWRUNNER CUT TWO') && !dW2.includes('WATCHER AIRED'), 'empty watcher pass falls back to the showrunner cut');
// toggle off: exactly two calls, no watcher
wCalls.length = 0; srReturn = 'Intensity: standard\nSHOWRUNNER CUT THREE: two-pass toggle proof.';
CA.directorWatcherPass = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(wCalls.join(',') === 'directive,review' && String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('SHOWRUNNER CUT THREE'), 'watcher toggle off restores the exact two-pass contract');
// restart: the watcher receives the never-aired warning
wCalls.length = 0; watcherReturn = 'Intensity: standard\nWATCHER AIRED FOUR: the road not taken, enjoyed.'; srReturn = 'Intensity: standard\nSHOWRUNNER CUT FOUR.';
CA.directorWatcherPass = true;
globalThis.__watcherSys = '';
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(globalThis.__watcherSys.includes('This episode is a RESTART'), 'restart: the watcher is told the discarded directive never aired');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED FOUR'), 'restart flow ships the watcher final cut');

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('MODULE INTEGRITY FAILED ✗'); process.exit(1); }
console.log('MODULE INTEGRITY OK ✓');
