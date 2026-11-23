/**
 * Card elements. The supplied art is the card face; we overlay only dynamic information
 * that differs from what is printed (build prompt §5.3).
 */
import { ABILITIES, CU_TYPES, type Ability } from '@psi-wars/shared';
import type { CardDef, Cost, StatValue, UnitStats } from '@psi-wars/engine';
import { artUrl, hasArt, placeholder, type ArtSize } from '../assets';
import { h } from '../ui/dom';

/** Stat box centres on the printed card (fractions of width/height), measured from the art. */
const STAT_POS: Record<Ability, number> = { cyber: 0.263, psionic: 0.5, physical: 0.741 };
const STAT_Y = 0.795;
const COST_Y = [0.069, 0.13, 0.19, 0.251, 0.312];
const ABILITY_NAME: Record<Ability, string> = { cyber: 'Cyber', psionic: 'Psionic', physical: 'Physical' };

export interface CardRenderOpts {
  size?: ArtSize;
  /** Live strengths for units in play (from the engine). */
  stats?: UnitStats;
  /** Always show stat chips, not only when modified (setting). */
  alwaysChips?: boolean;
}

export function backKey(deck: 'battle' | 'resource'): string {
  return `backs/${deck}`;
}

function img(key: string, size: ArtSize, alt: string): HTMLImageElement {
  const el = h('img', { class: 'art', alt, draggable: 'false', decoding: 'async' }) as HTMLImageElement;
  const ph = placeholder(key);
  if (ph) el.style.backgroundImage = `url(${ph})`;
  el.src = artUrl(key, size) ?? '';
  return el;
}

const EMBLEM: Record<string, string> = { Creature: '✦', Robot: '⚙', Cyborg: '⬢', Equipment: '⛨', Power: '⚡', Trap: '⌖', Resource: '◈', CreationUnit: '◉' };

/** Readable card face built from data, for cards whose art has not arrived (§5.3 fallback). */
export function proceduralFace(def: CardDef): HTMLElement {
  const typeLine = def.cardType === 'BattleUnit' ? `${def.unitType ?? ''}${def.isCommander ? ' Commander' : ''}` : def.cardType === 'CreationUnit' ? 'Creation Unit' : def.cardType;
  const cost = def.cost;
  return h(
    'div',
    { class: `proc-face proc-${def.cardType}${def.unitType ? ` proc-u-${def.unitType}` : ''}` },
    h('div', { class: 'proc-art' }, h('div', { class: 'proc-emblem' }, EMBLEM[def.unitType ?? def.cardType] ?? '◆')),
    h('div', { class: 'proc-name' }, def.name),
    cost &&
      h(
        'div',
        { class: 'proc-cost' },
        [...CU_TYPES, 'W' as const].map((t) => h('span', { class: `light l-${t}${cost[t] ? '' : ' off'}` }, String(cost[t] ?? 0))),
        // Change Request 1 costs: "pay one of these" (split light) and "pay any" (ringed light).
        (cost.choice ?? []).map((opts) => h('span', { class: 'light l-choice', style: { '--c1': `var(--cu-${opts[0]})`, '--c2': `var(--cu-${opts[1] ?? opts[0]})` } as any, title: `Deplete one: ${opts.join(' or ')}` }, '1')),
        cost.A ? h('span', { class: 'light l-A', title: `Deplete any ${cost.A}` }, String(cost.A)) : null,
      ),
    def.cuType && h('div', { class: `proc-cu l-${def.cuType}` }),
    def.stats &&
      h(
        'div',
        { class: 'proc-stats' },
        ABILITIES.map((a) => h('span', { class: `box b-${a}` }, String(def.stats![a]))),
      ),
    def.equip && h('div', { class: 'proc-stats' }, ABILITIES.map((a) => h('span', { class: `box b-${a}` }, def.equip!.ability === a ? `+${def.equip!.bonus}` : '0'))),
    h('div', { class: 'proc-type' }, typeLine.toUpperCase()),
    def.text && h('div', { class: 'proc-text' }, def.text),
  );
}

