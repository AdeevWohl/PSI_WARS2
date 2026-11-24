/**
 * Card elements. Every face is drawn live from card data (name, cost pips, strength boxes,
 * type line, rules text); the supplied art is shown cropped in the illustration window, so
 * the printed cost column, boxes and text (often out of date) never show.
 */
import { ABILITIES, CU_TYPES, type Ability } from '@psi-wars/shared';
import type { CardDef, Cost, StatValue, UnitStats } from '@psi-wars/engine';
import { artUrl, hasArt, placeholder, type ArtSize } from '../assets';
import { h } from '../ui/dom';
import { cropFor } from './crops';
import { KEYWORD_HELP, keywordsFor } from './keywords';

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
  const typeLine = def.cardType === 'BattleUnit' ? `${def.unitType ?? ''}${def.isCommander ? ' Commander' : ''}` : def.cardType === 'CreationUnit' ? 'Creation Unit' : def.cardType ?? '';
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


const CU_LABEL: Record<string, string> = { G: 'Digital Splicing', B: 'Neurogenesis', R: 'Bio-Acceleration', P: 'Material Animation' };
const ALL_CU = ['G', 'B', 'R', 'P'] as const;
/** Strength boxes a unit type can use: Robots have no Psionic, Creatures no Cyber. */
export function boxesFor(def: CardDef): Ability[] {
  if (def.unitType === 'Robot') return ['cyber', 'physical'];
  if (def.unitType === 'Creature') return ['psionic', 'physical'];
  return ['cyber', 'psionic', 'physical'];
}

interface Pip { n: number; types: string[]; burn: boolean }

/** Group a cost into pips: fixed colours, "one of" lights (split circles), Any, and burns. */
export function costPips(cost: Cost | undefined): Pip[] {
  if (!cost) return [];
  const out: Pip[] = [];
  const add = (types: string[], burn: boolean, n = 1) => {
    const key = [...types].sort().join('');
    const same = out.find((p) => p.burn === burn && [...p.types].sort().join('') === key);
    if (same) same.n += n;
    else out.push({ n, types: [...types], burn });
  };
  for (const tp of CU_TYPES) if (cost[tp]) add([tp], false, cost[tp]);
  for (const ch of cost.choice ?? []) add(ch, false);
  if (cost.A) add([...ALL_CU], false, cost.A);
  if (cost.W) {
    const coloured = ALL_CU.filter((tp) => cost[tp] > 0 || (cost.choice ?? []).some((c) => c.includes(tp)));
    add(cost.burnPool?.length ? cost.burnPool : coloured.length ? coloured : [...ALL_CU], true, cost.W);
  }
  for (const b of cost.burns ?? []) add(b, true);
  return out;
}

function pipDot(types: string[]): HTMLElement {
  const n = types.length;
  const bg = n === 1 ? `var(--cu-${types[0]})` : `conic-gradient(${types.map((tp, i) => `var(--cu-${tp}) ${(i / n) * 100}% ${((i + 1) / n) * 100}%`).join(', ')})`;
  return h('span', { class: 'lf-dot', style: { background: bg } });
}

export function pipEl(p: Pip): HTMLElement {
  const what = p.types.length === 4 ? 'any type' : p.types.map((tp) => CU_LABEL[tp]).join(' or ');
  const title = `${p.burn ? 'Burn (destroy)' : 'Deplete'} ${p.n} — ${what}`;
  return h('div', { class: `lf-pip${p.burn ? ' burn' : ''}`, title, 'aria-label': title }, h('span', { class: 'lf-n' }, String(p.n)), pipDot(p.types));
}

const KEYWORDS = ['Lock-On', 'Calibrate', 'Protocol', 'Mutation', 'Cannibalize', 'Reanimated', 'Relocate', 'Reactive', 'Creation Power', 'Assault', 'Guard', 'Precision', 'Scan', 'Stacked', 'Stack', 'Contain', 'Disoriented', 'Obliterate', 'Psionic X', 'Cyber X'];
const KW_RE = new RegExp(`(${KEYWORDS.map((k) => k.replace(/[-]/g, '\\-')).join('|')})`, 'g');

/** Rules text with keywords in bold (text nodes only — no HTML injection). */
function richText(text: string): Node[] {
  const out: Node[] = [];
  for (const part of text.split(KW_RE)) {
    if (!part) continue;
    out.push(KEYWORDS.includes(part) ? h('b', null, part) : document.createTextNode(part));
  }
  return out;
}

/** Text panel size by text length: short / medium panels leave more room for art; long text collapses to a hover tab. */
export type TextMode = 'none' | 's' | 'm' | 'l';
export function textMode(text: string): TextMode {
  const n = text.trim().length;
  if (!n) return 'none';
  if (n <= 80) return 's';
  if (n <= 170) return 'm';
  return 'l';
}
const PANEL: Record<TextMode, number> = { none: 0, s: 18, m: 31, l: 8.5 };

