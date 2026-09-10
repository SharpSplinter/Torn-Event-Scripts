"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const file = path.join(__dirname, "Torn Elimination Faction Rankings.user.js");
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
        "        hooks: { directory, ff, runtime, loadCompetition, queueFF, validateFF, setFFKey, refreshVisibleEstimates, loadBSHistory, findFFTargets, directoryRequest, competitionTick, saveExtra, synchronizeDirectoryEvent, competitionView, STYLE },\n        VERSION, REQUEST_GAP_MS,");
    vm.runInNewContext(source, context);
    const h = context.module.exports.hooks;
    h.runtime.config.tab = "competition";
    h.runtime.apiKey = "main-test-key";
    h.directory.loaded = true;
    h.directory.data = api.newDirectory([team], now);
    h.directory.team = "90";
    h.ff.key = "f".repeat(16);
    h.ff.validated = true;
    return { ...h, calls, logs, waits, saved, context, advance(ms) { time += ms; } };
}

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
    f.runtime.snapshot = { globalTeamsAvailable: true, completedAt: now, teams: [{ id: 91, name: "New", participants: 20 }] };
    f.synchronizeDirectoryEvent();
    assert.equal(f.directory.data.eventKey, "2026:91");
    assert.equal(f.runtime.history.points[0].marker, "keep");
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

test("hidden tab and faction scan pause directory network operations", async () => {
    const f = fixture(() => page([row(1)]));
    f.context.document.visibilityState = "hidden";
    assert.equal(await f.directoryRequest(90, 0), false);
    f.context.document.visibilityState = "visible";
    f.runtime.busy = true;
    assert.equal(await f.directoryRequest(90, 0), false);
    assert.equal(f.calls.length, 0);
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
