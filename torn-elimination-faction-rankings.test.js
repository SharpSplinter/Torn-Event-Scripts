"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "Torn Elimination Faction Rankings.user.js");
const api = require(scriptPath);

test("personal Team place uses the global event position out of 12, not tracked-player count", () => {
    const member = { participating: true, teamId: 84, teamName: "Rocket Scientists", teamRank: 7 };
    const teams = [
        { id: 84, name: "Rocket Scientists", position: 3, factionMembers: 9 },
        { id: null, name: "Not Participating", position: 1 }
    ];
    assert.equal(api.eventTeamPlace(member, teams), "3rd / 12");
    assert.equal(api.eventTeamPlace({ ...member, teamId: null }, teams), "3rd / 12");
    assert.equal(api.eventTeamPlace(member, [{ ...teams[0], position: 12, eliminated: true }]), "12th / 12");
    assert.equal(api.eventTeamPlace(member, []), "— / 12");
    assert.equal(api.eventTeamPlace(member, [{ ...teams[0], position: 999 }]), "— / 12");
    assert.equal(api.eventTeamPlace({ participating: false, teamName: "Not Participating" }, teams), "-");
    const full = Array.from({ length: 12 }, (_, i) => ({ id: 79 + i, name: i === 5 ? "Rocket Scientists" : "Team " + i, position: i + 1 }));
    assert.equal(api.eventTeamPlace(member, [...full, teams[1]]), "6th / 12");
});

function rosterMember(id, name) {
    return {
        id, name, position: "Member", level: 50, days_in_faction: 100,
        last_action: { status: "Online", timestamp: 1, relative: "1 minute ago" },
        status: { state: "Okay", description: "Okay", color: "green" }
    };
}

function rankedMember(id, name, score, attacks, teamId, availability = "fresh") {
    return api.normalizeMember(rosterMember(id, name), {
        competition: {
            name: "Elimination", score, attacks, team_id: teamId,
            team: teamId === null ? "" : "Team " + teamId
        }
    }, availability);
}

test("UTC update slots begin at HH:10", () => {
    assert.equal(
        api.slotAtOrBefore(new Date("2026-09-09T12:09:59.999Z")),
        Date.parse("2026-09-09T11:10:00.000Z")
    );
    assert.equal(
        api.slotAtOrBefore(new Date("2026-09-09T12:10:00.000Z")),
        Date.parse("2026-09-09T12:10:00.000Z")
    );
    assert.equal(
        api.slotAtOrBefore(new Date("2026-09-09T12:59:59.999Z")),
        Date.parse("2026-09-09T12:10:00.000Z")
    );
    assert.equal(
        api.nextSlot(new Date("2026-09-09T12:10:00.000Z")),
        Date.parse("2026-09-09T13:10:00.000Z")
    );
});

test("ordinals include faction positions through 100th", () => {
    const expected = {
        1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 11: "11th",
        12: "12th", 13: "13th", 21: "21st", 22: "22nd",
        23: "23rd", 100: "100th"
    };
    Object.entries(expected).forEach(([input, output]) => {
        assert.equal(api.ordinal(Number(input)), output);
    });
});

test("competition normalization separates participants and nonparticipants", () => {
    assert.deepEqual(api.normalizeCompetition({
        competition: {
            name: "Elimination", score: 17, attacks: 3,
            team_id: 4, team: "Example"
        }
    }), {
        active: true, name: "Elimination", score: 17, attacks: 3,
        teamId: 4, teamName: "Example"
    });
    const unassigned = api.normalizeCompetition({
        competition: {
            name: "Elimination", score: 0, attacks: 0,
            team_id: null, team: ""
        }
    });
    assert.equal(unassigned.active, true);
    assert.equal(unassigned.teamId, null);
    assert.equal(unassigned.teamName, "Not Participating");
    const unknown = api.normalizeMember(rosterMember(9, "Unknown Team"), {
        competition: {
            name: "Elimination", score: 0, attacks: 0,
            team_id: null, team: "Unknown"
        }
    });
    assert.equal(unknown.teamName, "Not Participating");
    assert.equal(unknown.participating, false);
    assert.equal(api.teamKey(unknown), "unassigned");
    assert.equal(api.normalizeCompetition({
        competition: { name: "Halloween", treats_collected: 99 }
    }).active, false);
});

test("team names remain authoritative when team_id is null", () => {
    const raw = {
        competition: {
            name: "Elimination", score: 0, attacks: 0,
            team: "Loose Cannons", team_id: null
        }
    };
    const competition = api.normalizeCompetition(raw);
    assert.equal(competition.teamId, null);
    assert.equal(competition.teamName, "Loose Cannons");
    const member = api.normalizeMember(rosterMember(77, "a1ry"), raw);
    assert.equal(member.participating, true);
    assert.equal(api.teamKey(member), "name:loose cannons");
    const resolved = api.resolveMemberTeams([member], [{
        id: 12, name: "Loose Cannons", participants: 1000,
        position: 1, score: 100, lives: 100
    }]);
    assert.equal(resolved[0].teamId, 12);
    assert.equal(resolved[0].teamName, "Loose Cannons");
    assert.equal(api.teamKey(resolved[0]), "12");
});