/** Starting font size for the text panel, as a % of card width, from the text length. */
function textSize(len: number): number {
  if (!len) return 6;
  return Math.max(3.2, Math.min(6.4, 74 / Math.sqrt(len)));
}

/** Shrink the text panel's font until everything fits (runs once the card is in the page). */
export function fitText(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.lf-text'))) {
    if (!el.isConnected || !el.clientHeight) continue;
    let size = Number(el.dataset.size ?? 5);
    for (let i = 0; i < 14 && el.scrollHeight > el.clientHeight + 1 && size > 2.4; i++) {
      size *= 0.92;
      el.style.fontSize = `${size}cqw`;
    }
  }
}
let fitQueued = false;
function queueFit(): void {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitText(document);
  });
}

let tipInstalled = false;
/** Card definitions behind collapsed descriptions (for their keyword list). */
const descDefs = new Map<string, CardDef>();
/** One floating caption for every collapsed "Description" tab (outside the card, so it is never clipped). */
function installDescTip(): void {
  if (tipInstalled || typeof document === 'undefined') return;
  tipInstalled = true;
  const tip = h('div', { class: 'lf-tip', role: 'tooltip' });
  document.body.appendChild(tip);
  const show = (src: HTMLElement) => {
    const kws = keywordsFor(descDefs.get(src.dataset.card ?? '') ?? ({ text: src.dataset.full ?? '' } as CardDef));
    tip.replaceChildren(h('div', null, ...richText(src.dataset.full ?? '')), ...kws.map((k) => h('div', { class: 'lf-tip-kw' }, h('b', null, `${k}: `), KEYWORD_HELP[k]!)));
    tip.classList.add('show');
    const r = src.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 16);
    tip.style.width = `${w}px`;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    tip.style.left = `${left}px`;
    const below = r.bottom + 8;
    tip.style.top = `${below}px`;
    requestAnimationFrame(() => {
      if (below + tip.offsetHeight > window.innerHeight - 8) tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
    });
  };
  const onOver = (e: Event) => {
    const src = (e.target as HTMLElement | null)?.closest?.('.lf-desc') as HTMLElement | null;
    if (src) show(src);
    else tip.classList.remove('show');
  };
  // Capture phase: screens that stop hover events (previews, drag) can't hide the caption.
  let last: EventTarget | null = null;
  const onMove = (e: Event) => {
    if (e.target === last) return;
    last = e.target;
    onOver(e);
  };
  document.addEventListener('pointerover', onMove, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('mouseover', onMove, true);
  document.addEventListener('focusin', onOver, true);
  document.addEventListener('pointerdown', () => tip.classList.remove('show'), true);
}

const TYPE_TINT: Record<string, string> = { Creature: '#ff8a4c', Robot: '#4fd1ff', Cyborg: '#c77dff', Equipment: '#b867ff', Power: '#ffc857', Trap: '#ffc857', Resource: '#5ee6a8', CreationUnit: '#5ee6a8' };

function typeLine(def: CardDef): string {
  const parts: string[] = [];
  if (def.cardType === 'BattleUnit') parts.push(`${def.unitType ?? ''}${def.isCommander ? ' Commander' : ''}`);
  else if (def.cardType === 'CreationUnit') parts.push('Creation Unit');
  else if (def.cardType === 'Equipment') parts.push(`Equipment · ${(def.equip?.allowed.length ?? 0) >= 3 ? 'Any Battle Unit' : def.equip?.allowed.join(', ') ?? ''}`);
  else parts.push(def.cardType === 'Trap' ? 'Power' : def.cardType);
  if (def.timing) parts.push(def.timing);
  for (const k of def.keywords ?? []) if (k !== def.timing && k !== 'Relocate') parts.push(k);
  return parts.join(' · ');
}

