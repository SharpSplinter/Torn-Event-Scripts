import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const html = String.raw`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEFR local UI fixture</title>
<style>body{margin:0;background:#20252a;color:#ddd;font:14px sans-serif}header.fixture{padding:18px;background:#111}#mainContainer{max-width:1000px;margin:auto}.content-wrapper{padding:12px}#factions{min-width:0}</style>
<header class="fixture">Torn UI fixture — Actions / Energy / Nerve / Life bars remain above the dashboard</header>
<div id="mainContainer"><div class="content-wrapper"><div id="factions"><div class="ui-tabs-panel">Faction content fixture</div></div></div></div>
<script>
window.GM_getValue=(key,fallback)=>fallback;
window.GM_setValue=()=>{};
if(new URLSearchParams(location.search).has("pda")) {
 const values={};
 window.PDA_storage={loadAll:async()=>({...values}),get:async(k,f)=>values[k]??f,setMany:async(v)=>Object.assign(values,v)};
}
window.GM_xmlhttpRequest=details=>{
 const u=new URL(details.url);
 let data={error:{code:32}};
 if(u.hostname==="api.torn.com"&&u.pathname.endsWith("/elimination")){
  data={elimination:window.fixture.directory.data.teams.map((t,i)=>({...t,score:1000+i*10+Math.floor(Date.now()/3000)%10,lives:100,position:i+1,wins:100+i,losses:10,eliminated:false}))};
 }
 if(u.hostname==="ffscouter.com"){
  if(u.pathname.endsWith("check-key"))data={is_registered:true,is_premium:false};
  else if(u.pathname.endsWith("get-stats"))data=u.searchParams.get("targets").split(",").map(id=>({player_id:Number(id),fair_fight:2.17,bs_estimate:744101542,source:"bss",last_updated:Math.floor(Date.now()/1000)-86400}));
  else if(u.pathname.endsWith("get-stats-history"))data={history:[1,2,3,4].map((n)=>({timestamp:Math.floor(Date.now()/1000)-(5-n)*21600,bs_estimate:n*200000000}))};
  else data={targets:[{player_id:3583932,name:"a1ry",level:50,fair_fight:2.17,bs_estimate:744101542,source:"bss"}]};
 }
 setTimeout(()=>details.onload({status:200,responseText:JSON.stringify(data)}),250);
};
</script><script src="/userscript.js"></script><script>
(async()=>{
 const h=window.fixture;
 await h.loadPersistentState();
 await h.loadCompetition();
 h.runtime.config.tab="competition";
 h.runtime.apiKey="fixture-public-key";
 h.runtime.status="Local preview — fixture data, no live API requests";
 h.directory.team=String(h.directory.data.teams[0].id);
 h.ff.key="fixturekey123456";h.ff.validated=true;
 const first=Object.values(h.directory.data.players).find(p=>p.teamId===Number(h.directory.team));
 h.directory.data.players[first.id]={...first,source:"torn",updatedAt:Date.now(),status:{state:"Hospital",until:Date.now()/1000+120},lastAction:{status:"Online"}};
 h.mount(document);
 setInterval(()=>h.updateHospitalTimers(),1000);
 setInterval(()=>h.refreshLiveTeams(),1000);
 await h.refreshVisibleEstimates();
})();
</script>`;
const server = http.createServer((req,res)=>{
 if(req.url==="/userscript.js"){
  const source=fs.readFileSync(path.join(root,"Torn Elimination Faction Rankings.user.js"),"utf8")
   .replace('if (typeof window !== "undefined" && window.document) void api.bootstrap(window);','window.fixture = api.hooks;')
   .replace("        VERSION, REQUEST_GAP_MS,","        hooks: { runtime, directory, ff, mount, loadPersistentState, loadCompetition, refreshLiveTeams, refreshVisibleEstimates, updateHospitalTimers, render },\n        VERSION, REQUEST_GAP_MS,");
  res.writeHead(200,{"Content-Type":"application/javascript; charset=utf-8"});res.end(source);
 }else{res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(html);}
});
server.listen(8765,"127.0.0.1",()=>console.log("Fixture preview: http://127.0.0.1:8765 (no live API calls)"));
