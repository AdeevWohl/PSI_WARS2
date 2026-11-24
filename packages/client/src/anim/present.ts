/**
 * Presenter: plays one batch of (per-seat filtered) engine events as animations (§6.7).
 *
 * The board is rendered in its *final* state first. Every card that moved is then pinned at
 * its old position with a paused FLIP, and released when the event that moved it plays;
 * cards that left the board become ghosts. Overlay effects (dice, banners, damage numbers,
 * particles) play in event order. Skipping finishes everything instantly; the board is
 * already correct, so outcomes can never depend on animation.
 */
import type { Ability, CUType, GameEvent, Seat } from '@psi-wars/shared';
import type { GameView } from '@psi-wars/engine';
import { playSfx, type Sfx } from '../audio';
import { settings } from '../settings';
import { createCardEl, updateOverlays } from '../render/card';
import { BattleStage } from './battle-stage';
import { castSpell, type SpellEnv } from './spell-fx';
import { rules } from '../data';
import type { Board } from '../render/board';
import { DIE_COLOR } from '../render/dice';
import { h } from '../ui/dom';
import { Die3D } from './dice3d';
import { flipFace, flipFrom, snap, toStage, type Snap } from './flip';
import type { Fx } from './fx';
import { DUR, EASE, HOLD, type Timeline } from './timeline';

type Anchors = NonNullable<ReturnType<Board['anchors']>>;

export interface PresentEnv {
  board: Board;
  tl: Timeline;
  fx: Fx;
  layer: HTMLElement;
  shakeEl: HTMLElement;
  names: (seat: unknown) => string;
  onEvent: (index: number) => void;
  onBattle: (ev: GameEvent) => void;
  /** Plain-language narration for one event (null = nothing to say). */
  caption?: (ev: GameEvent) => { text: string; kind?: string } | null;
}

/** Events after which the rest of the board re-lays out (cards left or joined a row). */
const LAYOUT = new Set(['UnitDestroyed', 'StackResolved', 'UnitTrapped', 'UnitFreed', 'UnitRevived', 'CardReturnedToHand', 'BattleEnded', 'CUDestroyed']);

/** Events that get their own readable beat (a hold afterwards) and a caption. */
const BEATS = new Set(['CardPlayed', 'AttackersDeclared', 'BlockersAssigned', 'BattleResolved', 'UnitDestroyed', 'UnitDamaged', 'LabDamaged', 'UnitTrapped', 'EscapeAttempt', 'CardsRevealed', 'CardDiscarded', 'UnitRevived', 'Obliterated', 'Disoriented', 'SweepDamage', 'StackResolving', 'EquipmentAttached', 'EquipmentMoved', 'UnitsDisabled', 'PlayerEliminated']);

export interface BatchStart {
  before: Map<string, Snap & { zone?: string }>;
  anchors: Map<Seat, Anchors>;
  hp: Map<Seat, number>;
}

const CU_OF: Record<string, CUType> = { CU_DS: 'G', CU_NG: 'B', CU_BA: 'R', CU_MA: 'P' };
const CU_COLOR: Record<CUType, string> = { G: '#3ddc5c', B: '#3aa0ff', R: '#ff4a4a', P: '#b867ff' };

export class Presenter {
  private pins = new Map<string, Animation>();
  private hidden = new Set<HTMLElement>();
  private ghosts = new Map<string, HTMLElement>();
  private temps = new Set<HTMLElement>();
  private diceBox: HTMLElement | null = null;
  private dice = new Map<string, Die3D>();
  private start!: BatchStart;
  private view!: GameView;
  private viewer: Seat | null = null;
  private stage: BattleStage | null = null;
  private batch: GameEvent[] = [];
  private idx = 0;
  private fighters = new Map<string, { att: string[]; def: string[]; attSeat: Seat; defSeat: Seat }>();

  constructor(private env: PresentEnv) {}

  private get tl(): Timeline {
    return this.env.tl;
  }

