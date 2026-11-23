/**
 * Board renderer. Keyed reconciliation: every visible card keeps one DOM element for its
 * whole life, and moving zones just re-parents it. That is what lets the animation layer
 * (Stage 3) FLIP cards between hand, Lab, battlefield and discard.
 */
import { CU_TYPES, type CUType, type Seat } from '@psi-wars/shared';
import type { Attack, CardDef, GameView } from '@psi-wars/engine';
import { artUrl } from '../assets';
import { snap, toStage, type Snap } from '../anim/flip';
import { h } from '../ui/dom';
import { createCardEl, describe, setMarkers, updateOverlays } from './card';

export type Zone = 'hand' | 'lab' | 'trapped' | 'battle' | 'equip' | 'discard' | 'stackItem';

export interface CardCtx {
  uid: string;
  zone: Zone;
  owner: Seat;
  def: CardDef;
  attackId?: string;
}

export interface BoardHooks {
  decorate(el: HTMLElement, ctx: CardCtx): void;
  click(ctx: CardCtx, ev: MouseEvent): void;
  hover(ctx: CardCtx | null, el?: HTMLElement): void;
  openDiscard(seat: Seat): void;
  /** Client-side tentative blocks during declaration: attackId -> blocker uid. */
  tentativeBlocks(): Map<string, string>;
  alwaysChips(): boolean;
}

const CU_NAMES: Record<CUType, string> = { G: 'Digital Splicing', B: 'Neurogenesis', R: 'Bio-Acceleration', P: 'Material Animation' };
const CU_ART: Record<CUType, string> = { G: 'cards/CU_DS', B: 'cards/CU_NG', R: 'cards/CU_BA', P: 'cards/CU_MA' };
export const SEAT_COLORS = ['#4fd1ff', '#ff8a4c', '#c77dff', '#5ee6a8'];

interface Area {
  seat: Seat;
  root: HTMLElement;
  strip: HTMLElement;
  name: HTMLElement;
  hp: HTMLElement;
  hpBar: HTMLElement;
  hand: HTMLElement;
  decks: HTMLElement;
  discard: HTMLElement;
  cus: HTMLElement;
  units: HTMLElement;
  trapped: HTMLElement;
}

export class Board {
  readonly root: HTMLElement;
  private top: HTMLElement;
  private bottomHost: HTMLElement;
  private battlefield: HTMLElement;
  private areas = new Map<Seat, Area>();
  private cardEls = new Map<string, HTMLElement>();
  private slotEls = new Map<string, HTMLElement>();
  private view!: GameView;
  /** Card elements removed by the last render (reused as ghosts by the animation layer). */
  lastRemoved = new Map<string, HTMLElement>();
  /** Displayed Lab HP held back until the damage animation plays. */
  hpOverride = new Map<Seat, number>();

  constructor(private hooks: BoardHooks) {
    this.top = h('div', { class: 'opp-row' });
    this.battlefield = h('div', { class: 'battlefield', 'aria-label': 'Battlefield' });
    this.bottomHost = h('div', { class: 'my-row' });
    this.root = h('div', { class: 'board-main' }, this.top, this.battlefield, this.bottomHost);
  }

  /** Element currently showing a card (for animations and focus). */
  elementFor(uid: string): HTMLElement | undefined {
    return this.cardEls.get(uid);
  }

  areaFor(seat: Seat): Area | undefined {
    return this.areas.get(seat);
  }

  elements(): Map<string, HTMLElement> {
    return this.cardEls;
  }

  /** Positions of every visible card (stage coordinates), for FLIP. */
  snapshot(): Map<string, Snap & { zone?: string }> {
    const out = new Map<string, Snap & { zone?: string }>();
    for (const [uid, el] of this.cardEls) if (el.isConnected) out.set(uid, { ...snap(el), zone: el.dataset.zone });
    return out;
  }

