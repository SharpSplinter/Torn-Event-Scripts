"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const file = path.join(__dirname, "Torn Elimination Faction Rankings Beta.user.js");
const api = require(file);
const now = Date.parse("2026-09-09T20:00:00Z");
const team = { id: 90, name: "Loose Cannons", participants: 101 };
const row = (id, state = "Okay") => ({ id, name: "Player " + id, level: 50,
    score: id, attacks: 1, status: { state, until: now / 1000 + 120 },
    last_action: { status: "Online", timestamp: now / 1000 } });
const page = (rows, next = null) => ({ eliminationteam: rows,
    _metadata: { links: { next, prev: null } } });

function fixture(responder = () => [], saved = {}) {
    let time = now;
    const calls = [], logs = [], waits = [];
    const context = { module: { exports: {} }, URL, Intl,
        document: { visibilityState: "visible" },
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } },
        console: Object.fromEntries(["debug", "info", "warn"].map(k => [k, (...args) => logs.push(args)])),
        setTimeout(fn, ms) { time += ms; waits.push(ms); queueMicrotask(fn); return 1; }, clearTimeout() {},
        GM_getValue(k, fallback) { return saved[k] ?? fallback; },
        GM_setValue(k, value) { saved[k] = structuredClone(value); },
        GM_xmlhttpRequest(details) {
            const url = new URL(details.url);
            calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), headers: details.headers, at: time });
            Promise.resolve(responder(url, details)).then(data => details.onload({
                status: data?.http || 200, responseText: JSON.stringify(data?.body ?? data)
            }), details.onerror);
        }
    };
    const source = fs.readFileSync(file, "utf8").replace("        VERSION, REQUEST_GAP_MS,",
        "        hooks: { requestJson, liveTeams, refreshLiveTeams, currentTeams, migrateAttackRankings, tabRefreshControl, refreshTab, directory, ff, runtime, loadPersistentState, readShared, loadCompetition, saveCompetitionSort, queueFF, validateFF, setFFKey, refreshVisibleEstimates, loadBSHistory, findFFTargets, directoryRequest, competitionTick, saveExtra, synchronizeDirectoryEvent, competitionView, bsHistoryMarkup, bindHistoryTooltips, STYLE },\n        VERSION, REQUEST_GAP_MS,");
    vm.runInNewContext(source.replace("hooks: {", "hooks: { watchPdaBridge, recoverPdaStorage,"), context);
    const h = context.module.exports.hooks;
    h.runtime.config.tab = "competition";
    h.runtime.apiKey = "main-test-key";
    h.directory.loaded = true;
    h.directory.data = api.newDirectory([team], now);
    h.directory.team = "90";
    h.directory.catalog = { year: 2026, updatedAt: now, teams: [team] };
    h.ff.key = "f".repeat(16);
    h.ff.validated = true;
    return { ...h, calls, logs, waits, saved, context, advance(ms) { time += ms; } };
}

test("late native readiness restores saved index and checkpoint without fallback writes", async () => {
    const f = fixture(), listeners = new Set();
    f.watchPdaBridge({
        addEventListener(name, fn) { listeners.add(fn); },
        removeEventListener(name, fn) { listeners.delete(fn); }
    });
    const d = api.newDirectory([team], now);
    api.acceptRosterPage(d, 90, 0, page([row(1)]), now, true);
    const saved = { TEFR_V2_DIRECTORY: api.packDirectory(d),
        TEFR_V2_PENDING_SCAN: { id: "retained" } };
    let ready = false, calls = 0, writes = 0;
    f.context.PDA_storage = {
        loadAll() { calls++; if (!ready) throw Error("private bridge error"); return structuredClone(saved); },
        setMany() { writes++; }
    };
    const loading = f.loadPersistentState();
    assert.equal(calls, 0);
    await loading;
    assert.equal(calls, 2);
    assert.ok(f.runtime.storageError);
    ready = true;
    f.context.document.visibilityState = "hidden";
    for (const fn of [...listeners]) fn();
    await f.recoverPdaStorage();
    assert.equal(calls, 2);
    f.context.document.visibilityState = "visible";
    await Promise.all([f.recoverPdaStorage(), f.recoverPdaStorage()]);
    assert.equal(calls, 3);
    assert.equal(f.runtime.storageError, "");
    assert.equal(f.runtime.scan.id, "retained");
    assert.equal(f.directory.data.scan.done, true);
    assert.equal(f.directory.data.players[1].status.state, "Okay");
    assert.equal(writes, 0);
    assert.deepEqual(f.saved, {});
    const recoveryLogs = JSON.stringify(f.logs);
    assert.match(recoveryLogs, /PDA_storage\.loadAll failed/);
    assert.match(recoveryLogs, /private bridge error/);
    assert.match(recoveryLogs, /Late bridge recovery succeeded/);
});

test("readiness event before timeout permits the first native load", async () => {
    const f = fixture(), listeners = new Set();
    f.watchPdaBridge({
        addEventListener(name, fn) { listeners.add(fn); },
        removeEventListener(name, fn) { listeners.delete(fn); }
    });
    let calls = 0, ready = false;
    f.context.PDA_storage = { loadAll() { calls++; assert.ok(ready); return {}; } };
    const loading = f.loadPersistentState();
    assert.equal(calls, 0);
    ready = true;
    for (const fn of [...listeners]) fn();
    await loading;
    assert.equal(calls, 1);
    assert.equal(f.runtime.storageError, "");
});

