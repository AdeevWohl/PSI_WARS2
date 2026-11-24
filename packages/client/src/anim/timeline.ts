/**
 * The one central animation scheduler (build prompt §6.2). Every animation goes through
 * here, so the speed multiplier, Instant mode and fast-forward apply in one place.
 *
 * Hard rule (§6.1): the engine never waits on animations and animations never change game
 * state. The timeline only *presents* events the engine already committed; skipping or
 * Instant mode changes nothing but timing.
 */
import { speedFactor } from '../settings';

export const EASE = {
  outQuint: 'cubic-bezier(0.22, 1, 0.36, 1)',
  inOutQuart: 'cubic-bezier(0.76, 0, 0.24, 1)',
  outBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  outCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
  inQuad: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)',
  /** Spring-ish settle for snaps (equipment, dice, stacks). */
  spring: 'linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1.004 83.8%, 1)',
} as const;

/** Base durations (ms) before the speed multiplier. */
// Change Request 1, Part D: slower at Normal so each action can be followed (Fast ~ the old Normal).
export const DUR = { micro: 150, std: 320, travel: 540, drama: 950, flip: 560 } as const;

/** Readable pause after each important beat, by the Hold time setting (before the speed multiplier). */
export const HOLD = { short: 220, normal: 480, long: 900 } as const;

export class Timeline {
  private running = new Set<Animation>();
  private waits = new Set<() => void>();
  private skipping = false;

  constructor() {
    // Nobody is watching a hidden tab, and browsers may stop advancing animation timelines
    // there: present instantly instead of stalling the queue.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.skip();
    });
  }

  factor(): number {
    return this.skipping || document.hidden ? 0 : speedFactor();
  }

  get instant(): boolean {
    return this.factor() === 0;
  }

  dur(ms: number): number {
    return Math.round(ms * this.factor());
  }

  /** Element.animate with central speed control, will-change only while running. */
  animate(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, opts: KeyframeAnimationOptions & { duration: number }): Animation {
    const duration = this.dur(opts.duration);
    const delay = opts.delay ? this.dur(Number(opts.delay)) : 0;
    const anim = el.animate(keyframes, { ...opts, duration: Math.max(duration, 0), delay, fill: opts.fill ?? 'none' });
    const he = el as HTMLElement;
    const prevWill = he.style.willChange;
    // will-change: opacity is a "grouping" hint: on a preserve-3d element (dice cubes, card
    // flips) it makes the browser draw the 3D object flat for as long as the animation runs.
    // ...and on a perspective container (a die's box) it flattens the cube inside. Skip both.
    const cs = getComputedStyle(el);
    const is3d = cs.transformStyle === 'preserve-3d' || cs.perspective !== 'none';
    if (!is3d) he.style.willChange = 'transform, opacity';
    this.running.add(anim);
    const done = () => {
      this.running.delete(anim);
      he.style.willChange = prevWill;
    };
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', done);
    if (duration === 0 && delay === 0) anim.finish();
    return anim;
  }

  /** Resolve after `ms` (scaled), or at once when skipping / instant. */
  wait(ms: number): Promise<void> {
    const d = this.dur(ms);
    if (d <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(id);
        this.waits.delete(finish);
        resolve();
      };
      const id = setTimeout(finish, d);
      this.waits.add(finish);
    });
  }

  /**
   * Await an animation (resolves immediately if it was skipped). Safety net: if the page stops
   * drawing frames without reporting itself hidden (an occluded or throttled window), animations
   * never start; after their expected length plus a margin the animation is finished so the game
   * can never freeze on presentation.
   */
  async done(a: Animation | null | undefined): Promise<void> {
    if (!a) return;
    const t = a.effect?.getComputedTiming();
    const expected = Number(t?.endTime ?? t?.activeDuration ?? 1000) || 1000;
    let timer = 0;
    const guard = new Promise<void>((resolve) => {
      timer = window.setTimeout(() => {
        try {
          a.finish();
        } catch {
          /* ignore */
        }
        resolve();
      }, expected + 1500);
    });
    try {
      await Promise.race([a.finished.then(() => undefined), guard]);
    } catch {
      /* cancelled */
    } finally {
      clearTimeout(timer);
    }
  }

  get busy(): boolean {
    return this.running.size > 0 || this.waits.size > 0;
  }

  /** Fast-forward: finish everything now and run the rest of the batch at zero duration. */
  skip(): void {
    this.skipping = true;
    for (const a of [...this.running]) {
      try {
        a.finish();
      } catch {
        a.cancel();
      }
    }
    for (const w of [...this.waits]) w();
  }

  /** Called when the presentation queue is empty. */
  settle(): void {
    this.skipping = false;
  }
}
