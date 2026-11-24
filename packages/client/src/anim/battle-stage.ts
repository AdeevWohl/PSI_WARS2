/**
 * Battle spotlight (Change Request 1, Part D5): each blocked battle is shown big in the centre,
 * one step at a time — the two fighters, a labelled row per battle (Cyber, Psionic, Physical)
 * with its dice and "strength + die = total", who is Disoriented and why, and the result in
 * words. Purely presentation: it only displays engine events.
 */
import type { Ability, GameEvent, Seat } from '@psi-wars/shared';
import type { GameView } from '@psi-wars/engine';
import { createCardEl, updateOverlays } from '../render/card';
import { DIE_COLOR } from '../render/dice';
import { SEAT_COLORS } from '../render/board';
import { h } from '../ui/dom';
import { DUR, EASE, type Timeline } from './timeline';


const LABEL: Record<Ability, string> = { cyber: 'CYBER BATTLE', psionic: 'PSIONIC BATTLE', physical: 'PHYSICAL BATTLE' };
const NAME: Record<Ability, string> = { cyber: 'Cyber', psionic: 'Psionic', physical: 'Physical' };

interface SideInfo {
  units: string[];
  seat: Seat;
}

export class BattleStage {
  readonly el: HTMLElement;
  readonly attackId: string;
  private rows = {} as Record<Ability, { row: HTMLElement; att: HTMLElement; def: HTMLElement; attDie: HTMLElement; defDie: HTMLElement; note: HTMLElement; line: () => HTMLElement }>;
  private cols: Record<'att' | 'def', { col: HTMLElement; tag: HTMLElement }>;
  private result = h('div', { class: 'bs-result' });
  private closed = false;

