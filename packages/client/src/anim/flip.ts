/**
 * FLIP (First, Last, Invert, Play): cards move between containers by measuring their old
 * and new rects and animating only the transform delta (§6.2). Layout stays correct and the
 * motion stays on the compositor.
 */
import { DUR, EASE, type Timeline } from './timeline';

export interface Snap {
  /** Centre in stage coordinates (the 1920x1080 design space). */
  cx: number;
  cy: number;
  /** Untransformed layout width (for scale). */
  w: number;
  transform: string;
  faceUp: boolean;
}

export function stageScale(): number {
  const st = document.getElementById('stage');
  if (!st) return 1;
  return st.getBoundingClientRect().width / 1920 || 1;
}

export function stageOrigin(): { x: number; y: number; s: number } {
  const st = document.getElementById('stage')!;
  const r = st.getBoundingClientRect();
  return { x: r.left, y: r.top, s: r.width / 1920 || 1 };
}

/** Screen rect -> stage-space rect. */
export function toStage(r: DOMRect): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
  const o = stageOrigin();
  const x = (r.left - o.x) / o.s;
  const y = (r.top - o.y) / o.s;
  const w = r.width / o.s;
  const h = r.height / o.s;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

export function snap(el: HTMLElement): Snap {
  const r = toStage(el.getBoundingClientRect());
  const t = getComputedStyle(el).transform;
  return { cx: r.cx, cy: r.cy, w: el.offsetWidth || 1, transform: t === 'none' ? '' : t, faceUp: !el.classList.contains('face-down') };
}

export interface FlipOpts {
  duration?: number;
  easing?: string;
  /** Lift the card on an arc (stage px) through the midpoint. */
  arc?: number;
  /** Start paused (pinned at its old position) until .play() is called. */
  paused?: boolean;
  /** Animate the card face from back to front during the move. */
  flipFace?: boolean;
  delay?: number;
  /** Extra scale bump at landing. */
  land?: boolean;
}

/** Animate `el` from a previous snapshot to where it is now. */
export function flipFrom(tl: Timeline, el: HTMLElement, first: Pick<Snap, 'cx' | 'cy' | 'w' | 'transform'>, opts: FlipOpts = {}): Animation | null {
  const last = snap(el);
  const dx = first.cx - last.cx;
  const dy = first.cy - last.cy;
  const s = first.w / (last.w || 1);
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(s - 1) < 0.01 && first.transform === last.transform && !opts.flipFace) return null;
  const from = `translate(${dx}px, ${dy}px) scale(${s}) ${first.transform}`;
  const to = last.transform || 'none';
  const frames: Keyframe[] = [{ transform: from, offset: 0 }];
  if (opts.arc) frames.push({ transform: `translate(${dx / 2}px, ${dy / 2 - opts.arc}px) scale(${(s + 1) / 2 * 1.08}) ${last.transform}`, offset: 0.5 });
  if (opts.land) frames.push({ transform: `scale(1.08) ${last.transform}`, offset: 0.82 });
  frames.push({ transform: to, offset: 1 });
  const anim = tl.animate(el, frames, { duration: opts.duration ?? DUR.travel, easing: opts.easing ?? EASE.outQuint, fill: 'backwards', delay: opts.delay });
  if (opts.flipFace) flipFace(tl, el, opts.duration ?? DUR.travel, opts.paused, opts.delay);
  if (opts.paused) anim.pause();
  return anim;
}

/** 3D flip of the card face (back -> front) with a specular sweep; cross-fade when 3D flip is off. */
export function flipFace(tl: Timeline, el: HTMLElement, duration: number = DUR.flip, paused = false, delay = 0): Animation | null {
  const inner = el.querySelector('.card-inner') as HTMLElement | null;
  if (!inner) return null;
  const threeD = document.documentElement.dataset.flip !== 'fade';
  let a: Animation;
  if (threeD) {
    a = tl.animate(inner, [
      { transform: 'rotateY(180deg) translateZ(0px)' },
      { transform: 'rotateY(180deg) translateZ(30px)', offset: 0.25 },
      { transform: 'rotateY(90deg) translateZ(40px)', offset: 0.6 },
      { transform: 'rotateY(0deg) translateZ(0px)' },
    ], { duration, easing: EASE.inOutQuart, fill: 'backwards', delay });
    const sheen = document.createElement('div');
    sheen.className = 'sheen';
    el.appendChild(sheen);
    const s = tl.animate(sheen, [{ transform: 'translateX(-120%)', opacity: 0 }, { opacity: 0.9, offset: 0.55 }, { transform: 'translateX(120%)', opacity: 0 }], { duration, easing: EASE.inOutQuart, fill: 'backwards', delay });
    s.finished.finally(() => sheen.remove()).catch(() => {});
    if (paused) s.pause();
  } else {
    a = tl.animate(inner, [{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.6, easing: EASE.outCubic, fill: 'backwards', delay });
  }
  if (paused) a.pause();
  return a;
}
