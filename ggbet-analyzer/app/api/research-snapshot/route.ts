import { NextResponse } from 'next/server';
export const dynamic='force-dynamic';
export async function GET(){
 try{
  const res=await fetch('https://raw.githubusercontent.com/joeydd032995-pixel/spec-journey-gg/research-data/latest.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!res.ok)return NextResponse.json({error:'Scheduled research has not produced a successful snapshot yet.'},{status:503});
  const data=await res.json();
  if(!Array.isArray(data.walkforward)||!Array.isArray(data.players)||!Array.isArray(data.matches))throw new Error('Invalid snapshot');
  return NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Scheduled research unavailable. Existing browser data retained.'},{status:502});}
}
