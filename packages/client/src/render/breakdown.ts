/** Per-battle breakdown (§8 "battle clarity"): strength + die = total, per ability, both sides. */
import type { GameEvent } from '@psi-wars/shared';
import { h, svg } from '../ui/dom';
import { dieSvg } from './dice';
import type { Namer } from './log';

const AB = ['cyber', 'psionic', 'physical'] as const;
const LABEL = { cyber: 'Cyber', psionic: 'Psionic', physical: 'Physical' };

export function renderBreakdown(ev: GameEvent | null, n: Namer, names: (s: unknown) => string, variant: 'standard' | 'noModifier'): HTMLElement {
  const box = h('div', { class: 'breakdown panel', 'aria-live': 'polite' }, h('h3', null, 'Last battle'));
  if (!ev) {
    box.appendChild(h('div', { class: 'faint' }, 'Dice results appear here.'));
    return box;
  }
  const a = ev.att as any;
  const d = ev.def as any;
  const winners = ev.winners as Record<string, 'att' | 'def' | null>;
  const head = h('tr', null, h('td'), h('td', { class: 'num dim' }, names(a.seat)), h('td'), h('td', { class: 'num dim' }, names(d.seat)));
  const rows: HTMLElement[] = [head];
  for (const ab of AB) {
    const sa = a[ab];
    const sd = d[ab];
    if (!sa || !sd) {
      if (ab !== 'physical') rows.push(h('tr', null, h('td', { class: `ab ${ab}` }, LABEL[ab]), h('td', { class: 'faint', colspan: '3' }, 'no battle')));
      continue;
    }
    const cell = (s: any, side: 'att' | 'def') => {
      const dice = h('span', { class: 'bd-dice' });
      const hist: number[] = s.history ?? [s.die];
      hist.forEach((x: number, i: number) => dice.appendChild(svg(dieSvg(ab, x, { size: 20, obliterated: i === hist.length - 1 ? s.obliterated : true, variant }))));
      const extra = ab === 'physical' && s.side5 ? ` +${s.side5}` : '';
      return h('td', { class: `num${winners[ab] === side ? ' win' : ''}` }, `${s.strength} + `, dice, `${extra} = ${s.total}`);
    };
    rows.push(h('tr', null, h('td', { class: `ab ${ab}` }, LABEL[ab]), cell(sa, 'att'), h('td', { class: 'faint' }, 'vs'), cell(sd, 'def')));
  }
  box.appendChild(h('table', { class: 'bd-table' }, ...rows));
  const notes: string[] = [];
  for (const ab of AB) {
    if (a[ab]?.obliterated && d[ab]?.obliterated) notes.push(`Both ${LABEL[ab]} dice destroyed (double Obliterate)`);
    else if (a[ab]?.obliterated) notes.push(`${names(a.seat)}'s ${LABEL[ab]} die destroyed by Obliterate`);
    else if (d[ab]?.obliterated) notes.push(`${names(d.seat)}'s ${LABEL[ab]} die destroyed by Obliterate`);
  }
  if (a.disoriented) notes.push(`${names(a.seat)} Disoriented — cannot destroy`);
  if (d.disoriented) notes.push(`${names(d.seat)} Disoriented — cannot destroy`);
  for (const nt of notes) box.appendChild(h('div', { class: 'bd-note' }, nt));
  const result = a.destroyed && d.destroyed ? 'Both destroyed' : a.destroyed ? `${a.units.map((u: string) => n.name(u)).join(' + ')} destroyed` : d.destroyed ? `${d.units.map((u: string) => n.name(u)).join(' + ')} destroyed` : 'Nothing destroyed';
  box.appendChild(h('div', { class: 'bd-result' }, result));
  return box;
}