  /** Stage-space rects of an area's fixed parts: where draws come from, where discards go. */
  anchors(seat: Seat): Record<'hand' | 'battleDeck' | 'resourceDeck' | 'discard' | 'hp' | 'cus' | 'area' | 'units', ReturnType<typeof toStage>> | null {
    const a = this.areas.get(seat);
    if (!a || !a.root.isConnected) return null;
    const r = (el: Element | null | undefined) => toStage((el ?? a.root).getBoundingClientRect());
    return {
      hand: r(a.hand),
      battleDeck: r(a.decks.querySelector('.pile-battle')),
      resourceDeck: r(a.decks.querySelector('.pile-resource')),
      discard: r(a.discard),
      hp: r(a.hp),
      cus: r(a.cus),
      area: r(a.root),
      units: r(a.units),
    };
  }

  cuGroupEl(seat: Seat, type: CUType): HTMLElement | null {
    return this.areas.get(seat)?.cus.querySelector(`.cu-${type}`) ?? null;
  }

  setHp(seat: Seat, hp: number): void {
    this.hpOverride.set(seat, hp);
    const a = this.areas.get(seat);
    if (!a || !this.view) return;
    a.hp.textContent = String(Math.max(hp, 0));
    a.hpBar.style.transform = `scaleX(${Math.max(0, Math.min(1, hp / this.view.config.startingHP))})`;
    a.hpBar.classList.toggle('low', hp <= Math.ceil(this.view.config.startingHP / 4));
  }

  render(view: GameView): void {
    this.view = view;
    const bottom = view.viewer ?? view.turn.active;
    const order = view.players.map((p) => p.seat);
    const rot = [...order.slice(order.indexOf(bottom)), ...order.slice(0, order.indexOf(bottom))];
    const opponents = rot.slice(1);
    this.root.dataset.opponents = String(opponents.length);
    const seen = new Set<string>();

    // Areas (created once per seat, re-parented if perspective changes)
    for (const seat of rot) {
      const a = this.areas.get(seat) ?? this.createArea(seat);
      const parent = seat === bottom ? this.bottomHost : this.top;
      a.root.classList.toggle('mine', seat === bottom);
      a.root.classList.toggle('opp', seat !== bottom);
      if (seat !== bottom) a.root.tabIndex = 0;
      else a.root.removeAttribute('tabindex');
      a.root.setAttribute('aria-label', `${view.players[seat]!.name}'s area`);
      if (a.root.parentElement !== parent) parent.appendChild(a.root);
    }
    for (const seat of opponents) this.top.appendChild(this.areas.get(seat)!.root); // keep turn order

    for (const seat of rot) this.renderArea(this.areas.get(seat)!, seat === bottom, seen);
    this.renderBattlefield(bottom, seen);

    this.lastRemoved = new Map();
    for (const [uid, el] of this.cardEls) {
      if (!seen.has(uid)) {
        el.remove();
        this.cardEls.delete(uid);
        this.lastRemoved.set(uid, el);
      }
    }
    for (const [uid, el] of this.slotEls) {
      if (!seen.has(`slot:${uid}`)) {
        el.remove();
        this.slotEls.delete(uid);
      }
    }
  }

  // ---------- areas ----------

  private createArea(seat: Seat): Area {
    const name = h('div', { class: 'p-name' });
    const hp = h('div', { class: 'p-hp', 'aria-live': 'polite' });
    const hpBar = h('div', { class: 'hp-fill' });
    const decks = h('div', { class: 'decks' });
    const discard = h('button', { class: 'discard-pile', title: 'Discard pile', onclick: () => this.hooks.openDiscard(seat) });
    const hand = h('div', { class: 'hand' });
    const cus = h('div', { class: 'cu-row', 'aria-label': 'Creation Units' });
    const units = h('div', { class: 'units-row', 'aria-label': 'Battle Units' });
    const trapped = h('div', { class: 'trapped-area', 'aria-label': 'Trapped units' });
    const strip = h(
      'div',
      { class: 'p-strip' },
      h('div', { class: 'p-id' }, name, h('div', { class: 'hp-wrap' }, hp, h('div', { class: 'hp-bar' }, hpBar))),
      decks,
      discard,
    );
    const root = h('section', { class: 'area', dataset: { seat: String(seat) }, style: { '--seat-color': SEAT_COLORS[seat] } as any }, strip, cus, h('div', { class: 'field' }, units, trapped), hand);
    const a: Area = { seat, root, strip, name, hp, hpBar, hand, decks, discard, cus, units, trapped };
    this.areas.set(seat, a);
    return a;
  }