/** The live card face: art window, cost pips, name, strength boxes, type line, rules text. */
export function liveFace(def: CardDef, size: ArtSize): HTMLElement {
  const tint = TYPE_TINT[def.unitType ?? def.cardType] ?? '#4fd1ff';
  const artWin = h('div', { class: 'lf-art' });
  if (hasArt(def.art)) {
    const im = img(def.art!, size === 'sm' ? 'md' : size, def.name);
    im.classList.add('lf-img');
    const crop = cropFor(def.art);
    im.style.setProperty('--z', String(crop.z));
    im.style.setProperty('--fy', String(crop.fy));
    artWin.appendChild(im);
  } else {
    artWin.classList.add('lf-noart');
    artWin.appendChild(def.cuType ? h('div', { class: `proc-cu l-${def.cuType}` }) : h('div', { class: 'proc-emblem' }, EMBLEM[def.unitType ?? def.cardType] ?? '◆'));
  }
  const pips = costPips(def.cost);
  const stats = def.stats && def.cardType === 'BattleUnit'
    ? h('div', { class: `lf-stats n${boxesFor(def).length}` }, boxesFor(def).map((a) => h('div', { class: `lf-box b-${a}`, 'data-ab': a, title: ABILITY_NAME[a] }, String(def.stats![a]))))
    : def.equip
      ? h('div', { class: 'lf-stats n1' },
        h('div', { class: `lf-box wide b-${def.equip.ability}`, title: `+${def.equip.bonus} ${ABILITY_NAME[def.equip.ability]}` }, `+${def.equip.bonus} ${ABILITY_NAME[def.equip.ability]}`),
        h('div', { class: 'lf-move', title: def.equip.moveCost ? 'Relocate cost (your Creation phase)' : 'Relocates for free in your Creation phase' }, 'Relocate', def.equip.moveCost ? h('span', { class: 'lf-pips row' }, costPips(def.equip.moveCost).map(pipEl)) : h('span', { class: 'lf-free' }, 'free')))
      : null;
  const text = def.text ?? '';
  const mode = textMode(text);
  const textEl = mode === 'none'
    ? null
    : mode === 'l'
      ? h('div', { class: 'lf-text lf-desc', 'data-full': text, 'data-card': def.id, tabindex: '-1', 'aria-label': text }, h('span', { class: 'lf-desc-label' }, 'ⓘ Description'), h('span', { class: 'lf-desc-hint' }, 'hover to read'))
      : h('div', { class: 'lf-text', 'data-size': String(textSize(text.length)), style: { fontSize: `${textSize(text.length)}cqw` } }, ...richText(text));
  if (mode === 'l') descDefs.set(def.id, def);
  installDescTip();
  const face = h(
    'div',
    { class: `lf lf-${def.cardType}${def.unitType ? ` lf-u-${def.unitType}` : ''}${stats ? '' : ' no-stats'} txt-${mode}`, style: { '--tint': tint, '--tp': `${PANEL[mode]}cqw`, '--sh': stats ? '14cqw' : '0cqw' } as any },
    artWin,
    pips.length ? h('div', { class: 'lf-pips' }, pips.map(pipEl)) : null,
    h('div', { class: 'lf-name' }, def.name),
    stats,
    h('div', { class: 'lf-type', style: { fontSize: `${Math.min(4.1, 118 / Math.max(1, typeLine(def).length))}cqw` } }, typeLine(def)),
    textEl,
  );
  queueFit();
  return face;
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
    front.appendChild(liveFace(def, size));
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

/** Refresh a face-up card's live strengths (boxes turn green/red when changed). */
export function updateOverlays(el: HTMLElement, def: CardDef, opts: CardRenderOpts = {}): void {
  if (def.stats) {
    const printedStats = def.printed?.stats ?? def.stats;
    for (const box of Array.from(el.querySelectorAll<HTMLElement>('.lf-box[data-ab]'))) {
      const a = box.dataset.ab as Ability;
      const printed = def.stats[a];
      const current: StatValue | number = opts.stats ? opts.stats[a] : printed;
      const xb = current === 'X' ? opts.stats?.xBonus?.[a] ?? 0 : 0;
      let tone = '';
      if (typeof current === 'number' && typeof printed === 'number') tone = current > printed ? 'up' : current < printed ? 'down' : '';
      else if (typeof current === 'number' && printed === 'X') tone = 'x';
      else if (xb) tone = xb > 0 ? 'up' : 'down';
      const text = xb ? `X${xb > 0 ? '+' : ''}${xb}` : statText(current);
      if (box.textContent !== text) box.textContent = text;
      box.classList.toggle('up', tone === 'up');
      box.classList.toggle('down', tone === 'down');
      box.classList.toggle('x', tone === 'x');
      box.title = `${ABILITY_NAME[a]} ${text}${text !== String(printed) ? ` (printed ${printed}; original art ${printedStats[a]})` : ''}`;
    }
  }
  queueFit();
}

export function setMarkers(el: HTMLElement, markers: { kind: string; label: string; icon: string }[]): void {
  const ov = el.querySelector('.overlays') as HTMLElement;
  ov.querySelectorAll('.marker').forEach((m) => m.remove());
  const wrap = markers.length ? h('div', { class: 'marker markers' }, markers.map((m) => h('span', { class: `mk mk-${m.kind}`, title: m.label, 'aria-label': m.label }, m.icon))) : null;
  if (wrap) ov.appendChild(wrap);
}
