import { describe, expect, it } from 'vitest';
import { totalProbabilities, evPerUnit, probOver, matchKey } from '../model';

describe('discrete market settlement', () => {
  it('reserves whole-number probability for pushes rather than under wins', () => {
    const p = totalProbabilities(130, 10, 130)!;
    expect(p.over).toBeCloseTo(p.under, 7);
    expect(p.push).toBeGreaterThan(0.039);
    expect(p.over + p.under + p.push).toBeCloseTo(1, 12);
    expect(evPerUnit(p.over, 100, p.push)).toBeCloseTo(0, 7);
  });
  it('half-point markets have no push probability', () => {
    const p = totalProbabilities(130.5, 10, 130.5)!;
    expect(p.over).toBeCloseTo(0.5, 7);
    expect(p.push).toBeCloseTo(0, 7);
  });
  it('rejects nonfinite model inputs', () => {
    expect(probOver(NaN, 10, 130)).toBeNull();
    expect(probOver(130, Infinity, 130)).toBeNull();
  });
  it('preserves repeated daily meetings with distinct timestamps', () => {
    const game = { date: '2026-09-10T10:05:00Z', player1: 'A', player2: 'B', score1: 65, score2: 67 };
    expect(matchKey(game)).not.toBe(matchKey({ ...game, date: '2026-09-10T11:05:00Z' }));
  });
});
