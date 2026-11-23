/**
 * Frame-time monitor with auto-degrade (§6.2): if frames run over budget for about a
 * second while animating, drop to the Performance preset and say so in a quiet toast.
 */
import { PRESETS, settings, updateSettings, type Settings } from '../settings';
import { h } from '../ui/dom';

const BUDGET_MS = 24; // ~42 fps floor before degrading
const WINDOW = 60;

export class PerfMonitor {
  private samples: number[] = [];
  private last = 0;
  private raf = 0;
  private degraded = false;
  fps = 60;

  start(): void {
    if (this.raf) return;
    const loop = (t: number) => {
      if (document.hidden) {
        this.last = 0;
      } else if (this.last) {
        const dt = t - this.last;
        // Gaps over 200 ms mean the browser throttled us (occluded/background window),
        // not that rendering is slow — never degrade on those.
        if (dt < 200) {
          this.samples.push(dt);
          if (this.samples.length > WINDOW) this.samples.shift();
        } else {
          this.samples = [];
        }
        const sorted = [...this.samples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
        this.fps = Math.round(1000 / median);
        const animating = document.getAnimations().length > 0;
        if (animating && this.samples.length === WINDOW && median > BUDGET_MS && !this.degraded && settings().speed !== 'instant') this.degrade();
      }
      this.last = document.hidden ? 0 : t;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private degrade(): void {
    this.degraded = true;
    const before: Partial<Settings> = {};
    for (const k of Object.keys(PRESETS.performance) as (keyof Settings)[]) (before as any)[k] = settings()[k];
    updateSettings(PRESETS.performance);
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = h('div', { class: 'toast warn', role: 'status' },
      'Effects were slowing the game down, so the Performance preset is on. ',
      h('button', { class: 'btn small ghost', onclick: () => { updateSettings(before); t.remove(); } }, 'Undo'),
      h('button', { class: 'btn small ghost', onclick: () => t.remove(), 'aria-label': 'Dismiss' }, '✕'));
    host.appendChild(t);
    this.samples = [];
  }
}
