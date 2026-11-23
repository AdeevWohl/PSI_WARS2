/**
 * Balance overlays (build prompt §13): a small JSON file layered over cards.json by the card
 * editor, the simulator, local games and online rooms. Only balance values may change — costs,
 * strengths, Equipment bonuses, numeric/option ability parameters, rules text and whether a card
 * is enabled. Identity (id, name, type, which abilities a card has) never changes, so an overlay
 * from a stranger can be loaded safely: anything else is dropped with a message.
 */
import type { CardDef, Cost, EffectSpec, Stats, StatValue } from './types';

export const BALANCE_FORMAT = 'psi-wars-balance';

export interface CardOverlay {
  cost?: Cost;
  stats?: Stats;
  equip?: CardDef['equip'];
  effects?: EffectSpec[];
  text?: string;
  enabled?: boolean;
}

export interface BalanceFile {
  format?: typeof BALANCE_FORMAT;
  version?: 1;
  name: string;
  notes?: string;
  cards: Record<string, CardOverlay>;
}

/** Allowed values for string ability parameters, by parameter name. */
export const PARAM_OPTIONS: Record<string, string[]> = {
  die: ['red', 'green', 'blue'],
  stat: ['cyber', 'psionic', 'physical'],
  hasAbility: ['cyber', 'psionic', 'physical'],
  ability: ['cyber', 'psionic', 'physical'],
  unitType: ['Creature', 'Robot', 'Cyborg'],
};

export const LIMITS = { cost: { min: 0, max: 9 }, stat: { min: 0, max: 15 }, bonus: { min: -5, max: 10 }, param: { min: -20, max: 50 }, text: 600 };

const COST_KEYS = ['G', 'B', 'R', 'P', 'W'] as const;
const STAT_KEYS = ['cyber', 'psionic', 'physical'] as const;
const UNIT_TYPES = ['Creature', 'Robot', 'Cyborg'] as const;

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Recursively check edited params against the base params: same keys, same value types. */
function cleanParams(base: Record<string, unknown>, edit: unknown, path: string, errors: string[]): Record<string, unknown> {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    errors.push(`${path}: parameters must be an object.`);
    return structuredClone(base);
  }
  const e = edit as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, bv] of Object.entries(base)) {
    const v = k in e ? e[k] : bv;
    const p = `${path}.${k}`;
    if (typeof bv === 'number') {
      if (isInt(v, LIMITS.param.min, LIMITS.param.max)) out[k] = v;
      else {
        errors.push(`${p}: must be a whole number from ${LIMITS.param.min} to ${LIMITS.param.max}.`);
        out[k] = bv;
      }
    } else if (typeof bv === 'boolean') {
      if (typeof v === 'boolean') out[k] = v;
      else {
        errors.push(`${p}: must be true or false.`);
        out[k] = bv;
      }
    } else if (typeof bv === 'string') {
      const opts = PARAM_OPTIONS[k];
      if (v === bv || (opts && typeof v === 'string' && opts.includes(v) && opts.includes(bv))) out[k] = v;
      else {
        errors.push(`${p}: "${String(v)}" is not allowed${opts ? ` (one of ${opts.join(', ')})` : ' (this parameter is fixed)'}.`);
        out[k] = bv;
      }
    } else if (bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = cleanParams(bv as Record<string, unknown>, v, p, errors);
    } else if (Array.isArray(bv)) {
      // Lists (e.g. allowed unit types) may be re-chosen from the same option set.
      if (Array.isArray(v) && v.every((x) => typeof x === 'string' && (UNIT_TYPES as readonly string[]).includes(x)) && bv.every((x) => (UNIT_TYPES as readonly string[]).includes(x as string))) out[k] = [...new Set(v)];
      else if (!same(v, bv)) {
        errors.push(`${p}: this list is fixed.`);
        out[k] = structuredClone(bv);
      } else out[k] = structuredClone(bv);
    } else out[k] = bv;
  }
  for (const k of Object.keys(e)) if (!(k in base)) errors.push(`${path}.${k}: unknown parameter ignored.`);
  return out;
}