export function createCardEl(uid: string | null, def: CardDef | null, opts: CardRenderOpts = {}): HTMLElement {
  const size = opts.size ?? 'sm';
  const el = h('div', { class: 'card', tabindex: '-1' });
  if (uid) el.dataset.uid = uid;
  const inner = h('div', { class: 'card-inner' });
  const front = h('div', { class: 'face front' });
  const back = h('div', { class: 'face back' });
  const deck = def?.deck ?? 'battle';
  back.appendChild(img(backKey(deck), size, `${deck === 'battle' ? 'Battle' : 'Resource'} Deck card back`));
  if (def) {
    el.dataset.cardId = def.id;
    front.appendChild(hasArt(def.art) ? img(def.art!, size, def.name) : proceduralFace(def));
  } else {
    el.classList.add('face-down');
  }
  inner.append(front, back);
  el.append(inner, h('div', { class: 'overlays' }));
  if (def) el.setAttribute('aria-label', describe(def));
  return el;
}

export function describe(def: CardDef): string {
  const parts = [def.name];
  if (def.cardType === 'BattleUnit') parts.push(`${def.unitType}${def.isCommander ? ' Commander' : ''}`);
  else parts.push(def.cardType);
  if (def.stats) parts.push(`Cyber ${def.stats.cyber}, Psionic ${def.stats.psionic}, Physical ${def.stats.physical}`);
  if (def.equip) parts.push(`+${def.equip.bonus} ${ABILITY_NAME[def.equip.ability]}`);
  if (def.text) parts.push(def.text);
  return parts.join('. ');
}

const statText = (v: StatValue | number) => String(v);

/** Refresh overlays (stat/cost chips) for a face-up card. */
export function updateOverlays(el: HTMLElement, def: CardDef, opts: CardRenderOpts = {}): void {
  const ov = el.querySelector('.overlays') as HTMLElement;
  const chips: HTMLElement[] = [];
  const printedStats = def.printed?.stats ?? def.stats;
  const artShown = hasArt(def.art);
  if (def.stats && printedStats && artShown) {
    for (const a of ABILITIES) {
      const printed = printedStats[a];
      const current: StatValue | number = opts.stats ? opts.stats[a] : def.stats[a];
      const xb = current === 'X' ? opts.stats?.xBonus?.[a] ?? 0 : 0;
      if (!opts.alwaysChips && current === printed && !xb) continue;
      let tone = 'same';
      if (typeof current === 'number' && typeof printed === 'number') tone = current > printed ? 'up' : current < printed ? 'down' : 'same';
      else if (typeof current === 'number' && printed === 'X') tone = 'x';
      else if (xb) tone = xb > 0 ? 'up' : 'down';
      const text = xb ? `X${xb > 0 ? '+' : ''}${xb}` : statText(current);
      chips.push(
        h(
          'span',
          { class: `chip stat-chip ${tone} c-${a}`, style: { left: `${STAT_POS[a] * 100}%`, top: `${STAT_Y * 100}%` }, title: `${ABILITY_NAME[a]} ${text} (printed ${printed})` },
          text,
        ),
      );
    }
  }
  // Costs the printed art can't show: "pay any" and "pay one of these" (Change Request 1).
  if (def.cost && artShown && (def.cost.A || def.cost.choice?.length)) {
    const parts = [...(def.cost.choice ?? []).map((o) => o.join('/')), ...(def.cost.A ? [`ANY ${def.cost.A}`] : [])];
    chips.push(h('span', { class: 'chip cost-chip extra', style: { top: `${COST_Y[COST_Y.length - 1]! * 100 + 8}%` }, title: `Also pay: ${parts.join(', ')}` }, parts.join(' + ')));
  }
  const printedCost: Cost | undefined = def.printed?.cost;
  if (def.cost && printedCost && artShown) {
    [...CU_TYPES, 'W' as const].forEach((t, i) => {
      if (def.cost![t] === printedCost[t]) return;
      const tone = def.cost![t] > printedCost[t] ? 'down' : 'up';
      chips.push(h('span', { class: `chip cost-chip ${tone}`, style: { top: `${COST_Y[i]! * 100}%` }, title: `Cost changed: ${printedCost[t]} → ${def.cost![t]}` }, String(def.cost![t])));
    });
  }
  const markers = ov.querySelectorAll('.marker');
  ov.replaceChildren(...chips, ...Array.from(markers));
}

export function setMarkers(el: HTMLElement, markers: { kind: string; label: string; icon: string }[]): void {
  const ov = el.querySelector('.overlays') as HTMLElement;
  ov.querySelectorAll('.marker').forEach((m) => m.remove());
  const wrap = markers.length ? h('div', { class: 'marker markers' }, markers.map((m) => h('span', { class: `mk mk-${m.kind}`, title: m.label, 'aria-label': m.label }, m.icon))) : null;
  if (wrap) ov.appendChild(wrap);
}
