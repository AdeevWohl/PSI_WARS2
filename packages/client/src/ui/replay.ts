/**
 * Replay viewer (build prompt §13): load an exported game log and step through it on the real
 * game screen — every command re-applied by the engine, with the same animations. Watch from
 * the public view or from any player's seat (their hand visible). Read-only.
 */
import type { Command, GameEvent, Seat } from '@psi-wars/shared';
import { filterEvents, Replayer, viewFor, type GameLog } from '@psi-wars/engine';
import type { GameSource, SeatInfo, Update } from '../game/source';
import { SEAT_COLORS } from '../render/board';
import { h, toast } from './dom';
import { GameScreen } from './game-screen';

class ReplayGame implements GameSource {
  readonly seats: SeatInfo[];
  pos: number;
  private listeners = new Set<(u: Update) => void>();

  constructor(readonly rp: Replayer, start: number) {
    this.pos = start;
    this.seats = rp.log.players.map((p, seat) => ({ seat, name: p.name, kind: 'remote' as const }));
  }

  view(viewer: Seat | null) {
    return viewFor(this.rp.stateAt(this.pos), viewer);
  }
  legal() {
    return null;
  }
  async send(_seat: Seat, _cmd: Command) {
    return { ok: false as const, error: 'This is a replay.' };
  }
  onUpdate(cb: (u: Update) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  eventsFor(events: GameEvent[], viewer: Seat | null) {
    return filterEvents(events, viewer);
  }
  exportLog() {
    return this.rp.log;
  }
  /** Advance one command and animate its events. */
  step(): boolean {
    if (this.pos >= this.rp.length) return false;
    this.pos++;
    for (const l of this.listeners) l({ events: this.rp.batches[this.pos]! });
    return true;
  }
  dispose() {
    this.listeners.clear();
  }
}

export class ReplayViewer {
  readonly el = h('div', { class: 'replay-host' });
  private rp: Replayer;
  private game!: ReplayGame;
  private screen!: GameScreen;
  private viewer: Seat | null = null;
  private playing = false;
  private timer = 0;
  private bar = h('div', { class: 'replay-bar panel', role: 'toolbar', 'aria-label': 'Replay controls' });
  private speed = 1;
  private keys = (e: KeyboardEvent) => this.onKey(e);

  constructor(log: GameLog, private onExit: () => void) {
    this.rp = new Replayer(log);
    if (this.rp.divergence) toast(`Replay warning: ${this.rp.divergence.reason}`, 'warn', 8000);
    this.mount(0);
    document.addEventListener('keydown', this.keys, true);
  }

  destroy(): void {
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.keys, true);
    this.screen?.destroy();
    this.game?.dispose();
  }

  /** (Re)build the game screen showing position `pos` (used for any backwards move or jump). */
  private mount(pos: number): void {
    this.screen?.destroy();
    this.game?.dispose();
    this.game = new ReplayGame(this.rp, pos);
    this.screen = new GameScreen(this.game, this.rp.batches.slice(0, pos + 1).flat(), { onExit: () => this.onExit(), viewer: this.viewer, readOnly: true });
    this.el.replaceChildren(this.screen.el, this.bar);
    this.renderBar();
  }

  private go(pos: number): void {
    pos = Math.max(0, Math.min(this.rp.length, pos));
    if (pos === this.game.pos + 1) {
      this.game.step();
      this.renderBar();
    } else if (pos !== this.game.pos) this.mount(pos);
  }

  private togglePlay(): void {
    this.playing = !this.playing;
    if (this.playing && this.game.pos >= this.rp.length) this.mount(0);
    this.renderBar();
    if (this.playing) this.tick();
  }

  private tick(): void {
    clearTimeout(this.timer);
    if (!this.playing) return;
    if (this.screen.busy) {
      this.timer = window.setTimeout(() => this.tick(), 120);
      return;
    }
    if (!this.game.step()) {
      this.playing = false;
      this.renderBar();
      return;
    }
    this.renderBar();
    this.timer = window.setTimeout(() => this.tick(), 450 / this.speed);
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') this.go(this.game.pos + 1);
    else if (e.key === 'ArrowLeft') this.go(this.game.pos - 1);
    else if (e.key === 'Home') this.go(0);
    else if (e.key === 'End') this.go(this.rp.length);
    else if (e.key === 'p' || e.key === 'P') this.togglePlay();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private renderBar(): void {
    const state = this.rp.stateAt(this.game.pos);
    const turns = this.rp.turnStarts();
    const btn = (label: string, title: string, on: () => void, disabled = false) => h('button', { class: 'btn small', title, 'aria-label': title, disabled: disabled ? true : undefined, onclick: on }, label);
    const atStart = this.game.pos === 0;
    const atEnd = this.game.pos >= this.rp.length;
    const turnSel = h('select', { class: 'text-input small', 'aria-label': 'Jump to turn', onchange: (e: Event) => this.go(Number((e.target as HTMLSelectElement).value)) },
      h('option', { value: '' }, `Turn ${state.turn.number}`),
      ...turns.map((t) => h('option', { value: String(t.index) }, `Go to turn ${t.turn}`)));
    const persp = h('select', { class: 'text-input small', 'aria-label': 'Watch as', onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      this.viewer = v === '' ? null : Number(v);
      this.mount(this.game.pos);
    } }, h('option', { value: '', selected: this.viewer === null ? true : undefined }, 'Public view'),
      ...this.rp.log.players.map((p, i) => h('option', { value: String(i), selected: this.viewer === i ? true : undefined }, `As ${p.name} (sees hand)`)));
    const speed = h('select', { class: 'text-input small', 'aria-label': 'Playback speed', onchange: (e: Event) => (this.speed = Number((e.target as HTMLSelectElement).value)) },
      ...[0.5, 1, 2, 4].map((s) => h('option', { value: String(s), selected: s === this.speed ? true : undefined }, `${s}×`)));
    const cmd = this.game.pos > 0 ? this.rp.log.commands[this.game.pos - 1] : null;
    const who = cmd ? h('span', { style: { color: SEAT_COLORS[cmd.seat] } }, this.rp.log.players[cmd.seat]?.name ?? `Seat ${cmd.seat + 1}`) : null;
    this.bar.replaceChildren(
      h('span', { class: 'replay-tag' }, 'REPLAY'),
      btn('⏮', 'Start (Home)', () => this.go(0), atStart),
      btn('◀', 'Step back (←)', () => this.go(this.game.pos - 1), atStart),
      h('button', { class: 'btn small primary', title: 'Play / pause (P)', onclick: () => this.togglePlay() }, this.playing ? '⏸ Pause' : '▶ Play'),
      btn('▶|', 'Step forward (→)', () => this.go(this.game.pos + 1), atEnd),
      btn('⏭', 'End (End)', () => this.go(this.rp.length), atEnd),
      h('span', { class: 'replay-pos' }, `${this.game.pos} / ${this.rp.length}`, cmd ? h('span', { class: 'dim' }, ' · ', who!, `: ${cmd.cmd.type}`) : null),
      turnSel, persp, speed,
      this.rp.divergence ? h('span', { class: 'replay-warn', title: this.rp.divergence.reason }, '⚠ differs from log') : '',
      h('button', { class: 'btn small ghost', onclick: () => this.onExit() }, 'Close'));
  }
}

/** Ask for a log file (or pasted JSON) and hand back the parsed object. */
export function pickLogFile(onLoad: (raw: unknown, name: string) => void): void {
  const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      onLoad(JSON.parse(await f.text()), f.name);
    } catch {
      toast('That file is not valid JSON.', 'error');
    }
  });
  input.click();
}
