import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit development-only refresh of the generated, public identity seed.
const root = path.dirname(fileURLToPath(import.meta.url));
const response = await fetch("https://ultimata.net/api/eliminationteams");
if (!response.ok) throw new Error("Ultimata directory unavailable");
const summary = await response.json();
if (!Array.isArray(summary.teams) || summary.teams.length !== 12) throw new Error("Unexpected team directory");
const teams = [];
const ids = new Set();
for (const item of summary.teams) {
    if (!/^[a-z-]+$/.test(item.slug)) throw new Error("Invalid team slug");
    const result = await fetch("https://ultimata.net/api/eliminationteams/" + item.slug);
    if (!result.ok) throw new Error("Team feed unavailable");
    const data = await result.json();
    if (!Array.isArray(data.members) || data.members.length !== item.known_members
        || !Number.isSafeInteger(data.team?.id)) throw new Error("Incomplete team feed");
    const rows = data.members.map(p => {
        if (!Number.isSafeInteger(p.player_id) || p.player_id <= 0 || ids.has(p.player_id))
            throw new Error("Invalid or duplicate player");
        ids.add(p.player_id);
        return [p.player_id, String(p.player_name), p.level, p.score, p.attacks,
            Number.isFinite(Date.parse(p.last_updated)) ? Date.parse(p.last_updated) : null];
    });
    teams.push({ id: data.team.id, name: data.team.name, rows });
    await new Promise(resolve => setTimeout(resolve, 1200));
}
const seed = { year: new Date().getUTCFullYear(), fetchedAt: Date.now(), teams };
const target = path.join(root, "Torn Elimination Faction Rankings.user.js");
const source = await fs.readFile(target, "utf8");
const pattern = /    \/\/ BEGIN GENERATED COMPETITION SEED[\s\S]*?    \/\/ END GENERATED COMPETITION SEED/;
if (!pattern.test(source)) throw new Error("Seed markers missing");
const encoded = JSON.stringify(seed).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const replacement = "    // BEGIN GENERATED COMPETITION SEED\n    const COMPETITION_SEED = " + encoded
    + ";\n    // END GENERATED COMPETITION SEED";
await fs.writeFile(target, source.replace(pattern, () => replacement));
console.log(JSON.stringify({ teams: teams.length, uniquePlayers: ids.size, seedBytes: Buffer.byteLength(encoded) }));