  private renderArea(a: Area, mine: boolean, seen: Set<string>): void {
    const v = this.view;
    const p = v.players[a.seat]!;
    a.root.classList.toggle('active-turn', v.turn.active === a.seat);
    a.root.classList.toggle('eliminated', p.eliminated);
    a.name.textContent = p.name + (v.turn.active === a.seat ? '' : '');
    const hp = this.hpOverride.get(a.seat) ?? p.labHP;
    a.hp.textContent = String(Math.max(hp, 0));
    a.hp.setAttribute('aria-label', `${p.name} Lab ${p.labHP} HP`);
    a.hpBar.style.transform = `scaleX(${Math.max(0, Math.min(1, hp / v.config.startingHP))})`;
    a.hpBar.classList.toggle('low', hp <= Math.ceil(v.config.startingHP / 4));

    // Decks
    a.decks.replaceChildren(
      this.pile('battle', p.battleDeckCount, 'Battle Deck'),
      this.pile('resource', p.resourceDeckCount, 'Resource Deck'),
    );

    // Discard: top card keyed (so a destroyed unit flies here), count badge
    const top = p.discard[p.discard.length - 1];
    const kids: Node[] = [];
    if (top) {
      const el = this.cardEl(top, 'discard', a.seat, seen);
      kids.push(el);
    } else kids.push(h('div', { class: 'pile-empty' }, 'Discard'));
    kids.push(h('span', { class: 'count' }, String(p.discard.length)));
    a.discard.replaceChildren(...kids);
    a.discard.setAttribute('aria-label', `${p.name} discard pile, ${p.discard.length} cards`);

    // Creation Units grouped by type with ready / depleted split
    const groups: Node[] = [];
    // Fortified Creation Units form their own pile per type (Resource Fortification).
    for (const t of CU_TYPES) {
      for (const fort of [false, true]) {
        const uids = p.cus.filter((u) => v.defs[v.cards[u]!.cardId]?.cuType === t && !!v.cards[u]!.equipment === fort);
        if (uids.length === 0) continue;
        const ready = uids.filter((u) => !v.cards[u]!.depleted).length;
        const label = `${fort ? 'Fortified ' : ''}${CU_NAMES[t]}: ${uids.length} (${ready} ready)${fort ? ' — depleted instead of destroyed when paying' : ''}`;
        groups.push(
          h(
            'div',
            { class: `cu-group cu-${t}${fort ? ' fortified' : ''}`, title: label, 'aria-label': label },
            fort ? h('span', { class: 'cu-shield', 'aria-hidden': 'true' }, '🛡') : null,
            h('img', { class: 'cu-art', src: artUrl(CU_ART[t], 'sm') ?? '', alt: '' }),
            h('span', { class: 'cu-shape', 'aria-hidden': 'true' }),
            h('span', { class: 'cu-count' }, String(uids.length)),
            h('span', { class: 'cu-ready' }, `${ready} ready`),
          ),
        );
      }
    }
    if (groups.length === 0) groups.push(h('div', { class: 'faint cu-empty' }, 'No Creation Units yet'));
    a.cus.replaceChildren(...groups);

    // Units in the Lab that are not in a battle
    const inBattle = new Set<string>();
    for (const atk of this.liveAttacks()) {
      atk.units.forEach((u) => inBattle.add(u));
      atk.blockers.forEach((u) => inBattle.add(u));
    }
    for (const [, b] of this.hooks.tentativeBlocks()) {
      const partner = v.cards[b]?.stackPartner;
      inBattle.add(b);
      if (partner) inBattle.add(partner);
    }
    const unitKids: Node[] = [];
    const done = new Set<string>();
    for (const u of p.lab) {
      if (done.has(u) || inBattle.has(u)) continue;
      const partner = v.cards[u]!.stackPartner;
      const group = partner ? [u, partner] : [u];
      group.forEach((x) => done.add(x));
      unitKids.push(this.group(group, a.seat, 'lab', seen));
    }
    a.units.replaceChildren(...unitKids);
    a.units.classList.toggle('empty', unitKids.length === 0);

    a.trapped.replaceChildren(...p.trapped.map((u) => this.slot(u, a.seat, 'trapped', seen)));
    a.trapped.classList.toggle('empty', p.trapped.length === 0);

    // Hand: own hand face-up in a fan; others as backs with a count
    if (mine && p.hand) {
      const n = p.hand.length;
      const slots = p.hand.map((u, i) => {
        const el = this.cardEl(u, 'hand', a.seat, seen);
        const s = h('div', { class: 'hand-slot' }, el);
        const t = n <= 1 ? 0 : i / (n - 1) - 0.5;
        const spread = Math.min(1060, 120 * n);
        s.style.left = `calc(50% + ${(t * spread).toFixed(1)}px)`;
        s.style.setProperty('--rot', `${(t * Math.min(18, n * 2.4)).toFixed(2)}deg`);
        s.style.setProperty('--lift', `${(Math.abs(t) * Math.abs(t) * 46).toFixed(1)}px`);
        s.style.zIndex = String(10 + i);
        return s;
      });
      a.hand.replaceChildren(...slots);
      a.hand.classList.add('fan');
      a.hand.setAttribute('aria-label', `Your hand, ${n} cards`);
    } else {
      const n = p.handCount;
      const backs = Array.from({ length: n }, (_, i) => {
        const el = createCardEl(null, null, { size: 'sm' });
        el.classList.add('hand-back');
        el.style.setProperty('--i', String(i));
        return el;
      });
      a.hand.replaceChildren(...backs, h('span', { class: 'count' }, String(n)));
      a.hand.classList.remove('fan');
      a.hand.setAttribute('aria-label', `${p.name}'s hand: ${n} cards`);
    }
  }

