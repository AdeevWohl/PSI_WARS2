/**
 * A unique cast animation for every Power/Trap card (Change Request 1, Part D), played when the
 * card resolves, plus the aiming style its targeting uses. Purely presentation.
 */
import type { GameView } from '@psi-wars/engine';
import type { Fx } from './fx';
import { EASE, type Timeline } from './timeline';
import { h } from '../ui/dom';

/** How a card's targeting looks while aiming (CSS classes aim-<style>). */
export const AIM_STYLE: Record<string, string> = { PW_OS: 'zap', TR_GSF: 'frost' };
export const aimStyle = (cardId: string): string => AIM_STYLE[cardId] ?? 'mark';

type Pt = { x: number; y: number };

export interface SpellEnv {
  tl: Timeline;
  fx: Fx;
  view: GameView;
  temp: (el: HTMLElement) => HTMLElement;
  untemp: (el: HTMLElement) => void;
  shake: (n: number) => void;
  /** Stage-space centre of a card on the board, if it is shown. */
  at: (uid: string | null | undefined) => (Pt & { w: number; h: number }) | null;
  /** A player's area / pile positions. */
  area: (seat: number) => { hp: Pt; discard: Pt; battleDeck: Pt; area: Pt } | null;
}

const BOARD_CX = (1920 - 392) / 2;

/** An expanding ring. */
function ring(env: SpellEnv, p: Pt, color: string, scale: number, duration: number, cls = 'shockwave'): Promise<void> {
  const el = env.temp(h('div', { class: cls, style: { left: `${p.x}px`, top: `${p.y}px`, '--glow': color } as any }));
  return env.tl.done(env.tl.animate(el, [{ transform: 'translate(-50%, -50%) scale(0.15)', opacity: 1 }, { transform: `translate(-50%, -50%) scale(${scale})`, opacity: 0 }], { duration, easing: EASE.outCubic, fill: 'forwards' })).then(() => env.untemp(el));
}

/** A themed overlay element animated with keyframes, removed after. */
function overlay(env: SpellEnv, cls: string, p: Pt, frames: Keyframe[], duration: number, style: Record<string, string> = {}): Promise<void> {
  const el = env.temp(h('div', { class: `sfx ${cls}`, style: { left: `${p.x}px`, top: `${p.y}px`, ...style } as any }));
  return env.tl.done(env.tl.animate(el, frames, { duration, easing: EASE.outCubic, fill: 'forwards' })).then(() => env.untemp(el));
}

/** Jagged arcs between points (chain lightning). */
function arcs(env: SpellEnv, pts: Pt[], color: string, duration = 600): Promise<void> {
  if (pts.length < 2) return Promise.resolve();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'bolt');
  svg.setAttribute('viewBox', '0 0 1920 1080');
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg: string[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const j = k === 0 || k === 8 ? 0 : Math.random() * 40 - 20;
      seg.push(`${(a.x + (b.x - a.x) * t + j).toFixed(0)},${(a.y + (b.y - a.y) * t + j).toFixed(0)}`);
    }
    for (const [w, c] of [[14, `${color}55`], [5, color], [2, '#ffffff']] as const) {
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', seg.join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', c);
      pl.setAttribute('stroke-width', String(w));
      svg.appendChild(pl);
    }
  }
  const el = env.temp(svg as unknown as HTMLElement);
  el.style.filter = `drop-shadow(0 0 10px ${color})`;
  return env.tl.done(env.tl.animate(el, [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.3, offset: 0.3 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration, fill: 'forwards' })).then(() => env.untemp(el));
}

function flash(env: SpellEnv, color: string, peak = 0.35, duration = 550): void {
  const el = env.temp(h('div', { class: 'screen-flash', style: { '--flash': color } as any }));
  env.tl.done(env.tl.animate(el, [{ opacity: 0 }, { opacity: peak, offset: 0.15 }, { opacity: 0 }], { duration, fill: 'forwards' })).then(() => env.untemp(el));
}