test("named teams with null IDs do not collapse into one team", () => {
    const loose = api.normalizeMember(rosterMember(1, "Loose"), {
        competition: {
            name: "Elimination", score: 2, attacks: 1,
            team: "Loose Cannons", team_id: null
        }
    });
    const brain = api.normalizeMember(rosterMember(2, "Brain"), {
        competition: {
            name: "Elimination", score: 1, attacks: 1,
            team: "Brain Surgeons", team_id: null
        }
    });
    const ranked = api.rankMembers([loose, brain]);
    assert.deepEqual(ranked.map((member) => member.teamRank), [1, 1]);
    const teams = api.aggregateTeams([], ranked);
    assert.deepEqual(teams.map((team) => team.key).sort(), [
        "name:brain surgeons", "name:loose cannons"
    ]);
});

test("faction ranking follows all tie-breaks and assigns team ranks", () => {
    const ranked = api.rankMembers([
        rankedMember(5, "Zulu", 10, 1, 2),
        rankedMember(4, "Alpha", 10, 2, 1),
        rankedMember(3, "Bravo", 10, 2, null),
        rankedMember(2, "Charlie", 20, 1, 2),
        rankedMember(1, "alpha", 10, 2, 1)
    ]);
    assert.deepEqual(ranked.map((member) => member.id), [1, 4, 3, 2, 5]);
    assert.deepEqual(ranked.map((member) => member.factionRank), [1, 2, 3, 4, 5]);
    assert.equal(ranked.find((member) => member.id === 1).teamRank, 1);
    assert.equal(ranked.find((member) => member.id === 4).teamRank, 2);
    assert.equal(ranked.find((member) => member.id === 3).teamRank, null);
});

test("one hundred members receive unique 1-N faction ranks", () => {
    const input = Array.from({ length: 100 }, (_, index) =>
        rankedMember(index + 1, "Member " + String(index + 1).padStart(3, "0"),
            index % 9, index % 4, index % 3 ? index % 3 : null)
    );
    const ranked = api.rankMembers(input);
    assert.equal(ranked.length, 100);
    assert.deepEqual(
        [...new Set(ranked.map((member) => member.factionRank))],
        Array.from({ length: 100 }, (_, index) => index + 1)
    );
    assert.equal(api.ordinal(ranked.at(-1).factionRank), "100th");
});

test("unavailable records rank below usable records", () => {
    const ranked = api.rankMembers([
        rankedMember(1, "Unavailable", 999999, 999, 1, "unavailable"),
        rankedMember(2, "Fresh", 0, 0, null, "fresh"),
        rankedMember(3, "Stale", 1, 0, 1, "stale")
    ]);
    assert.deepEqual(ranked.map((member) => member.id), [3, 2, 1]);
});

test("team aggregation keeps global and faction-only totals separate", () => {
    const members = api.rankMembers([
        rankedMember(1, "A", 15, 2, 7),
        rankedMember(2, "B", 10, 3, 7),
        rankedMember(3, "C", 99, 9, null)
    ]);
    const teams = api.aggregateTeams([{
        id: 7, name: "Seven", participants: 1000, position: 2,
        score: 50000, lives: 900, wins: 10, losses: 2, eliminated: false
    }], members);
    assert.equal(teams[0].score, 50000);
    assert.equal(teams[0].lives, 900);
    assert.equal(teams[0].factionMembers, 2);
    assert.equal(teams[0].factionScore, 0, "Never sum team tickets across members");
    assert.equal(teams[0].factionAttacks, 5);
});

test("history replaces a repeated slot and resets for a new event key", () => {
    const first = { slot: 100, completedAt: 101, profileId: 1, teams: {}, members: {} };
    const replacement = { ...first, completedAt: 102 };
    const second = { ...first, slot: 200 };
    let history = api.upsertHistory(null, "2026:1,2", first);
    history = api.upsertHistory(history, "2026:1,2", replacement);
    assert.equal(history.points.length, 1);
    assert.equal(history.points[0].completedAt, 102);
    history = api.upsertHistory(history, "2026:1,2", second);
    assert.equal(api.previousHistoryPoint(history, 200).slot, 100);
    history = api.upsertHistory(history, "2027:3,4", { ...second, slot: 300 });
    assert.equal(history.points.length, 1);
    assert.equal(history.eventKey, "2027:3,4");
});

