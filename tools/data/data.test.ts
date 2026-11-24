import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const cards = JSON.parse(readFileSync(join(ROOT, 'data', 'cards.json'), 'utf8')).cards as any[];
const rules = JSON.parse(readFileSync(join(ROOT, 'data', 'rules.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'art', 'generated', 'assets.manifest.json'), 'utf8'));
const byId = new Map(cards.map((c) => [c.id, c]));

describe('cards.json', () => {
  it('has unique ids and all 29 Part B cards enabled', () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
    expect(cards).toHaveLength(97);
    expect(cards.every((c) => c.enabled)).toBe(true);
  });

  it('matches the v0.4 workbook for sample cards (IDs preserved through renames)', () => {
    const c = (id: string) => byId.get(id);
    expect(c('BU_DSH').name).toBe('Vesper Ripper');
    expect(c('BU_LS').cost).toEqual({ G: 0, B: 1, R: 2, P: 0, W: 0 });
    expect(c('BU_LS').stats).toEqual({ cyber: 0, psionic: 3, physical: 2 });
    expect(c('EQ_KA').cost).toEqual({ G: 0, B: 0, R: 0, P: 0, W: 1, choice: [['R', 'P'], ['R', 'P']], burnPool: ['R', 'P'] });
    expect(c('EQ_KA').equip.moveCost).toEqual({ G: 0, B: 0, R: 0, P: 0, W: 0, choice: [['R', 'P']] });
    expect(c('PW_EM').cost.burnPool).toEqual(['G', 'B', 'R', 'P']);
    expect(c('TR_GSF').cardType).toBe('Power');
    expect(c('TR_GSF').timing).toBe('Reactive');
    expect(c('PW_RR').timing).toBe('Creation');
    expect(c('BU_DC').protocols).toHaveProperty('Precision');
  });

  it('every battle-deck card has a full cost and every unit has stats', () => {
    for (const c of cards.filter((c) => c.deck === 'battle')) {
      // The five lights, plus optional "pay any" (A) and "pay one of these" (choice) from Change Request 1.
      expect(Object.keys(c.cost).filter((k) => !['A', 'choice', 'burnPool', 'burns'].includes(k)).sort()).toEqual(['B', 'G', 'P', 'R', 'W']);
      if (c.cardType === 'BattleUnit') {
        expect(['Creature', 'Robot', 'Cyborg']).toContain(c.unitType);
        for (const k of ['cyber', 'psionic', 'physical']) {
          expect(typeof c.stats[k] === 'number' || c.stats[k] === 'X').toBe(true);
        }
      }
      if (c.cardType === 'Equipment') expect(c.equip.bonus).toBeGreaterThan(0);
    }
  });

  it('every card has generated art in the manifest', () => {
    for (const c of cards) {
      // New cards without art yet: the client draws a generated face until art is added.
      if (!c.art) {
        expect(String(c.origin), c.id).toMatch(/no art yet|v0\.4/);
        continue;
      }
      const a = manifest.assets[c.art];
      expect(a, c.id).toBeTruthy();
      for (const v of ['sm', 'md', 'lg']) {
        expect(existsSync(join(ROOT, 'art', 'generated', a.variants[v].webp)), `${c.id} ${v}`).toBe(true);
      }
    }
    expect(manifest.assets['backs/battle']).toBeTruthy();
    expect(manifest.assets['backs/resource']).toBeTruthy();
  });
});

describe('starter decks', () => {
  const dir = join(ROOT, 'data', 'decks');
  const lim = rules.deckLimits;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`${f} obeys §A12 / A12-a limits`, () => {
      const deck = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
      const battleN = sum(deck.battle);
      expect(battleN).toBeGreaterThanOrEqual(lim.battle.min);
      expect(battleN).toBeLessThanOrEqual(lim.battle.max);
      let units = 0;
      for (const [id, n] of Object.entries<number>(deck.battle)) {
        const c = byId.get(id);
        expect(c?.deck, id).toBe('battle');
        expect(n).toBeLessThanOrEqual(lim.battle.maxCopies);
        if (c.cardType === 'BattleUnit') units += n;
      }
      expect(units).toBeGreaterThanOrEqual(lim.battle.minBattleUnits);
      const resN = sum(deck.resource);
      expect(resN).toBeGreaterThanOrEqual(lim.resource.min);
      expect(resN).toBeLessThanOrEqual(lim.resource.max);
      let cus = 0;
      for (const [id, n] of Object.entries<number>(deck.resource)) {
        const c = byId.get(id);
        expect(c?.deck, id).toBe('resource');
        if (c.cardType === 'CreationUnit') {
          cus += n;
          expect(n).toBeLessThanOrEqual(lim.resource.maxPerCUType);
        } else expect(n).toBeLessThanOrEqual(lim.resource.maxCopiesNonCU);
      }
      expect(cus).toBeLessThanOrEqual(lim.resource.maxCreationUnits);
    });
  }
});