test("invalid native responses fail closed and transient startup errors retry", async () => {
    for (const value of [null, [], "invalid"]) {
        const f = fixture();
        f.context.PDA_storage = { loadAll() { return value; } };
        await f.loadPersistentState();
        assert.ok(f.runtime.storageError);
        assert.equal(f.runtime.nativeValues, null);
    }
    const f = fixture();
    let calls = 0;
    f.context.PDA_storage = { loadAll() { if (++calls === 1) throw Error("not ready"); return {}; } };
    await f.loadPersistentState();
    assert.equal(calls, 2);
    assert.equal(f.runtime.storageError, "");
});

test("bundled seed has 12 teams, 22814 unique players and no invented status", () => {
    const d = api.newDirectory(undefined, now);
    assert.equal(d.teams.length, 12);
    assert.equal(Object.keys(d.players).length, 22814);
    assert.equal(new Set(Object.values(d.players).map(p => p.id)).size, 22814);
    assert.equal(Object.values(d.players).every(p => p.status === null && p.source === "ultimata"), true);
    assert.ok(Buffer.byteLength(JSON.stringify(d)) < 8 * 1024 * 1024);
});

test("official pages override seed and retire unmatched rows only after full scan", () => {
    const d = api.newDirectory([team], now);
    d.players[99999999] = { id: 99999999, source: "ultimata", teamId: 90 };
    const next = "https://api.torn.com/v2/torn/90/eliminationteam?offset=100&key=NEVER_PERSIST";
    api.acceptRosterPage(d, 90, 0, page(Array.from({ length: 100 }, (_, i) => row(i + 1)), next), now, true);
    assert.ok(d.players[99999999]);
    assert.equal(d.scan.done, false);
    assert.equal(d.players[1].source, "torn");
    assert.equal(JSON.stringify(d).includes("NEVER_PERSIST"), false);
    api.acceptRosterPage(d, 90, 100, page([row(101), row(101)]), now, true);
    assert.equal(d.scan.done, true);
    assert.equal(Object.keys(d.players).length, 101);
    assert.equal(d.pages["90:100"].ids.length, 1);
});

test("pagination rejects malformed, foreign, repeated and wrong-team links atomically", () => {
    for (const next of ["https://evil.example/?offset=100", "/v2/torn/89/eliminationteam?offset=100",
        "/v2/torn/90/eliminationteam?offset=0", "/v2/torn/90/eliminationteam?offset=no"]) {
        const d = api.newDirectory([team], now);
        const before = JSON.stringify(d);
        assert.throws(() => api.acceptRosterPage(d, 90, 0, page([row(1)], next), now, true));
        assert.equal(JSON.stringify(d), before);
    }
    assert.throws(() => api.nextRosterOffset({}, 90, 0));
    assert.throws(() => api.acceptRosterPage(api.newDirectory([team], now), 90, 0, page([row(-1)])));
});

test("new year excludes old seed; changed event team IDs reset directory only", () => {
    assert.equal(Object.keys(api.newDirectory([team], Date.UTC(2027, 8, 9)).players).length, 0);
    const f = fixture();
    f.runtime.history = { points: [{ marker: "keep" }] };
    f.directory.catalog = null;
    f.runtime.snapshot = { globalTeamsAvailable: true, completedAt: now, teams: [{ id: 91, name: "New", participants: 20 }] };
    f.synchronizeDirectoryEvent();
    assert.equal(f.directory.data.eventKey, "2026:91");
    assert.equal(f.runtime.history.points[0].marker, "keep");
});

test("compact directory survives page reloads and keeps completed scans completed", async () => {
    const f = fixture(() => page([row(1)]));
    f.ff.key = "";
    await f.directoryRequest(90, 0, true);
    assert.equal(f.directory.data.scan.done, true);
    assert.equal(f.saved.TEFR_V2_DIRECTORY.schema, 3);
    assert.equal(f.saved.TEFR_V2_DIRECTORY.players, undefined);
    const restored = fixture(() => page([row(1)]), f.saved);
    restored.ff.key = "";
    restored.directory.loaded = false;
    await restored.loadCompetition();
    restored.directory.catalog = { year: 2026, updatedAt: now, teams: [team] };
    assert.equal(restored.directory.data.scan.done, true);
    assert.equal(restored.directory.data.players[1].status.state, "Okay");
    await restored.competitionTick();
    assert.equal(restored.calls.length, 1, "Reload updates the visible page only");
    await restored.competitionTick();
    assert.equal(restored.calls.length, 1, "No recurring full build");
    restored.advance(60000);
    await restored.competitionTick();
    assert.equal(restored.calls.length, 2);
    assert.ok(restored.calls.every(call => call.path === "/v2/torn/90/eliminationteam" && call.params.offset === "0"));
});

test("official cursor is independent of standings order and resumes missing pages", () => {
    const d = api.newDirectory([{ id: 90, name: "B" }, { id: 70, name: "A" }], now);
    d.players = {};
    api.acceptRosterPage(d, 70, 0, page([row(1)]), now, true);
    d.teams.reverse();
    api.reconcileDirectoryCursor(d);
    assert.equal(d.teams[d.scan.team].id, 90);
    api.acceptRosterPage(d, 90, 0, page([row(2)]), now, true);
    assert.equal(d.scan.done, true);
    const stored = JSON.parse(JSON.stringify(api.packDirectory(d)));
    assert.equal(api.unpackDirectory(stored).scan.done, true);
});