test("hidden nonparticipants stay in snapshots without renumbering visible ranks", () => {
    const rows = api.rankMembers([
        rankedMember(1, "Hidden", 30, 2, null),
        rankedMember(2, "Visible", 20, 1, 7)
    ]);
    assert.deepEqual(api.visibleMembers(rows).map((member) => member.id), [2]);
    assert.equal(api.visibleMembers(rows)[0].factionRank, 2);
    assert.equal(api.visibleMembers(rows, true).length, 2);
    assert.equal(Object.keys(api.buildHistoryPoint({ members: rows, teams: [] }).members).length, 2);
    const config = api.withNonParticipantVisibility({ team: "unassigned", participation: "no" }, false);
    assert.equal(config.showNonParticipants, false);
    assert.equal(config.team, "all");
    assert.equal(config.participation, "all");
});

test("enrollment cutoff requires a successful final check and preserves late joiners", () => {
    const deadline = Date.parse("2026-09-10T12:00:00Z");
    assert.equal(api.ENROLLMENT_END_MS, deadline);
    const waiting = { ...rankedMember(1, "Waiting", 0, 0, null), competitionCheckedAt: deadline - 1 };
    assert.equal(api.memberNeedsRefresh(waiting, deadline - 1), true);
    assert.equal(api.memberNeedsRefresh(waiting, deadline), true);
    assert.equal(api.memberNeedsRefresh(waiting, deadline + 600000), true);
    const confirmed = { ...waiting, competitionCheckedAt: deadline };
    assert.equal(api.memberNeedsRefresh(confirmed, deadline), false);
    assert.equal(api.memberNeedsRefresh(confirmed, deadline + 3600000, true), true);
    const final = api.priorMember(rosterMember(1, "Updated name"), confirmed, "final");
    assert.equal(final.name, "Updated name");
    assert.equal(final.availability, "final");
    assert.equal(api.memberNeedsRefresh(final, deadline + 3600000), false);
    assert.equal(api.memberNeedsRefresh({ ...confirmed, availability: "stale" }, deadline + 600000), true);
    assert.equal(api.memberNeedsRefresh({ ...confirmed, availability: "unavailable" }, deadline + 600000), true);
    assert.equal(api.memberNeedsRefresh({ ...confirmed, participating: true }, deadline + 600000), true);
    assert.equal(api.memberNeedsRefresh(undefined, deadline + 600000), true);
    assert.equal(api.memberNeedsRefresh(confirmed, Date.parse("2027-09-11T12:10:00Z")), true);
    const failed = api.priorMember(rosterMember(2, "Unknown"), api.normalizeMember({ id: 2 }, null, "unavailable"));
    assert.equal(failed.availability, "unavailable");
});

test("numeric faction IDs are validated and deduplicated", () => {
    assert.deepEqual(api.parseFactionIds("44817, 123\n44817; 456"), [44817, 123, 456]);
    assert.deepEqual(api.parseFactionIds(""), []);
    for (const invalid of ["-1", "0", "1.5", "123x", "https://www.torn.com/44817", "2147483648"]) {
        assert.throws(() => api.parseFactionIds(invalid), /numeric faction IDs/);
    }
    assert.equal(api.normalizeFaction({ basic: { id: 44817, name: "Sister", tag: "SIS" } }).tag, "SIS");
});

test("alliance and faction ranks are separate; duplicates and stale rosters do not double count", () => {
    const own = api.normalizeFaction({ id: 10, name: "Main", tag: "M" }, null, true);
    const sister = api.normalizeFaction({ basic: { id: 44817, name: "Sister", tag: "S" } });
    const merged = api.mergeFactionRosters([
        { faction: own, stale: true, members: [rosterMember(3, "Old")] },
        { faction: sister, stale: false, members: [rosterMember(2, "Winner"), rosterMember(3, "Moved")] },
        { faction: own, stale: false, members: [rosterMember(1, "Main"), rosterMember(2, "Duplicate")] }
    ]);
    assert.equal(merged.length, 3);
    assert.equal(merged.find((member) => member.id === 3).name, "Moved");
    const ranked = api.rankMembers(merged.map((member) => api.normalizeMember(member, {
        competition: { name: "Elimination", team_id: 7, team: "Team", score: 500, attacks: member.id * 2 }
    })));
    assert.deepEqual(ranked.map((member) => member.allianceRank), [1, 2, 3]);
    assert.equal(ranked.find((member) => member.id === 1).factionRank, 1);
    assert.equal(ranked.find((member) => member.id === 1).allianceRank, 3);
    assert.equal(ranked.find((member) => member.id === 2).factionRank, 2);
    const history = api.buildHistoryPoint({ scope: "1:44817", members: ranked, teams: [], factions: [own, sister] });
    assert.equal(api.pointRank(history, 1, "alliance"), 3);
    assert.equal(api.pointRank(history, 1, "faction"), 1);
    assert.equal(history.members["1"][6], 10);
    assert.match(api.factionLabel(ranked[0]), /\[S\] Sister/);
});

