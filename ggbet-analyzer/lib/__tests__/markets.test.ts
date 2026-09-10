import {describe,it,expect} from 'vitest';
import {spreadProbabilities,matchupHistory} from '../model';
describe('spread settlement',()=>{
 it('accounts for pushes and conserves probability',()=>{const p=spreadProbabilities(3,10,-3)!;expect(p.cover+p.other+p.push).toBeCloseTo(1);expect(p.push).toBeGreaterThan(0);expect(p.cover).toBeCloseTo(p.other);});
 it('reverses sides and has no half-line push',()=>{const a=spreadProbabilities(5,12,-3.5)!;const b=spreadProbabilities(-5,12,3.5)!;expect(a.cover).toBeCloseTo(b.other);expect(a.push).toBeCloseTo(0);expect(a.cover).toBeGreaterThan(.5);});
 it('rejects invalid lines',()=>{for(const line of ['', 'abc', -3.25])expect(spreadProbabilities(0,10,line)).toBeNull();});
});
describe('H2H evidence',()=>{
 it('deduplicates reversed games and excludes future and old data',()=>{const now=Date.parse('2026-09-10');const m={id:'1',date:'2026-09-09',player1:'A',player2:'B',score1:60,score2:70,total:999};const h=matchupHistory('A','B',[m,{...m,player1:'B',player2:'A',score1:70,score2:60},{...m,date:'2027-01-01'},{...m,date:'2020-01-01'}],now);expect(h.games).toHaveLength(1);expect(h.mean).toBe(130);expect(h.weight).toBe(0);});
});
