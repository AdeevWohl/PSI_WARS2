import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDefs, type RulesData } from '@psi-wars/engine';
import { canAdd, deckCounts, exportDeckJson, parseDeckImport } from '../src/deck-io';

const ROOT = resolve(__dirname, '..', '..', '..');
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const defs = buildDefs(read('data/cards.json'));
const rules: RulesData = read('data/rules.json');
const creature = { id: 'creature-commander', ...read('data/decks/creature-commander.json') };
let n = 0;
const id = () => `id${n++}`;

describe('deck import / export', () => {
  it('round-trips a starter deck as a legal deck', () => {
    const r = parseDeckImport(exportDeckJson(creature), defs, rules, id);
    expect(r.errors).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.deck!.battle).toEqual(Object.fromEntries(Object.entries(creature.battle).sort(([a], [b]) => a.localeCompare(b))));
  });
  it('rejects non-JSON and foreign formats', () => {
    expect(parseDeckImport('not json', defs, rules, id).deck).toBeNull();
    expect(parseDeckImport(JSON.stringify({ format: 'other-game' }), defs, rules, id).deck).toBeNull();
  });
  it('drops unknown cards and reports rule problems without refusing the deck', () => {
    const r = parseDeckImport(JSON.stringify({ name: 'x', battle: { BU_LS: 3, NOPE: 2 }, resource: { CU_NG: 9 } }), defs, rules, id);
    expect(r.deck).not.toBeNull();
    expect(r.errors.join(' ')).toMatch(/NOPE/);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.deck!.battle).toEqual({ BU_LS: 3 });
  });
});

describe('deck limits while building', () => {
  it('caps copies and deck sizes', () => {
    const d = { battle: { BU_LS: 3 }, resource: { CU_NG: 8 } };
    expect(canAdd(defs, rules, d, 'BU_LS')).toMatch(/copies/);
    expect(canAdd(defs, rules, d, 'CU_NG')).toMatch(/Creation Unit type/);
    expect(canAdd(defs, rules, d, 'BU_TS')).toBeNull();
    expect(deckCounts(defs, creature)).toMatchObject({ battle: 30, resource: 23, units: 17, cus: 20 });
  });
});