/** Check one card's overlay against its base definition; returns the cleaned overlay (changed fields only). */
export function cleanCardOverlay(base: CardDef, edit: unknown, errors: string[]): CardOverlay {
  const name = base.name;
  const out: CardOverlay = {};
  if (!edit || typeof edit !== 'object') {
    errors.push(`${name}: overlay must be an object.`);
    return out;
  }
  const e = edit as Record<string, unknown>;
  const known = new Set(['cost', 'stats', 'equip', 'effects', 'text', 'enabled']);
  for (const k of Object.keys(e)) if (!known.has(k)) errors.push(`${name}: "${k}" cannot be changed by a balance file and was ignored.`);

  if ('cost' in e) {
    if (!base.cost) errors.push(`${name}: has no cost.`);
    else {
      const c = e.cost as Record<string, unknown> | null;
      const cost = { ...base.cost };
      let ok = !!c && typeof c === 'object';
      for (const k of COST_KEYS) {
        if (!ok) break;
        const v = c![k] ?? base.cost[k];
        if (isInt(v, LIMITS.cost.min, LIMITS.cost.max)) cost[k] = v;
        else {
          errors.push(`${name}: cost ${k} must be a whole number from 0 to ${LIMITS.cost.max}.`);
          ok = false;
        }
      }
      if (ok && !same(cost, base.cost)) out.cost = cost;
    }
  }
  if ('stats' in e) {
    if (!base.stats) errors.push(`${name}: has no strengths.`);
    else {
      const st = e.stats as Record<string, unknown> | null;
      const stats = { ...base.stats };
      let ok = !!st && typeof st === 'object';
      for (const k of STAT_KEYS) {
        if (!ok) break;
        const v = (st![k] ?? base.stats[k]) as StatValue;
        if (v === 'X' || isInt(v, LIMITS.stat.min, LIMITS.stat.max)) stats[k] = v;
        else {
          errors.push(`${name}: ${k} must be X or a whole number from 0 to ${LIMITS.stat.max}.`);
          ok = false;
        }
      }
      if (ok && !same(stats, base.stats)) out.stats = stats;
    }
  }
  if ('equip' in e) {
    if (!base.equip) errors.push(`${name}: is not Equipment.`);
    else {
      const q = e.equip as Record<string, unknown> | null;
      const eq = structuredClone(base.equip);
      if (q && typeof q === 'object') {
        if ('bonus' in q) {
          if (isInt(q.bonus, LIMITS.bonus.min, LIMITS.bonus.max)) eq.bonus = q.bonus;
          else errors.push(`${name}: Equipment bonus must be a whole number from ${LIMITS.bonus.min} to ${LIMITS.bonus.max}.`);
        }
        if ('ability' in q) {
          if ((STAT_KEYS as readonly unknown[]).includes(q.ability)) eq.ability = q.ability as typeof eq.ability;
          else errors.push(`${name}: Equipment ability must be cyber, psionic or physical.`);
        }
        if ('allowed' in q) {
          const a = q.allowed;
          if (Array.isArray(a) && a.length && a.every((x) => (UNIT_TYPES as readonly unknown[]).includes(x))) eq.allowed = [...new Set(a)] as typeof eq.allowed;
          else errors.push(`${name}: Equipment must allow at least one of Creature, Robot, Cyborg.`);
        }
      } else errors.push(`${name}: equip must be an object.`);
      if (!same(eq, base.equip)) out.equip = eq;
    }
  }
  if ('effects' in e) {
    const list = e.effects;
    if (!Array.isArray(list) || list.length !== base.effects.length) errors.push(`${name}: the list of abilities cannot change (only their values).`);
    else {
      const effects = base.effects.map((be, i) => {
        const ee = list[i] as Partial<EffectSpec> | undefined;
        if (!ee || ee.effect !== be.effect || ee.trigger !== be.trigger) {
          errors.push(`${name}: ability ${i + 1} must stay ${be.effect} (${be.trigger}).`);
          return structuredClone(be);
        }
        return { ...be, params: cleanParams(be.params, ee.params, `${name} ${be.effect}`, errors) };
      });
      if (!same(effects, base.effects)) out.effects = effects;
    }
  }
  if ('text' in e) {
    if (typeof e.text === 'string' && e.text.length <= LIMITS.text) {
      if (e.text !== base.text) out.text = e.text;
    } else errors.push(`${name}: rules text must be at most ${LIMITS.text} characters.`);
  }
  if ('enabled' in e) {
    if (typeof e.enabled === 'boolean') {
      if (e.enabled !== base.enabled) out.enabled = e.enabled;
    } else errors.push(`${name}: enabled must be true or false.`);
  }
  return out;
}