test("userscript security and TornPDA compatibility invariants", () => {
    const source = fs.readFileSync(scriptPath, "utf8").replace(/\/\/ BEGIN GENERATED COMPETITION SEED[\s\S]*?\/\/ END GENERATED COMPETITION SEED/, "");
    // TornPDA does a literal text substitution of exactly "###PDA-APIKEY###"
    // wherever it appears in the source. Any extra characters immediately
    // touching the placeholder (e.g. wrapping underscores) would survive the
    // substitution and get baked into the injected key, making it invalid.
    assert.equal((source.match(/PDA_KEY_RAW = "###PDA-APIKEY###";/g) || []).length, 1);
    assert.match(source, /Team tickets/);
    for (const page of ["factions.php*", "page.php?sid=elimination*", "hospitalview.php*", "page.php?sid=attack&user2ID*"])
        assert.ok(source.includes("// @match        https://www.torn.com/" + page));
    assert.match(source, /Public-access key only/);
    assert.match(source, /PDA_httpGet/);
    assert.match(source, /PDA_storage/);
    assert.match(source, /GM_xmlhttpRequest/);
    assert.match(source, /Authorization:\s*"ApiKey "\s*\+\s*key/);
    const tornRequest = source.slice(source.indexOf("function requestJson("), source.indexOf("function requestWithRetry("));
    assert.equal(/searchParams\.set\(["']key["']/.test(tornRequest), false);
    assert.equal((source.match(/searchParams\.set\(["']key["']/g) || []).length, 1, "Only the authorized FFScouter query-key exception");
    assert.match(source, /url.searchParams.set\("key", ff.key\)/);
    assert.equal(api.REQUEST_GAP_MS >= 1100, true);
    assert.equal(api.MEMBER_REQUEST_GAP_MS, 900);
    assert.equal(api.MEMBER_CHUNK_SIZE, 10);
    assert.equal(api.MEMBER_CHUNK_PAUSE_MS, 2000);
    assert.match(source, /grid-template-columns:repeat\(auto-fit,minmax\(74px,1fr\)\)/);
    assert.match(source, /@match\s+https:\/\/www\.torn\.com\/factions\.php\*/);
    assert.match(source, /content\.querySelector\("#factions"\)/);
    assert.match(source, /:scope > \.ui-tabs-panel/);
    assert.match(source, /host\.insertBefore\(root, before\)/);
    assert.match(source, /align-self:flex-start/);
    assert.ok(source.includes("#tefr-root{display:flex;flex-direction:column;max-height:min(70vh,700px)}"));
    assert.ok(source.includes("@supports(height:100dvh){#tefr-root{max-height:min(70dvh,700px)}}"));
    assert.ok(source.includes("#tefr-root .tefr-view{flex:0 1 auto;min-height:0;max-height:none;overflow-y:auto"));
    assert.ok(source.includes("overscroll-behavior-y:contain"));
    assert.ok(source.includes("-webkit-overflow-scrolling:touch"));
    assert.ok(source.includes('#tefr-root.is-collapsed>.tefr-body{display:none}'));
    assert.ok(source.includes('tabindex="0" aria-label="Scrollable dashboard content"'));
    assert.doesNotMatch(source, /const host = doc\.querySelector\("#mainContainer"\)/);
    assert.match(source, /\[TEFR\]/);
    assert.match(source, /tefr-spinner/);
    assert.match(source, /aria-valuenow/);
    assert.match(source, /Detected runtime/);
});

function fixtureRuntime(responder, persisted = {}) {
    let now = Date.parse("2026-09-10T11:10:00Z");
    const calls = [], waits = [], timers = [], saved = structuredClone(persisted);
    class Clock extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const context = {
        module: { exports: {} }, URL, Date: Clock,
        console: { debug() {}, info() {}, warn() {} },
        clearTimeout() {},
        setTimeout(callback, ms) {
            if (ms < 60000) {
                waits.push(ms);
                now += ms;
                queueMicrotask(callback);
            } else {
                timers.push({ callback, ms });
            }
            return 1;
        },
        GM_setValue(name, value) { saved[name] = structuredClone(value); },
        GM_getValue(name, fallback) { return saved[name] ?? fallback; },
        GM_xmlhttpRequest(details) {
            const endpoint = new URL(details.url).pathname.replace("/v2", "");
            calls.push({ endpoint, at: now });
            const response = responder(endpoint);
            details.onload({ status: 200, responseText: JSON.stringify(response) });
        }
    };
    const source = fs.readFileSync(scriptPath, "utf8").replace(
        "        VERSION, REQUEST_GAP_MS,",
        "        hooks: { runtime, render, refreshData, loadPersistentState, catchUpRefresh, activeApiKey, settingsView, STYLE },\n        VERSION, REQUEST_GAP_MS,"
    );
    vm.runInNewContext(source, context);
    const hooks = context.module.exports.hooks;
    hooks.runtime.apiKey = "fixture-key";
    return { ...hooks, calls, waits, timers, saved, setNow(value) { now = Date.parse(value); } };
}

test("a manually saved key is always available as a backup and overrides an injected key", () => {
    const fixture = fixtureRuntime(() => { throw new Error("unused"); });
    const { runtime } = fixture;
    runtime.apiKey = "";
    runtime.injectedKey = "";
    assert.equal(fixture.activeApiKey(), "");
    runtime.injectedKey = "injected-key";
    assert.equal(fixture.activeApiKey(), "injected-key",
        "Falls back to the TornPDA-injected key when no manual key is saved");
    runtime.apiKey = "manual-key";
    assert.equal(fixture.activeApiKey(), "manual-key",
        "A manually saved key overrides the injected key as a backup/redundancy path");
    runtime.root = {
        innerHTML: "", className: "", addEventListener() {},
        ownerDocument: { addEventListener() {} },
        querySelector: () => null, querySelectorAll: () => []
    };
    runtime.config.tab = "settings";
    fixture.render();
    assert.match(runtime.root.innerHTML, /data-role="api-key"/,
        "The manual key field must remain visible even when a key is injected");
    assert.match(runtime.root.innerHTML, /backup \/ override/);
    runtime.apiKey = "";
    fixture.render();
    assert.match(runtime.root.innerHTML, /data-role="api-key"/,
        "The manual key field is also available when relying solely on the injected key");
});

test("automatic refresh uses completion age, including the exact 30-minute boundary", () => {
    const completedAt = Date.parse("2026-09-10T11:05:00Z");
    const snapshot = { slot: Date.parse("2026-09-10T10:10:00Z"), completedAt };
    const config = { lastCheckedSlot: snapshot.slot, lastCheckedFactionIds: "" };
    assert.equal(api.automaticRefreshDue(snapshot, config, completedAt + 5 * 60000), false);
    assert.equal(api.automaticRefreshDue(snapshot, config, completedAt + 30 * 60000), false);
    assert.equal(api.automaticRefreshDue(snapshot, config, completedAt + 30 * 60000 + 1), true);
    assert.equal(api.automaticRefreshDue(null, {}, completedAt), true);
    assert.equal(api.automaticRefreshDue({ completedAt: "invalid" }, {}, completedAt), true);
    assert.equal(api.automaticRefreshDue(null, { lastSuccessfulUpdateAt: completedAt }, completedAt + 60000), false);
});

test("reloads reuse persistent updates while manual Refresh bypasses the freshness guard", async () => {
    let failure = false;
    const responder = (endpoint) => {
        if (endpoint === "/user/basic") return { profile: { id: 1, name: "Owner" } };
        if (endpoint === "/user/competition") return failure ? { error: { code: 16 } }
            : { competition: { name: "Elimination", team_id: 7, team: "Seven", score: 5, attacks: 2 } };
        if (endpoint === "/faction/basic") return { basic: { id: 10, name: "Main" } };
        if (endpoint === "/faction/members") return { members: [rosterMember(1, "Owner")] };
        if (endpoint === "/faction/44817/basic") return { basic: { id: 44817, name: "Sister" } };
        if (endpoint === "/faction/44817/members") return { members: [] };
        if (endpoint === "/torn/elimination") return { elimination: [{ id: 7, name: "Seven", lives: 10 }] };
        assert.fail("Unexpected endpoint: " + endpoint);
    };
    const first = fixtureRuntime(responder);
    first.setNow("2026-09-10T11:25:00Z");
    assert.equal(await first.catchUpRefresh("catch-up"), true);
    const initialCalls = first.calls.length;
    assert.equal(await first.refreshData("manual"), true);
    assert.ok(first.calls.length > initialCalls, "Manual refresh must work immediately after an automatic update");
    const completedAt = first.runtime.snapshot.completedAt;
    first.saved.TEFR_V1_API_KEY = "fixture-key";

    const reload = fixtureRuntime(responder, first.saved);
    await reload.loadPersistentState();
    // Reproduces old-slot and alliance-setting mismatches without an old completion time.
    reload.runtime.snapshot.slot -= 3600000;
    reload.runtime.config.lastCheckedFactionIds = "";
    reload.setNow(new Date(completedAt + 10 * 60000).toISOString());
    assert.equal(await reload.catchUpRefresh("catch-up"), false);
    assert.equal(await reload.catchUpRefresh("resume"), false);
    assert.equal(reload.calls.length, 0);
    assert.match(reload.runtime.status, /Using cached update/);
    reload.setNow(new Date(completedAt + 30 * 60000).toISOString());
    assert.equal(await reload.catchUpRefresh("resume"), false);
    assert.equal(await reload.refreshData("scheduled"), false);
    assert.equal(reload.calls.length, 0);
    assert.equal(reload.timers.length, 1, "A skipped scheduled update must still schedule the next HH:10 check");

    reload.runtime.config.lastCheckedFactionIds = reload.runtime.config.alliedFactionIds.join(",");
    reload.setNow(new Date(completedAt + 30 * 60000 + 1).toISOString());
    assert.equal(await reload.catchUpRefresh("resume"), true);
    assert.ok(reload.calls.length > 0, "Stale data must refresh even in an already recorded hourly slot");
    assert.equal(reload.runtime.history.points.length, 1, "Same-slot refreshes replace the snapshot");
    const latest = reload.runtime.snapshot.completedAt;
    const again = fixtureRuntime(responder, reload.saved);
    await again.loadPersistentState();
    again.setNow(new Date(latest + 1000).toISOString());
    assert.equal(await again.catchUpRefresh("catch-up"), false);
    assert.equal(again.calls.length, 0);
    assert.equal(await again.refreshData("manual"), true);
    assert.ok(again.calls.length > 0);
    const successfulAt = again.runtime.snapshot.completedAt;
    failure = true;
    assert.equal(await again.refreshData("manual"), false);
    assert.equal(again.runtime.config.lastSuccessfulUpdateAt, successfulAt,
        "Failed refreshes must not renew the cached update timestamp");
});

test("an inactive-event check is persisted to avoid repeated reload requests", async () => {
    const first = fixtureRuntime((endpoint) => {
        if (endpoint === "/user/basic") return { profile: { id: 1 } };
        if (endpoint === "/user/competition") return { competition: null };
        if (endpoint === "/faction/members") return { members: [] };
        if (endpoint === "/faction/basic") return { basic: { id: 10 } };
        if (endpoint === "/torn/elimination") return { elimination: [] };
        assert.fail("Unexpected endpoint: " + endpoint);
    });
    assert.equal(await first.catchUpRefresh("catch-up"), false);
    assert.equal(first.calls.length, 5);
    first.saved.TEFR_V1_API_KEY = "fixture-key";
    const reload = fixtureRuntime(() => assert.fail("A fresh inactive-event check must not repeat"), first.saved);
    await reload.loadPersistentState();
    assert.equal(await reload.catchUpRefresh("catch-up"), false);
    assert.equal(reload.calls.length, 0);
});

test("leaving during a faction scan checkpoints and resumes without repeating completed requests", async () => {
    let first;
    const response = endpoint => {
        if (endpoint === "/user/basic") return { profile: { id: 1, name: "Player 1" } };
        if (endpoint === "/user/competition" || /^\/user\/\d+\/competition$/.test(endpoint))
            return { competition: { name: "Elimination", team_id: 90, team: "Loose Cannons", score: 1, attacks: 1 } };
        if (endpoint === "/faction/members") return { members: [1, 2, 3, 4].map(id => rosterMember(id, "Player " + id)) };
        if (endpoint === "/faction/44817/members") return { members: [] };
        if (endpoint.endsWith("/basic")) return { basic: { id: 10, name: "Faction" } };
        if (endpoint === "/torn/elimination") return { elimination: [{ id: 90, name: "Loose Cannons" }] };
        assert.fail("Unexpected endpoint " + endpoint);
    };
    first = fixtureRuntime(endpoint => {
        if (endpoint === "/user/2/competition") first.runtime.pageActive = false;
        return response(endpoint);
    });
    assert.equal(await first.refreshData("manual"), false);
    assert.ok(first.saved.TEFR_V2_PENDING_SCAN.responses["/user/2/competition"]);
    assert.equal(first.calls.some(call => call.endpoint === "/user/3/competition"), false);
    const before = first.calls.length;
    assert.equal(await first.refreshData("scheduled"), false);
    assert.equal(first.calls.length, before, "Hidden pages issue no new requests");
    first.saved.TEFR_V1_API_KEY = "fixture-key";
    const next = fixtureRuntime(response, first.saved);
    await next.loadPersistentState();
    assert.equal(await next.catchUpRefresh("resume"), true);
    assert.deepEqual(next.calls.map(call => call.endpoint), ["/user/3/competition", "/user/4/competition"]);
    assert.equal(next.saved.TEFR_V2_PENDING_SCAN, null);
    assert.equal(next.runtime.snapshot.members.length, 4);
    const reload = fixtureRuntime(() => assert.fail("Completed update should stay cached"), next.saved);
    await reload.loadPersistentState();
    assert.equal(await reload.catchUpRefresh("catch-up"), false);
});

test("refresh integrates alliance rosters, faster pacing, withdrawals, and retained final records", async () => {
    let closed = false, withdrawn = false, rosterFailure = false;
    const ownRoster = Array.from({ length: 11 }, (_, index) => rosterMember(index + 1, "Main " + (index + 1)));
    const sisterRoster = [rosterMember(12, "LateJoiner"), rosterMember(13, "NeverJoins"), ownRoster[0]];
    const competition = (id) => ({
        competition: {
            name: "Elimination", team_id: id === 13 || id === 12 && (!closed || withdrawn) ? null : 7,
            team: id === 13 || id === 12 && (!closed || withdrawn) ? "Unknown" : "Loose Cannons",
            score: id === 13 ? 0 : id, attacks: 1
        }
    });
    const fixture = fixtureRuntime((endpoint) => {
        if (endpoint === "/user/basic") return { profile: { id: 1, name: "Main 1" } };
        if (endpoint === "/user/competition") return competition(1);
        if (endpoint === "/faction/basic") return { basic: { id: 10, name: "Main", tag: "M" } };
        if (endpoint === "/faction/members") return { members: ownRoster };
        if (endpoint === "/faction/44817/basic") return { basic: { id: 44817, name: "Sister", tag: "S" } };
        if (endpoint === "/faction/44817/members") return rosterFailure
            ? { error: { code: 16 } } : { members: sisterRoster };
        if (endpoint === "/torn/elimination") return { elimination: [{ id: 7, name: "Loose Cannons", score: 100, lives: 20 }] };
        const match = endpoint.match(/^\/user\/(\d+)\/competition$/);
        assert.ok(match, "Unexpected endpoint: " + endpoint);
        return competition(Number(match[1]));
    });
    const { runtime } = fixture;
    assert.equal(runtime.config.showNonParticipants, false);
    assert.equal(runtime.config.alliedFactionIds[0], 44817);
    assert.equal(await fixture.refreshData("scheduled"), true);
    assert.equal(runtime.snapshot.members.length, 13);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 1).factionId, 10);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 12).participating, false);
    assert.equal(Object.keys(runtime.history.points[0].members).length, 13);
    const calls = fixture.calls.filter((call) => /^\/user\/\d+\/competition$/.test(call.endpoint));
    assert.equal(calls.length, 12);
    assert.equal(calls.some((call) => call.endpoint === "/user/1/competition"), false);
    assert.ok(calls.slice(1).every((call, index) =>
        call.at - calls[index].at >= api.MEMBER_REQUEST_GAP_MS));
    assert.ok(calls[10].at - calls[9].at >= api.MEMBER_CHUNK_PAUSE_MS);
    assert.equal(fixture.waits.filter((ms) => ms === api.MEMBER_CHUNK_PAUSE_MS).length, 1);

    closed = true;
    fixture.setNow("2026-09-10T12:10:00Z");
    assert.equal(await fixture.refreshData("scheduled"), true);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 12).participating, true);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 13).availability, "fresh");
    fixture.calls.length = 0;
    fixture.setNow("2026-09-10T13:10:00Z");
    withdrawn = true;
    assert.equal(await fixture.refreshData("scheduled"), true);
    assert.equal(fixture.calls.some((call) => call.endpoint === "/user/13/competition"), false);
    assert.equal(fixture.calls.some((call) => call.endpoint === "/user/12/competition"), true);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 12).participating, false);
    assert.equal(runtime.snapshot.members.length, 13);
    assert.equal(runtime.snapshot.failedMembers, 0);
    assert.equal(runtime.snapshot.retainedMembers, 1);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 13).availability, "final");

    fixture.calls.length = 0;
    rosterFailure = true;
    assert.equal(await fixture.refreshData("manual"), true);
    assert.equal(fixture.calls.some((call) => call.endpoint === "/user/13/competition"), true);
    assert.equal(runtime.snapshot.members.length, 13);
    assert.equal(runtime.snapshot.members.find((member) => member.id === 12).rosterStale, true);
    assert.match(runtime.warning, /44817 roster unavailable/);
    assert.equal(runtime.history.points.length, 3);

    const buttons = {};
    runtime.root = {
        innerHTML: "", className: "",
        addEventListener() {},
        ownerDocument: { addEventListener() {} },
        querySelector(selector) {
            if (selector === "[data-action='toggle-nonparticipants']") return {
                addEventListener(type, handler) { buttons.visibility = handler; }
            };
            return null;
        },
        querySelectorAll(selector) {
            return selector === "[data-rank-scope]" ? ["alliance", "faction"].map((scope) => ({
                dataset: { rankScope: scope },
                addEventListener(type, handler) { buttons[scope] = handler; }
            })) : [];
        }
    };
    for (const tab of ["ranking", "teams", "trends"]) {
        runtime.config.tab = tab;
        fixture.render();
        assert.doesNotMatch(runtime.root.innerHTML, /NeverJoins/);
        assert.doesNotMatch(runtime.root.innerHTML, /LateJoiner/);
    }
    runtime.config.tab = "ranking";
    fixture.render();
    buttons.visibility();
    assert.match(runtime.root.innerHTML, /NeverJoins/);
    assert.match(runtime.root.innerHTML, /LateJoiner/);
    assert.match(runtime.root.innerHTML, /Alliance Rank:/);
    assert.match(runtime.root.innerHTML, /Faction Rank:/);
    buttons.faction();
    assert.equal(runtime.config.rankScope, "faction");
    assert.equal(runtime.config.faction, "10");
    buttons.alliance();
    assert.equal(runtime.config.faction, "all");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.saved.TEFR_V1_CONFIG.showNonParticipants, true);
    runtime.config.tab = "overview";
    // Legacy cached team aggregates covered every selected faction.
    // The new card must derive separate totals from the saved member rows.
    runtime.snapshot.teams[0].factionScore = 999999;
    fixture.render();
    for (const [label, value] of [
        ["Faction Attacks", 11], ["Faction Members", 11],
        ["Alliance Attacks", 11], ["Alliance Members", 11]
    ]) {
        assert.ok(runtime.root.innerHTML.includes("<small>" + label + "</small><b>" + value + "</b>"), label);
    }
    buttons.visibility();
    assert.ok(runtime.root.innerHTML.includes("<small>Alliance Members</small><b>11</b>"));
    runtime.config.tab = "settings";
    fixture.render();
    assert.match(runtime.root.innerHTML, /value="44817"/);
    assert.match(runtime.root.innerHTML, /\[S\] Sister/);
    assert.doesNotMatch(runtime.root.innerHTML, /fixture-key/);
});

