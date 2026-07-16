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
        addEventListener: () => {}, removeEventListener: () => {},
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, focus: () => {}, blur: () => {}, click: () => {},
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
globalThis.toastr = { info: () => {}, success: () => {}, warning: () => {}, error: () => {}, clear: () => {} };
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
    setExtensionPrompt: () => {}, getCurrentChatId: () => 'gate.jsonl',
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
ok(SRC.includes('LEGACY_DIRECTOR_PROMPT_V248, LEGACY_DIRECTOR_PROMPT_V251];'), 'stored 2.49-2.51 default prompt auto-upgrades to the CRAFT default');
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
        if (sys.includes('expert story director')) { llmCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE — the rematch everyone bet against.'; }
        llmCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.profileId = 'gate-profile';
CA.directorMode = 'auto';
CA.streaming = false;
CA.critiqueOnEpisode = true;
CA.critiqueAuto = 0;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'SECRET: episode one beats', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'The duel ends and the crowd goes silent. [EPISODE_END]' });
console.log = logCap;
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1); } catch (e) { errors.push('sim handler threw: ' + (e && e.message)); }
await new Promise(r => setTimeout(r, 200)); // the chain is fire-and-forget from the handler; let it drain
console.log = realLog;
ok(!errors.some(x => x.includes('sim handler threw')), 'conclusion handler ran the sim without throwing');
ok(llmCalls[0] === 'critique', 'the EDITOR pass fired first (got order: ' + llmCalls.join(', ') + ')');
ok(llmCalls[1] === 'directive', 'the NEXT directive fired second — designed with the fresh notes already saved');
ok(String(ctx.chatMetadata.cc_critique || '').startsWith('NORTH STAR:'), 'the review landed in cc_critique under the NORTH STAR contract');
const dNow = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dNow.episode === 2 && !dNow.concluded, 'auto mode chained to a live episode 2 after the review (got E' + dNow.episode + (dNow.concluded ? ' concluded' : '') + ')');

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('MODULE INTEGRITY FAILED ✗'); process.exit(1); }
console.log('MODULE INTEGRITY OK ✓');