test("full seed persistence is compact enough to leave room for TornPDA history", () => {
    const d = api.newDirectory(undefined, now);
    const packed = JSON.stringify(api.packDirectory(d));
    assert.ok(Buffer.byteLength(packed) < 3 * 1024 * 1024);
    assert.equal(Object.keys(api.unpackDirectory(JSON.parse(packed)).players).length, 22814);
});

test("same-event official ID corrections preserve other indexed teams", () => {
    const f = fixture();
    f.directory.data = api.newDirectory([{ id: 79, name: "Brain Surgeons" }, team], now);
    f.directory.data.pages["90:0"] = { ids: [1], next: null, updatedAt: now };
    f.directory.catalog = { year: 2026, updatedAt: now, teams: [{ id: 70, name: "Brain Surgeons" }, team] };
    f.synchronizeDirectoryEvent();
    assert.ok(f.directory.data.pages["90:0"]);
    assert.equal(f.directory.data.teams[0].id, 70);
    assert.equal(f.directory.data.scan.offset, 0);
});

test("hospital timer handles unknown, missing time, expiry and revised discharge", () => {
    assert.equal(api.hospitalLabel({ source: "ultimata" }, now), "Status unavailable");
    const p = api.normalizeDirectoryPlayer(row(1, "Hospital"), 90, now);
    assert.equal(api.hospitalLabel(p, now), "Hospital · 00:02:00");
    assert.equal(api.hospitalLabel(p, now + 120000), "Hospital · Awaiting status refresh");
    p.status.until = null;
    assert.equal(api.hospitalLabel(p, now), "Hospital · timer unavailable");
    p.status.until = now / 1000 + 3600;
    assert.equal(api.hospitalLabel(p, now), "Hospital · 01:00:00");
    p.status.state = "Okay";
    assert.equal(api.hospitalLabel(p, now), "Okay");
});

test("null FF estimates stay unknown and page filters retain unknowns by default", () => {
    const e = api.normalizeEstimate({ player_id: 1, fair_fight: null, bs_estimate: null }, now);
    assert.equal(e.fairFight, null);
    assert.equal(e.estimate, null);
    const filters = { status: "all", activity: "all", minff: "2", maxff: "3", minbs: "", maxbs: "", unknown: true };
    assert.equal(api.passesEstimateFilters({}, e, filters), true);
    assert.equal(api.passesEstimateFilters({}, e, { ...filters, unknown: false }), false);
    assert.equal(api.passesEstimateFilters({}, { fairFight: 4, estimate: 5 }, filters), false);
});

test("finder validates ranges and uses one canonical team with all-activity default", () => {
    const p = api.finderParameters({ team: 90, minlevel: 1, maxlevel: 100, minff: 1, maxff: 3, limit: 20 }, [team]);
    assert.equal(p["elimination_teams[]"], "Loose Cannons");
    assert.equal(p.inactiveonly, 0);
    assert.equal(p.limit, 20);
    assert.throws(() => api.finderParameters({ team: 90, minlevel: 5, maxlevel: 1, minff: 1, maxff: 3, limit: 20 }, [team]));
});

test("FF queue coalesces batches, enforces 6s gap and never logs query credentials", async () => {
    const f = fixture(url => url.pathname.endsWith("check-key")
        ? { key: "f".repeat(16), is_registered: true } : []);
    await Promise.all([f.queueFF("get-stats", { targets: "1" }), f.queueFF("get-stats", { targets: "1" })]);
    assert.equal(f.calls.length, 1);
    for (let i = 2; i < 13; i++) await f.queueFF("get-stats", { targets: String(i) });
    for (let i = 1; i < f.calls.length; i++) assert.ok(f.calls[i].at - f.calls[i - 1].at >= 6000);
    assert.equal(f.calls.some(c => c.headers.Authorization), false);
    await f.validateFF();
    assert.equal(JSON.stringify(f.logs).includes("f".repeat(16)), false);
    assert.equal(JSON.stringify(f.saved).includes("f".repeat(16)), false);
});

test("visible FF estimates cache for 5m, missing players are negatively cached", async () => {
    const f = fixture(() => [{ player_id: 1, fair_fight: 2.17, bs_estimate: 500, last_updated: 1, source: "bss" }]);
    f.directory.data.players = { 1: api.normalizeDirectoryPlayer(row(1), 90), 2: api.normalizeDirectoryPlayer(row(2), 90) };
    f.directory.displayIds = [1, 2];
    await f.refreshVisibleEstimates();
    assert.equal(f.calls.length, 1);
    assert.equal(f.ff.cache.stats[2].estimate, null);
    await f.refreshVisibleEstimates();
    assert.equal(f.calls.length, 1);
    f.advance(300000);
    await f.refreshVisibleEstimates();
    assert.equal(f.calls.length, 2);
});

test("FF queue discards obsolete page requests and replaced-key responses", async () => {
    let release;
    const f = fixture(() => new Promise(resolve => { release = resolve; }));
    const running = f.queueFF("get-stats", { targets: "1" });
    await new Promise(resolve => setImmediate(resolve));
    const obsolete = f.queueFF("get-stats", { targets: "2" }, () => false);
    f.ff.generation++;
    release([{ player_id: 1 }]);
    assert.equal(await running, null);
    assert.equal(await obsolete, null);
    assert.equal(f.calls.length, 1);
});