  constructor(host: HTMLElement, private tl: Timeline, private view: GameView, attackId: string, att: SideInfo, def: SideInfo, private names: (seat: unknown) => string) {
    this.attackId = attackId;
    const column = (side: 'att' | 'def', info: SideInfo) => {
      const tag = h('div', { class: 'bs-tag' });
      const cards = h('div', { class: `bs-cards n${Math.min(info.units.length, 2)}` }, ...info.units.map((u) => this.cardFor(u)));
      const label = h('div', { class: 'bs-who', style: { color: SEAT_COLORS[info.seat] } }, `${side === 'att' ? 'ATTACKER' : 'DEFENDER'} · ${this.names(info.seat)}`);
      const nm = h('div', { class: 'bs-name' }, info.units.map((u) => this.cardName(u)).join(' + '));
      const col = h('div', { class: `bs-col bs-${side}`, style: { '--seat-color': SEAT_COLORS[info.seat] } as any }, label, cards, nm, tag);
      return { col, tag };
    };
    this.cols = { att: column('att', att), def: column('def', def) };
    const mid = h('div', { class: 'bs-mid' });
    for (const ab of ['cyber', 'psionic', 'physical'] as const) {
      const r = {
        attDie: h('div', { class: 'bs-die' }),
        defDie: h('div', { class: 'bs-die' }),
        att: h('div', { class: 'bs-eq' }),
        def: h('div', { class: 'bs-eq' }),
        note: h('div', { class: 'bs-note' }),
        row: h('div', { class: `bs-row r-${ab} pending`, style: { '--ab': DIE_COLOR[ab] } as any }),
        line: () => r.row.querySelector('.bs-line') as HTMLElement,
      };
      r.row.append(h('div', { class: 'bs-label' }, LABEL[ab]), h('div', { class: 'bs-line' }, r.attDie, r.att, h('span', { class: 'bs-vs' }, 'vs'), r.def, r.defDie), r.note);
      this.rows[ab] = r;
      mid.append(r.row);
    }
    this.el = h('div', { class: 'battle-stage', 'aria-hidden': 'true' }, h('div', { class: 'bs-backdrop' }), h('div', { class: 'bs-panel' }, this.cols.att.col, mid, this.cols.def.col), this.result);
    host.appendChild(this.el);
    if (!tl.instant) {
      tl.animate(this.el.querySelector('.bs-backdrop')!, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.std, easing: EASE.outCubic });
      tl.animate(this.cols.att.col, [{ transform: 'translateX(-260px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: DUR.travel, easing: EASE.outQuint });
      tl.animate(this.cols.def.col, [{ transform: 'translateX(260px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: DUR.travel, easing: EASE.outQuint });
      tl.animate(mid, [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], { duration: DUR.travel, easing: EASE.outCubic, delay: 120 });
    }
  }

  private cardName(uid: string): string {
    const c = this.view.cards[uid];
    return (c && this.view.defs[c.cardId]?.name) || 'Unit';
  }

  private cardFor(uid: string): HTMLElement {
    const c = this.view.cards[uid];
    const def = c ? this.view.defs[c.cardId] ?? null : null;
    const el = createCardEl(null, def, { size: 'md' });
    if (def) updateOverlays(el, def, { stats: this.view.unitStats[uid] });
    el.style.setProperty('--w', '190px');
    return el;
  }

  /** Where the dice for one ability and side go (null if this stage is closed). */
  dieSlot(side: 'att' | 'def', ab: Ability): HTMLElement | null {
    if (this.closed) return null;
    const r = this.rows[ab];
    r.row.classList.remove('pending');
    return side === 'att' ? r.attDie : r.defDie;
  }

  async disoriented(e: GameEvent): Promise<void> {
    const side = e.side as 'att' | 'def';
    const ab = (e.ability as Ability) ?? 'cyber';
    const r = this.rows[ab];
    r.row.classList.remove('pending');
    if (e.auto) {
      r.note.textContent = `${side === 'att' ? 'Attacker' : 'Defender'} has no ${NAME[ab]} — automatically Disoriented`;
      r.note.classList.add('show');
    }
    const tag = this.cols[side].tag;
    tag.textContent = 'DISORIENTED — can’t destroy';
    tag.classList.add('show', 'dis');
    this.cols[side].col.classList.add('disoriented');
    if (!this.tl.instant) await this.tl.done(this.tl.animate(tag, [{ transform: 'scale(1.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: DUR.std, easing: EASE.outBack }));
  }

  /** True once the dice have been played step by step (later dice events then add nothing). */
  presented = false;
  private physicalShown = false;

  /**
   * Play the battles one at a time: Cyber, then Psionic, then Physical. Each row rolls its two
   * dice slowly, shows "strength + die = total", and says who won before the next row starts.
   * `ahead` = this battle's events that follow the dice in the same batch.
   */
  async playDice(dice: GameEvent, ahead: GameEvent[], diceTable: Record<Ability, Record<string, { bonus: number }>>, makeDie: (ab: Ability, side: number, who: 'att' | 'def') => { el: HTMLElement; roll: (delay: number, duration: number) => Animation | null; shatter: () => void }, sfx: (n: 'dice' | 'obliterate' | 'disorient') => void): Promise<void> {
    this.presented = true;
    const att = dice.att as Record<string, any>;
    const def = dice.def as Record<string, any>;
    const resolved = ahead.find((x) => x.type === 'BattleResolved') as Record<string, any> | undefined;
    for (const ab of ['cyber', 'psionic', 'physical'] as const) {
      const r = this.rows[ab];
      for (const k of ['cyber', 'psionic', 'physical'] as const) this.rows[k].row.classList.toggle('active', k === ab);
      r.row.classList.remove('pending');
      const auto = ahead.find((x) => x.type === 'Disoriented' && x.auto && x.ability === ab);
      if (auto) {
        const loser = auto.side as 'att' | 'def';
        r.note.textContent = `${loser === 'att' ? 'Attacker' : 'Defender'} has no ${NAME[ab]} to fight with — automatically Disoriented`;
        r.note.classList.add('show');
        r.row.classList.add(`won-${loser === 'att' ? 'def' : 'att'}`);
        await this.disoriented(auto);
        sfx('disorient');
        await this.tl.wait(1100);
        continue;
      }
      if (att[ab] === null || att[ab] === undefined) {
        r.note.textContent = `No ${NAME[ab]} battle (both need ${NAME[ab]} 1 or more)`;
        r.note.classList.add('show');
        r.row.classList.add('skipped');
        await this.tl.wait(650);
        continue;
      }
      // Roll this battle's two dice, slowly.
      const dA = makeDie(ab, att[ab], 'att');
      const dD = makeDie(ab, def[ab], 'def');
      r.attDie.replaceChildren(dA.el);
      r.defDie.replaceChildren(dD.el);
      sfx('dice');
      const a1 = dA.roll(0, 1700);
      const a2 = dD.roll(140, 1700);
      await this.tl.done(a2 ?? a1);
      // Obliteration
      const obl = ahead.find((x) => x.type === 'Obliterated' && x.die === ab);
      if (obl) {
        sfx('obliterate');
        if (obl.by === 'both' || obl.by === 'att') dD.shatter();
        if (obl.by === 'both' || obl.by === 'def') dA.shatter();
        r.note.textContent = obl.by === 'both' ? 'Both rolled Obliterate — both dice destroyed' : `${obl.by === 'att' ? 'Attacker' : 'Defender'} rolled Obliterate — the other die is destroyed`;
        r.note.classList.add('show');
        await this.tl.wait(700);
      }
      // Totals (exact from the result when it is in this batch; otherwise from the dice table).
      let ta: number | null;
      let td: number | null;
      let eqA: string;
      let eqD: string;
      const killed = (side: 'att' | 'def') => !!obl && (obl.by === 'both' || obl.by === (side === 'att' ? 'def' : 'att'));
      const strA = Number(att.str?.[ab] ?? 0);
      const strD = Number(def.str?.[ab] ?? 0);
      if (resolved?.att?.[ab] && resolved?.def?.[ab]) {
        ta = resolved.att[ab].total;
        td = resolved.def[ab].total;
        eqA = this.eq(resolved.att[ab]);
        eqD = this.eq(resolved.def[ab]);
      } else if (ab !== 'physical') {
        const bonus = (side: 'att' | 'def', face: number) => (killed(side) ? 0 : diceTable[ab][String(face)]?.bonus ?? 0);
        ta = strA + bonus('att', att[ab]);
        td = strD + bonus('def', def[ab]);
        eqA = `${strA} + ${ta - strA} = `;
        eqD = `${strD} + ${td - strD} = `;
      } else {
        // Physical before any re-roll: strength + die + 1 for each surviving Cyber/Psionic side 5.
        const dieKilled = (a: Ability, side: 'att' | 'def') => ahead.some((x) => x.type === 'Obliterated' && x.die === a && (x.by === 'both' || x.by === (side === 'att' ? 'def' : 'att')));
        const plus = (side: 'att' | 'def', d: Record<string, any>) => (['cyber', 'psionic'] as const).reduce((n, a) => n + (d[a] != null && !dieKilled(a, side) ? Number((diceTable[a][String(d[a])] as { physicalPlus?: number } | undefined)?.physicalPlus ?? 0) : 0), 0);
        const pbA = killed('att') ? 0 : diceTable.physical[String(att.physical)]?.bonus ?? 0;
        const pbD = killed('def') ? 0 : diceTable.physical[String(def.physical)]?.bonus ?? 0;
        const xA = plus('att', att);
        const xD = plus('def', def);
        const pa = strA + pbA + xA;
        const pd = strD + pbD + xD;
        eqA = `${strA} + ${pbA}${xA ? ` + ${xA}` : ''} = `;
        eqD = `${strD} + ${pbD}${xD ? ` + ${xD}` : ''} = `;
        r.att.replaceChildren(h('span', { class: 'bs-sum' }, eqA), h('b', null, String(pa)));
        r.def.replaceChildren(h('span', { class: 'bs-sum' }, eqD), h('b', null, String(pd)));
        r.note.textContent = 'Before any re-roll — a re-roll icon lets that side roll its Physical die again';
        r.note.classList.add('show');
        continue;
      }
      r.att.replaceChildren(h('span', { class: 'bs-sum' }, eqA), h('b', null, ta === null ? '?' : String(ta)));
      r.def.replaceChildren(h('span', { class: 'bs-sum' }, eqD), h('b', null, td === null ? '?' : String(td)));
      if (!this.tl.instant) await this.tl.done(this.tl.animate(r.line(), [{ transform: 'scale(1.06)', filter: 'brightness(1.6)' }, { transform: 'none', filter: 'none' }], { duration: 420, easing: EASE.outCubic }));
      if (ta === null || td === null) continue; // Physical waits for re-roll decisions
      if (ab === 'physical') this.physicalShown = true;
      const w = ta > td ? 'att' : td > ta ? 'def' : null;
      if (w) {
        r.row.classList.add(`won-${w}`);
        this.flashWinner(ab, w);
        if (ab !== 'physical') {
          const dis = ahead.find((x) => x.type === 'Disoriented' && x.ability === ab && !x.auto);
          if (dis) {
            await this.tl.wait(350);
            await this.disoriented(dis);
            sfx('disorient');
          }
        }
      } else {
        r.note.textContent = ab === 'physical' ? 'Tie on Physical — nothing is destroyed' : 'Tie — nobody is Disoriented';
        r.note.classList.add('show');
      }
      await this.tl.wait(1100);
    }
    for (const k of ['cyber', 'psionic', 'physical'] as const) this.rows[k].row.classList.remove('active');
  }

  private eq(p: { strength: number; total: number; side5?: number }): string {
    const bonus = p.total - p.strength - (p.side5 ?? 0);
    return `${p.strength} ${bonus >= 0 ? '+' : '−'} ${Math.abs(bonus)}${p.side5 ? ` + ${p.side5}` : ''} = `;
  }

  private flashWinner(ab: Ability, w: 'att' | 'def'): void {
    const r = this.rows[ab];
    const tag = h('div', { class: 'bs-win', style: { '--ab': DIE_COLOR[ab] } as any }, `${w === 'att' ? 'ATTACKER' : 'DEFENDER'} WINS ${NAME[ab].toUpperCase()}`);
    r.row.appendChild(tag);
    // Pops in, holds, then fades so the sums underneath can be read again.
    if (this.tl.instant) tag.remove();
    else this.tl.done(this.tl.animate(tag, [{ transform: 'translate(-50%, -50%) scale(1.8)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%, -50%) scale(0.85)', opacity: 0 }], { duration: 1700, easing: 'ease-out', fill: 'forwards' })).then(() => tag.remove());
  }

  /** Reveal each battle's maths in turn, then say what happened. */
  async resolved(e: GameEvent): Promise<void> {
    type Part = { strength: number; die: number; total: number; side5?: number } | null;
    const att = e.att as Record<string, any>;
    const def = e.def as Record<string, any>;
    const winners = e.winners as Record<Ability, 'att' | 'def' | null>;
    for (const ab of ['cyber', 'psionic', 'physical'] as const) {
      if (this.presented && (ab !== 'physical' || this.physicalShown)) continue;
      const r = this.rows[ab];
      if (ab === 'physical') r.note.classList.remove('show');
      const a: Part = att[ab];
      const d: Part = def[ab];
      if (!a || !d) {
        if (!r.note.classList.contains('show')) {
          r.note.textContent = winners[ab] ? '' : `No ${NAME[ab]} battle (both need ${NAME[ab]} 1 or more)`;
          r.note.classList.toggle('show', !winners[ab]);
          r.row.classList.add('skipped');
        }
        r.row.classList.remove('pending');
        if (winners[ab]) r.row.classList.add(`won-${winners[ab]}`);
        continue;
      }
      const eq = (p: NonNullable<Part>) => {
        const bonus = p.total - p.strength - (p.side5 ?? 0);
        return `${p.strength} ${bonus >= 0 ? '+' : '−'} ${Math.abs(bonus)}${p.side5 ? ` + ${p.side5}` : ''} = `;
      };
      r.att.replaceChildren(h('span', { class: 'bs-sum' }, eq(a)), h('b', null, String(a.total)));
      r.def.replaceChildren(h('span', { class: 'bs-sum' }, eq(d)), h('b', null, String(d.total)));
      r.row.classList.remove('pending');
      const w = winners[ab];
      if (w) r.row.classList.add(`won-${w}`);
      else if (ab !== 'physical') {
        r.note.textContent = 'Tie — nobody is Disoriented';
        r.note.classList.add('show');
      }
      if (!this.tl.instant) {
        await this.tl.done(this.tl.animate(r.row, [{ transform: 'scale(1.04)', filter: 'brightness(1.5)' }, { transform: 'none', filter: 'none' }], { duration: DUR.std + 120, easing: EASE.outCubic }));
        await this.tl.wait(260);
      }
    }
    const names = (side: 'att' | 'def') => ((side === 'att' ? att : def).units as string[]).map((u) => this.cardName(u)).join(' + ');
    let text: string;
    if (att.destroyed && def.destroyed) text = 'Both are destroyed';
    else if (def.destroyed) text = `${names('att')} destroys ${names('def')}`;
    else if (att.destroyed) text = `${names('def')} destroys ${names('att')}`;
    else if (att.disoriented && def.disoriented) text = 'Both are Disoriented — nothing is destroyed';
    else if (winners.physical && (winners.physical === 'att' ? att.disoriented : def.disoriented)) text = `${names(winners.physical)} wins on Physical but is Disoriented — it can’t destroy`;
    else text = 'A tie on Physical — nothing is destroyed';
    this.say(text);
    for (const side of ['att', 'def'] as const) {
      if ((side === 'att' ? att : def).destroyed) {
        const t = this.cols[side].tag;
        t.textContent = 'DESTROYED';
        t.classList.add('show', 'dead');
        this.cols[side].col.classList.add('destroyed');
      }
    }
  }

  /** Battle damage (B3): "takes N damage — M Physical left". */
  damaged(e: GameEvent): void {
    const side = (['att', 'def'] as const).find((s) => this.cols[s].col.querySelector(`.card`) && this.sideHas(s, String(e.uid)));
    if (side) {
      const t = this.cols[side].tag;
      t.textContent = e.lethal ? `TAKES ${e.amount} DAMAGE — DESTROYED` : `TAKES ${e.amount} DAMAGE — ${e.physicalAfter} PHYSICAL LEFT`;
      t.classList.add('show', 'hurt');
    }
    this.say(`${this.cardName(String(e.uid))} takes ${e.amount} damage${e.lethal ? ' and is destroyed' : ` — ${e.physicalAfter} Physical for the rest of the turn`}`);
  }

  private sides: Record<'att' | 'def', Set<string>> = { att: new Set(), def: new Set() };
  setUnits(att: string[], def: string[]): void {
    this.sides = { att: new Set(att), def: new Set(def) };
  }
  private sideHas(side: 'att' | 'def', uid: string): boolean {
    return this.sides[side].has(uid);
  }

  private say(text: string): void {
    this.result.textContent = text;
    this.result.classList.add('show');
    if (!this.tl.instant) this.tl.animate(this.result, [{ transform: 'translate(-50%, 20px)', opacity: 0 }, { transform: 'translate(-50%, 0)', opacity: 1 }], { duration: DUR.std, easing: EASE.outBack });
  }

  async close(hold = 700): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.tl.instant) {
      await this.tl.wait(hold);
      await this.tl.done(this.tl.animate(this.el, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.std, easing: EASE.inQuad, fill: 'forwards' }));
    }
    this.el.remove();
  }

  /** Remove at once (skip, end of batch with the battle over). */
  dispose(): void {
    this.closed = true;
    this.el.remove();
  }
}
