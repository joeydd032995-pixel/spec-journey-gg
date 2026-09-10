'use client';
import React, { useEffect, useRef, useState } from 'react';
import { C, SP } from '@/lib/theme';
import { Card, CardHeader, Btn } from '@/components/ui';
import { loadKey, saveKey } from '@/lib/storage';
import { impliedProb, matchKey, wfKey, type Bet, type Player, type MatchResult, type WalkForwardRow } from '@/lib/model';

type Setter<T> = React.Dispatch<React.SetStateAction<T[]>>;
export default function Automation({setPlayers,setMatches,setWf,setBets}: {
 setPlayers:Setter<Player>; setMatches:Setter<MatchResult>; setWf:Setter<WalkForwardRow>; setBets:Setter<Bet>;
}) {
 const [enabled,setEnabled]=useState(false);
 const [ready,setReady]=useState(false);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('Not run yet.');
 const [closeUrl,setCloseUrl]=useState('');
 const active=useRef(false);
 const generation=useRef(0);
 useEffect(()=>{setEnabled(loadKey<string>('ggba:auto-enabled','')==='yes'); setCloseUrl(loadKey('ggba:close-url','')); setMessage(loadKey('ggba:auto-status','Not run yet.'));setReady(true); return ()=>{generation.current++;};},[]);
 useEffect(()=>{if(ready){saveKey('ggba:auto-enabled',enabled?'yes':'no');saveKey('ggba:close-url',closeUrl);}},[ready,enabled,closeUrl]);
 async function run() {
  if(active.current)return;
  active.current=true;setBusy(true); const gen=generation.current;
  try {
   const response=await fetch('/api/research-snapshot',{signal:AbortSignal.timeout(60000)});
   const data=await response.json();
   if(!response.ok)throw new Error(data.error||'League feed unavailable');
   if(!Array.isArray(data.players)||!Array.isArray(data.matches)||!Array.isArray(data.walkforward))throw new Error('Invalid league feed; existing data retained.');
   if(data.walkforward.some((r:WalkForwardRow)=>!r.player1||!r.player2||!Number.isFinite(Date.parse(r.date))||!Number.isFinite(Number(r.actual_total))))throw new Error('Invalid snapshot; existing data retained.');
   if(gen!==generation.current)return;
   setPlayers(prev=>{const m=new Map(prev.map(p=>[p.name.toLowerCase(),p]));data.players.forEach((p:Player)=>m.set(p.name.toLowerCase(),p));return [...m.values()];});
   setMatches(prev=>{const m=new Map(prev.map(r=>[matchKey(r),r]));data.matches.forEach((r:MatchResult)=>m.set(matchKey(r),r));return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date));});
   // Preserve already captured snapshots: a rolling feed must not rewrite earlier inputs.
   setWf(prev=>{const m=new Map(prev.map(r=>[wfKey(r),r]));data.walkforward.forEach((r:WalkForwardRow)=>{if(!m.has(wfKey(r)))m.set(wfKey(r),r);});return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date));});
   let closeStatus='CLV: waiting for a closing-odds feed.';
   if(closeUrl.trim()) {
    try {
     const url=new URL(closeUrl,window.location.origin);
     if(url.origin!==window.location.origin)throw new Error('Closing feed must use a same-site endpoint.');
     const res=await fetch(url,{signal:AbortSignal.timeout(20000)}); const quotes=await res.json();
     if(!res.ok||!Array.isArray(quotes))throw new Error('Closing feed must return a JSON array.');
     // Exact ledger ID, market, line and timestamp required; never match repeated players by name.
     const valid=quotes.filter(q=>typeof q.betId==='string'&&typeof q.source==='string'&&q.source.trim()&&q.isClosing===true&&Number.isFinite(Date.parse(q.capturedAt))&&Number.isFinite(Date.parse(q.startsAt))&&Date.parse(q.capturedAt)<=Date.parse(q.startsAt)&&Date.parse(q.startsAt)<=Date.now()&&Date.parse(q.startsAt)-Date.parse(q.capturedAt)<=5*60000&&impliedProb(q.sideOdds)!=null&&impliedProb(q.otherOdds)!=null);
     if(gen!==generation.current)return;
     setBets(prev=>prev.map(b=>{
      if(b.close_side!==undefined&&b.close_side!=='')return b;
      const q=valid.filter(q=>q.betId===b.id&&q.market===b.bet_type&&String(q.line)===b.line&&Date.parse(q.capturedAt)>=Date.parse(b.timestamp)).sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt))[0];
      return q?{...b,close_side:q.sideOdds,close_other:q.otherOdds,notes:[b.notes,`Closing source: ${q.source}; captured ${q.capturedAt}`].filter(Boolean).join('\n')}:b;
     }));
     closeStatus=`CLV: ${valid.length} valid feed records checked; only exact ledger matches applied.`;
    }catch(e){closeStatus=`CLV blocked: ${(e as Error).message}`;}
   }
   const status=`${new Date().toLocaleString()}: checked ${data.walkforward.length} snapshots. Backtest, O/U diagnostic and in-sample probe refresh from imported data. ${closeStatus}`;
   setMessage(status);saveKey('ggba:auto-status',status);
  }catch(e){if(gen===generation.current)setMessage(`Import failed: ${(e as Error).message}. Retry on next run; existing data retained.`);}
  finally{active.current=false;if(gen===generation.current)setBusy(false);}
 }
 useEffect(()=>{
  if(!ready||!enabled)return;
  const tick=()=>{if(document.visibilityState==='visible')void run();};
  tick(); const timer=setInterval(tick,5*60000);document.addEventListener('visibilitychange',tick);
  return ()=>{clearInterval(timer);document.removeEventListener('visibilitychange',tick);};
 // Data setters are stable; editing the feed reschedules the next run.
 },[ready,enabled,closeUrl]);
 return <Card>
  <CardHeader title="Research automation" sub="GitHub collects public league results every 15 minutes, even with your phone closed. This page checks for the latest successful snapshot every five minutes while visible. Scheduled jobs may be delayed." />
  <div style={{display:'flex',gap:SP.md,flexWrap:'wrap',alignItems:'center'}}>
   <label style={{fontSize:14}}><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> Auto-refresh research</label>
   <Btn onClick={()=>void run()} disabled={busy}>{busy?'Refreshing…':'Run now'}</Btn>
  </div>
  <p role="status" style={{fontSize:14,color:C.muted,lineHeight:1.6}}>{message}</p>
  <details><summary style={{cursor:'pointer',fontSize:14}}>Closing line value · feed setup</summary>
   <p style={{fontSize:14,color:C.muted}}>The league results feed has no verified closing odds. CLV updates automatically when a compatible same-site closing-odds endpoint is connected. Existing manual closes are preserved. The GitHub research schedule does not guarantee last-second odds capture.</p>
   <label style={{fontSize:14}}>Closing-odds endpoint<input aria-label="Closing-odds endpoint" value={closeUrl} onChange={e=>setCloseUrl(e.target.value)} placeholder="/api/closing-odds" style={{display:'block',width:'100%',background:C.surface,color:C.text,border:`1px solid ${C.border}`,padding:12,marginTop:8}}/></label>
   <p style={{fontSize:14,color:C.muted}}>Feed records must identify the ledger bet, exact market and selection line, source, both American odds, event start and a closing capture within five minutes before start.</p>
  </details>
  <p style={{fontSize:14,color:C.muted}}>Walk-forward diagnostics are recalculated automatically; in-sample probing stays exploratory and never changes your model settings. O/U calibration currently tests hypothetical lines, not historical market odds.</p>
 </Card>;
}