test("FF key replacement/removal clears account-dependent caches and suggestions", async () => {
    const f = fixture();
    f.ff.cache.stats[1] = { source: "spies", estimate: 20 };
    f.ff.suggestions = [{ id: 1 }];
    await f.setFFKey("r".repeat(16));
    assert.equal(Object.keys(f.ff.cache.stats).length, 0);
    assert.equal(f.ff.suggestions.length, 0);
    await f.setFFKey("");
    assert.equal(f.saved.TEFR_V2_FF_KEY, "");
    assert.equal(Object.keys(f.saved.TEFR_V2_FF_CACHE.stats).length, 0);
});

test("FF errors use cooldown and stop invalid-key automatic polling", async () => {
    let n = 0;
    const f = fixture(() => ++n === 1 ? { http: 429, body: { code: 20, retry_after_seconds: 70 } } : []);
    await f.queueFF("get-stats", { targets: "1" });
    assert.ok(f.calls[1].at - f.calls[0].at >= 70000);
    const invalid = fixture(() => ({ http: 401, body: { code: 6, error: "secret echo ffffffffffffffff" } }));
    await invalid.queueFF("get-stats", { targets: "1" });
    assert.equal(invalid.ff.blocked, true);
    assert.equal(JSON.stringify(invalid.logs).includes("ffffffffffffffff"), false);
});

test("history is on demand, bounded and cached; suggestions stay separate", async () => {
    const f = fixture(url => url.pathname.endsWith("get-stats-history") ? { history: [
        { timestamp: 1, bs_estimate: 20 }, { timestamp: 21601, bs_estimate: null }, { timestamp: 43201, bs_estimate: 40 }
    ] } : { parameters: { key: "do not save" }, targets: [{ player_id: 777, name: "Target", level: 5, fair_fight: 2, bs_estimate: 400, hospital_until: 9999999999 }] });
    await f.loadBSHistory(1);
    await f.loadBSHistory(1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].params.limit, "28");
    assert.equal(f.ff.cache.history[1].points[1].value, null);
    const before = Object.keys(f.directory.data.players).length;
    await f.findFFTargets({ team: 90, minlevel: 1, maxlevel: 100, minff: 1, maxff: 3, limit: 20 });
    assert.equal(f.ff.suggestions.length, 1);
    assert.equal(Object.keys(f.directory.data.players).length, before);
    assert.equal(JSON.stringify(f.ff.cache).includes("hospital_until"), false);
    assert.equal(JSON.stringify(f.saved).includes("do not save"), false);
});

test("directory closure cooldown persists and does not trigger per-player Torn requests", async () => {
    const f = fixture(() => ({ error: { code: 32 } }));
    await f.directoryRequest(90, 0, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.directory.data.scan.retryAt, now + 1800000);
    assert.ok(f.saved.TEFR_V2_DIRECTORY.scan.retryAt);
    f.ff.key = "";
    await f.competitionTick();
    assert.equal(f.calls.length, 1);
});

test("hidden tabs pause requests; faction scans pause indexing but not on-demand pages", async () => {
    const f = fixture(() => page([row(1)]));
    f.context.document.visibilityState = "hidden";
    assert.equal(await f.directoryRequest(90, 0), false);
    f.context.document.visibilityState = "visible";
    f.runtime.busy = true;
    assert.equal(await f.directoryRequest(90, 0, true), false);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.directoryRequest(90, 0), true);
    assert.equal(f.calls.length, 1);
});

test("storage failure keeps in-memory data, pauses scan and preserves faction history", async () => {
    const f = fixture();
    f.context.GM_setValue = () => { throw new Error("quota"); };
    f.runtime.history = { points: [{ keep: true }] };
    assert.equal(await f.saveExtra("TEFR_V2_DIRECTORY", f.directory.data), false);
    assert.equal(f.directory.data.scan.paused, true);
    assert.equal(f.runtime.history.points[0].keep, true);
    assert.ok(Object.keys(f.directory.data.players).length > 0);
});

test("TornPDA native storage shares the completed index and pending scan across pages", async () => {
    const saved = {}, legacy = {};
    const store = {
        async loadAll() { return structuredClone(saved); },
        async get(k, fallback) { return structuredClone(saved[k] ?? fallback); },
        async setMany(values) { Object.assign(saved, structuredClone(values)); }
    };
    const first = fixture(() => page([row(1)]), legacy);
    first.context.PDA_storage = store;
    await first.loadPersistentState();
    first.runtime.apiKey = "main-test-key";
    first.runtime.config.tab = "competition";
    await first.directoryRequest(90, 0, true);
    await first.saveExtra("TEFR_V2_PENDING_SCAN", { id: "checkpoint", responses: { "/user/basic": { data: { profile: { id: 1 } } } } });
    assert.equal(saved.TEFR_V2_DIRECTORY.schema, 3);
    assert.equal(legacy.TEFR_V2_DIRECTORY, undefined);
    const second = fixture(() => page([row(1)]), legacy);
    second.context.PDA_storage = store;
    await second.loadPersistentState();
    second.directory.loaded = false;
    await second.loadCompetition();
    assert.equal(second.runtime.storageMode, "TornPDA native storage");
    assert.equal(second.runtime.scan.id, "checkpoint");
    assert.equal(second.directory.data.scan.done, true);
    assert.equal(second.directory.data.players[1].status.state, "Okay");
    saved.TEFR_V2_PENDING_SCAN = null;
    assert.equal(await second.readShared("TEFR_V2_PENDING_SCAN"), null);
});