/**
 * Validate a balance file (from the editor, a download or the network) against cards.json.
 * Returns a cleaned file that only contains real changes, plus human-readable problems.
 */
export function cleanBalance(baseCards: { cards: CardDef[] }, raw: unknown): { balance: BalanceFile; errors: string[] } {
  const errors: string[] = [];
  const empty: BalanceFile = { format: BALANCE_FORMAT, version: 1, name: 'Custom balance', cards: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { balance: empty, errors: ['Not a balance file (expected a JSON object).'] };
  const r = raw as Record<string, unknown>;
  if (r.format !== undefined && r.format !== BALANCE_FORMAT) return { balance: empty, errors: [`Unknown format "${String(r.format)}".`] };
  const byId = new Map(baseCards.cards.map((c) => [c.id, c] as const));
  const cards: Record<string, CardOverlay> = {};
  const src = r.cards && typeof r.cards === 'object' ? (r.cards as Record<string, unknown>) : {};
  if (!r.cards) errors.push('No "cards" section: nothing to apply.');
  for (const [id, o] of Object.entries(src)) {
    const base = byId.get(id);
    if (!base) {
      errors.push(`Unknown card "${id}" ignored.`);
      continue;
    }
    const c = cleanCardOverlay(base, o, errors);
    if (Object.keys(c).length) cards[id] = c;
  }
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : 'Custom balance';
  const notes = typeof r.notes === 'string' ? r.notes.slice(0, 2000) : undefined;
  return { balance: { format: BALANCE_FORMAT, version: 1, name, ...(notes ? { notes } : {}), cards }, errors };
}

/** The overlay that turns `base` into `edited` (changed fields only) — what the editor saves. */
export function diffCard(base: CardDef, edited: CardDef): CardOverlay {
  const o: CardOverlay = {};
  if (edited.cost && !same(edited.cost, base.cost)) o.cost = structuredClone(edited.cost);
  if (edited.stats && !same(edited.stats, base.stats)) o.stats = structuredClone(edited.stats);
  if (edited.equip && !same(edited.equip, base.equip)) o.equip = structuredClone(edited.equip);
  if (!same(edited.effects, base.effects)) o.effects = structuredClone(edited.effects);
  if (edited.text !== base.text) o.text = edited.text;
  if (edited.enabled !== base.enabled) o.enabled = edited.enabled;
  return o;
}

/** A short human summary of an overlay, e.g. "cost B2→B1; physical 2→3". */
export function describeOverlay(base: CardDef, o: CardOverlay): string[] {
  const out: string[] = [];
  if (o.cost && base.cost) for (const k of COST_KEYS) if (o.cost[k] !== base.cost[k]) out.push(`cost ${k} ${base.cost[k]}→${o.cost[k]}`);
  if (o.stats && base.stats) for (const k of STAT_KEYS) if (o.stats[k] !== base.stats[k]) out.push(`${k} ${base.stats[k]}→${o.stats[k]}`);
  if (o.equip && base.equip) {
    if (o.equip.bonus !== base.equip.bonus) out.push(`bonus +${base.equip.bonus}→+${o.equip.bonus}`);
    if (o.equip.ability !== base.equip.ability) out.push(`ability ${base.equip.ability}→${o.equip.ability}`);
    if (!same(o.equip.allowed, base.equip.allowed)) out.push(`allowed ${base.equip.allowed.join('/')}→${o.equip.allowed.join('/')}`);
  }
  if (o.effects) out.push('ability values');
  if (o.text !== undefined) out.push('text');
  if (o.enabled !== undefined) out.push(o.enabled ? 'enabled' : 'disabled');
  return out;
}
