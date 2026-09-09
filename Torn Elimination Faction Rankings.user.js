// ==UserScript==
// @name         Torn Elimination Faction Rankings
// @namespace    https://github.com/SharpSplinter/Torn-Event-Scripts
// @version      1.3.1
// @description  Compact hourly Elimination rankings for every faction member. Public-access key only.
// @author       sharpsplinter [351311]
// @license      MIT
// @match        https://www.torn.com/factions.php*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_info
// @connect      api.torn.com
// ==/UserScript==

(function(factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof window !== "undefined" && window.document) void api.bootstrap(window);
})(function() {
    "use strict";

    const VERSION = "1.3.1";
    const API_BASE = "https://api.torn.com/v2";
    const PDA_KEY_RAW = "_###PDA-APIKEY###_";
    const ROOT_ID = "tefr-root";
    const NOT_PARTICIPATING = "Not Participating";
    const ENROLLMENT_END_MS = Date.UTC(2026, 8, 10, 12);
    const REQUEST_GAP_MS = 1200;
    const MEMBER_CHUNK_SIZE = 10;
    const MEMBER_CHUNK_PAUSE_MS = 10000;
    const MAX_HISTORY_POINTS = 1200;
    const STORAGE = {
        key: "TEFR_V1_API_KEY", config: "TEFR_V1_CONFIG",
        snapshot: "TEFR_V1_SNAPSHOT", history: "TEFR_V1_HISTORY"
    };
    const DEFAULT_CONFIG = {
        collapsed: false, tab: "overview", search: "", team: "all", faction: "all", rankScope: "alliance",
        alliedFactionIds: [44817],
        participation: "all", showNonParticipants: false, sort: "rank", metric: "score",
        range: "168", trendMember: "", lastCheckedSlot: 0, lastCheckedFactionIds: ""
    };
    const COLORS = [
        "#55ddb8", "#69aef7", "#f6c85f", "#f28e8e", "#b99cff", "#73d2de",
        "#f7a35c", "#90d67f", "#e678c5", "#aab7c4", "#f45b69", "#91e8e1"
    ];
    const runtime = {
        root: null, config: { ...DEFAULT_CONFIG }, snapshot: null,
        history: { eventKey: "", points: [] }, apiKey: "", injectedKey: "",
        nativeValues: null, storageMode: "GM storage", busy: false,
        progress: null, status: "Loading saved data...", error: "", warning: "",
        retryNotBefore: 0, scheduleTimer: null, tickTimer: null, mountObserver: null
    };

    const number = (value, fallback = 0) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const nullableNumber = (value) => {
        if (value === null || value === undefined || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };
    const escapeHtml = (value) => String(value ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const formatNumber = (value) => Number.isFinite(Number(value))
        ? new Intl.NumberFormat("en-US").format(Number(value)) : "-";
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    function debugLog(event, details = {}) {
        if (typeof console !== "undefined" && typeof console.debug === "function") {
            console.debug("[TEFR] " + event, details);
        }
    }
    function infoLog(event, details = {}) {
        if (typeof console !== "undefined" && typeof console.info === "function") {
            console.info("[TEFR] " + event, details);
        }
    }

    function detectedRuntime() {
        const isPda = typeof PDA_httpGet === "function"
            || typeof PDA_storage !== "undefined"
            || Boolean(PDA_KEY_RAW && !PDA_KEY_RAW.includes("PDA-APIKEY"));
        let engine = isPda ? "TornPDA" : "Browser";
        if (!isPda) {
            try {
                const info = typeof GM_info !== "undefined" ? GM_info : null;
                engine = String(info?.scriptHandler || "")
                    || (typeof GM_xmlhttpRequest === "function"
                        ? "Userscript manager" : "Browser");
            } catch (_) {
                engine = typeof GM_xmlhttpRequest === "function"
                    ? "Userscript manager" : "Browser";
            }
        }
        const compact = typeof window !== "undefined"
            && window.matchMedia?.("(max-width: 700px)").matches;
        return engine + " · " + (compact ? "Compact layout" : "Desktop layout");
    }

    function ordinal(value) {
        const n = Math.max(0, Math.trunc(number(value)));
        const mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 13) return n + "th";
        return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
    }

    function slotAtOrBefore(input) {
        const now = input instanceof Date ? new Date(input) : new Date(input || Date.now());
        const slot = new Date(now);
        slot.setUTCMinutes(10, 0, 0);
        if (now.getTime() < slot.getTime()) slot.setUTCHours(slot.getUTCHours() - 1);
        return slot.getTime();
    }

    function nextSlot(input) { return slotAtOrBefore(input) + 3600000; }

    function formatUtc(timestamp) {
        if (!timestamp) return "Never";
        return new Date(timestamp).toLocaleString("en-GB", {
            timeZone: "UTC", day: "2-digit", month: "short",
            hour: "2-digit", minute: "2-digit", hour12: false
        }) + " UTC";
    }

    function normalizeCompetition(raw) {
        const competition = raw?.competition || raw || {};
        const active = competition.name === "Elimination";
        const teamId = active ? nullableNumber(competition.team_id) : null;
        const rawTeam = active ? String(competition.team || "").trim() : "";
        const suppliedTeam = normalizedTeamName(rawTeam) === "unknown" ? "" : rawTeam;
        return {
            active, name: String(competition.name || ""),
            score: active ? number(competition.score) : 0,
            attacks: active ? number(competition.attacks) : 0,
            teamId,
            teamName: active && (teamId !== null || suppliedTeam)
                ? suppliedTeam || "Unnamed team" : NOT_PARTICIPATING
        };
    }

    function normalizeMember(member, competition, availability = "fresh", checkedAt = 0) {
        const comp = normalizeCompetition(competition);
        return {
            id: number(member?.id), name: String(member?.name || "Unknown"),
            position: String(member?.position || ""), level: number(member?.level),
            daysInFaction: number(member?.days_in_faction),
            factionId: nullableNumber(member?.faction?.id),
            factionName: String(member?.faction?.name || "Your faction"),
            factionTag: String(member?.faction?.tag || ""),
            rosterStale: Boolean(member?.rosterStale),
            lastAction: {
                status: String(member?.last_action?.status || ""),
                timestamp: number(member?.last_action?.timestamp),
                relative: String(member?.last_action?.relative || "")
            },
            status: {
                state: String(member?.status?.state || ""),
                description: String(member?.status?.description || ""),
                color: String(member?.status?.color || "")
            },
            participating: comp.active && (comp.teamId !== null
                || !isNonParticipatingTeam(comp.teamName)),
            teamId: comp.teamId, teamName: comp.teamName,
            score: comp.score, attacks: comp.attacks, availability,
            competitionCheckedAt: comp.active ? checkedAt : 0,
            factionRank: null, teamRank: null
        };
    }

    function memberPerformanceCompare(left, right) {
        const leftUnavailable = left.availability === "unavailable";
        const rightUnavailable = right.availability === "unavailable";
        if (leftUnavailable !== rightUnavailable) return leftUnavailable ? 1 : -1;
        if (right.score !== left.score) return right.score - left.score;
        if (right.attacks !== left.attacks) return right.attacks - left.attacks;
        if (left.participating !== right.participating) return left.participating ? -1 : 1;
        const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        return byName || left.id - right.id;
    }

    function memberNeedsRefresh(previous, asOf, force = false) {
        // Only the 2026 enrollment deadline has been confirmed.
        return force || !previous || new Date(asOf).getUTCFullYear() !== 2026
            || asOf < ENROLLMENT_END_MS || previous.participating !== false
            || !["fresh", "final"].includes(previous.availability)
            || number(previous.competitionCheckedAt) < ENROLLMENT_END_MS;
    }

    function visibleMembers(members, showNonParticipants = false) {
        return members.filter((member) => showNonParticipants || member.participating
            && (member.teamId != null || !isNonParticipatingTeam(member.teamName)));
    }

    function withNonParticipantVisibility(config, show) {
        return {
            ...config, showNonParticipants: Boolean(show),
            team: !show && config.team === "unassigned" ? "all" : config.team,
            participation: !show && config.participation === "no" ? "all" : config.participation
        };
    }

    function parseFactionIds(value) {
        const parts = String(value || "").trim().split(/[\s,;]+/).filter(Boolean);
        if (parts.some((part) => !/^\d+$/.test(part)
            || !Number.isSafeInteger(Number(part)) || Number(part) < 1 || Number(part) > 2147483647)) {
            throw new Error("Enter numeric faction IDs separated by commas or new lines.");
        }
        return [...new Set(parts.map(Number))];
    }

    function normalizeFaction(raw, id = null, own = false) {
        const basic = raw?.basic || raw || {};
        return {
            id: nullableNumber(basic.id) ?? id,
            name: String(basic.name || (own ? "Your faction" : "Faction " + id)),
            tag: String(basic.tag || ""), own
        };
    }

    function factionLabel(member) {
        return (member.factionTag ? "[" + member.factionTag + "] " : "")
            + (member.factionName || "Your faction");
    }

    function mergeFactionRosters(sources) {
        const unique = new Map();
        [...sources].sort((a, b) => Number(a.stale) - Number(b.stale)).forEach((source) => {
            source.members.forEach((member) => {
                const id = number(member.id);
                if (id && !unique.has(id)) {
                    unique.set(id, { ...member, faction: source.faction, rosterStale: Boolean(source.stale) });
                }
            });
        });
        return [...unique.values()];
    }

    async function loadFactionRosters(ownRoster, ownFaction, ids, key, params, previous) {
        const sources = [{ faction: ownFaction, members: ownRoster, stale: false }];
        const warnings = [];
        for (const id of ids.filter((id) => id !== ownFaction.id)) {
            const cached = previous?.factions?.find((faction) => faction.id === id);
            let faction = normalizeFaction(cached, id);
            runtime.status = "Loading faction " + id + "…";
            updateProgress(0, 0);
            await sleep(REQUEST_GAP_MS);
            try {
                faction = normalizeFaction(await requestWithRetry("/faction/" + id + "/basic", key, params), id);
            } catch (error) {
                warnings.push("Faction " + id + " details unavailable; using a saved name or ID.");
                debugLog("Faction details fallback", { id, code: error?.code ?? null });
            }
            await sleep(REQUEST_GAP_MS);
            try {
                const result = await requestWithRetry("/faction/" + id + "/members",
                    key, { ...params, strip_tags: true });
                if (!Array.isArray(result.members)) throw new ApiError("Invalid roster");
                sources.push({ faction, members: result.members, stale: false });
            } catch (error) {
                const members = (previous?.members || []).filter((member) => member.factionId === id)
                    .map((member) => ({
                        id: member.id, name: member.name, position: member.position, level: member.level,
                        days_in_faction: member.daysInFaction,
                        last_action: member.lastAction, status: member.status
                    }));
                sources.push({ faction, members, stale: true });
                warnings.push("Faction " + id + " roster unavailable"
                    + (members.length ? "; saved roster shown." : "; not included yet."));
                debugLog("Faction roster fallback", { id, retained: members.length, code: error?.code ?? null });
            }
        }
        return {
            roster: mergeFactionRosters(sources),
            factions: sources.map((source) => ({
                ...source.faction, memberCount: source.members.length, rosterAvailable: !source.stale
            })),
            warnings
        };
    }

    function normalizedTeamName(value) {
        return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    }

    function isNonParticipatingTeam(value) {
        return ["", "unknown", "unknown team", "unassigned", "not participating"]
            .includes(normalizedTeamName(value));
    }

    function teamKey(value) {
        const rawId = value && Object.prototype.hasOwnProperty.call(value, "teamId")
            ? value.teamId : value?.id;
        const id = nullableNumber(rawId);
        if (id !== null) return String(id);
        const name = normalizedTeamName(value?.teamName ?? value?.name);
        return name && !isNonParticipatingTeam(name) ? "name:" + name : "unassigned";
    }

    function resolveMemberTeams(members, globalTeams) {
        const normalizedTeams = (globalTeams || []).map(normalizeGlobalTeam);
        const byName = new Map(normalizedTeams.map((team) =>
            [normalizedTeamName(team.name), team]));
        const byId = new Map(normalizedTeams.map((team) =>
            [String(team.id), team]));
        return members.map((member) => {
            const idMatch = member.teamId !== null
                ? byId.get(String(member.teamId)) : null;
            if (idMatch) return { ...member, teamName: idMatch.name };
            if (!member.participating) {
                return { ...member, teamId: null, teamName: NOT_PARTICIPATING };
            }
            if (member.teamId !== null) return member;
            const match = byName.get(normalizedTeamName(member.teamName));
            return match ? { ...member, teamId: match.id, teamName: match.name } : member;
        });
    }

    function rankMembers(input) {
        const members = input.map((member) => ({ ...member })).sort(memberPerformanceCompare);
        members.forEach((member, index) => { member.allianceRank = index + 1; });
        const factionCounts = new Map();
        members.forEach((member) => {
            const key = member.factionId ?? "own";
            const rank = (factionCounts.get(key) || 0) + 1;
            factionCounts.set(key, rank);
            member.factionRank = rank;
        });
        members.forEach((member) => {
            member.sourceFactionSize = factionCounts.get(member.factionId ?? "own");
        });
        const groups = new Map();
        members.filter((member) => member.participating).forEach((member) => {
            const key = teamKey(member);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(member);
        });
        groups.forEach((group) => {
            group.sort(memberPerformanceCompare).forEach((member, index) => {
                member.teamRank = index + 1;
            });
        });
        return members;
    }

    function normalizeGlobalTeam(team) {
        const normalized = {
            id: nullableNumber(team?.id), name: String(team?.name || "Unnamed team"),
            participants: number(team?.participants), position: number(team?.position, 999),
            score: number(team?.score), lives: number(team?.lives),
            wins: number(team?.wins), losses: number(team?.losses),
            eliminated: Boolean(team?.eliminated),
            eliminatedTimestamp: nullableNumber(team?.eliminated_timestamp),
            factionMembers: 0, factionScore: 0, factionAttacks: 0
        };
        normalized.key = teamKey(normalized);
        return normalized;
    }

    function aggregateTeams(globalTeams, members) {
        const map = new Map((globalTeams || []).map((team) => {
            const normalized = normalizeGlobalTeam(team);
            return [normalized.key, normalized];
        }));
        members.filter((member) => member.participating).forEach((member) => {
            const key = teamKey(member);
            if (!map.has(key)) {
                map.set(key, {
                    ...normalizeGlobalTeam({ id: member.teamId, name: member.teamName }),
                    key, position: 999
                });
            }
            const team = map.get(key);
            team.factionMembers += 1;
            team.factionScore += member.score;
            team.factionAttacks += member.attacks;
        });
        return [...map.values()].sort((left, right) =>
            left.position - right.position || right.score - left.score
            || left.name.localeCompare(right.name)
        );
    }

    function eventKey(slot, teams) {
        const year = new Date(slot).getUTCFullYear();
        const ids = (teams || []).map((team) => number(team.id))
            .filter(Boolean).sort((a, b) => a - b);
        return year + ":" + ids.join(",");
    }

    function buildHistoryPoint(snapshot) {
        const teams = Object.fromEntries(snapshot.teams.map((team) => [
            team.key || teamKey(team),
            [team.score, team.lives, team.factionScore, team.factionAttacks, team.position]
        ]));
        const members = Object.fromEntries(snapshot.members.map((member) => [
            String(member.id),
            [member.allianceRank ?? member.factionRank, member.teamRank, member.score, member.attacks,
                member.teamId, member.teamName, member.factionId, member.factionRank]
        ]));
        return {
            slot: snapshot.slot, completedAt: snapshot.completedAt,
            profileId: snapshot.profile?.id || null, teams, members,
            factions: snapshot.factions || [], scope: snapshot.scope || ""
        };
    }

    function upsertHistory(history, key, point, maxPoints = MAX_HISTORY_POINTS) {
        const points = history?.eventKey === key && Array.isArray(history.points)
            ? history.points.filter((entry) => entry.slot !== point.slot) : [];
        points.push(point);
        points.sort((left, right) => left.slot - right.slot);
        return { eventKey: key, points: points.slice(-maxPoints) };
    }

    function previousHistoryPoint(history, slot) {
        return [...(history?.points || [])]
            .filter((point) => point.slot < slot)
            .sort((a, b) => b.slot - a.slot)[0] || null;
    }

    function injectedKey() {
        const value = String(PDA_KEY_RAW || "").trim();
        return value && !value.includes("PDA-APIKEY") ? value : "";
    }

    function nativeStore() {
        return typeof PDA_storage !== "undefined" && PDA_storage?.loadAll
            ? PDA_storage : null;
    }

    async function legacyGet(key, fallback) {
        try {
            if (typeof GM_getValue === "function") {
                const value = await Promise.resolve(GM_getValue(key, fallback));
                return value === undefined ? fallback : value;
            }
            if (typeof GM !== "undefined" && typeof GM.getValue === "function") {
                return await GM.getValue(key, fallback);
            }
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (_) {
            return fallback;
        }
    }

    async function legacySet(key, value) {
        if (typeof GM_setValue === "function") {
            await Promise.resolve(GM_setValue(key, value));
            return;
        }
        if (typeof GM !== "undefined" && typeof GM.setValue === "function") {
            await GM.setValue(key, value);
            return;
        }
        localStorage.setItem(key, JSON.stringify(value));
    }

    async function legacyDelete(key) {
        if (typeof GM_deleteValue === "function") {
            await Promise.resolve(GM_deleteValue(key));
            return;
        }
        if (typeof GM !== "undefined" && typeof GM.deleteValue === "function") {
            await GM.deleteValue(key);
            return;
        }
        localStorage.removeItem(key);
    }

    async function loadPersistentState() {
        const store = nativeStore();
        if (store) {
            try {
                runtime.nativeValues = await store.loadAll();
                runtime.storageMode = "TornPDA native storage";
            } catch (_) {
                runtime.nativeValues = null;
                runtime.storageMode = "GM storage fallback";
            }
        }
        const read = async (key, fallback) => runtime.nativeValues
            && Object.prototype.hasOwnProperty.call(runtime.nativeValues, key)
            ? runtime.nativeValues[key] : legacyGet(key, fallback);
        runtime.config = {
            ...DEFAULT_CONFIG,
            ...await read(STORAGE.config, DEFAULT_CONFIG)
        };
        runtime.config = withNonParticipantVisibility(runtime.config,
            runtime.config.showNonParticipants);
        try {
            runtime.config.alliedFactionIds = parseFactionIds(
                (runtime.config.alliedFactionIds || []).join(","));
        } catch (_) {
            runtime.config.alliedFactionIds = [];
        }
        runtime.snapshot = await read(STORAGE.snapshot, null);
        runtime.history = await read(STORAGE.history, { eventKey: "", points: [] });
        if (!runtime.history || !Array.isArray(runtime.history.points)) {
            runtime.history = { eventKey: "", points: [] };
        }
        runtime.injectedKey = injectedKey();
        runtime.apiKey = runtime.injectedKey || await legacyGet(STORAGE.key, "");
    }

    async function persistValues(values) {
        const store = nativeStore();
        if (store && runtime.nativeValues) {
            try {
                await store.setMany(values);
                Object.assign(runtime.nativeValues, values);
                return;
            } catch (error) {
                runtime.warning = error?.code === "QuotaExceeded"
                    ? "TornPDA storage quota reached; using GM storage."
                    : "TornPDA storage failed; using GM storage.";
            }
        }
        for (const [key, value] of Object.entries(values)) await legacySet(key, value);
    }

    async function saveConfig() {
        await persistValues({ [STORAGE.config]: runtime.config });
    }

    class ApiError extends Error {
        constructor(message, code = null, status = 0) {
            super(message);
            this.name = "ApiError";
            this.code = nullableNumber(code);
            this.status = number(status);
        }
    }

    function safeApiMessage(error) {
        const messages = {
            1: "The Public-access Torn key is missing.",
            2: "The Public-access Torn key is invalid.",
            5: "Torn's API rate limit was reached.",
            8: "Torn temporarily blocked API requests from this connection.",
            9: "Torn's API is temporarily disabled.",
            10: "The API-key owner cannot currently use the Torn API.",
            13: "The API key is temporarily disabled because its owner is inactive.",
            15: "Torn returned a temporary API error.",
            16: "This key cannot access the requested public selection.",
            17: "Torn's API backend returned a temporary error.",
            18: "The API key is paused."
        };
        return messages[error?.code] || (error?.status
            ? "Torn API request failed with HTTP " + error.status + "."
            : "Torn API request failed.");
    }

    function gmHttpGet(url, headers) {
        return new Promise((resolve, reject) => {
            const details = {
                method: "GET", url, headers, timeout: 30000,
                onload: resolve, onerror: reject, ontimeout: reject, onabort: reject
            };
            try {
                if (typeof GM_xmlhttpRequest === "function") {
                    GM_xmlhttpRequest(details);
                } else if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
                    GM.xmlHttpRequest(details).then(resolve, reject);
                } else {
                    fetch(url, { headers }).then(async (response) => resolve({
                        status: response.status,
                        statusText: response.statusText,
                        responseText: await response.text()
                    }), reject);
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    async function httpGet(url, headers) {
        if (typeof PDA_httpGet === "function") return PDA_httpGet(url, headers);
        return gmHttpGet(url, headers);
    }

    async function requestJson(path, key, params = {}) {
        debugLog("API request", { endpoint: path });
        const url = new URL(API_BASE + path);
        Object.entries(params).forEach(([name, value]) => {
            if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
        });
        const response = await httpGet(url.toString(), {
            Accept: "application/json",
            Authorization: "ApiKey " + key
        });
        const status = number(response?.status);
        debugLog("API response", { endpoint: path, status });
        let data;
        try {
            data = JSON.parse(response?.responseText || "");
        } catch (_) {
            throw new ApiError("Invalid JSON response", null, status);
        }
        if (data?.error) {
            throw new ApiError(String(data.error.error || "Torn API error"), data.error.code, status);
        }
        if (status < 200 || status >= 300) throw new ApiError("HTTP error", null, status);
        return data;
    }

    async function requestWithRetry(path, key, params, attempts = 3) {
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await requestJson(path, key, params);
            } catch (error) {
                lastError = error;
                const retryable = [5, 8, 9, 15, 17].includes(error?.code)
                    || !error?.code && (!error?.status || error.status >= 500);
                if (!retryable || attempt === attempts - 1) break;
                const wait = error?.code === 5 ? 15000 * (attempt + 1) : 2000 * (attempt + 1);
                infoLog("API retry scheduled", {
                    endpoint: path, attempt: attempt + 2,
                    code: error?.code ?? null, status: error?.status || 0, waitMs: wait
                });
                await sleep(wait);
            }
        }
        throw lastError;
    }

    function updateProgress(done, total, label = "") {
        runtime.progress = { done, total, label };
        const status = runtime.root?.querySelector("[data-role='progress-text']");
        const bar = runtime.root?.querySelector("[data-role='progress-bar']");
        const percent = total ? Math.round(done / total * 100) : 0;
        if (status) status.textContent = total
            ? "Updating " + done + " of " + total + " · " + percent + "%"
                + (label ? " · " + label : "")
            : runtime.status;
        if (bar) bar.style.width = total ? Math.round(done / total * 100) + "%" : "0%";
        const track = bar?.parentElement;
        if (track) {
            track.setAttribute("aria-valuenow", String(percent));
            track.classList.toggle("is-indeterminate", !total && runtime.busy);
        }
    }

    function priorMember(member, previous, availability = "stale") {
        if (!previous || previous.availability === "unavailable") {
            return normalizeMember(member, null, "unavailable");
        }
        return normalizeMember(member, {
            competition: {
                name: "Elimination", team_id: previous.teamId,
                team: previous.teamName, score: previous.score, attacks: previous.attacks
            }
        }, availability, number(previous.competitionCheckedAt));
    }

    async function refreshData(reason = "scheduled", slot = slotAtOrBefore(Date.now())) {
        if (runtime.busy) return false;
        const key = runtime.injectedKey || runtime.apiKey;
        if (!key) {
            runtime.error = "Enter a Public-access Torn key in Settings.";
            runtime.config.tab = "settings";
            render();
            return false;
        }
        runtime.busy = true;
        infoLog("Refresh started", { reason, slot: formatUtc(slot) });
        runtime.error = "";
        runtime.warning = "";
        runtime.status = reason === "manual" ? "Manual refresh started." : "Hourly refresh started.";
        updateProgress(0, 0);
        render();
        const timestamp = Math.floor(Date.now() / 1000);
        const params = { timestamp };
        const alliedIds = [...runtime.config.alliedFactionIds];
        try {
            const requests = await Promise.allSettled([
                requestWithRetry("/user/basic", key, params),
                requestWithRetry("/user/competition", key, params),
                requestWithRetry("/faction/members", key, { ...params, strip_tags: true }),
                requestWithRetry("/torn/elimination", key, params),
                requestWithRetry("/faction/basic", key, params)
            ]);
            if (requests[1].status === "rejected") throw requests[1].reason;
            if (requests[2].status === "rejected") throw requests[2].reason;

            const profileRaw = requests[0].status === "fulfilled"
                ? requests[0].value?.profile || {} : {};
            const personalRaw = requests[1].value;
            const personal = normalizeCompetition(personalRaw);
            if (!Array.isArray(requests[2].value?.members)) throw new ApiError("Invalid faction roster");
            const ownRoster = requests[2].value.members;
            const globalTeams = requests[3].status === "fulfilled"
                && Array.isArray(requests[3].value?.elimination)
                ? requests[3].value.elimination : [];
            const eventActive = personal.active
                || globalTeams.some((team) => !team.eliminated);
            if (!eventActive) {
                runtime.config.lastCheckedSlot = slot;
                runtime.config.lastCheckedFactionIds = alliedIds.join(",");
                runtime.status = "Elimination is not currently active.";
                await saveConfig();
                return false;
            }

            const profile = {
                id: number(profileRaw.id), name: String(profileRaw.name || ""),
                level: number(profileRaw.level)
            };
            const currentYearPrefix = new Date(slot).getUTCFullYear() + ":";
            const knownEventKey = String(runtime.history.eventKey || "");
            const keyForEvent = requests[3].status === "fulfilled"
                ? eventKey(slot, globalTeams)
                : knownEventKey.startsWith(currentYearPrefix)
                    ? knownEventKey : eventKey(slot, []);
            const priorSnapshot = runtime.snapshot?.eventKey === keyForEvent
                ? runtime.snapshot : null;
            const cachedOwn = priorSnapshot?.profile?.id === profile.id
                ? priorSnapshot?.factions?.find((faction) => faction.own) : null;
            const ownFaction = normalizeFaction(requests[4].status === "fulfilled"
                ? requests[4].value : cachedOwn, null, true);
            const loaded = await loadFactionRosters(ownRoster, ownFaction, alliedIds,
                key, params, priorSnapshot);
            const { roster, factions } = loaded;
            if (requests[4].status === "rejected") {
                loaded.warnings.push("Your faction details are unavailable; using the saved name or Your faction.");
            }
            const previousById = new Map(
                (priorSnapshot?.members || []).map((member) => [String(member.id), member])
            );
            const normalized = [];
            const otherMembers = [];
            roster.filter((member) => number(member.id) !== profile.id).forEach((member) => {
                const previous = previousById.get(String(member.id));
                if (memberNeedsRefresh(previous, timestamp * 1000, reason === "manual")) {
                    otherMembers.push(member);
                } else {
                    normalized.push(priorMember(member, previous, "final"));
                }
            });
            const retainedMembers = normalized.length;
            infoLog("Enrollment refresh queue", {
                queued: otherMembers.length, retainedMembers,
                enrollmentEnds: formatUtc(ENROLLMENT_END_MS)
            });
            const total = otherMembers.length;
            const chunkTotal = Math.ceil(total / MEMBER_CHUNK_SIZE);
            if (profile.id) {
                const own = roster.find((member) => number(member.id) === profile.id);
                if (own) normalized.push(normalizeMember(own, personalRaw, "fresh", timestamp * 1000));
            }

            let lastStartedAt = Date.now();
            for (let index = 0; index < otherMembers.length; index += 1) {
                const member = otherMembers[index];
                const chunk = Math.floor(index / MEMBER_CHUNK_SIZE) + 1;
                if (index > 0 && index % MEMBER_CHUNK_SIZE === 0) {
                    runtime.status = "Pacing member update chunk " + chunk + " of " + chunkTotal + ".";
                    infoLog("Member chunk pacing pause", {
                        chunk, chunkTotal, completed: index, total,
                        pauseMs: MEMBER_CHUNK_PAUSE_MS
                    });
                    updateProgress(index, total, "pacing pause before chunk "
                        + chunk + " of " + chunkTotal);
                    await sleep(MEMBER_CHUNK_PAUSE_MS);
                }
                const wait = REQUEST_GAP_MS - (Date.now() - lastStartedAt);
                if (wait > 0) await sleep(wait);
                lastStartedAt = Date.now();
                updateProgress(index, total, "chunk " + chunk + " of "
                    + chunkTotal + " · " + String(member.name || ""));
                try {
                    const response = await requestWithRetry(
                        "/user/" + encodeURIComponent(String(member.id)) + "/competition",
                        key,
                        params
                    );
                    normalized.push(normalizeMember(member, response, "fresh", timestamp * 1000));
                    debugLog("Member updated", {
                        id: number(member.id), chunk, completed: index + 1, total
                    });
                } catch (error) {
                    debugLog("Member update fallback", {
                        id: number(member.id), chunk,
                        code: error?.code ?? null, status: error?.status || 0
                    });
                    normalized.push(priorMember(member, previousById.get(String(member.id))));
                }
                updateProgress(index + 1, total, "chunk " + chunk + " of "
                    + chunkTotal + " · " + String(member.name || ""));
            }

            roster.filter((member) => !normalized.some((row) => row.id === number(member.id)))
                .forEach((member) => {
                    normalized.push(priorMember(member, previousById.get(String(member.id))));
                });
            const resolved = resolveMemberTeams(normalized, globalTeams);
            const resolvedByName = resolved.filter((member, index) =>
                normalized[index]?.teamId === null && member.teamId !== null).length;
            infoLog("Team assignments resolved", {
                members: resolved.length, resolvedByName,
                namedTeams: new Set(resolved.filter((member) => member.participating)
                    .map((member) => teamKey(member))).size
            });
            const members = rankMembers(resolved);
            const teams = aggregateTeams(globalTeams, members);
            const failedMembers = members.filter((member) =>
                ["stale", "unavailable"].includes(member.availability)).length;
            const snapshot = {
                schema: 1, eventKey: keyForEvent, slot, completedAt: Date.now(),
                profile, personal, teams, members, failedMembers, retainedMembers, factions,
                alliedFactionIds: alliedIds, scope: profile.id + ":" + [...alliedIds].sort((a, b) => a - b).join(","),
                globalTeamsAvailable: requests[3].status === "fulfilled",
                profileAvailable: requests[0].status === "fulfilled"
            };
            runtime.snapshot = snapshot;
            runtime.history = upsertHistory(runtime.history, keyForEvent, buildHistoryPoint(snapshot));
            runtime.config.lastCheckedSlot = slot;
            runtime.config.lastCheckedFactionIds = alliedIds.join(",");
            runtime.retryNotBefore = 0;
            runtime.status = "Updated for the " + formatUtc(slot) + " interval.";
            const dataWarning = failedMembers
                ? failedMembers + " member record(s) use stale or unavailable data."
                : requests[3].status === "rejected"
                    ? "Global team totals are temporarily unavailable." : "";
            runtime.warning = [...loaded.warnings, dataWarning].filter(Boolean).join(" ");
            await persistValues({
                [STORAGE.snapshot]: runtime.snapshot,
                [STORAGE.history]: runtime.history,
                [STORAGE.config]: runtime.config
            });
            infoLog("Refresh completed", {
                slot: formatUtc(slot), members: members.length,
                teams: teams.length, failedMembers, retainedMembers
            });
            return true;
        } catch (error) {
            runtime.error = safeApiMessage(error);
            runtime.status = "Refresh failed.";
            runtime.retryNotBefore = Date.now() + 5 * 60 * 1000;
            console.warn("[TEFR] Refresh failed", {
                reason, code: error?.code ?? null, status: error?.status || 0,
                message: runtime.error
            });
            return false;
        } finally {
            runtime.busy = false;
            runtime.progress = null;
            render();
            scheduleNextRefresh();
        }
    }

    function teamColor(value) {
        const raw = String(value ?? "");
        let index = Number(raw);
        if (!Number.isFinite(index)) {
            index = [...raw].reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) | 0, 0);
        }
        return COLORS[Math.abs(index) % COLORS.length];
    }

    function pointRank(point, memberId, scope) {
        const entry = point?.members?.[String(memberId)];
        return nullableNumber(scope === "faction" ? entry?.[7] ?? (!point?.scope ? entry?.[0] : null) : entry?.[0]);
    }

    function displayRank(member) {
        return runtime.config.rankScope === "faction" ? member.factionRank : member.allianceRank ?? member.factionRank;
    }

    function rankLabel() {
        return runtime.config.rankScope === "faction" ? "Faction Rank" : "Alliance Rank";
    }

    function priorRank(memberId) {
        const point = previousHistoryPoint({ points: scopeHistoryPoints() }, runtime.snapshot?.slot || Infinity);
        return pointRank(point, memberId, runtime.config.rankScope);
    }

    function rankMovement(member) {
        const prior = priorRank(member.id);
        if (prior === null) return { value: 0, label: "New", tone: "" };
        const delta = prior - displayRank(member);
        if (delta > 0) return { value: delta, label: "&#9650; " + delta, tone: "good" };
        if (delta < 0) return { value: delta, label: "&#9660; " + Math.abs(delta), tone: "bad" };
        return { value: 0, label: "-", tone: "" };
    }

    function scopeHistoryPoints() {
        return (runtime.history?.points || []).filter((point) => point.scope === runtime.snapshot?.scope
            || !point.scope && !(runtime.snapshot?.alliedFactionIds || []).length);
    }

    function historyPoints() {
        const points = scopeHistoryPoints();
        if (runtime.config.range === "all") return points;
        return points.slice(-Math.max(1, number(runtime.config.range, 168)));
    }

    function rankSparkline(memberId) {
        const values = historyPoints()
            .map((point) => pointRank(point, memberId, runtime.config.rankScope))
            .filter((value) => value !== null);
        if (values.length < 2) return '<span class="tefr-muted">Rank history starts after the next update.</span>';
        const width = 260;
        const height = 54;
        const max = Math.max(...values);
        const min = Math.min(...values);
        const spread = Math.max(1, max - min);
        const points = values.map((value, index) => {
            const x = values.length === 1 ? 0 : index / (values.length - 1) * width;
            const y = 5 + (value - min) / spread * (height - 10);
            return x.toFixed(1) + "," + y.toFixed(1);
        }).join(" ");
        return '<svg class="tefr-spark" viewBox="0 0 ' + width + " " + height
            + '" role="img" aria-label="' + rankLabel() + ' history"><polyline points="' + points
            + '" fill="none" stroke="#55ddb8" stroke-width="3"/></svg>';
    }

    function metricIndex(metric) {
        return { score: 0, lives: 1, factionScore: 2, factionAttacks: 3 }[metric] ?? 0;
    }

    function rankingLabel() {
        return (runtime.snapshot?.factions?.length || 0) > 1 ? "Alliance" : "Faction";
    }

    function contributionLabel() {
        return rankingLabel() === "Alliance" ? "Selected factions" : "Faction";
    }

    function metricLabel(metric) {
        return {
            score: "Global score", lives: "Global lives",
            factionScore: contributionLabel() + " score", factionAttacks: contributionLabel() + " attacks"
        }[metric] || "Global score";
    }

    function teamTrendChart() {
        const points = historyPoints();
        const teams = runtime.snapshot?.teams || [];
        if (points.length < 2 || !teams.length) {
            return '<div class="tefr-empty">Team trend lines appear after two hourly updates.</div>';
        }
        const width = 760;
        const height = 260;
        const pad = 32;
        const index = metricIndex(runtime.config.metric);
        const allValues = [];
        teams.forEach((team) => points.forEach((point) => {
            const value = nullableNumber(point.teams?.[team.key || teamKey(team)]?.[index]);
            if (value !== null) allValues.push(value);
        }));
        const max = Math.max(1, ...allValues);
        const lines = teams.map((team) => {
            const coords = points.map((point, pointIndex) => {
                const value = nullableNumber(point.teams?.[team.key || teamKey(team)]?.[index]);
                if (value === null) return null;
                const x = pad + pointIndex / Math.max(1, points.length - 1) * (width - pad * 2);
                const y = height - pad - value / max * (height - pad * 2);
                return x.toFixed(1) + "," + y.toFixed(1);
            }).filter(Boolean).join(" ");
            return '<polyline points="' + coords + '" fill="none" stroke="'
                + teamColor(team.id) + '" stroke-width="2.5"/>';
        }).join("");
        const legend = teams.map((team) => '<span><i style="background:'
            + teamColor(team.id) + '"></i>' + escapeHtml(team.name) + "</span>").join("");
        return '<div class="tefr-chart"><svg viewBox="0 0 ' + width + " " + height
            + '" role="img" aria-label="' + escapeHtml(metricLabel(runtime.config.metric))
            + ' trend"><path d="M32 16V228H744" stroke="#355269" fill="none"/>'
            + lines + '</svg></div><div class="tefr-legend">' + legend + "</div>";
    }

    function comparisonBars() {
        const teams = runtime.snapshot?.teams || [];
        const metric = runtime.config.metric;
        const key = {
            score: "score", lives: "lives",
            factionScore: "factionScore", factionAttacks: "factionAttacks"
        }[metric] || "score";
        const max = Math.max(1, ...teams.map((team) => number(team[key])));
        return '<div class="tefr-bars">' + teams.map((team) => {
            const value = number(team[key]);
            const width = Math.max(value ? 2 : 0, value / max * 100);
            return '<div class="tefr-bar-row"><span>' + escapeHtml(team.name)
                + '</span><div><i style="width:' + width.toFixed(2) + "%;background:"
                + teamColor(team.id) + '"></i></div><b>' + formatNumber(value) + "</b></div>";
        }).join("") + "</div>";
    }

    function personalCard() {
        const snapshot = runtime.snapshot;
        const member = snapshot?.members?.find((row) => row.id === snapshot.profile?.id);
        if (!snapshot) return '<div class="tefr-empty">Enter a Public-access Torn key to load your Elimination comparison.</div>';
        if (!member) return '<div class="tefr-notice warn">Your personal event data loaded, but your exact faction row is unavailable.</div>';
        if (!visibleMembers([member], runtime.config.showNonParticipants).length) {
            return '<div class="tefr-notice">Your status is Not Participating. '
                + 'Use Show Not Participating to view your personal card.</div>';
        }
        const movement = rankMovement(member);
        const comparison = runtime.config.rankScope === "faction"
            ? snapshot.members.filter((row) => row.factionId === member.factionId) : snapshot.members;
        const index = comparison.findIndex((row) => row.id === member.id);
        const above = index > 0 ? comparison[index - 1] : null;
        const below = index < comparison.length - 1 ? comparison[index + 1] : null;
        const teamTotal = snapshot.members.filter((row) =>
            teamKey(row) === teamKey(member)).length;
        const neighbor = (label, other, ahead) => other
            && !visibleMembers([other], runtime.config.showNonParticipants).length
            ? '<div><small>' + label + '</small><b>Not Participating (hidden)</b></div>'
            : other
            ? '<div><small>' + label + ": " + escapeHtml(other.name) + '</small><b>'
                + (ahead ? formatNumber(other.score - member.score) : formatNumber(member.score - other.score))
                + ' score / ' + (ahead ? formatNumber(other.attacks - member.attacks)
                    : formatNumber(member.attacks - other.attacks)) + " attacks</b></div>"
            : '<div><small>' + label + '</small><b>-</b></div>';
        return '<section class="tefr-personal"><div class="tefr-rank-badge">'
            + ordinal(displayRank(member)) + '</div><div class="tefr-personal-main"><small>'
            + rankLabel() + ' · ' + displayRank(member) + " of " + comparison.length + '</small><h3>'
            + escapeHtml(member.name) + '</h3><span class="tefr-team-dot" style="background:'
            + teamColor(teamKey(member)) + '"></span>' + escapeHtml(member.teamName)
            + '<small>' + escapeHtml(factionLabel(member)) + '</small>'
            + '<small>Faction Rank: ' + ordinal(member.factionRank) + ' / '
            + (member.sourceFactionSize || snapshot.members.length)
            + ' · Alliance Rank: ' + ordinal(member.allianceRank ?? member.factionRank)
            + ' / ' + snapshot.members.length + '</small>'
            + '</div><div class="tefr-stat"><small>Score</small><b>' + formatNumber(member.score)
            + '</b></div><div class="tefr-stat"><small>Attacks</small><b>' + formatNumber(member.attacks)
            + '</b></div><div class="tefr-stat"><small>Team place</small><b>'
            + (member.teamRank ? ordinal(member.teamRank) + " / " + teamTotal : "-")
            + '</b></div><div class="tefr-stat"><small>Movement</small><b class="'
            + movement.tone + '">' + movement.label + '</b></div><div class="tefr-neighbors">'
            + neighbor("Member above", above, true) + neighbor("Member below", below, false)
            + '</div><div class="tefr-personal-chart">' + rankSparkline(member.id) + "</div></section>";
    }

    function overviewTeamTotals(team, members, ownFactionId) {
        const totals = {
            factionScore: 0, factionAttacks: 0, factionMembers: 0,
            allianceScore: 0, allianceAttacks: 0, allianceMembers: 0
        };
        const key = team.key || teamKey(team);
        members.forEach((member) => {
            if (!member.participating || teamKey(member) !== key) return;
            totals.allianceScore += number(member.score);
            totals.allianceAttacks += number(member.attacks);
            totals.allianceMembers += 1;
            if (nullableNumber(member.factionId) === nullableNumber(ownFactionId)) {
                totals.factionScore += number(member.score);
                totals.factionAttacks += number(member.attacks);
                totals.factionMembers += 1;
            }
        });
        return totals;
    }

    function teamCards() {
        const teams = runtime.snapshot?.teams || [];
        const members = runtime.snapshot?.members || [];
        const ownFactionId = runtime.snapshot?.factions?.find((faction) => faction.own)?.id
            ?? members.find((member) => member.id === runtime.snapshot?.profile?.id)?.factionId;
        return '<div class="tefr-team-grid">' + teams.map((team) => {
            const totals = overviewTeamTotals(team, members, ownFactionId);
            return '<article class="tefr-team-card" style="--team:' + teamColor(team.id)
            + '"><header><span class="tefr-team-place">' + (team.position < 999 ? "#" + team.position : "-")
            + '</span><b>' + escapeHtml(team.name) + '</b>'
            + (team.eliminated ? '<em>Eliminated</em>' : "") + '</header><div class="tefr-mini-grid">'
            + '<span><small>Global score</small><b>' + formatNumber(team.score) + '</b></span>'
            + '<span><small>Lives</small><b>' + formatNumber(team.lives) + '</b></span>'
            + '<span><small>Global participants</small><b>' + formatNumber(team.participants) + '</b></span>'
            + '<span><small>Faction Score</small><b>' + formatNumber(totals.factionScore) + '</b></span>'
            + '<span><small>Faction Attacks</small><b>' + formatNumber(totals.factionAttacks) + '</b></span>'
            + '<span><small>Faction Members</small><b>' + formatNumber(totals.factionMembers) + '</b></span>'
            + '<span><small>Alliance Score</small><b>' + formatNumber(totals.allianceScore) + '</b></span>'
            + '<span><small>Alliance Attacks</small><b>' + formatNumber(totals.allianceAttacks) + '</b></span>'
            + '<span><small>Alliance Members</small><b>' + formatNumber(totals.allianceMembers) + '</b></span>'
            + '<span><small>W / L</small><b>' + formatNumber(team.wins) + " / " + formatNumber(team.losses)
            + "</b></span></div></article>";
        }).join("") + "</div>";
    }

    function memberCard(member) {
        const movement = rankMovement(member);
        const state = member.status?.state || member.status?.description || "Unknown";
        const availability = member.availability === "final"
            ? '<span class="tefr-muted">Enrollment closed</span>'
            : member.availability === "fresh" ? ""
            : '<span class="tefr-stale">' + (member.availability === "stale" ? "Stale" : "Unavailable") + "</span>";
        const teamRank = member.teamRank ? ordinal(member.teamRank) : "-";
        return '<article class="tefr-member-card' + (member.id === runtime.snapshot?.profile?.id ? " is-me" : "")
            + '" data-member-card data-search="' + escapeHtml((member.name + " " + member.id).toLowerCase())
            + '" data-team="' + escapeHtml(teamKey(member))
            + '" data-faction="' + (member.factionId ?? "own")
            + '" data-participating="' + (member.participating ? "yes" : "no") + '">'
            + '<div class="tefr-rank-badge" title="' + rankLabel() + '">' + ordinal(displayRank(member)) + '</div>'
            + '<div class="tefr-member-main"><a href="https://www.torn.com/profiles.php?XID='
            + encodeURIComponent(member.id) + '" target="_blank" rel="noopener noreferrer">'
            + escapeHtml(member.name) + " [" + member.id + "]</a><span><i style=\"background:"
            + teamColor(teamKey(member)) + '"></i>' + escapeHtml(member.teamName) + " · Team " + teamRank
            + '</span><span>Faction: ' + escapeHtml(factionLabel(member))
            + (member.factionId ? ' [' + member.factionId + ']' : "")
            + (member.rosterStale ? ' · Roster stale' : "")
            + '</span><span>Alliance Rank: <b>' + ordinal(member.allianceRank ?? member.factionRank)
            + '</b> · Faction Rank: <b>' + ordinal(member.factionRank) + '</b>'
            + "</span></div><div class=\"tefr-member-metrics\"><b>" + formatNumber(member.score)
            + "<small>Score</small></b><b>" + formatNumber(member.attacks)
            + "<small>Attacks</small></b><b class=\"" + movement.tone + "\">" + movement.label
            + "<small>Move</small></b></div>" + availability
            + '<details><summary>Details &amp; hourly rank history</summary><div class="tefr-details-grid">'
            + "<span><small>Faction position</small><b>" + escapeHtml(member.position || "-") + "</b></span>"
            + "<span><small>Faction Rank</small><b>" + ordinal(member.factionRank)
            + " / " + member.sourceFactionSize + "</b></span>"
            + "<span><small>Level</small><b>" + formatNumber(member.level) + "</b></span>"
            + "<span><small>Status</small><b>" + escapeHtml(state) + "</b></span>"
            + "<span><small>Last action</small><b>" + escapeHtml(member.lastAction?.relative || "-") + "</b></span>"
            + "<span><small>Event last checked</small><b>"
            + formatUtc(member.competitionCheckedAt) + "</b></span>"
            + "</div>" + rankSparkline(member.id) + "</details></article>";
    }

    function teamOptions() {
        const teams = runtime.snapshot?.teams || [];
        return '<option value="all">All teams</option>'
            + teams.filter((team) => team.factionMembers).map((team) =>
                '<option value="' + escapeHtml(team.key || teamKey(team)) + '"'
                + (String(runtime.config.team) === (team.key || teamKey(team)) ? " selected" : "")
                + ">" + escapeHtml(team.name) + " (" + team.factionMembers + ")</option>").join("")
            + (runtime.config.showNonParticipants
                ? '<option value="unassigned"' + (runtime.config.team === "unassigned" ? " selected" : "")
                    + ">" + NOT_PARTICIPATING + "</option>" : "");
    }

    function factionOptions() {
        return (runtime.config.rankScope === "faction" ? "" : '<option value="all">All selected factions</option>')
            + (runtime.snapshot?.factions || []).map((faction) => {
                const id = String(faction.id ?? "own");
                return '<option value="' + id + '"' + (runtime.config.faction === id ? " selected" : "")
                    + ">" + escapeHtml(faction.name) + "</option>";
            }).join("");
    }

    function rankingView() {
        const roster = runtime.snapshot?.members || [];
        if (!roster.length) return '<div class="tefr-empty">Faction rankings are not available yet.</div>';
        const members = visibleMembers(roster, runtime.config.showNonParticipants);
        if (runtime.config.rankScope === "faction" && (runtime.config.faction === "all"
            || !(runtime.snapshot?.factions || []).some((faction) => String(faction.id ?? "own") === runtime.config.faction))) {
            runtime.config.faction = String(runtime.snapshot?.factions?.find((faction) => faction.own)?.id ?? "own");
        }
        return rankScopeControl()
            + '<div class="tefr-toolbar"><label><span>Search</span><input data-role="search" type="search" '
            + 'placeholder="Player name or ID" value="' + escapeHtml(runtime.config.search) + '"></label>'
            + '<label><span>Faction</span><select data-role="faction-filter">' + factionOptions() + "</select></label>"
            + '<label><span>Team</span><select data-role="team-filter">' + teamOptions() + "</select></label>"
            + '<label><span>Participation</span><select data-role="participation-filter">'
            + '<option value="all">Everyone</option><option value="yes"'
            + (runtime.config.participation === "yes" ? " selected" : "") + ">Participating</option>"
            + (runtime.config.showNonParticipants
                ? '<option value="no"' + (runtime.config.participation === "no" ? " selected" : "")
                    + ">Not Participating</option>" : "") + "</select></label></div>"
            + '<div class="tefr-result-count" data-role="result-count"></div>'
            + '<div class="tefr-member-list">' + members.map(memberCard).join("") + "</div>"
            + (!members.length ? '<div class="tefr-empty">No participating members yet. '
                + 'Use Show Not Participating to view the roster.</div>' : "");
    }

    function groupedTeamsView() {
        const roster = runtime.snapshot?.members || [];
        if (!roster.length) return '<div class="tefr-empty">Team groups are not available yet.</div>';
        const members = visibleMembers(roster, runtime.config.showNonParticipants);
        if (!members.length) return '<div class="tefr-empty">No participating members yet. '
            + 'Use Show Not Participating to view the roster.</div>';
        const groups = new Map();
        members.forEach((member) => {
            const key = teamKey(member);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(member);
        });
        const order = [...(runtime.snapshot?.teams || [])]
            .map((team) => team.key || teamKey(team))
            .filter((key) => groups.has(key));
        if (groups.has("unassigned")) order.push("unassigned");
        return '<div class="tefr-team-groups">' + order.map((key) => {
            const group = groups.get(key) || [];
            const team = runtime.snapshot?.teams?.find((item) =>
                (item.key || teamKey(item)) === key);
            const name = team?.name || group[0]?.teamName || NOT_PARTICIPATING;
            const score = group.reduce((sum, member) => sum + member.score, 0);
            const attacks = group.reduce((sum, member) => sum + member.attacks, 0);
            return '<section class="tefr-team-group" style="--team:' + teamColor(team?.id ?? key)
                + '"><header><div><span class="tefr-team-dot"></span><b>' + escapeHtml(name)
                + "</b><small>" + group.length + " faction member" + (group.length === 1 ? "" : "s")
                + '</small></div><div><b>' + formatNumber(score) + " score</b><b>"
                + formatNumber(attacks) + " attacks</b></div></header>"
                + '<div class="tefr-member-list">' + group.map(memberCard).join("") + "</div></section>";
        }).join("") + "</div>";
    }

    function largeRankChart(memberId) {
        const points = historyPoints().map((point) => ({
            slot: point.slot,
            rank: pointRank(point, memberId, runtime.config.rankScope)
        })).filter((point) => point.rank !== null);
        if (points.length < 2) return '<div class="tefr-empty">Rank history appears after two hourly updates.</div>';
        const width = 760, height = 240, pad = 34;
        const max = Math.max(1, ...points.map((point) => point.rank));
        const coords = points.map((point, index) => {
            const x = pad + index / Math.max(1, points.length - 1) * (width - pad * 2);
            const y = pad + (point.rank - 1) / Math.max(1, max - 1) * (height - pad * 2);
            return x.toFixed(1) + "," + y.toFixed(1);
        }).join(" ");
        return '<div class="tefr-chart"><svg viewBox="0 0 ' + width + " " + height
            + '" role="img" aria-label="' + rankLabel() + ' history"><path d="M34 18V206H742" '
            + 'stroke="#355269" fill="none"/><polyline points="' + coords
            + '" fill="none" stroke="#55ddb8" stroke-width="4"/></svg></div>'
            + '<div class="tefr-chart-note">Best rank is shown at the top · '
            + formatUtc(points[0].slot) + " to " + formatUtc(points[points.length - 1].slot) + "</div>";
    }

    function trendsView() {
        const roster = runtime.snapshot?.members || [];
        if (!roster.length) return '<div class="tefr-empty">Trend data is not available yet.</div>';
        const members = visibleMembers(roster, runtime.config.showNonParticipants);
        const own = members.find((member) => member.id === runtime.snapshot?.profile?.id);
        const selected = members.some((member) => String(member.id) === String(runtime.config.trendMember))
            ? String(runtime.config.trendMember)
            : String(own?.id || members[0]?.id || "");
        runtime.config.trendMember = selected;
        const options = members.map((member) => '<option value="' + member.id + '"'
            + (String(member.id) === selected ? " selected" : "") + ">"
            + ordinal(displayRank(member)) + " · " + escapeHtml(member.name)
            + " · " + escapeHtml(factionLabel(member)) + "</option>").join("");
        return rankScopeControl() + '<div class="tefr-toolbar"><label><span>Team metric</span><select data-role="metric">'
            + ["score", "lives", "factionScore", "factionAttacks"].map((metric) =>
                '<option value="' + metric + '"' + (runtime.config.metric === metric ? " selected" : "")
                + ">" + metricLabel(metric) + "</option>").join("") + "</select></label>"
            + '<label><span>Rank member</span><select data-role="trend-member"'
            + (!members.length ? " disabled" : "") + ">" + options + "</select></label>"
            + '<label><span>History range</span><select data-role="range">'
            + '<option value="24">24 updates</option><option value="168"'
            + (runtime.config.range === "168" ? " selected" : "") + ">7 days</option>"
            + '<option value="720"' + (runtime.config.range === "720" ? " selected" : "")
            + ">30 days</option><option value=\"all\"" + (runtime.config.range === "all" ? " selected" : "")
            + ">All stored</option></select></label></div>"
            + '<section class="tefr-panel"><h3>' + escapeHtml(metricLabel(runtime.config.metric))
            + " by Elimination team</h3>" + teamTrendChart() + "</section>"
            + '<section class="tefr-panel"><h3>' + rankLabel() + ' history</h3>'
            + (selected ? largeRankChart(selected)
                : '<div class="tefr-empty">No participating members to chart. '
                    + 'Use Show Not Participating to select other members.</div>') + "</section>";
    }

    function overviewView() {
        if (!runtime.snapshot) return '<div class="tefr-empty">No cached snapshot yet. Add your key in Settings.</div>';
        return rankScopeControl() + personalCard()
            + '<section class="tefr-panel"><div class="tefr-panel-heading"><h3>Global team standings</h3>'
            + '<label><span>Chart</span><select data-role="metric">'
            + ["score", "lives", "factionScore", "factionAttacks"].map((metric) =>
                '<option value="' + metric + '"' + (runtime.config.metric === metric ? " selected" : "")
                + ">" + metricLabel(metric) + "</option>").join("") + "</select></label></div>"
            + comparisonBars() + teamCards() + "</section>";
    }

    function settingsView() {
        const factionSetup = '<section class="tefr-panel"><h3>Sister / alliance factions</h3>'
            + '<div class="tefr-key-row"><label><span>Faction IDs (comma-separated)</span>'
            + '<input data-role="allied-faction-ids" type="text" autocomplete="off" spellcheck="false" '
            + 'placeholder="44817" value="' + escapeHtml(runtime.config.alliedFactionIds.join(", "))
            + '"' + (runtime.busy ? " disabled" : "") + '></label>'
            + '<button type="button" data-action="save-factions"' + (runtime.busy ? " disabled" : "")
            + '>Save &amp; refresh</button></div><p>Your faction is always included. '
            + 'Add numeric faction IDs to rank their members alongside yours. '
            + 'Leave blank to return to your faction only. Names and tags are loaded automatically.</p>'
            + '<div class="tefr-settings-grid">' + (runtime.snapshot?.factions || []).map((faction) =>
                '<span><small>' + (faction.own ? 'Your faction' : 'Sister / alliance')
                + ' · ID ' + (faction.id ?? "pending") + '</small><b>'
                + escapeHtml((faction.tag ? "[" + faction.tag + "] " : "") + faction.name)
                + '</b><small>' + faction.memberCount + ' members'
                + (faction.rosterAvailable ? "" : ' · Roster unavailable') + '</small></span>'
            ).join("") + '</div></section>';
        const keySetup = runtime.injectedKey
            ? '<div class="tefr-notice good">TornPDA supplied the Public-access key securely.</div>'
            : '<div class="tefr-key-row"><label><span>Public-access Torn API key</span>'
                + '<input data-role="api-key" type="password" autocomplete="off" spellcheck="false" '
                + 'placeholder="' + (runtime.apiKey ? "Stored key — enter a replacement" : "Paste key") + '"></label>'
                + '<button type="button" data-action="save-key">Save key</button>'
                + (runtime.apiKey ? '<button type="button" class="danger" data-action="clear-key">Clear key</button>' : "")
                + "</div>";
        return '<div class="tefr-settings"><section class="tefr-panel"><h3>API access</h3>'
            + '<div class="tefr-public"><b>Public-access Torn key only</b>'
            + "<span>Limited or Full access is unnecessary.</span></div>" + keySetup
            + '<p>The key is sent only in the Authorization header. It is never shown, logged, included in URLs, '
            + "or stored with ranking history.</p></section>" + factionSetup
            + '<section class="tefr-panel"><h3>Refresh &amp; storage</h3><div class="tefr-settings-grid">'
            + "<span><small>Detected runtime</small><b>" + escapeHtml(detectedRuntime()) + "</b></span>"
            + "<span><small>Storage</small><b>" + escapeHtml(runtime.storageMode) + "</b></span>"
            + "<span><small>Member pacing</small><b>" + MEMBER_CHUNK_SIZE
            + " per chunk · " + Math.round(MEMBER_CHUNK_PAUSE_MS / 1000) + "s pause</b></span>"
            + "<span><small>Enrollment deadline</small><b>10 Sep 2026, 12:00 UTC</b></span>"
            + "<span><small>Final nonparticipant records</small><b>"
            + formatNumber(runtime.snapshot?.retainedMembers || 0) + "</b></span>"
            + "<span><small>Last completed slot</small><b>" + formatUtc(runtime.snapshot?.slot) + "</b></span>"
            + "<span><small>Next scheduled update</small><b data-role=\"next-slot\">"
            + formatUtc(nextSlot(Date.now())) + "</b></span><span><small>Saved hourly updates</small><b>"
            + formatNumber(runtime.history?.points?.length || 0) + "</b></span></div>"
            + '<p>Hidden members remain in every snapshot. They are checked hourly through enrollment '
            + 'and once more after it closes. Confirmed nonparticipants then use their saved event data; '
            + 'new members and failed checks stay in the update queue. Refresh manually to recheck everyone.</p>'
            + '<button type="button" class="danger" data-action="clear-history">Clear rank history</button></section>'
            + '<section class="tefr-panel"><h3>Diagnostics</h3><p>Open the F12 console and filter for '
            + '<code>[TEFR]</code> to inspect sanitized scheduling, API, chunk, team-resolution, and mount events.</p>'
            + '<code>/user/basic</code> <code>/faction/basic</code> '
            + '<code>/faction/{id}/basic</code> <code>/faction/{id}/members</code> '
            + '<code>/user/competition</code> <code>/faction/members</code> '
            + "<code>/user/{id}/competition</code> <code>/torn/elimination</code></section></div>";
    }

    function currentView() {
        if (runtime.config.tab === "ranking") return rankingView();
        if (runtime.config.tab === "teams") return groupedTeamsView();
        if (runtime.config.tab === "trends") return trendsView();
        if (runtime.config.tab === "settings") return settingsView();
        return overviewView();
    }

    function headerStatus() {
        if (runtime.busy && runtime.progress?.total) {
            const percent = Math.round(runtime.progress.done / runtime.progress.total * 100);
            return "Updating " + runtime.progress.done + " / " + runtime.progress.total
                + " · " + percent + "%" + (runtime.progress.label
                    ? " · " + runtime.progress.label : "");
        }
        return runtime.status || (runtime.snapshot ? "Cached data ready." : "Waiting for setup.");
    }

    function rankScopeControl() {
        return '<div class="tefr-panel-heading tefr-result-count" role="group" aria-label="Rank comparison">'
            + ["alliance", "faction"].map((scope) => '<button type="button" data-rank-scope="' + scope
                + '" aria-pressed="' + (runtime.config.rankScope === scope) + '">'
                + (scope === "alliance" ? "Alliance Rank" : "Faction Rank") + "</button>").join("")
            + '<small>Faction Rank compares members within their own faction.</small></div>';
    }

    function visibilityControl() {
        if (!runtime.snapshot) return "";
        const members = runtime.snapshot.members || [];
        const count = members.length - visibleMembers(members).length;
        const showing = runtime.config.showNonParticipants;
        return '<div class="tefr-panel-heading tefr-result-count"><button type="button" data-action="toggle-nonparticipants"'
            + ' aria-pressed="' + showing + '">'
            + (showing ? "Hide " : "Show ") + NOT_PARTICIPATING + " (" + count + ")</button>"
            + '<small>' + count + (showing ? " included" : " hidden")
            + " · Places use all " + members.length + " members.</small></div>";
    }

    function render() {
        if (!runtime.root) return;
        const tabs = [
            ["overview", "Overview"], ["ranking", rankingLabel() + " Ranking"],
            ["teams", "Teams"], ["trends", "Trends"], ["settings", "Settings"]
        ];
        runtime.root.className = "tefr-root"
            + (runtime.config.collapsed ? " is-collapsed" : "")
            + (runtime.busy ? " is-busy" : "");
        const percent = runtime.progress?.total
            ? Math.round(runtime.progress.done / runtime.progress.total * 100) : 0;
        runtime.root.innerHTML = '<header class="tefr-header"><div class="tefr-title">'
            + '<span class="tefr-logo">E</span><div><h2>Elimination Faction Rankings</h2>'
            + '<span class="tefr-status-line">' + (runtime.busy
                ? '<i class="tefr-spinner" aria-hidden="true"></i>' : "")
            + '<span data-role="progress-text" aria-live="polite">'
            + escapeHtml(headerStatus()) + "</span></span></div></div>"
            + '<div class="tefr-header-actions"><span class="tefr-public-badge">Public-access key only</span>'
            + '<button type="button" data-action="refresh"' + (runtime.busy ? " disabled" : "")
            + ' aria-label="Refresh now">Refresh</button><button type="button" data-action="collapse" '
            + 'aria-label="' + (runtime.config.collapsed ? "Expand" : "Collapse") + ' dashboard">'
            + (runtime.config.collapsed ? "Expand" : "Collapse") + "</button></div>"
            + '<div class="tefr-progress' + (runtime.busy && !runtime.progress?.total
                ? " is-indeterminate" : "") + '" role="progressbar" aria-label="Update progress" '
            + 'aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent
            + '"><i data-role="progress-bar" style="width:' + percent
            + '%"></i></div></header><div class="tefr-body">'
            + '<nav class="tefr-tabs" aria-label="Elimination dashboard views">'
            + tabs.map(([id, label]) => '<button type="button" data-tab="' + id + '"'
                + (runtime.config.tab === id ? ' class="active" aria-current="page"' : "")
                + ">" + label + "</button>").join("") + "</nav>" + visibilityControl()
            + (runtime.error ? '<div class="tefr-notice error">' + escapeHtml(runtime.error) + "</div>" : "")
            + (runtime.warning ? '<div class="tefr-notice warn">' + escapeHtml(runtime.warning) + "</div>" : "")
            + '<main class="tefr-view">' + currentView() + "</main></div>";
        bindEvents();
        applyMemberFilters();
        updateNextSlotText();
    }

    function applyMemberFilters() {
        if (!runtime.root || runtime.config.tab !== "ranking") return;
        const query = String(runtime.config.search || "").trim().toLowerCase();
        let shown = 0;
        runtime.root.querySelectorAll("[data-member-card]").forEach((card) => {
            const matches = (!query || card.dataset.search.includes(query))
                && (runtime.config.team === "all" || card.dataset.team === String(runtime.config.team))
                && (runtime.config.faction === "all" || card.dataset.faction === runtime.config.faction)
                && (runtime.config.participation === "all"
                    || card.dataset.participating === runtime.config.participation);
            card.hidden = !matches;
            if (matches) shown += 1;
        });
        const count = runtime.root.querySelector("[data-role='result-count']");
        if (count) count.textContent = shown + " of " + (runtime.snapshot?.members?.length || 0) + " members";
    }

    function bindEvents() {
        runtime.root.querySelectorAll("[data-rank-scope]").forEach((button) => {
            button.addEventListener("click", () => {
                runtime.config.rankScope = button.dataset.rankScope;
                runtime.config.faction = runtime.config.rankScope === "faction"
                    ? String(runtime.snapshot?.factions?.find((faction) => faction.own)?.id ?? "own") : "all";
                void saveConfig();
                render();
            });
        });
        runtime.root.querySelector("[data-action='save-factions']")?.addEventListener("click", async () => {
            if (runtime.busy) return;
            const input = runtime.root.querySelector("[data-role='allied-faction-ids']");
            try {
                runtime.config.alliedFactionIds = parseFactionIds(input.value);
            } catch (error) {
                input.setCustomValidity(error.message);
                input.reportValidity();
                return;
            }
            runtime.config.faction = "all";
            runtime.retryNotBefore = 0;
            await saveConfig();
            await refreshData("manual", slotAtOrBefore(Date.now()));
        });
        runtime.root.querySelector("[data-role='allied-faction-ids']")?.addEventListener("input", (event) => {
            event.target.setCustomValidity("");
        });
        runtime.root.querySelector("[data-action='toggle-nonparticipants']")?.addEventListener("click", () => {
            runtime.config = withNonParticipantVisibility(runtime.config,
                !runtime.config.showNonParticipants);
            void saveConfig();
            render();
        });
        runtime.root.querySelector("[data-action='collapse']")?.addEventListener("click", () => {
            runtime.config.collapsed = !runtime.config.collapsed;
            void saveConfig();
            render();
        });
        runtime.root.querySelector("[data-action='refresh']")?.addEventListener("click", () => {
            void refreshData("manual", slotAtOrBefore(Date.now()));
        });
        runtime.root.querySelectorAll("[data-tab]").forEach((button) => {
            button.addEventListener("click", () => {
                runtime.config.tab = button.dataset.tab;
                void saveConfig();
                render();
            });
        });
        const search = runtime.root.querySelector("[data-role='search']");
        search?.addEventListener("input", () => {
            runtime.config.search = search.value;
            applyMemberFilters();
        });
        search?.addEventListener("change", () => void saveConfig());
        [["team-filter", "team"], ["participation-filter", "participation"], ["faction-filter", "faction"]].forEach(([role, key]) => {
            runtime.root.querySelector("[data-role='" + role + "']")?.addEventListener("change", (event) => {
                runtime.config[key] = event.target.value;
                void saveConfig();
                applyMemberFilters();
            });
        });
        runtime.root.querySelectorAll("[data-role='metric']").forEach((select) => {
            select.addEventListener("change", () => {
                runtime.config.metric = select.value;
                void saveConfig();
                render();
            });
        });
        [["trend-member", "trendMember"], ["range", "range"]].forEach(([role, key]) => {
            runtime.root.querySelector("[data-role='" + role + "']")?.addEventListener("change", (event) => {
                runtime.config[key] = event.target.value;
                void saveConfig();
                render();
            });
        });
        runtime.root.querySelector("[data-action='save-key']")?.addEventListener("click", async () => {
            const input = runtime.root.querySelector("[data-role='api-key']");
            const key = String(input?.value || "").trim();
            if (!key) return;
            runtime.apiKey = key;
            runtime.retryNotBefore = 0;
            await legacySet(STORAGE.key, key);
            input.value = "";
            runtime.error = "";
            render();
            void catchUpRefresh("key setup");
        });
        runtime.root.querySelector("[data-action='clear-key']")?.addEventListener("click", async () => {
            runtime.apiKey = "";
            await legacyDelete(STORAGE.key);
            runtime.status = "Stored key cleared.";
            render();
        });
        runtime.root.querySelector("[data-action='clear-history']")?.addEventListener("click", async () => {
            if (!window.confirm("Clear all stored Elimination rank history?")) return;
            runtime.history = { eventKey: runtime.snapshot?.eventKey || "", points: [] };
            await persistValues({ [STORAGE.history]: runtime.history });
            runtime.status = "Rank history cleared.";
            render();
        });
    }

    function updateNextSlotText() {
        const node = runtime.root?.querySelector("[data-role='next-slot']");
        if (node) node.textContent = formatUtc(nextSlot(Date.now()));
    }

    function scheduleNextRefresh() {
        clearTimeout(runtime.scheduleTimer);
        const due = nextSlot(Date.now());
        infoLog("Next refresh scheduled", {
            due: formatUtc(due), delayMs: Math.max(0, due - Date.now())
        });
        runtime.scheduleTimer = setTimeout(() => {
            void refreshData("scheduled", due);
        }, Math.max(0, due - Date.now()));
    }

    async function catchUpRefresh(reason = "resume") {
        const target = slotAtOrBefore(Date.now());
        const latest = Math.max(number(runtime.snapshot?.slot), number(runtime.config.lastCheckedSlot));
        const scopeChanged = runtime.config.lastCheckedFactionIds !== runtime.config.alliedFactionIds.join(",");
        if ((runtime.injectedKey || runtime.apiKey) && (latest < target || scopeChanged)
            && !runtime.busy && Date.now() >= runtime.retryNotBefore) {
            infoLog("Catch-up refresh required", {
                reason, target: formatUtc(target), latest: formatUtc(latest)
            });
            await refreshData(reason, target);
        }
    }

    const STYLE = `
@keyframes tefr-spin{to{transform:rotate(360deg)}}@keyframes tefr-progress-move{0%{transform:translateX(-120%)}100%{transform:translateX(330%)}}
.tefr-status-line{display:flex!important;align-items:center;gap:6px;min-width:0}.tefr-spinner{display:inline-block;flex:0 0 auto;width:12px;height:12px;border:2px solid #426173;border-top-color:var(--accent);border-radius:50%;animation:tefr-spin .75s linear infinite}.tefr-progress{height:4px!important}.tefr-progress i{background:linear-gradient(90deg,#37ba98,var(--accent),#8af1d7)!important}.tefr-progress.is-indeterminate i{width:28%!important;animation:tefr-progress-move 1.1s linear infinite}
#tefr-root{--bg:#101820;--panel:#17242e;--panel2:#1d2e3a;--line:#2c4353;--text:#e8f0f5;--muted:#9fb1bd;--accent:#55ddb8;--bad:#ff8585;--warn:#f6c85f;display:block;align-self:flex-start;flex:0 0 auto;width:100%;max-width:100%;min-width:0;min-height:0;height:auto;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;margin:10px 0;font:12px/1.35 Arial,sans-serif;overflow:hidden;box-sizing:border-box}
#tefr-root *{box-sizing:border-box}#tefr-root button,#tefr-root input,#tefr-root select{font:inherit}
.tefr-header{display:flex;position:relative;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;background:linear-gradient(135deg,#182a35,#101820)}.tefr-title{display:flex;align-items:center;gap:8px;min-width:0}.tefr-logo{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--accent);color:#0b171d;font-size:18px;font-weight:900}.tefr-title h2{font-size:14px;margin:0}.tefr-title span:not(.tefr-logo){color:var(--muted);font-size:11px;display:block;white-space:normal}.tefr-header-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}.tefr-public-badge,.tefr-public b{color:#092019;background:var(--accent);border-radius:999px;padding:4px 8px;font-weight:800}.tefr-root button{min-height:34px;border:1px solid var(--line);border-radius:6px;padding:5px 9px;background:#223744;color:var(--text);cursor:pointer}.tefr-root button:hover,.tefr-root button:focus-visible{border-color:var(--accent)}.tefr-root button:disabled{opacity:.55;cursor:wait}.tefr-progress{position:absolute;bottom:0;left:0;right:0;height:2px;background:#20323d}.tefr-progress i{display:block;height:100%;background:var(--accent);transition:width .2s}
.tefr-body,.tefr-view{min-height:0}.tefr-body{padding:8px}.is-collapsed .tefr-body{display:none}.tefr-tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:5px;margin-bottom:8px}.tefr-tabs button{white-space:normal;line-height:1.15}.tefr-tabs button.active{background:var(--accent);border-color:var(--accent);color:#092019;font-weight:800}.tefr-notice{padding:7px 9px;margin:7px 0;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:5px;background:var(--panel)}.tefr-notice.warn{border-left-color:var(--warn)}.tefr-notice.error{border-left-color:var(--bad)}.tefr-notice.good{border-left-color:var(--accent)}.tefr-empty{padding:20px;text-align:center;color:var(--muted);background:var(--panel);border-radius:6px}.tefr-muted{color:var(--muted)}
.tefr-panel,.tefr-personal,.tefr-team-card,.tefr-member-card,.tefr-team-group{background:var(--panel);border:1px solid var(--line);border-radius:7px}.tefr-panel{padding:9px;margin-top:8px}#tefr-root .tefr-panel h3{position:static!important;height:auto!important;font-size:14px!important;line-height:1.25!important;margin:0 0 7px!important;padding:0!important}.tefr-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.tefr-panel-heading label{display:flex;align-items:center;gap:5px}.tefr-panel-heading label span{color:var(--muted)}
.tefr-personal{display:grid;grid-template-columns:54px minmax(150px,2fr) repeat(4,minmax(62px,1fr));gap:7px;align-items:center;padding:9px;border-color:#3b7669}.tefr-rank-badge{display:grid;place-items:center;align-self:stretch;min-height:42px;border-radius:6px;background:#203b43;color:var(--accent);font-size:16px;font-weight:900}.tefr-personal-main{display:flex;min-width:0;flex-direction:column;justify-content:center;gap:2px}.tefr-personal-main h3{position:static!important;height:auto!important;font-size:15px!important;line-height:1.2!important;margin:0!important;padding:0!important;overflow-wrap:anywhere}.tefr-personal-main small{position:static!important;line-height:1.2!important}.tefr-personal-main>span{display:block;line-height:1.25}.tefr-personal-main small,.tefr-stat small,.tefr-mini-grid small,.tefr-member-metrics small,.tefr-details-grid small,.tefr-settings-grid small{display:block;color:var(--muted);font-size:10px;font-weight:400}.tefr-team-dot,.tefr-member-main i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.tefr-stat{min-width:0}.tefr-stat b{display:block;font-size:14px;overflow-wrap:anywhere}#tefr-root .good{color:var(--accent)!important}#tefr-root .bad{color:var(--bad)!important}.tefr-neighbors{grid-column:2/5;display:grid;grid-template-columns:1fr 1fr;gap:5px}.tefr-neighbors div{padding:5px 7px;background:var(--panel2);border-radius:5px}.tefr-neighbors b{display:block;font-size:11px}.tefr-personal-chart{grid-column:5/7}.tefr-spark{width:100%;height:48px;display:block}
.tefr-team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:8px}.tefr-team-card{border-top:3px solid var(--team);padding:7px}.tefr-team-card header{display:flex;align-items:center;gap:6px;margin-bottom:6px}.tefr-team-card header b{flex:1;overflow-wrap:anywhere}.tefr-team-card header em{color:var(--bad);font-size:10px}.tefr-team-place{font-weight:900;color:var(--team)}.tefr-mini-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.tefr-mini-grid span{background:var(--panel2);border-radius:4px;padding:4px}.tefr-mini-grid b{display:block;font-size:12px}
.tefr-bars{display:grid;gap:4px}.tefr-bar-row{display:grid;grid-template-columns:minmax(75px,130px) 1fr 70px;gap:6px;align-items:center}.tefr-bar-row>span{overflow-wrap:anywhere}.tefr-bar-row>div{height:8px;background:#0d151b;border-radius:99px;overflow:hidden}.tefr-bar-row i{display:block;height:100%;border-radius:99px}.tefr-bar-row>b{text-align:right}.tefr-toolbar{display:grid;grid-template-columns:2fr 1fr 1fr;gap:7px;padding:7px;background:var(--panel);border:1px solid var(--line);border-radius:7px}.tefr-toolbar label,.tefr-key-row label{display:grid;gap:3px;color:var(--muted)}.tefr-root input,.tefr-root select{width:100%;min-height:34px;background:#0f1b23;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:5px 7px}.tefr-result-count{padding:6px 2px;color:var(--muted)}
.tefr-member-list{display:grid;gap:5px}.tefr-member-card{display:grid;grid-template-columns:52px minmax(130px,1fr) minmax(190px,auto) auto;gap:7px;align-items:center;padding:6px}.tefr-member-card.is-me{border-color:var(--accent);box-shadow:inset 3px 0 var(--accent)}.tefr-member-card[hidden]{display:none}.tefr-member-main{min-width:0}.tefr-member-main a{display:block;color:var(--text);font-weight:800;text-decoration:none;overflow-wrap:anywhere}.tefr-member-main span{display:block;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.tefr-member-metrics{display:grid;grid-template-columns:repeat(3,minmax(52px,1fr));gap:4px;text-align:right}.tefr-member-metrics b{font-size:13px}.tefr-stale{color:var(--warn);font-size:10px}.tefr-member-card details{grid-column:2/-1}.tefr-member-card summary{color:var(--muted);cursor:pointer;padding:2px}.tefr-details-grid,.tefr-settings-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:5px 0}.tefr-details-grid span,.tefr-settings-grid span{background:var(--panel2);padding:5px;border-radius:4px}
.tefr-team-groups{display:grid;gap:8px}.tefr-team-group{border-top:3px solid var(--team);padding:7px}.tefr-team-group>header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px}.tefr-team-group>header>div{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.tefr-team-group .tefr-team-dot{background:var(--team);margin:0}.tefr-team-group header small{color:var(--muted)}.tefr-team-group>header>div:last-child b{background:var(--panel2);padding:3px 6px;border-radius:4px}.tefr-chart{width:100%;overflow:hidden}.tefr-chart svg{display:block;width:100%;max-height:280px}.tefr-legend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px}.tefr-legend span{font-size:10px;color:var(--muted)}.tefr-legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}.tefr-chart-note{color:var(--muted);font-size:10px;text-align:center}
.tefr-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.tefr-settings .tefr-panel{margin:0}.tefr-settings .tefr-panel:last-child{grid-column:1/-1}.tefr-public{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}.tefr-public span,.tefr-settings p{color:var(--muted)}.tefr-key-row{display:grid;grid-template-columns:minmax(160px,1fr) auto auto;gap:6px;align-items:end}.tefr-root button.danger{border-color:#7c4545;color:#ffabab}.tefr-settings code{display:inline-block;background:#0e1920;color:#b9d6e5;padding:4px 6px;margin:2px;border-radius:4px;overflow-wrap:anywhere}
.tefr-root button[aria-pressed="true"]{background:var(--accent);color:#092019;font-weight:800}.tefr-result-count button{max-width:100%;white-space:normal;overflow-wrap:anywhere}.tefr-settings-grid b{overflow-wrap:anywhere}.tefr-toolbar{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(min-width:701px){.tefr-view{max-height:min(72vh,780px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:2px}}
@media(max-width:700px){.tefr-header{align-items:flex-start}.tefr-public-badge{width:100%;text-align:center;order:3}.tefr-personal{grid-template-columns:48px repeat(2,1fr)}.tefr-personal-main{grid-column:2/4}.tefr-neighbors,.tefr-personal-chart{grid-column:1/-1}.tefr-team-grid,.tefr-settings{grid-template-columns:1fr}.tefr-settings .tefr-panel:last-child{grid-column:auto}.tefr-toolbar{grid-template-columns:1fr}.tefr-member-card{grid-template-columns:48px minmax(0,1fr)}.tefr-member-metrics{grid-column:1/-1;text-align:center}.tefr-member-card details{grid-column:1/-1}.tefr-stale{position:absolute;right:12px}.tefr-member-card{position:relative}.tefr-details-grid,.tefr-settings-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:430px){#tefr-root{margin-left:0;margin-right:0}.tefr-header{display:grid}.tefr-header-actions{justify-content:flex-start}.tefr-mini-grid{grid-template-columns:repeat(2,1fr)}.tefr-key-row{grid-template-columns:1fr 1fr}.tefr-key-row label{grid-column:1/-1}.tefr-bar-row{grid-template-columns:76px 1fr 52px}.tefr-team-group>header{align-items:flex-start;flex-direction:column}}
@supports(padding:max(0px)){.tefr-body{padding-left:max(8px,env(safe-area-inset-left));padding-right:max(8px,env(safe-area-inset-right))}}
`;

    function injectStyle(doc) {
        if (doc.getElementById("tefr-style")) return;
        const style = doc.createElement("style");
        style.id = "tefr-style";
        style.textContent = STYLE;
        doc.head.appendChild(style);
    }

    function mountPoint(doc) {
        const main = doc.querySelector("#mainContainer");
        if (!main) return null;
        const content = main.querySelector(":scope > .content-wrapper")
            || main.querySelector(".content-wrapper");
        if (!content) return null;
        const host = content.querySelector("#factions") || content;
        const before = host.querySelector(":scope > .ui-tabs-panel")
            || host.querySelector(":scope > #faction-main")
            || null;
        return { host, before };
    }

    function mount(doc = document) {
        injectStyle(doc);
        const point = mountPoint(doc);
        if (!point) return false;
        const { host, before } = point;
        let root = doc.getElementById(ROOT_ID);
        if (!root) {
            root = doc.createElement("section");
            root.id = ROOT_ID;
            root.setAttribute("aria-label", "Elimination faction rankings");
        }
        const positioned = root.parentElement === host
            && (!before || root.nextElementSibling === before);
        if (!positioned) {
            host.insertBefore(root, before);
            infoLog("Dashboard mounted", {
                host: host.id || host.className || host.tagName,
                before: before?.id || before?.className || null
            });
        }
        runtime.root = root;
        render();
        return true;
    }

    async function bootstrap(win) {
        if (win.top !== win || win.__TEFR_BOOTSTRAPPED__) return;
        win.__TEFR_BOOTSTRAPPED__ = true;
        await loadPersistentState();
        mount(win.document);
        scheduleNextRefresh();
        clearInterval(runtime.tickTimer);
        runtime.tickTimer = setInterval(updateNextSlotText, 30000);
        win.document.addEventListener("visibilitychange", () => {
            if (win.document.visibilityState === "visible") {
                mount(win.document);
                void catchUpRefresh("resume");
            }
        });
        runtime.mountObserver = new MutationObserver(() => {
            const point = mountPoint(win.document);
            const root = win.document.getElementById(ROOT_ID);
            if (point && (!root || root.parentElement !== point.host
                || point.before && root.nextElementSibling !== point.before)) {
                mount(win.document);
            }
        });
        runtime.mountObserver.observe(win.document.body, { childList: true, subtree: true });
        await catchUpRefresh("catch-up");
    }

    return {
        VERSION, REQUEST_GAP_MS, MEMBER_CHUNK_SIZE, MEMBER_CHUNK_PAUSE_MS, ENROLLMENT_END_MS,
        ordinal, slotAtOrBefore, nextSlot,
        normalizeCompetition, normalizeMember, memberPerformanceCompare,
        memberNeedsRefresh, priorMember, visibleMembers, withNonParticipantVisibility,
        parseFactionIds, normalizeFaction, factionLabel, mergeFactionRosters,
        pointRank,
        normalizedTeamName, isNonParticipatingTeam, teamKey, resolveMemberTeams,
        rankMembers, normalizeGlobalTeam, aggregateTeams, eventKey,
        buildHistoryPoint, upsertHistory, previousHistoryPoint,
        safeApiMessage, detectedRuntime, bootstrap
    };
});