test("native storage failures never fall back or disappear after a lease write", async () => {
    const f = fixture();
    const secret = "sensitive-storage-test-key";
    f.context.PDA_storage = {
        async loadAll() { return {}; },
        async setMany(values) {
            if ("TEFR_V2_DIRECTORY" in values) throw new Error("quota exceeded for " + secret);
        }
    };
    await f.loadPersistentState();
    f.runtime.apiKey = secret;
    assert.equal(await f.saveExtra("TEFR_V2_DIRECTORY", f.directory.data), false);
    assert.equal(f.saved.TEFR_V2_DIRECTORY, undefined);
    await f.saveExtra("TEFR_V2_DIRECTORY_LEASE", null);
    assert.ok(f.runtime.storageError);
    assert.equal(f.directory.data.scan.paused, true);
    const logs = JSON.stringify(f.logs);
    assert.match(logs, /\[TEFR Beta\]\[Storage\] Storage write failed/);
    assert.match(logs, /PDA_storage\.setMany/);
    assert.match(logs, /TEFR_V2_DIRECTORY/);
    assert.match(logs, /payloadCharacters/);
    assert.match(logs, /quota exceeded for \[redacted\]/);
    assert.equal(logs.includes(secret), false);
    const broken = fixture();
    broken.context.PDA_storage = { async loadAll() { throw new Error("offline"); } };
    await broken.loadPersistentState();
    assert.ok(broken.runtime.storageError);
    assert.equal(await broken.directoryRequest(90, 0), false);
    assert.equal(broken.calls.length, 0);
});

test("failed shared reads never overwrite an index with an older in-memory copy", async () => {
    const f = fixture(() => page([row(1)]));
    const saved = { TEFR_V2_DIRECTORY: { marker: "retain" } };
    f.context.PDA_storage = {
        async loadAll() { return structuredClone(saved); },
        async get() { throw new Error("bridge unavailable"); },
        async setMany(values) { Object.assign(saved, structuredClone(values)); }
    };
    await f.loadPersistentState();
    f.runtime.config.tab = "competition";
    f.runtime.apiKey = "main-test-key";
    assert.equal(await f.directoryRequest(90, 0), false);
    assert.equal(f.calls.length, 0);
    assert.equal(saved.TEFR_V2_DIRECTORY.marker, "retain");
    assert.ok(f.runtime.storageError);
    const logs = JSON.stringify(f.logs);
    assert.match(logs, /Shared storage read failed/);
    assert.match(logs, /PDA_storage\.get/);
    assert.match(logs, /bridge unavailable/);
    assert.match(logs, /TEFR_V2_DIRECTORY_LEASE/);
});

test("concurrent roster ticks coalesce and page navigation refreshes only the visible page", async () => {
    const f = fixture(url => page([row(Number(url.searchParams.get("offset")) + 1)]));
    f.ff.key = "";
    const d = f.directory.data;
    d.scan.done = true;
    await Promise.all([f.directoryRequest(90, 0), f.directoryRequest(90, 0)]);
    assert.equal(f.calls.length, 1);
    f.directory.offset = 100;
    await f.competitionTick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].params.offset, "100");
    f.directory.offset = 0;
    await f.competitionTick();
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].params.offset, "0");
    await f.competitionTick();
    assert.equal(f.calls.length, 3);
    assert.equal(f.directory.data.scan.done, true);
    assert.equal(f.calls.every(c => c.path === "/v2/torn/90/eliminationteam"), true);
});

test("TornPDA without its native bridge fails closed instead of saving to page storage", async () => {
    const f = fixture();
    f.context.PDA_httpGet = async () => { throw new Error("Must not request"); };
    await f.loadPersistentState();
    assert.match(f.runtime.storageError, /PDA_storage/);
    assert.match(JSON.stringify(f.logs), /Native storage API was not found/);
    assert.equal(await f.saveExtra("TEFR_V2_DIRECTORY", f.directory.data), false);
    assert.equal(f.saved.TEFR_V2_DIRECTORY, undefined);
    assert.equal(await f.directoryRequest(90, 0), false);
});

test("on-demand pages bypass index chunk pauses without clearing the index pause", async () => {
    const f = fixture(() => page([row(1)]));
    f.ff.key = "";
    f.directory.data.scan.requests = 9;
    f.directory.data.scan.retryAt = now + 10000;
    await f.competitionTick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.directory.data.scan.requests, 9);
    assert.equal(f.directory.data.scan.retryAt, now + 10000);
    f.advance(5000);
    await f.competitionTick();
    assert.equal(f.calls.length, 2, "Only the current page repeats after five seconds");
});