function envKey() {
    const envPath = path.join(__dirname, ".env");
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    const preferred = lines.find((line) => /^\s*(?:TORN_)?API_KEY\s*=/i.test(line));
    const fallback = lines.find((line) =>
        !/^\s*(?:#|$)/.test(line) && line.includes("=")
    );
    const value = (preferred || fallback || "").split("=").slice(1).join("=").trim();
    return value.replace(/^['"]|['"]$/g, "");
}

async function liveGet(endpoint, key) {
    const response = await fetch("https://api.torn.com/v2" + endpoint, {
        headers: { Accept: "application/json", Authorization: "ApiKey " + key }
    });
    assert.equal(response.ok, true, "HTTP " + response.status + " for " + endpoint);
    const data = await response.json();
    assert.equal(Boolean(data.error), false, "Torn API error for " + endpoint);
    return data;
}

test("opt-in live Torn v2 schema smoke test", {
    skip: process.env.TEFR_LIVE !== "1",
    timeout: 30000
}, async () => {
    const key = envKey();
    assert.ok(key, "No API key found in .env");
    const basic = await liveGet("/user/basic", key);
    const personal = await liveGet("/user/competition", key);
    const faction = await liveGet("/faction/members?strip_tags=true", key);
    const elimination = await liveGet("/torn/elimination", key);
    assert.equal(typeof basic.profile?.id, "number");
    assert.equal(typeof personal.competition, "object");
    assert.ok(Array.isArray(faction.members));
    assert.ok(Array.isArray(elimination.elimination));
    const member = faction.members.find((item) =>
        String(item.name).toLocaleLowerCase() === "a1ry")
        || faction.members.find((item) => item.id === basic.profile.id)
        || faction.members[0];
    assert.ok(member?.id);
    const memberCompetition = await liveGet("/user/" + member.id + "/competition", key);
    assert.equal(typeof memberCompetition.competition, "object");
    if (memberCompetition.competition.name === "Elimination"
        && !api.isNonParticipatingTeam(memberCompetition.competition.team)) {
        const normalized = api.normalizeMember(member, memberCompetition);
        assert.equal(normalized.participating, true);
        const resolved = api.resolveMemberTeams(
            [normalized], elimination.elimination
        )[0];
        const globalMatch = elimination.elimination.find((team) =>
            api.normalizedTeamName(team.name)
                === api.normalizedTeamName(normalized.teamName));
        if (globalMatch) assert.equal(resolved.teamId, globalMatch.id);
    }
});

test("opt-in live sister faction ID and public roster schema", {
    skip: process.env.TEFR_LIVE !== "1",
    timeout: 30000
}, async () => {
    const key = envKey();
    const faction = await liveGet("/faction/44817/basic", key);
    assert.equal(faction.basic?.id, 44817);
    assert.equal(typeof faction.basic?.name, "string");
    assert.equal(typeof faction.basic?.tag, "string");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const roster = await liveGet("/faction/44817/members?strip_tags=true", key);
    assert.ok(Array.isArray(roster.members));
    assert.ok(roster.members.every((member) => Number.isInteger(member.id)));
});
