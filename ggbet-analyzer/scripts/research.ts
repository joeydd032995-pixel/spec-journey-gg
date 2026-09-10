import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fetchFeed } from '../lib/h2hggl';
import { DEFAULT_SETTINGS, makeRatings, wfKey, type WalkForwardRow } from '../lib/model';
const folder = 'research-output';
await mkdir(folder, {recursive:true});
let previous: {walkforward:WalkForwardRow[]} = {walkforward:[]};
try { previous=JSON.parse(await readFile(`${folder}/latest.json`,'utf8')); }
catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Previous research state is corrupt; refusing replacement.'); }
const fresh=await fetchFeed(previous.walkforward.length ? 3 : 90,1);
if(!fresh.walkforward.length || !fresh.players.length)throw new Error('Empty source response; preserving previous state.');
const byKey=new Map(previous.walkforward.map(r=>[wfKey(r),r]));
for(const r of fresh.walkforward){
 if(!Number.isFinite(Date.parse(r.date)) || !Number.isFinite(Number(r.actual_total)))throw new Error('Invalid source row');
 if(!byKey.has(wfKey(r)))byKey.set(wfKey(r),r);
}
// Reconstruct all pre-match snapshots from accumulated results, not rolling-window aggregates.
const {buildWalkforward,aggregatePlayers}=await import('../lib/betsapi');
const games=[...byKey.values()].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)).map(r=>({ts:Date.parse(r.date)/1000,date:r.date,hour_utc:r.hour_utc??'',hp:r.player1,ap:r.player2,ht:r.p1_team,at:r.p2_team,hs:Number(r.score1),as_:Number(r.score2)}));
const wf=buildWalkforward(games);
const ratings=makeRatings(DEFAULT_SETTINGS); const errors:number[]=[];
for(const r of wf){const pred=ratings.predict(r.player1,r.p1_team,r.player2,r.p2_team);
 if(Math.min(r.p1_gp,r.p2_gp)>=10)errors.push(pred.total-r.actual_total);
 ratings.update(r.player1,r.p1_team,r.player2,r.p2_team,r.score1,r.score2);
}
const generatedAt=new Date().toISOString();
const report={generatedAt,modelSettings:DEFAULT_SETTINGS,source:'h2hggl public results',games:wf.length,qualifyingGames:errors.length,mae:errors.length?errors.reduce((a,b)=>a+Math.abs(b),0)/errors.length:null,rmse:errors.length?Math.sqrt(errors.reduce((a,b)=>a+b*b,0)/errors.length):null,calibration:'Exploratory; no verified sportsbook history connected',clv:'Not connected',evaluation:'Retrospective chronological replay, not an immutable prospective prediction archive'};
const players=aggregatePlayers(games).map(p=>({...p,fg_pct:'',steals:'',fouls:''}));
const matches=games.map(g=>({id:`${g.date}:${g.hp}:${g.ap}`,date:g.date,player1:g.hp,player2:g.ap,score1:g.hs,score2:g.as_,total:g.hs+g.as_}));
await writeFile(`${folder}/latest.json`,JSON.stringify({players,matches,walkforward:wf,meta:report}));
await writeFile(`${folder}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({games:wf.length,qualifyingGames:errors.length,generatedAt}));
