import {writeFile,mkdir} from 'node:fs/promises';
const token=process.env.BETSAPI_TOKEN;
const ids=(process.env.BETSAPI_TEST_EVENT_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
if(!token||!ids.length||ids.length>10||ids.some(id=>!/^\d+$/.test(id)))throw new Error('Configure BETSAPI_TOKEN and 1–10 BETSAPI_TEST_EVENT_IDS first.');
async function api(path,params){
 const url=new URL(path,'https://api.b365api.com');url.search=new URLSearchParams({...params,token}).toString();
 let res;try{res=await fetch(url,{signal:AbortSignal.timeout(20000)});}catch{throw new Error('Provider connection failed');}
 if(!res.ok)throw new Error(`Provider HTTP ${res.status}`);
 const data=await res.json();if(Number(data.success)!==1)throw new Error('Provider rejected request; check subscription entitlement.');return data.results;
}
const report=[];
for(const id of ids){
 const events=await api('/v1/event/view',{event_id:id});const event=events?.[0];
 if(!event||String(event.id)!==id||!/h2h.*gg/i.test(event.league?.name||'')){report.push({eventId:id,status:'REJECT',reason:'Event or H2H GG league identity not verified'});continue;}
 const data=await api('/v2/event/odds',{event_id:id,source:'ggbet',odds_market:'1,2,3'});
 const start=Number(event.time);const markets={};
 for(const key of ['18_1','18_2','18_3']){
  const rows=data?.odds?.[key];
  const accepted=Array.isArray(rows)?rows.filter(r=>Number.isFinite(Number(r.add_time))&&Number(r.add_time)<start&&r.ss==null&&r.time_str==null&&['over_od','home_od'].some(f=>Number(r[f])>1)&&['under_od','away_od'].some(f=>Number(r[f])>1)):[];
  const latest=Math.max(0,...accepted.map(r=>Number(r.add_time)));
  markets[key]={prematchRecords:accepted.length,lastObservedSecondsBeforeStart:latest?start-latest:null};
 }
 report.push({eventId:id,league:event.league.name,source:'BetsAPI / GGBet',matchingDirection:data?.stats?.matching_dir??null,markets,status:'CANDIDATE',reason:'Validate history completeness, orientation, exact line and actual start before enabling CLV.'});
}
await mkdir('research-output',{recursive:true});
await writeFile('research-output/odds-coverage.json',JSON.stringify({checkedAt:new Date().toISOString(),events:report},null,2));
console.log('Coverage report created. No raw odds or credentials included.');