  private pile(deck: 'battle' | 'resource', count: number, label: string): HTMLElement {
    return h(
      'div',
      { class: `pile pile-${deck}${count === 0 ? ' empty' : ''}`, title: `${label}: ${count}`, 'aria-label': `${label} ${count} cards` },
      h('img', { src: artUrl(`backs/${deck}`, 'sm') ?? '', alt: '' }),
      h('span', { class: 'count' }, String(count)),
    );
  }

  private liveAttacks(): Attack[] {
    return (this.view.battle?.attacks ?? []).filter((a) => a.status !== 'cancelled' && a.units.some((u) => this.view.cards[u]?.zone === 'lab'));
  }

  // ---------- units ----------

  private group(uids: string[], owner: Seat, zone: Zone, seen: Set<string>, attackId?: string): HTMLElement {
    const slots = uids.map((u) => this.slot(u, owner, zone, seen, attackId));
    if (slots.length === 1) return slots[0]!;
    return h('div', { class: 'stack-group', title: 'Stack: fights as one' }, ...slots);
  }

  private slot(uid: string, owner: Seat, zone: Zone, seen: Set<string>, attackId?: string): HTMLElement {
    const v = this.view;
    const c = v.cards[uid]!;
    let s = this.slotEls.get(uid);
    if (!s) {
      s = h('div', { class: 'slot' });
      this.slotEls.set(uid, s);
    }
    seen.add(`slot:${uid}`);
    // On the battlefield an attacker is depleted by attacking, but it is shown as attacking, not spent.
    const attacking = zone === 'battle' && v.battle?.attacks.some((x) => x.units.includes(uid));
    s.classList.toggle('depleted', c.depleted && zone !== 'trapped' && !attacking);
    s.classList.toggle('attacking', !!attacking);
    if (attacking) s.style.setProperty('--seat-color', SEAT_COLORS[owner] ?? '');
    s.classList.toggle('has-equip', !!c.equipment);
    const unit = this.cardEl(uid, zone, owner, seen, attackId);
    unit.classList.add('unit');
    const kids: Node[] = [];
    if (c.equipment && v.cards[c.equipment]) {
      const eq = this.cardEl(c.equipment, 'equip', owner, seen);
      eq.classList.add('equip');
      kids.push(eq);
    }
    kids.push(unit);
    s.replaceChildren(...kids);
    return s;
  }