test("near-live teams are paced, persisted separately, and stop on hidden pages", async () => {
    const teams = Array.from({ length: 12 }, (_, i) => ({
        id: 70 + i, name: "Team " + i, score: 100 + i, lives: 10,
        wins: i, losses: 0, position: i + 1, participants: 100, eliminated: false
    }));
    const f = fixture(() => ({ elimination: teams }));
    f.runtime.config.tab = "overview";
    assert.equal(await f.refreshLiveTeams(), true);
    assert.equal(f.currentTeams().length, 12);
    assert.equal(f.saved.TEFR_V2_LIVE_TEAMS.teams.length, 12);
    assert.equal(f.saved.TEFR_V1_SNAPSHOT, undefined, "Does not reset the faction freshness clock");
    assert.equal(await f.refreshLiveTeams(), false);
    f.advance(3000);
    assert.equal(await f.refreshLiveTeams(), true);
    assert.equal(await f.refreshLiveTeams(true), true, "Manual standings refresh bypasses freshness");
    assert.ok(f.calls.every(c => c.path === "/v2/torn/elimination"));
    assert.ok(f.calls.slice(1).every((c, i) => c.at - f.calls[i].at >= api.REQUEST_GAP_MS));
    f.context.document.visibilityState = "hidden";
    assert.equal(await f.refreshLiveTeams(true), false);
    assert.equal(f.calls.length, 3);
});

test("live teams preserve cached standings and honor API rate-limit cooldowns", async () => {
    const f = fixture(() => ({ error: { code: 5, error: "NEVER_ECHO_KEY" } }));
    f.runtime.config.tab = "overview";
    f.liveTeams.data = { year: 2026, updatedAt: now - 10000, teams: [team] };
    assert.equal(await f.refreshLiveTeams(), false);
    assert.equal(f.liveTeams.data.teams[0].id, 90);
    assert.equal(await f.refreshLiveTeams(true), false);
    assert.equal(f.calls.length, 1);
    assert.ok(f.liveTeams.retryAt >= now + 60000);
    assert.equal(JSON.stringify(f.logs).includes("NEVER_ECHO_KEY"), false);
});

test("obsolete queued Torn requests are discarded before spending API quota", async () => {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; }));
    const first = f.requestJson("/torn/elimination", "test-key");
    await new Promise(resolve => setImmediate(resolve));
    let relevant = true;
    const second = f.requestJson("/torn/90/eliminationteam", "test-key", {}, () => relevant);
    const rejected = assert.rejects(second, error => error.paused === true);
    relevant = false;
    finish({});
    await first;
    await rejected;
    assert.equal(f.calls.length, 1);
});

test("invalid Torn keys stop automatic polling until explicitly replaced", async () => {
    const f = fixture(() => ({ error: { code: 2 } }));
    f.runtime.config.tab = "overview";
    assert.equal(await f.refreshLiveTeams(), false);
    f.advance(120000);
    assert.equal(await f.refreshLiveTeams(), false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.runtime.tornBlocked, 2);
});

test("cached ranks and history migrate to attacks without multiplying tickets", async () => {
    const f = fixture();
    f.runtime.snapshot = { members: [
        { id: 1, name: "A", score: 5000, attacks: 1, factionId: 10, teamId: 70, teamName: "A", participating: true },
        { id: 2, name: "B", score: 1, attacks: 20, factionId: 10, teamId: 71, teamName: "B", participating: true }
    ], teams: [] };
    f.runtime.history = { points: [{ members: {
        1: [1, 1, 5000, 1, 70, "A", 10, 1], 2: [2, 1, 1, 20, 71, "B", 10, 2]
    }, teams: { 70: [5000, 10, 5000, 1, 1] } }] };
    await f.migrateAttackRankings();
    assert.deepEqual(Array.from(f.runtime.snapshot.members, m => m.id), [2, 1]);
    assert.equal(f.runtime.history.points[0].members[1][0], 2);
    assert.equal(f.runtime.history.points[0].members[2][7], 1);
    assert.equal(f.runtime.history.points[0].teams[70][2], null);
    assert.equal(f.saved.TEFR_V1_SNAPSHOT.rankingMetric, "attacks");
});

test("life-loss checkpoints and all tie-breaks follow the official rules", () => {
    const start = api.ELIMINATION_START_MS;
    const t = (id, score, wins, losses, lives) => ({ id, score, wins, losses, lives, name: "T" + id, eliminated: false });
    const teams = [t(1, 99, 5, 1, 2), t(2, 100, 0, 99, 1), t(3, 99, 4, 1, 2),
        t(4, 99, 4, 2, 3), t(5, 99, 4, 2, 1), t(6, 1, 0, 9, 0)];
    const before = api.lifeLossState(teams, start - 1);
    assert.equal(before.started, false);
    assert.equal(before.next, start);
    assert.deepEqual(before.atRisk.map(t => t.id), [5]);
    assert.equal(api.lifeLossState(teams, start).next, start + 900000);
    assert.equal(api.lifeLossState(teams, start + 900000).next, start + 1800000);
    teams.push(t(7, 99, 4, 2, 1));
    assert.deepEqual(api.lifeLossState(teams, start).atRisk.map(t => t.id), [5, 7]);
    const final = Array.from({ length: 12 }, (_, i) => ({ ...t(i, 100, 1, 1, i === 5 ? 1 : 0), eliminated: i !== 5 }));
    assert.equal(api.lifeLossState(final, start).winner.id, 5);
    assert.equal(api.lifeLossState(final, start).tickets, 100);
});

test("overview, ranking and teams have distinct scoped refresh controls", () => {
    const f = fixture();
    for (const tab of ["overview", "ranking", "teams"]) {
        f.runtime.config.tab = tab;
        assert.match(f.tabRefreshControl(), /data-refresh-tab/);
        assert.match(f.tabRefreshControl(), /total attacks only/);
    }
    f.runtime.config.tab = "competition";
    assert.equal(f.tabRefreshControl(), "");
});