/** Units in play matching a predicate, with their positions. */
function unitsWhere(env: SpellEnv, pred: (cardId: string, owner: number) => boolean): (Pt & { w: number; h: number; uid: string })[] {
  const out: (Pt & { w: number; h: number; uid: string })[] = [];
  for (const p of env.view.players) {
    for (const u of p.lab) {
      const c = env.view.cards[u];
      if (!c || !pred(c.cardId, p.seat)) continue;
      const r = env.at(u);
      if (r) out.push({ ...r, uid: u });
    }
  }
  return out;
}

const typeOf = (env: SpellEnv, cardId: string) => env.view.defs[cardId]?.unitType ?? '';

/**
 * Play the cast animation for a resolving Power/Trap card.
 * `from` = where the card is (the resolving zone), `caster` its controller, `target` its target.
 */
export async function castSpell(env: SpellEnv, cardId: string, caster: number, from: Pt, target: string | null): Promise<void> {
  const tgt = target && !target.startsWith('lab:') ? env.at(target) : null;
  const lab = target?.startsWith('lab:') ? env.area(Number(target.slice(4))) : null;
  const mine = env.area(caster);
  switch (cardId) {
    case 'PW_OS': {
      // Overload Strike: the card crackles and charges up red; the bolt itself strikes on damage.
      env.fx.burst(from.x, from.y, { color: '#ff3b3b', count: 24, speed: 2.2, ring: true });
      await overlay(env, 'sfx-charge', from, [{ transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1.3)', opacity: 1, offset: 0.6 }, { transform: 'translate(-50%, -50%) scale(0.9)', opacity: 0 }], 650, { '--glow': '#ff3b3b' });
      return;
    }
    case 'TR_GSF': {
      // Grankor Stasis Field: an icy field collapses onto the target before the cage closes.
      const p = tgt ?? from;
      flash(env, '#7fe8ff', 0.25);
      await Promise.all([
        overlay(env, 'sfx-frost', p, [{ transform: 'translate(-50%, -50%) scale(2.6) rotate(0deg)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1) rotate(90deg)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%, -50%) scale(0.9) rotate(120deg)', opacity: 0.2 }], 900),
        ring(env, p, '#7fe8ff', 3, 900, 'shockwave big'),
      ]);
      env.fx.burst(p.x, p.y, { color: '#bff6ff', count: 36, speed: 2.4 });
      return;
    }
    case 'PW_BP': {
      // Bio Pulse: a toxic green wave rolls from the caster across the enemy side; spores burst on each hit.
      const start = mine?.area ?? { x: BOARD_CX, y: 800 };
      flash(env, '#5bff6a', 0.22, 700);
      await overlay(env, 'sfx-wave', start, [{ transform: 'translate(-50%, -50%) scale(0.2)', opacity: 0.9 }, { transform: 'translate(-50%, -50%) scale(6)', opacity: 0 }], 1000, { '--glow': '#5bff6a' });
      for (const u of unitsWhere(env, (id, owner) => owner !== caster && ['Creature', 'Cyborg'].includes(typeOf(env, id)))) env.fx.burst(u.x, u.y, { color: '#7dff6a', count: 22, speed: 1.6 });
      await env.tl.wait(250);
      return;
    }
    case 'PW_SB': {
      // Static Burst: chain lightning jumps between every enemy Robot and Cyborg.
      const hits = unitsWhere(env, (id, owner) => owner !== caster && ['Robot', 'Cyborg'].includes(typeOf(env, id)));
      flash(env, '#4fd1ff', 0.3);
      env.shake(0.8);
      await arcs(env, [from, ...hits], '#4fd1ff', 750);
      for (const u of hits) env.fx.burst(u.x, u.y, { color: '#8be9ff', count: 18, speed: 2.6 });
      return;
    }
    case 'PW_HEP': {
      // High-Energy Pulse: a cyan EMP — concentric rings and a scanline sweep; digital units flicker.
      flash(env, '#00e5ff', 0.3);
      await Promise.all([ring(env, { x: BOARD_CX, y: 540 }, '#00e5ff', 9, 900, 'shockwave big'), ring(env, { x: BOARD_CX, y: 540 }, '#00e5ff', 6, 700, 'shockwave'), overlay(env, 'sfx-scan', { x: BOARD_CX, y: 0 }, [{ transform: 'translate(-50%, 0)', opacity: 0.9 }, { transform: 'translate(-50%, 1080px)', opacity: 0.2 }], 800)]);
      return;
    }
    case 'PW_MD': {
      // Mental Disrupter: purple psychic spirals ripple out; Creatures and Cyborgs reel.
      flash(env, '#c77dff', 0.28);
      await overlay(env, 'sfx-spiral', { x: BOARD_CX, y: 540 }, [{ transform: 'translate(-50%, -50%) scale(0.3) rotate(0deg)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(2.2) rotate(240deg)', opacity: 0.9, offset: 0.6 }, { transform: 'translate(-50%, -50%) scale(3) rotate(360deg)', opacity: 0 }], 1100);
      for (const u of unitsWhere(env, (id) => ['Creature', 'Cyborg'].includes(typeOf(env, id)))) env.fx.burst(u.x, u.y, { color: '#d9a8ff', count: 14, speed: 1.4 });
      return;
    }
    case 'PW_CR':
    case 'PW_RR': {
      // Regenerate / Refurb: a vortex opens over the discard pile (life green, or blueprint blue).
      const p = mine?.discard ?? from;
      const color = cardId === 'PW_CR' ? '#7dff6a' : '#4fd1ff';
      await overlay(env, cardId === 'PW_CR' ? 'sfx-vortex life' : 'sfx-vortex tech', p, [{ transform: 'translate(-50%, -50%) scale(0.2) rotate(0deg)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1.4) rotate(300deg)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%, -50%) scale(1.8) rotate(420deg)', opacity: 0 }], 1000);
      env.fx.burst(p.x, p.y, { color, count: 30, speed: 2.4, ring: true });
      return;
    }
    case 'PW_EH': {
      // Equipment Hunter: a gold scanning beam sweeps the Battle Deck.
      const p = mine?.battleDeck ?? from;
      await overlay(env, 'sfx-beam', p, [{ transform: 'translate(-50%, -50%) scaleX(0.1)', opacity: 0 }, { transform: 'translate(-50%, -50%) scaleX(1)', opacity: 1, offset: 0.35 }, { transform: 'translate(-50%, -50%) scaleX(1) translateY(-10px)', opacity: 1, offset: 0.7 }, { transform: 'translate(-50%, -50%) scaleX(0.1)', opacity: 0 }], 900);
      env.fx.burst(p.x, p.y, { color: '#ffc857', count: 20, speed: 2 });
      return;
    }
    case 'PW_EM': {
      // Equipment Mechanic: spinning gears and sparks over the discard pile.
      const p = mine?.discard ?? from;
      await overlay(env, 'sfx-gear', p, [{ transform: 'translate(-50%, -50%) scale(0.3) rotate(0deg)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1.2) rotate(270deg)', opacity: 1, offset: 0.6 }, { transform: 'translate(-50%, -50%) scale(1) rotate(400deg)', opacity: 0 }], 950);
      env.fx.burst(p.x, p.y, { color: '#ff9a3c', count: 26, speed: 3 });
      return;
    }
    default: {
      // Any other Power/Trap: a gold flare at the card and a ring toward its target.
      env.fx.burst(from.x, from.y, { color: '#ffc857', count: 20, speed: 2.2, ring: true });
      if (tgt || lab) await ring(env, tgt ?? lab!.hp, '#ffc857', 2.5, 600);
      else await env.tl.wait(400);
    }
  }
}