  private cardEl(uid: string, zone: Zone, owner: Seat, seen: Set<string>, attackId?: string): HTMLElement {
    const v = this.view;
    const c = v.cards[uid];
    const def = c ? v.defs[c.cardId] : undefined;
    let el = this.cardEls.get(uid);
    if (!el || (def && el.dataset.cardId !== def.id)) {
      el?.remove();
      el = createCardEl(uid, def ?? null, { size: 'sm' });
      this.cardEls.set(uid, el);
      el.addEventListener('click', (ev) => {
        const ctx = (el as any).__ctx as CardCtx | undefined;
        if (ctx) this.hooks.click(ctx, ev);
      });
      el.addEventListener('pointerenter', () => this.hooks.hover((el as any).__ctx ?? null, el));
      el.addEventListener('pointerleave', () => this.hooks.hover(null));
      el.addEventListener('focus', () => this.hooks.hover((el as any).__ctx ?? null, el));
      el.addEventListener('blur', () => this.hooks.hover(null));
      // Keyboard play (§7 accessibility): Enter/Space acts like a click, arrows move between cards.
      el.addEventListener('keydown', (ev) => this.cardKey(el!, ev));
    }
    seen.add(uid);
    if (!def || !c) return el;
    const ctx: CardCtx = { uid, zone, owner, def, attackId };
    (el as any).__ctx = ctx;
    el.className = 'card';
    el.dataset.zone = zone;
    if (c.depleted && def.cardType === 'CreationUnit') el.classList.add('cu', 'depleted');
    const stats = v.unitStats[uid];
    updateOverlays(el, def, { stats, alwaysChips: this.hooks.alwaysChips() && !!stats });
    const markers: { kind: string; label: string; icon: string }[] = [];
    if (c.disoriented) markers.push({ kind: 'disoriented', label: 'Disoriented: cannot destroy this battle', icon: '◎' });
    if (zone !== 'hand' && v.turnEffects.length && stats && this.isDisabled(uid)) markers.push({ kind: 'disabled', label: 'Cannot attack or defend this turn', icon: '⊘' });
    if (c.disoriented) el.classList.add('disoriented');
    setMarkers(el, markers);
    this.hooks.decorate(el, ctx);
    const interactive = el.classList.contains('interactive');
    el.tabIndex = 0;
    el.setAttribute('role', interactive ? 'button' : 'img');
    if (interactive) el.setAttribute('aria-pressed', String(el.classList.contains('selected')));
    else el.removeAttribute('aria-pressed');
    const dimmed = el.classList.contains('dimmed');
    const state = !interactive ? '' : dimmed ? 'cannot be played now' : el.classList.contains('target') ? 'can be chosen as the target' : el.classList.contains('selected') ? 'selected' : 'available';
    const extra = [state, el.title, c.depleted && zone !== 'hand' ? 'depleted' : '', ...markers.map((m) => m.label)].filter(Boolean);
    el.setAttribute('aria-label', [describe(def), ...extra].map((x) => x.trim().replace(/\.+$/, '')).join('. '));
    return el;
  }