test("BS chart labels axes, scales close values and distinguishes sparse samples", () => {
    const f = fixture();
    const t = now / 1000;
    f.ff.cache.history[1] = { points: [
        { at: t + 86400, value: 13.16e9 },
        { at: t, value: 13e9 },
        { at: t + 21600, value: 13.05e9 }
    ] };
    const html = f.bsHistoryMarkup(1);
    assert.ok(html.includes("Date / time (UTC)"));
    assert.ok(html.includes("BS estimate"));
    assert.ok(html.includes("13.200B") || html.includes("B</text>"));
    assert.match(html, /class="tefr-bs-line" d="M[^"]+L/);
    assert.match(html, /class="tefr-bs-gap" d="M[^"]+L/);
    assert.ok(html.includes("Gap guide"));
    assert.ok(html.includes("not necessarily zero"));
    const ys = [...html.matchAll(/<circle cx="[^"]+" cy="([^"]+)"[^>]+class="tefr-bs-dot"/g)].map(m => +m[1]);
    assert.equal(ys.length, 3);
    assert.ok(Math.max(...ys) - Math.min(...ys) > 60);
    assert.equal(f.ff.cache.history[1].points[0].at, t + 86400);
});

test("BS chart handles empty, zero, single and flat histories without invalid geometry", () => {
    const f = fixture();
    assert.ok(f.bsHistoryMarkup(1).includes("Load up to"));
    f.ff.cache.history[1] = { points: [{ at: 1, value: null }, { at: NaN, value: 10 }] };
    assert.ok(f.bsHistoryMarkup(1).includes("No estimate history"));
    for (const points of [[{ at: 1, value: 0 }], [{ at: 1, value: 10 }, { at: 21601, value: 10 }]]) {
        f.ff.cache.history[1] = { points };
        const html = f.bsHistoryMarkup(1);
        assert.equal(/NaN|Infinity/.test(html), false);
        assert.equal((html.match(/class="tefr-bs-dot"/g) || []).length, points.length);
    }
});

test("explicit missing history buckets are dashed, never drawn as observations", () => {
    const f = fixture();
    f.ff.cache.history[1] = { points: [
        { at: 1, value: 10 }, { at: 10001, value: null }, { at: 21601, value: 20 }
    ] };
    const html = f.bsHistoryMarkup(1);
    assert.ok(html.includes('class="tefr-bs-line" d=""'));
    assert.match(html, /class="tefr-bs-gap" d="M[^"]+L/);
    assert.equal((html.match(/class="tefr-bs-dot"/g) || []).length, 2);
});

test("BS tooltips support touch clicks, mouse hover, keyboard and outside dismissal", () => {
    const f = fixture(), events = {}, docEvents = {};
    const tip = { hidden: true, style: {}, offsetWidth: 180, offsetHeight: 44 };
    const plot = { querySelector: () => tip, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300 }) };
    const point = {
        closest: () => plot,
        setAttribute(key, value) { this[key] = value; },
        getAttribute: () => "10 Sept, 12:00 UTC\nBS estimate: 13,160,000,000",
        querySelector: () => ({ getBoundingClientRect: () => ({ left: 280, top: 10, bottom: 16, width: 6 }) })
    };
    const target = { closest: () => point };
    const root = {
        querySelectorAll: () => [],
        addEventListener(name, fn) { assert.equal(events[name], undefined); events[name] = fn; },
        ownerDocument: { addEventListener: (name, fn) => { docEvents[name] = fn; } },
        contains: () => false
    };
    f.bindHistoryTooltips(root);
    f.bindHistoryTooltips(root);
    events.pointerover({ pointerType: "touch", target });
    assert.equal(tip.hidden, true);
    events.click({ target });
    assert.equal(tip.hidden, false);
    assert.ok(tip.textContent.includes("13,160,000,000"));
    assert.equal(point["aria-pressed"], "true");
    assert.equal(tip.style.left, "112px");
    events.pointerout({ pointerType: "mouse", target });
    assert.equal(tip.hidden, false);
    events.keydown({ key: "Escape", target });
    assert.equal(tip.hidden, true);
    events.pointerover({ pointerType: "mouse", target });
    assert.equal(tip.hidden, false);
    events.pointerout({ pointerType: "mouse", target });
    assert.equal(tip.hidden, true);
    let prevented = false;
    events.keydown({ key: "Enter", target, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(tip.hidden, false);
    docEvents.click({ target: {} });
    assert.equal(tip.hidden, true);
    f.ff.cache.history[1] = { points: [{ at: 1, value: 5 }] };
    const html = f.bsHistoryMarkup(1);
    assert.ok(html.includes('data-bs-point tabindex="0" role="button"'));
    assert.ok(html.includes('r="14" fill="transparent"'));
    assert.ok(html.includes('role="tooltip" hidden'));
});