  async play(events: GameEvent[], start: BatchStart, view: GameView, viewer: Seat | null): Promise<void> {
    this.start = start;
    this.view = view;
    this.viewer = viewer;
    const { board } = this.env;
    const now = board.elements();
    const removed = board.lastRemoved;

    // Who fights in each battle of this batch (for the spotlight).
    for (const e of events) {
      if (e.type === 'BattleResolved') {
        const a = e.att as { units: string[]; seat: Seat };
        const d = e.def as { units: string[]; seat: Seat };
        this.fighters.set(String(e.attackId), { att: a.units, def: d.units, attSeat: a.seat, defSeat: d.seat });
      }
    }
    // Which cards each event moves ("claims")
    const claimed = new Set<string>();
    for (const e of events) for (const u of this.claims(e)) claimed.add(u);

    // Pin claimed movers at their old place; animate everything else now (or after the
    // layout-changing event, when the batch has one).
    const holdLayout = events.some((e) => LAYOUT.has(e.type));
    for (const [uid, el] of now) {
      const b = start.before.get(uid);
      if (b) {
        if (claimed.has(uid)) {
          const a = flipFrom(this.tl, el, b, { paused: true, duration: DUR.travel });
          if (a) this.pins.set(uid, a);
        } else if (holdLayout) {
          // Other cards make room only once the event that changes the layout has played
          // (e.g. after a destroyed unit has shattered), not at the start of the batch.
          const a = flipFrom(this.tl, el, b, { paused: true, duration: DUR.std + 120 });
          if (a) this.reflow.push(a);
        } else {
          flipFrom(this.tl, el, b, { duration: DUR.std + 80 });
        }
      } else if (claimed.has(uid)) {
        el.style.opacity = '0';
        this.hidden.add(el);
      } else if (!this.tl.instant) {
        this.tl.animate(el, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: getComputedStyle(el).transform === 'none' ? 'none' : getComputedStyle(el).transform }], { duration: DUR.std, easing: EASE.outCubic });
      }
    }
    // Cards that left the board become ghosts at their last position.
    for (const [uid, el] of removed) {
      const b = start.before.get(uid);
      if (!b) continue;
      const g = this.ghost(el, b);
      if (claimed.has(uid)) this.ghosts.set(uid, g);
      else this.tl.done(this.tl.animate(g, [{ opacity: 1 }, { opacity: 0, transform: `${b.transform} scale(0.8)` }], { duration: DUR.std, easing: EASE.inQuad, fill: 'forwards' })).then(() => g.remove());
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      this.batch = events;
      this.idx = i;
      this.env.onEvent(i);
      this.narrate(ev);
      try {
        await this.step(ev);
        if (LAYOUT.has(ev.type)) this.releaseReflow();
        if (BEATS.has(ev.type) && !this.tl.instant) await this.tl.wait(HOLD[settings().holdTime] ?? HOLD.normal);
      } catch (err) {
        console.warn('animation step failed', ev?.type, err);
      }
    }
    this.env.onEvent(events.length);
    if (this.reflow.length && !this.tl.instant) {
      const pending = [...this.reflow];
      this.releaseReflow();
      await Promise.all(pending.map((a) => this.tl.done(a)));
    }
    this.finish();
  }

  private reflow: Animation[] = [];

  /** Let the rest of the board slide into its new layout. */
  private releaseReflow(): void {
    for (const a of this.reflow) {
      try {
        a.currentTime = 0;
        a.play();
      } catch {
        /* ignore */
      }
    }
    this.reflow = [];
  }

  /** Release anything still pinned/hidden and clear overlays. */
  finish(): void {
    for (const a of this.reflow) {
      try {
        a.play();
        a.finish();
      } catch {
        /* ignore */
      }
    }
    this.reflow = [];
    for (const a of this.pins.values()) {
      try {
        a.play();
        a.finish();
      } catch {
        /* ignore */
      }
    }
    this.pins.clear();
    for (const el of this.hidden) el.style.opacity = '';
    this.hidden.clear();
    for (const g of this.ghosts.values()) g.remove();
    this.ghosts.clear();
    for (const t of this.temps) t.remove();
    this.temps.clear();
    this.diceBox?.remove();
    this.diceBox = null;
    this.dice.clear();
    this.env.board.hpOverride.clear();
    // Keep the spotlight only while its battle is waiting on a decision (e.g. a re-roll).
    if (this.stage && (this.tl.instant || this.view?.battle?.current?.attackId !== this.stage.attackId)) {
      this.stage.dispose();
      this.stage = null;
    }
    this.fighters.clear();
  }

  // ---------- spotlight / showcase ----------

  private openStage(attackId: string): BattleStage | null {
    if (this.stage?.attackId === attackId) return this.stage;
    if (!settings().spotlight || this.tl.instant) return null;
    let f = this.fighters.get(attackId);
    if (!f) {
      const atk = this.view.battle?.attacks.find((a) => a.id === attackId);
      if (atk) f = { att: atk.units, def: atk.blockers, attSeat: atk.seat, defSeat: atk.target };
    }
    if (!f || !f.att.length || !f.def.length) return null;
    const host = this.env.layer.parentElement ?? this.env.layer;
    this.stage = new BattleStage(host, this.tl, this.view, attackId, { units: f.att, seat: f.attSeat }, { units: f.def, seat: f.defSeat }, this.env.names);
    this.stage.setUnits(f.att, f.def);
    return this.stage;
  }

  /** A played card is shown large in the middle first, then flies to where it goes. */
  private async showcase(cardId: string, from: { cx: number; cy: number } | null, fromOpponent: boolean, target: HTMLElement | undefined): Promise<void> {
    const def = this.view.defs[cardId];
    if (!def) return;
    const W = 280;
    const cx = (1920 - 392) / 2;
    const cy = 470;
    const card = createCardEl(null, def, { size: 'lg' });
    updateOverlays(card, def);
    card.style.setProperty('--w', `${W}px`);
    const color = def.cardType === 'BattleUnit' ? (def.unitType === 'Robot' ? '#4fd1ff' : def.unitType === 'Creature' ? '#ff8a4c' : '#c77dff') : def.cardType === 'Equipment' ? '#b867ff' : '#ffc857';
    const wrap = this.temp(h('div', { class: 'showcase', style: { left: `${cx}px`, top: `${cy}px`, '--glow': color } as any }, card, h('div', { class: 'showcase-name' }, def.name)));
    this.sfx('showcase');
    const sx = from ? from.cx - cx : 0;
    const sy = from ? from.cy - cy : 320;
    await this.tl.done(this.tl.animate(wrap, [
      { transform: `translate(-50%, -50%) translate(${sx}px, ${sy}px) scale(0.3) rotateY(${fromOpponent ? 90 : 0}deg)`, opacity: 0.5 },
      { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1.06) rotateY(0deg)', opacity: 1, offset: 0.75 },
      { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1) rotateY(0deg)', opacity: 1 },
    ], { duration: DUR.travel, easing: EASE.outQuint, fill: 'forwards' }));
    await this.tl.wait(650);
    if (target && target.isConnected) {
      const r = this.centre(target);
      const k = Math.max(0.2, r.w / W);
      await this.tl.done(this.tl.animate(wrap, [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${r.cx - cx}px, ${r.cy - cy}px) scale(${k})`, opacity: 1, offset: 0.85 },
        { transform: `translate(-50%, -50%) translate(${r.cx - cx}px, ${r.cy - cy}px) scale(${k})`, opacity: 0 },
      ], { duration: DUR.travel - 120, easing: EASE.inOutQuart, fill: 'forwards' }));
    } else {
      await this.tl.done(this.tl.animate(wrap, [{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, -50%) scale(0.8)' }], { duration: DUR.std, fill: 'forwards' }));
    }
    wrap.remove();
    this.temps.delete(wrap);
  }

  /** The landing: a slam, a shockwave across the board and a small shake. */
  private async slam(el: HTMLElement, color: string): Promise<void> {
    if (this.tl.instant) return;
    const base = getComputedStyle(el).transform;
    const bt = base === 'none' ? '' : base;
    this.sfx('slam');
    await this.tl.done(this.tl.animate(el, [{ transform: `${bt} translateY(-34px) scale(1.22)`, filter: 'brightness(1.9)' }, { transform: `${bt}`, filter: 'none' }], { duration: 230, easing: EASE.inQuad }));
    const r = this.centre(el);
    const ring = this.temp(h('div', { class: 'shockwave', style: { left: `${r.cx}px`, top: `${r.cy}px`, '--glow': color } as any }));
    this.tl.done(this.tl.animate(ring, [{ transform: 'translate(-50%, -50%) scale(0.2)', opacity: 0.9 }, { transform: 'translate(-50%, -50%) scale(4.5)', opacity: 0 }], { duration: 700, easing: EASE.outCubic, fill: 'forwards' })).then(() => ring.remove());
    this.env.fx.burst(r.cx, r.y + r.h * 0.92, { count: 26, color, speed: 3.4, ring: true });
    this.shake(0.7);
  }

  /** A red lightning bolt smites (x, y) from above. */
  private async bolt(x: number, y: number): Promise<void> {
    if (this.tl.instant) return;
    this.sfx('spell');
    const pts: string[] = [];
    let cx = x + (Math.random() * 160 - 80);
    for (let i = 0; i <= 10; i++) {
      const py = -40 + ((y + 40) * i) / 10;
      const px = i === 10 ? x : cx + (Math.random() * 70 - 35);
      cx = cx * 0.6 + x * 0.4;
      pts.push(`${px.toFixed(0)},${py.toFixed(0)}`);
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'bolt');
    svg.setAttribute('viewBox', '0 0 1920 1080');
    for (const [w, c] of [[22, 'rgba(255,40,40,0.35)'], [9, '#ff3b3b'], [3, '#fff4f0']] as const) {
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', pts.join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', c);
      pl.setAttribute('stroke-width', String(w));
      pl.setAttribute('stroke-linejoin', 'bevel');
      svg.appendChild(pl);
    }
    const el = this.temp(svg as unknown as HTMLElement);
    const flash = this.temp(h('div', { class: 'screen-flash', style: { '--flash': '#ff2a2a' } as any }));
    this.tl.done(this.tl.animate(flash, [{ opacity: 0 }, { opacity: 0.5, offset: 0.1 }, { opacity: 0 }], { duration: 500, fill: 'forwards' })).then(() => flash.remove());
    this.shake(1.6);
    this.env.fx.burst(x, y, { color: '#ff3b3b', count: 40, speed: 4.2, ring: true });
    await this.tl.done(this.tl.animate(el, [{ opacity: 0 }, { opacity: 1, offset: 0.05 }, { opacity: 0.25, offset: 0.25 }, { opacity: 1, offset: 0.4 }, { opacity: 0.6, offset: 0.7 }, { opacity: 0 }], { duration: 650, fill: 'forwards' }));
    el.remove();
    this.temps.delete(el);
  }

  private spellEnv(): SpellEnv {
    return {
      tl: this.tl,
      fx: this.env.fx,
      view: this.view,
      temp: (el) => this.temp(el),
      untemp: (el) => {
        el.remove();
        this.temps.delete(el);
      },
      shake: (n) => this.shake(n),
      at: (uid) => {
        const el = uid ? this.el(uid) : undefined;
        if (!el) return null;
        const r = this.centre(el);
        return { x: r.cx, y: r.cy, w: r.w, h: r.h };
      },
      area: (seat) => {
        const a = this.env.board.anchors(seat);
        if (!a) return null;
        const p = (k: { cx: number; cy: number }) => ({ x: k.cx, y: k.cy });
        return { hp: p(a.hp), discard: p(a.discard), battleDeck: p(a.battleDeck), area: p(a.area) };
      },
    };
  }

  private floatNumber(x: number, y: number, text: string, cls = 'dmg-num'): void {
    if (this.tl.instant) return;
    const num = this.temp(h('div', { class: cls }, text));
    Object.assign(num.style, { left: `${x}px`, top: `${y}px` });
    this.tl.done(this.tl.animate(num, [{ transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 }, { transform: 'translate(-50%, -80%) scale(1.4)', opacity: 1, offset: 0.2 }, { transform: 'translate(-50%, -220%) scale(1)', opacity: 0 }], { duration: 1200, easing: EASE.outQuint, fill: 'forwards' })).then(() => num.remove());
  }

  // ---------- narration ----------

  private captionEl: HTMLElement | null = null;

  /** The caption strip at the top of the battlefield says what is happening, in words. */
  private narrate(e: GameEvent): void {
    const line = this.env.caption?.(e);
    if (!line) return;
    if (!this.captionEl || !this.captionEl.isConnected) {
      this.captionEl = h('div', { class: 'caption-strip', role: 'status', 'aria-live': 'polite' });
      this.env.layer.parentElement?.appendChild(this.captionEl);
    }
    const el = this.captionEl;
    el.textContent = line.text;
    el.classList.toggle('big', line.kind === 'big');
    el.classList.add('show');
    if (!this.tl.instant) this.tl.animate(el, [{ opacity: 0.2, transform: 'translate(-50%, -6px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: DUR.micro, easing: EASE.outCubic });
    clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => el.classList.remove('show'), 4000);
  }

  private captionTimer = 0;

  // ---------- helpers ----------

  private claims(e: GameEvent): string[] {
    const u = (x: unknown) => (typeof x === 'string' ? [x] : []);
    switch (e.type) {
      case 'CardPlayed':
      case 'CardDrawn':
      case 'EquipmentAttached':
      case 'EquipmentMoved':
      case 'EquipmentDiscarded':
      case 'UnitFreed':
      case 'UnitDestroyed':
      case 'CardReturnedToHand':
      case 'CardSearched':
      case 'CardTutored':
      case 'CardMilled':
      case 'StackResolved':
        return u(e.uid);
      case 'UnitTrapped':
        return [...u(e.uid), ...u(e.trap)];
      case 'Stacked':
      case 'Unstacked':
        return (e.uids as string[]) ?? [];
      case 'UnitRevived':
        return [String(e.uid)];
      case 'AttackersDeclared':
        return ((e.attacks as { units: string[] }[]) ?? []).flatMap((a) => a.units);
      case 'BlockersAssigned':
        return ((e.blocks as { units: string[] }[]) ?? []).flatMap((b) => b.units ?? []);
      case 'BattleEnded':
        return [...this.start.before.entries()].filter(([, s]) => s.zone === 'battle').map(([uid]) => uid);
      default:
        return [];
    }
  }

  private ghost(el: HTMLElement, b: Snap): HTMLElement {
    el.style.opacity = '';
    el.classList.add('anim-ghost');
    const w = b.w;
    Object.assign(el.style, { position: 'absolute', left: `${b.cx - w / 2}px`, top: `${b.cy - w / 0.7243 / 2}px`, width: `${w}px`, transform: b.transform || 'none' });
    el.style.setProperty('--w', `${w}px`);
    this.env.layer.appendChild(el);
    return el;
  }

  private el(uid: unknown): HTMLElement | undefined {
    return typeof uid === 'string' ? this.env.board.elements().get(uid) : undefined;
  }

  /** Release a pinned card (or reveal a hidden arrival from an anchor). */
  private release(uid: string, from?: { cx: number; cy: number; w: number }, opts: { flipFace?: boolean; land?: boolean; arc?: number; easing?: string; duration?: number } = {}): Animation | null {
    const el = this.el(uid);
    if (!el) return null;
    const pin = this.pins.get(uid);
    if (pin) {
      this.pins.delete(uid);
      pin.play();
      if (opts.flipFace) flipFace(this.tl, el, opts.duration ?? DUR.travel);
      return pin;
    }
    if (this.hidden.has(el)) {
      this.hidden.delete(el);
      el.style.opacity = '';
      if (from) return flipFrom(this.tl, el, { ...from, transform: '' }, { arc: opts.arc, flipFace: opts.flipFace, land: opts.land, easing: opts.easing, duration: opts.duration });
    }
    return null;
  }

  private centre(el: Element): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
    return toStage(el.getBoundingClientRect());
  }

  private sfx(name: Sfx): void {
    if (!this.tl.instant || name === 'victory' || name === 'defeat') playSfx(name);
  }

  private shake(strength: number): void {
    const level = settings().shake;
    if (level === 'off' || this.tl.instant) return;
    const k = (level === 'subtle' ? 0.45 : 1) * Math.min(strength, 3);
    const frames = [0, -1, 1, -0.6, 0.6, -0.3, 0].map((f) => ({ transform: `translate(${f * 9 * k}px, ${f * -5 * k}px)` }));
    this.tl.animate(this.env.shakeEl, frames, { duration: 320, easing: 'linear' });
  }

  private temp(el: HTMLElement): HTMLElement {
    this.env.layer.appendChild(el);
    this.temps.add(el);
    return el;
  }

  private async flyTemp(cardId: string | null, deck: 'battle' | 'resource', from: { cx: number; cy: number; w: number }, to: { cx: number; cy: number }, flip: boolean): Promise<void> {
    if (this.tl.instant) return;
    const def = cardId ? this.view.defs[cardId] ?? null : null;
    const el = createCardEl(null, def ?? ({ deck } as any), { size: 'sm' });
    if (!def) el.classList.add('face-down');
    const w = from.w;
    Object.assign(el.style, { position: 'absolute', left: `${to.cx - w / 2}px`, top: `${to.cy - w / 0.7243 / 2}px`, width: `${w}px` });
    el.style.setProperty('--w', `${w}px`);
    this.temp(el);
    const a = flipFrom(this.tl, el, { cx: from.cx, cy: from.cy, w, transform: '' }, { arc: 60, flipFace: flip && !!def, duration: DUR.travel });
    await this.tl.done(a);
    await this.tl.done(this.tl.animate(el, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.6)' }], { duration: DUR.micro, fill: 'forwards' }));
    el.remove();
    this.temps.delete(el);
  }

  private banner(text: string, sub: string | null, color: string): Promise<void> {
    if (this.tl.instant) return Promise.resolve();
    const el = this.temp(h('div', { class: 'banner', style: { '--banner-color': color } as any }, h('div', { class: 'banner-text' }, text), sub ? h('div', { class: 'banner-sub' }, sub) : null));
    const a = this.tl.animate(el, [
      { transform: 'translateX(-110%) skewX(-12deg)', opacity: 0 },
      { transform: 'translateX(0) skewX(-12deg)', opacity: 1, offset: 0.25 },
      { transform: 'translateX(0) skewX(-12deg)', opacity: 1, offset: 0.7 },
      { transform: 'translateX(110%) skewX(-12deg)', opacity: 0 },
    ], { duration: 1050, easing: EASE.inOutQuart, fill: 'forwards' });
    return this.tl.done(a).then(() => {
      el.remove();
      this.temps.delete(el);
    });
  }

  private aura(el: HTMLElement | undefined, ability: Ability | 'danger' | 'gold'): void {
    if (!el || this.tl.instant || settings().glow === 'off') return;
    const color = ability === 'danger' ? '#ff4d6d' : ability === 'gold' ? '#ffc857' : DIE_COLOR[ability];
    const halo = h('div', { class: 'aura', style: { '--aura': color } as any });
    el.appendChild(halo);
    this.tl.done(this.tl.animate(halo, [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'scale(1.06)', offset: 0.35 }, { opacity: 0, transform: 'scale(1.15)' }], { duration: 760, easing: EASE.outCubic, fill: 'forwards' })).then(() => halo.remove());
  }

  private ensureDiceBox(attackId: string): HTMLElement {
    if (this.diceBox) return this.diceBox;
    const col = document.querySelector(`.bf-col[data-attack="${CSS.escape(attackId)}"]`);
    const r = col ? this.centre(col) : { cx: 780, cy: 470 };
    const box = h('div', { class: 'dice-box' }, h('div', { class: 'dice-row top' }), h('div', { class: 'dice-row bottom' }));
    Object.assign(box.style, { left: `${r.cx + 120}px`, top: `${r.cy}px` });
    this.env.layer.appendChild(box);
    this.diceBox = box;
    return box;
  }

  // ---------- the catalogue ----------

  private async step(e: GameEvent): Promise<void> {
    const tl = this.tl;
    const v = this.view;
    if (this.stage) {
      const same = e.attackId === undefined || String(e.attackId) === this.stage.attackId;
      const battleBeat = ['XRolled', 'RollModified', 'AbilityRoll', 'DiceRolled', 'Obliterated', 'Disoriented', 'PsionicWin', 'Rerolled', 'BattleResolved', 'UnitDamaged'].includes(e.type);
      if (!battleBeat || !same) {
        await this.stage.close(e.type === 'UnitDestroyed' ? 500 : 900);
        this.stage = null;
      }
    }
    const anchorsOf = (seat: unknown): Anchors | undefined => (typeof seat === 'number' ? this.start.anchors.get(seat) ?? this.env.board.anchors(seat) ?? undefined : undefined);
    switch (e.type) {
      case 'TurnStarted': {
        const seat = e.seat as Seat;
        this.sfx('phase');
        const area = this.env.board.areaFor(seat)?.root;
        if (area && !tl.instant) tl.animate(area, [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 60px 6px color-mix(in srgb, var(--seat-color) 35%, transparent)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 900 });
        await this.banner(seat === this.viewer ? 'YOUR TURN' : `${this.env.names(seat).toUpperCase()}'S TURN`, `Turn ${e.turn}`, 'var(--seat-color, #4fd1ff)');
        return;
      }
      case 'PhaseChanged': {
        const now = document.querySelector('.phase.now');
        if (now && !tl.instant) tl.animate(now, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: DUR.std * 1.5, easing: EASE.outBack });
        if (e.phase === 'battle' && e.seat === v.turn.active && settings().speed !== 'fast') await this.banner('BATTLE', null, '#ff4a4a');
        return;
      }
      case 'CardDrawn': {
        const a = anchorsOf(e.seat);
        if (!a) return;
        const deck = e.deck === 'resource' ? a.resourceDeck : a.battleDeck;
        const from = { cx: deck.cx, cy: deck.cy, w: deck.w };
        this.sfx('draw');
        if (typeof e.uid === 'string' && this.el(e.uid)) {
          const anim = this.release(e.uid, from, { flipFace: true, arc: 90, duration: 520 });
          await tl.wait(160);
          void anim;
        } else {
          await this.flyTemp(null, e.deck === 'resource' ? 'resource' : 'battle', from, { cx: a.hand.cx, cy: a.hand.cy }, false);
        }
        return;
      }
      case 'CUEntered': {
        const a = anchorsOf(e.seat);
        const t = CU_OF[String(e.cardId)];
        const group = t ? this.env.board.cuGroupEl(e.seat as Seat, t) : null;
        if (!a || !group) return;
        const g = this.centre(group);
        await this.flyTemp(String(e.cardId), 'resource', { cx: a.resourceDeck.cx, cy: a.resourceDeck.cy, w: 60 }, { cx: g.cx, cy: g.cy }, true);
        if (!tl.instant) tl.animate(group, [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: DUR.std, easing: EASE.outBack });
        this.env.fx.burst(g.cx, g.cy, { color: t ? CU_COLOR[t] : '#fff', count: 10, speed: 2 });
        return;
      }
      case 'CUDepleted': {
        this.sfx('cuDeplete');
        const seat = e.seat as Seat;
        for (const t of ['G', 'B', 'R', 'P'] as CUType[]) {
          const g = this.env.board.cuGroupEl(seat, t);
          const art = g?.querySelector('.cu-art');
          if (art && !tl.instant) tl.animate(art, [{ transform: 'rotate(0)', filter: 'none' }, { transform: 'rotate(90deg)', filter: 'saturate(0.2)', offset: 0.6 }, { transform: 'rotate(0)', filter: 'none' }], { duration: DUR.std * 1.6, easing: EASE.outCubic });
        }
        await tl.wait(DUR.micro);
        return;
      }
      case 'CUDestroyed': {
        const seat = e.seat as Seat;
        const a = anchorsOf(seat);
        for (const id of (e.cardIds as string[]) ?? []) {
          const t = CU_OF[id];
          const g = t ? this.env.board.cuGroupEl(seat, t) : null;
          if (g && a) {
            const r = this.centre(g);
            this.env.fx.shards({ x: r.x, y: r.y, w: 40, h: 40 }, t ? CU_COLOR[t] : '#fff', { x: a.discard.cx, y: a.discard.cy });
          }
        }
        await tl.wait(DUR.std);
        return;
      }
      case 'CardPlayed': {
        const uid = String(e.uid);
        const el = this.el(uid);
        const a = anchorsOf(e.seat);
        this.sfx('play');
        const mode = settings().showcase;
        // Your own targeted spells were already shown big in the staging area.
        const stagedSpell = e.seat === this.viewer && (e.cardType === 'Power' || e.cardType === 'Trap') && !!e.target;
        const show = !tl.instant && !stagedSpell && e.cardType !== 'Resource' && (mode === 'on' || (mode === 'opponents' && e.seat !== this.viewer));
        if (show) {
          const prev = el?.style.opacity ?? '';
          if (el) el.style.opacity = '0';
          await this.showcase(String(e.cardId), a ? { cx: a.hand.cx, cy: a.hand.cy } : null, e.seat !== this.viewer, el);
          if (el) el.style.opacity = prev === '0' ? '' : prev;
        }
        const anim = this.release(uid, a ? { cx: a.hand.cx, cy: a.hand.cy, w: 80 } : undefined, { flipFace: !show && e.seat !== this.viewer, land: !show, duration: show ? 1 : DUR.travel + 80 });
        await tl.done(anim);
        if (el && e.cardType !== 'Resource') {
          const color = e.cardType === 'Equipment' ? '#b867ff' : e.cardType === 'BattleUnit' ? '#8be9ff' : '#ffc857';
          if (show && e.cardType === 'BattleUnit') await this.slam(el, color);
          else {
            const r = this.centre(el);
            this.env.fx.burst(r.cx, r.y + r.h * 0.9, { count: 16, color, speed: 2.6, ring: true });
          }
        }
        return;
      }
      case 'UnitDamaged': {
        const el = this.el(e.uid);
        this.sfx('damage');
        if (this.stage && String(e.attackId) === this.stage.attackId) this.stage.damaged(e);
        if (el) {
          const r = this.centre(el);
          // A damage spell smites from above; sweeps just hit.
          if (e.cause === 'effect' && !this.batch.some((x) => x.type === 'SweepDamage' && x.source === e.source)) await this.bolt(r.cx, r.cy);
          else if (e.cause === 'effect') this.env.fx.burst(r.cx, r.cy, { color: '#ffffff', count: 10, speed: 2 });
          this.floatNumber(r.cx, r.cy, `−${e.amount}`, Number(e.amount) >= 3 ? 'dmg-num crit' : 'dmg-num');
          this.aura(el, 'danger');
          this.env.fx.burst(r.cx, r.cy, { color: '#ff4d6d', count: 12 + Number(e.amount) * 3, speed: 2.4 });
          this.shake(0.3 + Number(e.amount) * 0.15);
        }
        return;
      }
      case 'SweepDamage': {
        this.sfx('sweep');
        if (!tl.instant && !this.batch.some((x) => x.type === 'StackResolving' && x.uid === e.source)) {
          const flash = this.temp(h('div', { class: 'screen-flash', style: { '--flash': '#ff6a5a' } as any }));
          tl.done(tl.animate(flash, [{ opacity: 0 }, { opacity: 0.35, offset: 0.2 }, { opacity: 0 }], { duration: 600, fill: 'forwards' })).then(() => flash.remove());
          const ring = this.temp(h('div', { class: 'shockwave big', style: { left: `${(1920 - 392) / 2}px`, top: '540px', '--glow': '#ff6a5a' } as any }));
          await tl.done(tl.animate(ring, [{ transform: 'translate(-50%, -50%) scale(0.1)', opacity: 1 }, { transform: 'translate(-50%, -50%) scale(9)', opacity: 0 }], { duration: 900, easing: EASE.outCubic, fill: 'forwards' }));
          ring.remove();
        }
        return;
      }
      case 'UnitRevived': {
        const uid = String(e.uid);
        const a = anchorsOf(e.seat);
        this.sfx('revive');
        const anim = this.release(uid, a ? { cx: a.discard.cx, cy: a.discard.cy, w: 70 } : undefined, { land: true, duration: DUR.travel + 120 });
        await tl.done(anim);
        const el = this.el(uid);
        if (el) {
          const r = this.centre(el);
          this.env.fx.burst(r.cx, r.cy, { color: '#ffc857', count: 30, speed: 2.8, ring: true });
          this.aura(el, 'gold');
        }
        return;
      }
      case 'CardDiscarded': {
        const a = anchorsOf(e.seat);
        if (a) await this.flyTemp(String(e.cardId), 'battle', { cx: a.hand.cx, cy: a.hand.cy, w: 110 }, { cx: a.discard.cx, cy: a.discard.cy }, true);
        return;
      }
      case 'ResourceFortified':
      case 'CUFortified': {
        const a = anchorsOf(e.seat);
        this.sfx('shield');
        if (a && !tl.instant) {
          this.env.fx.burst(a.cus.cx, a.cus.cy, { color: '#ffd36a', count: 18, speed: 2, ring: true });
          this.floatNumber(a.cus.cx, a.cus.cy - 20, '🛡', 'shield-num');
        }
        await tl.wait(DUR.std);
        return;
      }
      case 'EquipmentAttached':
      case 'EquipmentMoved': {
        const uid = String(e.uid);
        const anim = this.release(uid, undefined, { easing: EASE.spring });
        await tl.done(anim);
        const def = v.defs[String(e.cardId)];
        const unit = this.el(e.type === 'EquipmentAttached' ? e.unit : e.toUnit);
        if (def?.equip) this.aura(unit, def.equip.ability);
        this.sfx('play');
        return;
      }
      case 'EquipmentDiscarded':
      case 'StackResolved':
      case 'CardReturnedToHand':
      case 'CardSearched':
      case 'CardTutored':
      case 'UnitFreed': {
        if (typeof e.uid !== 'string') return;
        const g = this.ghosts.get(e.uid);
        if (g) {
          this.ghosts.delete(e.uid);
          await tl.done(tl.animate(g, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.7)' }], { duration: DUR.std, fill: 'forwards' }));
          g.remove();
          return;
        }
        const a = anchorsOf(e.seat);
        await tl.done(this.release(e.uid, a ? { cx: a.battleDeck.cx, cy: a.battleDeck.cy, w: 40 } : undefined, { flipFace: e.type === 'CardSearched' }));
        return;
      }
      case 'CardMilled': {
        const a = anchorsOf(e.seat);
        if (a) await this.flyTemp(String(e.cardId), 'resource', { cx: a.resourceDeck.cx, cy: a.resourceDeck.cy, w: 50 }, { cx: a.discard.cx, cy: a.discard.cy }, true);
        this.release(String(e.uid));
        return;
      }
      case 'Stacked':
      case 'Unstacked': {
        const anims = ((e.uids as string[]) ?? []).map((u) => this.release(u, undefined, { easing: EASE.spring }));
        await Promise.all(anims.map((x) => tl.done(x)));
        for (const u of (e.uids as string[]) ?? []) this.aura(this.el(u), 'gold');
        return;
      }
      case 'AttackersDeclared': {
        const attacks = (e.attacks as { units: string[] }[]) ?? [];
        if (!attacks.length) return;
        this.sfx('play');
        let last: Animation | null = null;
        let i = 0;
        for (const atk of attacks) {
          for (const u of atk.units) {
            const b = this.start.before.get(u);
            const el = this.el(u);
            const delay = i++ * 90;
            if (b && el) setTimeout(() => {
              const r = this.centre(el);
              this.env.fx.stream({ x: b.cx, y: b.cy }, { x: r.cx, y: r.cy }, '#ff6a5a', 12);
            }, tl.dur(delay));
            const pin = this.pins.get(u);
            if (pin) {
              this.pins.delete(u);
              pin.currentTime = 0;
              if (delay && !tl.instant) setTimeout(() => pin.play(), tl.dur(delay));
              else pin.play();
              last = pin;
            }
          }
        }
        await tl.done(last);
        return;
      }
      case 'BlockersAssigned': {
        const blocks = (e.blocks as { units: string[]; attacker: string }[]) ?? [];
        const anims = blocks.flatMap((b) => (b.units ?? []).map((u) => this.release(u)));
        await Promise.all(anims.map((x) => tl.done(x)));
        for (const b of blocks) {
          const teth = document.querySelector(`.bf-col[data-attack="${CSS.escape(b.attacker)}"] .bf-tether`);
          if (teth && !tl.instant) tl.animate(teth, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1.15)', offset: 0.7 }, { transform: 'scaleY(1)' }], { duration: DUR.std * 1.4, easing: EASE.outBack });
        }
        return;
      }
      case 'StackResolving': {
        const el = this.el(e.uid);
        this.aura(el, 'gold');
        this.sfx('spell');
        const r = el ? this.centre(el) : null;
        const from = r ? { x: r.cx, y: r.cy } : { x: (1920 - 392) / 2, y: 540 };
        if (!tl.instant) await castSpell(this.spellEnv(), String(e.cardId), Number(e.controller), from, (e.target as string | null) ?? null);
        else await tl.wait(DUR.std);
        return;
      }
      case 'UnitTrapped': {
        const uid = String(e.uid);
        const el = this.el(uid);
        this.sfx('trap');
        if (el && !tl.instant) {
          const cage = h('div', { class: 'cage' });
          el.appendChild(cage);
          await tl.done(tl.animate(cage, [{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], { duration: DUR.std * 1.6, easing: EASE.outBack, fill: 'forwards' }));
          const r = this.centre(el);
          this.env.fx.burst(r.cx, r.cy, { color: '#9fe3ff', count: 20, speed: 2 });
          await tl.done(this.release(uid, undefined, { duration: DUR.travel + 120 }));
          this.release(String(e.trap));
          cage.remove();
        } else {
          this.release(uid);
          this.release(String(e.trap));
        }
        return;
      }
      case 'TrapFizzled': {
        await tl.wait(DUR.std);
        return;
      }
      case 'UnitsDisabled': {
        for (const u of (e.uids as string[]) ?? []) this.aura(this.el(u), 'danger');
        await tl.wait(DUR.std);
        return;
      }
      case 'RemovedFromBattle': {
        const el = this.el(e.uid);
        if (el && !tl.instant) tl.animate(el, [{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: DUR.std * 2 });
        await tl.wait(DUR.micro);
        return;
      }
      case 'XRolled':
      case 'RollModified':
      case 'AbilityRoll': {
        const el = this.el(e.uid);
        if (!el || tl.instant) return;
        const r = this.centre(el);
        const die = new Die3D('physical', Number(e.side), v.config.diceVariant, 40);
        const label = e.type === 'XRolled' ? `X = ${e.value}` : e.type === 'RollModified' ? `${Number(e.delta) > 0 ? '+' : ''}${e.delta}` : Number(e.side) === 6 ? 'Obliterate!' : '';
        const pop = this.temp(h('div', { class: 'mini-roll', style: { left: `${r.cx}px`, top: `${r.y - 10}px` } }, die.el, label ? h('span', null, label) : null));
        this.sfx('dice');
        await tl.done(die.roll(tl, Number(e.side)));
        await tl.wait(420);
        pop.remove();
        this.temps.delete(pop);
        return;
      }
      case 'DiceRolled': {
        const stage = this.openStage(String(e.attackId));
        if (stage && !tl.instant) {
          await tl.wait(DUR.travel);
          // This battle's later events in this batch (up to its result), for step-by-step play.
          const ahead: GameEvent[] = [];
          for (let k = this.idx + 1; k < this.batch.length; k++) {
            const x = this.batch[k]!;
            if (x.attackId !== undefined && String(x.attackId) !== stage.attackId) break;
            ahead.push(x);
            if (x.type === 'BattleResolved') break;
          }
          await stage.playDice(e, ahead, rules.dice[v.config.diceVariant] as any, (ab, face, who) => {
            const die = new Die3D(ab, face, v.config.diceVariant, 84);
            this.dice.set(`${who}:${ab}`, die);
            return {
              el: die.el,
              roll: (delay, duration) => die.roll(tl, face, delay, duration),
              shatter: () => {
                const r = this.centre(die.el);
                this.env.fx.shards({ x: r.x, y: r.y, w: r.w, h: r.h }, DIE_COLOR[ab]);
                void die.shatter(tl);
              },
            };
          }, (n) => this.sfx(n));
          return;
        }
        const box = stage ? null : this.ensureDiceBox(String(e.attackId));
        const att = e.att as Record<string, any>;
        const def = e.def as Record<string, any>;
        const viewerIsAtt = att.seat === this.viewer;
        const fallback = box ? { att: box.querySelector(viewerIsAtt ? '.dice-row.bottom' : '.dice-row.top')!, def: box.querySelector(viewerIsAtt ? '.dice-row.top' : '.dice-row.bottom')! } : null;
        const rows = fallback;
        this.sfx('dice');
        let last: Animation | null = null;
        let i = 0;
        for (const side of ['att', 'def'] as const) {
          const d = side === 'att' ? att : def;
          for (const ab of ['cyber', 'psionic', 'physical'] as const) {
            if (d[ab] === null || d[ab] === undefined) continue;
            const die = new Die3D(ab, d[ab], v.config.diceVariant, stage ? 76 : 58);
            this.dice.set(`${side}:${ab}`, die);
            (stage?.dieSlot(side, ab) ?? rows?.[side])?.appendChild(die.el);
            last = die.roll(tl, d[ab], i++ * 90) ?? last;
          }
        }
        await tl.done(last);
        return;
      }
      case 'Obliterated': {
        if (this.stage?.presented) return;
        this.sfx('obliterate');
        const ab = e.die as Ability;
        const victims = e.by === 'both' ? ['att', 'def'] : e.by === 'att' ? ['def'] : ['att'];
        if (!tl.instant) {
          const flash = this.temp(h('div', { class: 'screen-flash', style: { '--flash': DIE_COLOR[ab] } as any }));
          tl.done(tl.animate(flash, [{ opacity: 0 }, { opacity: 0.55, offset: 0.15 }, { opacity: 0 }], { duration: 520, fill: 'forwards' })).then(() => flash.remove());
          this.shake(1.6);
          const call = this.temp(h('div', { class: 'callout', style: { color: DIE_COLOR[ab] } }, `${ab.toUpperCase()} OBLITERATE`, h('small', null, e.by === 'both' ? 'both dice destroyed' : 'opposing die destroyed')));
          tl.done(tl.animate(call, [{ opacity: 0, transform: 'translate(-50%, -50%) scale(1.6)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1200, easing: EASE.outQuint, fill: 'forwards' })).then(() => call.remove());
        }
        for (const s of victims) {
          const die = this.dice.get(`${s}:${ab}`);
          if (die) {
            const r = this.centre(die.el);
            this.env.fx.shards({ x: r.x, y: r.y, w: r.w, h: r.h }, DIE_COLOR[ab]);
            void die.shatter(tl);
          }
        }
        await tl.wait(560);
        return;
      }
      case 'Disoriented': {
        if (this.stage?.presented) return;
        this.sfx('disorient');
        if (this.stage) {
          await this.stage.disoriented(e);
          return;
        }
        for (const u of (e.uids as string[]) ?? []) {
          const el = this.el(u);
          if (!el) continue;
          const r = this.centre(el);
          this.env.fx.burst(r.cx, r.cy, { color: '#3ddc5c', count: 14, speed: 1.6, ring: true });
          this.aura(el, 'cyber');
        }
        await tl.wait(DUR.std * 1.5);
        return;
      }
      case 'PsionicWin': {
        await tl.wait(DUR.micro);
        return;
      }
      case 'Rerolled': {
        const die = this.dice.get(`${e.side}:physical`);
        if (die) await tl.done(die.reroll(tl, Number(e.physical)));
        this.sfx('dice');
        return;
      }
      case 'BattleResolved': {
        this.env.onBattle(e);
        const stage = this.openStage(String(e.attackId));
        if (stage) {
          await stage.resolved(e);
          await tl.wait(500);
          this.diceBox?.remove();
          this.diceBox = null;
          this.dice.clear();
          return;
        }
        const winners = e.winners as Record<string, 'att' | 'def' | null>;
        const att = e.att as { units: string[] };
        const def = e.def as { units: string[] };
        for (const ab of ['cyber', 'psionic', 'physical'] as const) {
          const w = winners[ab];
          if (w) for (const u of w === 'att' ? att.units : def.units) this.aura(this.el(u), ab);
        }
        await tl.wait(650);
        this.diceBox?.remove();
        this.diceBox = null;
        this.dice.clear();
        return;
      }
      case 'UnitDestroyed': {
        const uid = String(e.uid);
        const b = this.start.before.get(uid);
        const a = anchorsOf(e.seat);
        this.sfx('destroy');
        const real = this.el(uid);
        let shell = this.ghosts.get(uid);
        if (!shell && real && b) {
          shell = this.ghost(real.cloneNode(true) as HTMLElement, b);
          this.temps.add(shell);
          const pin = this.pins.get(uid);
          if (pin) {
            this.pins.delete(uid);
            pin.finish();
          }
          real.style.opacity = '0';
          this.hidden.add(real);
        }
        if (shell) {
          this.ghosts.delete(uid);
          const r = this.centre(shell);
          await tl.done(tl.animate(shell, [{ filter: 'brightness(1)' }, { filter: 'brightness(4) saturate(0)', offset: 0.35 }, { filter: 'brightness(2)', opacity: 0, transform: `${b?.transform ?? ''} scale(1.08)` }], { duration: 420, easing: EASE.outQuint, fill: 'forwards' }));
          this.env.fx.shards({ x: r.x, y: r.y, w: r.w, h: r.h }, '#d8f4ff', a ? { x: a.discard.cx, y: a.discard.cy } : undefined);
          shell.remove();
        }
        if (real && this.hidden.has(real)) {
          this.hidden.delete(real);
          real.style.opacity = '';
          if (!tl.instant) tl.animate(real, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.std, delay: 200 });
        }
        await tl.wait(DUR.std);
        return;
      }
      case 'UnblockedHit': {
        const a = anchorsOf(e.target);
        if (!a || tl.instant) return;
        const anims = ((e.units as string[]) ?? []).map((u) => {
          const el = this.el(u);
          if (!el) return null;
          const r = this.centre(el);
          const dx = (a.hp.cx - r.cx) * 0.25;
          const dy = (a.hp.cy - r.cy) * 0.25;
          const base = getComputedStyle(el).transform;
          const bt = base === 'none' ? '' : base;
          return tl.animate(el, [{ transform: `${bt}` }, { transform: `translate(${dx}px, ${dy}px) ${bt}`, offset: 0.45 }, { transform: `${bt}` }], { duration: 420, easing: EASE.inOutQuart });
        });
        await Promise.all(anims.map((x) => tl.done(x)));
        return;
      }
      case 'LabDamaged': {
        const seat = e.seat as Seat;
        const amount = Number(e.amount);
        const srcCard = typeof e.source === 'string' ? v.cards[e.source] : undefined;
        const srcDef = srcCard ? v.defs[srcCard.cardId] : undefined;
        const hpA = this.env.board.anchors(seat);
        if (srcDef?.cardType === 'Power' && hpA) await this.bolt(hpA.hp.cx, hpA.hp.cy);
        this.env.board.setHp(seat, Number(e.hp));
        this.sfx('labHit');
        const a = this.env.board.anchors(seat);
        if (a && !tl.instant) {
          const num = this.temp(h('div', { class: amount >= 3 ? 'dmg-num crit' : 'dmg-num' }, `−${amount}`));
          const hpEl = this.env.board.areaFor(seat)?.root.querySelector('.hp-wrap');
          if (hpEl) {
            hpEl.classList.remove('hit');
            void (hpEl as HTMLElement).offsetWidth;
            hpEl.classList.add('hit');
          }
          Object.assign(num.style, { left: `${a.hp.cx}px`, top: `${a.hp.cy}px` });
          tl.done(tl.animate(num, [{ transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 }, { transform: 'translate(-50%, -80%) scale(1.5)', opacity: 1, offset: 0.2 }, { transform: 'translate(-50%, -260%) scale(1)', opacity: 0 }], { duration: 1100, easing: EASE.outQuint, fill: 'forwards' })).then(() => num.remove());
          this.env.fx.burst(a.hp.cx, a.hp.cy, { color: '#ff4d6d', count: 14 + amount * 4, speed: 3 });
        }
        if (seat === this.viewer && !tl.instant) {
          const vig = this.temp(h('div', { class: 'vignette' }));
          tl.done(tl.animate(vig, [{ opacity: 0 }, { opacity: Math.min(1, 0.4 + amount * 0.12), offset: 0.2 }, { opacity: 0 }], { duration: 900, fill: 'forwards' })).then(() => vig.remove());
        }
        this.shake(0.5 + amount * 0.35);
        await tl.wait(480);
        return;
      }
      case 'EscapeAttempt': {
        const el = this.el(e.uid);
        if (!el || tl.instant) return;
        const cage = h('div', { class: 'cage' });
        el.appendChild(cage);
        tl.animate(cage, [{ transform: 'scale(1)' }, { transform: 'scale(1.06, 0.96)' }, { transform: 'scale(0.97, 1.04)' }, { transform: 'scale(1)' }], { duration: 480, iterations: 1 });
        const r = this.centre(el);
        const die = new Die3D('physical', Number(e.side), v.config.diceVariant, 40);
        const pop = this.temp(h('div', { class: 'mini-roll', style: { left: `${r.cx}px`, top: `${r.y - 10}px` } }, die.el, h('span', null, `${e.physical} + ${e.value} ${e.freed ? '> ' : '≤ '}${e.threshold}`)));
        await tl.done(die.roll(tl, Number(e.side)));
        if (e.freed) {
          this.env.fx.shards({ x: r.x, y: r.y, w: r.w, h: r.h }, '#9fe3ff');
          this.sfx('trap');
        } else {
          await tl.done(tl.animate(cage, [{ transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 200, easing: EASE.outBack }));
        }
        await tl.wait(380);
        cage.remove();
        pop.remove();
        this.temps.delete(pop);
        return;
      }
      case 'CardsRevealed': {
        const cards = (e.cards as { uid: string; cardId: string }[]) ?? [];
        if (tl.instant || !cards.length) return;
        const row = this.temp(h('div', { class: 'reveal-row' }));
        const els = cards.slice(0, 6).map((c) => {
          const el = createCardEl(null, v.defs[c.cardId] ?? null, { size: 'md' });
          el.classList.add('face-down');
          el.style.setProperty('--w', '220px');
          el.style.width = '220px';
          row.appendChild(el);
          return el;
        });
        row.prepend(h('div', { class: 'reveal-title' }, `${this.env.names(e.seat)} reveals`));
        for (const el of els) {
          el.classList.remove('face-down');
          flipFace(tl, el, DUR.flip);
        }
        await tl.wait(DUR.flip + 1100);
        await tl.done(tl.animate(row, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR.std, fill: 'forwards' }));
        row.remove();
        this.temps.delete(row);
        return;
      }
      case 'BattleEnded': {
        const anims = [...this.pins.keys()].filter((u) => this.start.before.get(u)?.zone === 'battle').map((u) => this.release(u));
        await Promise.all(anims.map((x) => tl.done(x)));
        return;
      }
      case 'PlayerEliminated': {
        const area = this.env.board.areaFor(e.seat as Seat)?.root;
        if (area && !tl.instant) await tl.done(tl.animate(area, [{ filter: 'none' }, { filter: 'grayscale(1) brightness(0.5)' }], { duration: DUR.drama, fill: 'none' }));
        return;
      }
      case 'GameOver': {
        const winners = (e.winners as number[]) ?? [];
        const won = this.viewer !== null && winners.includes(this.viewer);
        const lost = this.viewer !== null && !won && !e.draw;
        this.sfx(lost ? 'defeat' : 'victory');
        if (tl.instant) return;
        const main = this.env.board.root;
        if (winners.length) {
          const a = this.env.board.anchors(winners[0]!);
          if (a) {
            main.style.transformOrigin = `${a.area.cx}px ${a.area.cy}px`;
            this.env.fx.burst(a.area.cx, a.area.cy, { color: '#ffc857', count: 70, speed: 6, size: 4, life: 70, ring: true });
            this.env.fx.burst(a.area.cx, a.area.cy, { color: '#8be9ff', count: 50, speed: 4, life: 60 });
          }
          tl.animate(main, [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], { duration: 1500, easing: EASE.outQuint, fill: 'forwards' });
        }
        if (lost) tl.animate(main, [{ filter: 'none' }, { filter: 'grayscale(0.85) brightness(0.6)' }], { duration: 1400, fill: 'forwards' });
        await this.banner(e.draw ? 'DRAW' : won ? 'VICTORY' : lost ? 'DEFEAT' : `${winners.map((w) => this.env.names(w)).join(', ')} WINS`, null, lost ? '#ff4d6d' : '#ffc857');
        return;
      }
      default:
        return;
    }
  }
}

export function hpSnapshot(view: GameView): Map<Seat, number> {
  return new Map(view.players.map((p) => [p.seat, p.labHP]));
}

export { snap };