  private cardKey(el: HTMLElement, ev: KeyboardEvent): void {
    const ctx = (el as any).__ctx as CardCtx | undefined;
    if (!ctx) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      ev.stopPropagation();
      if (el.classList.contains('interactive')) this.hooks.click(ctx, new MouseEvent('click', { shiftKey: ev.shiftKey }));
      return;
    }
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(ev.key in moves) && ev.key !== 'Home' && ev.key !== 'End') return;
    // Interactive cards first when there are any, so arrows walk through the current choices.
    const all = [...this.root.querySelectorAll<HTMLElement>('.card[tabindex="0"]')].filter((x) => x.offsetParent !== null);
    const live = all.filter((x) => x.classList.contains('interactive'));
    const list = live.length && el.classList.contains('interactive') ? live : all;
    const i = list.indexOf(el);
    const next = ev.key === 'Home' ? list[0] : ev.key === 'End' ? list[list.length - 1] : list[(i + moves[ev.key]! + list.length) % list.length];
    if (next) {
      ev.preventDefault();
      ev.stopPropagation();
      next.focus({ preventScroll: true });
    }
  }

  private isDisabled(uid: string): boolean {
    const v = this.view;
    const def = v.defs[v.cards[uid]!.cardId]!;
    const st = v.unitStats[uid]!;
    return v.turnEffects.some((te) => {
      const f = te.filter;
      if (f.hasAbility && !(st[f.hasAbility as 'cyber'] === 'X' || (st[f.hasAbility as 'cyber'] as number) >= 1)) return false;
      if (f.unitType && !(Array.isArray(f.unitType) ? f.unitType : [f.unitType]).includes(def.unitType)) return false;
      return true;
    });
  }

  // ---------- battlefield ----------

  private renderBattlefield(bottom: Seat, seen: Set<string>): void {
    const v = this.view;
    const cols: Node[] = [];
    const tentative = this.hooks.tentativeBlocks();
    for (const atk of this.liveAttacks()) {
      const attackerIsBottom = atk.seat === bottom;
      const defenderSeat = atk.target;
      const attEl = this.group(atk.units.filter((u) => v.cards[u]?.zone === 'lab'), atk.seat, 'battle', seen, atk.id);
      let defEl: HTMLElement;
      const blockers = atk.blockers.length ? atk.blockers : tentative.has(atk.id) ? this.withPartner(tentative.get(atk.id)!) : [];
      if (blockers.length && blockers.some((u) => v.cards[u]?.zone === 'lab')) {
        defEl = this.group(blockers.filter((u) => v.cards[u]?.zone === 'lab'), defenderSeat, 'battle', seen, atk.id);
        if (!atk.blockers.length) defEl.classList.add('tentative');
      } else {
        defEl = h(
          'div',
          { class: 'unblocked', style: { '--seat-color': SEAT_COLORS[defenderSeat] } as any },
          h('span', { class: 'arrow', 'aria-hidden': 'true' }, attackerIsBottom ? '▲' : '▼'),
          h('span', null, atk.status === 'resolved' ? 'resolved' : `Unblocked → ${v.players[defenderSeat]!.name}'s Lab`),
        );
      }
      const topEl = attackerIsBottom ? defEl : attEl;
      const botEl = attackerIsBottom ? attEl : defEl;
      const multi = v.players.filter((p) => !p.eliminated).length > 2 || v.players.length > 2;
      cols.push(
        h(
          'div',
          { class: `bf-col${atk.status === 'resolved' ? ' resolved' : ''}`, dataset: { attack: atk.id }, style: { '--seat-color': SEAT_COLORS[defenderSeat] } as any },
          multi ? h('div', { class: 'bf-label' }, `${v.players[atk.seat]!.name} → ${v.players[defenderSeat]!.name}`) : null,
          h('div', { class: 'bf-cell top' }, topEl),
          h('div', { class: 'bf-tether', 'aria-hidden': 'true' }),
          h('div', { class: 'bf-cell bottom' }, botEl),
        ),
      );
    }
    // Power / Trap cards on the stack, shown in the middle of the field
    const stack = v.stack.map((it) => {
      const el = this.cardEl(it.uid, 'stackItem', it.controller, seen);
      return h('div', { class: 'stack-item' }, el, it.target ? h('span', { class: 'stack-target' }, `→ ${v.defs[v.cards[it.target]?.cardId ?? '']?.name ?? 'target'}`) : null);
    });
    const parts: Node[] = [cols.length ? h('div', { class: 'bf-cols' }, ...cols) : h('div', { class: 'bf-empty faint' }, v.phase === 'battle' ? 'No battles' : '')];
    if (stack.length) parts.push(h('div', { class: 'stack-zone', 'aria-label': 'Cards waiting to resolve' }, h('div', { class: 'stack-title' }, 'Resolving'), ...stack));
    this.battlefield.replaceChildren(...parts);
  }

  private withPartner(uid: string): string[] {
    const p = this.view.cards[uid]?.stackPartner;
    return p ? [uid, p] : [uid];
  }
}