test("sorting supports both directions and leaves unknown values last", () => {
    const rows = [
        { id: 1, name: "Alpha", level: 1, score: 10, attacks: 2 },
        { id: 2, name: "Bravo", level: 2, score: 20, attacks: 4 },
        { id: 3, name: "Charlie", level: null, score: null, attacks: null }
    ];
    const estimates = { 1: { fairFight: 1, estimate: 100 }, 2: { fairFight: 2, estimate: 200 } };
    for (const field of ["level", "score", "attacks", "ff", "bs"]) {
        assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, field, "asc").map(p => p.id), [1, 2, 3]);
        assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, field, "desc").map(p => p.id), [2, 1, 3]);
    }
    assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, "name", "desc").map(p => p.id), [3, 2, 1]);
    assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, "name", "asc").map(p => p.id), [1, 2, 3]);
    assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, "api", "desc").map(p => p.id), [1, 2, 3]);
    assert.deepEqual(rows.map(p => p.id), [1, 2, 3]);
});

test("status priority overrides every sort field and direction including roster order", () => {
    const rows = [
        { id: 1, name: "A", level: 100, score: 100, attacks: 100, status: { state: "Traveling" } },
        { id: 2, name: "B", level: 50, score: 50, attacks: 50, status: { state: "Hospital" } },
        { id: 3, name: "Z", level: 1, score: 1, attacks: 1, status: { state: "Okay" } },
        { id: 4, name: "C", level: 200, score: 200, attacks: 200, status: null },
        { id: 5, name: "D", level: 150, score: 150, attacks: 150, status: { state: "Jail" } }
    ];
    const estimates = Object.fromEntries(rows.map(p => [p.id, { fairFight: p.level, estimate: p.level }]));
    for (const field of ["api", "name", "level", "score", "attacks", "ff", "bs"])
        for (const direction of ["asc", "desc"])
            assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, field, direction).map(p => p.id), [3, 2, 1, 5, 4]);
    rows.push({ id: 6, name: "E", level: 2, status: { state: "Okay" } });
    assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, "level", "desc").slice(0, 2).map(p => p.id), [6, 3]);
    assert.deepEqual(api.sortCompetitionPlayers(rows, estimates, "level", "asc").slice(0, 2).map(p => p.id), [3, 6]);
    rows[1].status.state = "Hospitalized";
    assert.equal(api.sortCompetitionPlayers(rows, estimates, "api")[2].id, 2);
});

test("competition sort defaults to name and persists only valid field and direction", async () => {
    const f = fixture();
    assert.equal(f.directory.filters.sort, "name");
    const markup = f.competitionView();
    const select = markup.match(/<select data-cp-field="sort">([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(m => m[1]), ["name", "level", "score", "attacks", "ff", "bs"]);
    assert.equal(markup.includes("Roster order"), false);
    await Promise.all([
        f.saveCompetitionSort({ sort: "ff", direction: "asc" }),
        f.saveCompetitionSort({ sort: "bs", direction: "desc", key: "must-not-persist" })
    ]);
    assert.deepEqual(f.saved.TEFR_V2_COMPETITION_SORT, { sort: "bs", direction: "desc" });
    const reload = fixture(undefined, f.saved);
    reload.directory.loaded = false;
    await reload.loadCompetition();
    assert.equal(reload.directory.filters.sort, "bs");
    assert.equal(reload.directory.filters.direction, "desc");
    const pda = fixture();
    pda.runtime.nativeValues = { TEFR_V2_COMPETITION_SORT: { sort: "attacks", direction: "desc" } };
    pda.directory.loaded = false;
    await pda.loadCompetition();
    assert.equal(pda.directory.filters.sort, "attacks");
    const old = fixture(undefined, { TEFR_V2_COMPETITION_SORT: { sort: "api", direction: "invalid" } });
    old.directory.loaded = false;
    await old.loadCompetition();
    assert.equal(old.directory.filters.sort, "name");
    assert.equal(old.directory.filters.direction, "asc");
});

test("selected competition subview is explicit and has an accessible visual state", () => {
    const f = fixture();
    f.directory.mode = "finder";
    let markup = f.competitionView();
    assert.ok(markup.includes('data-cp-action="finder" aria-pressed="true"'));
    assert.ok(markup.includes('data-cp-action="roster" aria-pressed="false"'));
    assert.ok(markup.includes("Viewing: Target Finder"));
    assert.ok(markup.includes("Ascending"));
    assert.ok(markup.includes("Descending"));
    assert.ok(f.STYLE.includes('.tefr-cp-subtabs button[aria-pressed="true"]'));
    assert.ok(f.STYLE.includes(".tefr-cp-heading h3{position:static!important"));
    f.directory.mode = "roster";
    markup = f.competitionView();
    assert.ok(markup.includes("Viewing: Team roster"));
    assert.ok(markup.includes('data-cp-action="roster" aria-pressed="true"'));
});

test("competition rendering limits DOM to 100 cards and escapes names", () => {
    const f = fixture();
    f.directory.data = api.newDirectory(undefined, now);
    f.directory.team = String(f.directory.data.teams[0].id);
    const markup = f.competitionView();
    assert.equal((markup.match(/data-cp-player=/g) || []).length, 100);
    assert.ok(markup.includes("Status unavailable"));
    assert.ok(markup.includes("page.php?sid=attack&amp;user2ID="));
    assert.ok(f.STYLE.includes(".tefr-cp-card"));
    f.directory.data.players = { 1: { id: 1, name: '<img src=x onerror=alert(1)>', teamId: 90, source: "ultimata" } };
    f.directory.team = "90"; f.directory.displayIds = [];
    assert.equal(f.competitionView().includes("<img src=x"), false);
});
