/**
 * Particles and screen effects on one canvas overlay (§6.2): hard particle cap, pooled
 * particles, the loop runs only while something is alive, and pauses when the tab is hidden.
 */
import { settings } from '../settings';

interface P {
  alive: boolean;
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
  shape: 0 | 1 | 2; // 0 dot, 1 shard, 2 ring
  rot: number; vr: number; g: number; drag: number;
  tx: number; ty: number; home: number;
}

const CAP = { off: 0, reduced: 140, full: 520 } as const;

export class Fx {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private pool: P[] = [];
  private raf = 0;
  private last = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-canvas';
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.g = this.canvas.getContext('2d')!;
    for (let i = 0; i < CAP.full; i++) this.pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 2, color: '#fff', shape: 0, rot: 0, vr: 0, g: 0, drag: 0.98, tx: 0, ty: 0, home: 0 });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.alive() > 0) this.kick();
    });
  }

  private cap(): number {
    return CAP[settings().particles];
  }

  private spawn(init: Partial<P>): void {
    const cap = this.cap();
    if (cap === 0) return;
    let used = 0;
    let free: P | undefined;
    for (const p of this.pool) {
      if (p.alive) used++;
      else if (!free) free = p;
    }
    if (used >= cap || !free) return;
    Object.assign(free, { alive: true, life: 0, rot: 0, vr: 0, g: 0, drag: 0.97, home: 0, shape: 0, size: 3, ...init });
    this.kick();
  }

  private alive(): number {
    let n = 0;
    for (const p of this.pool) if (p.alive) n++;
    return n;
  }

  private scaleCount(n: number): number {
    return settings().particles === 'reduced' ? Math.ceil(n / 3) : n;
  }

  /** Energy puff / sparks at a point (stage coords). */
  burst(x: number, y: number, opts: { count?: number; color?: string; speed?: number; size?: number; life?: number; ring?: boolean } = {}): void {
    const n = this.scaleCount(opts.count ?? 18);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed ?? 3) * (0.4 + Math.random());
      this.spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, max: (opts.life ?? 40) * (0.6 + Math.random() * 0.6), size: (opts.size ?? 3) * (0.5 + Math.random()), color: opts.color ?? '#8be9ff', drag: 0.93 });
    }
    if (opts.ring) this.spawn({ x, y, vx: 0, vy: 0, max: 28, size: 10, color: opts.color ?? '#8be9ff', shape: 2, drag: 1 });
  }

  /** Shatter a rect into shards that stream toward a target (stage coords). */
  shards(r: { x: number; y: number; w: number; h: number }, color: string, target?: { x: number; y: number }): void {
    const n = this.scaleCount(36);
    for (let i = 0; i < n; i++) {
      const x = r.x + Math.random() * r.w;
      const y = r.y + Math.random() * r.h;
      const a = Math.atan2(y - (r.y + r.h / 2), x - (r.x + r.w / 2));
      this.spawn({
        x, y, vx: Math.cos(a) * (2 + Math.random() * 3), vy: Math.sin(a) * (2 + Math.random() * 3) - 1.5,
        max: 60 + Math.random() * 30, size: 5 + Math.random() * 7, color, shape: 1, vr: (Math.random() - 0.5) * 0.4,
        g: target ? 0 : 0.18, drag: 0.95, tx: target?.x ?? 0, ty: target?.y ?? 0, home: target ? 0.06 : 0,
      });
    }
  }

  /** A short stream of particles from a to b (motion trails, auras flowing). */
  stream(a: { x: number; y: number }, b: { x: number; y: number }, color: string, count = 16): void {
    const n = this.scaleCount(count);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      this.spawn({ x: a.x + (b.x - a.x) * t * 0.2 + (Math.random() - 0.5) * 20, y: a.y + (b.y - a.y) * t * 0.2 + (Math.random() - 0.5) * 20, vx: 0, vy: 0, max: 50, size: 2.5, color, tx: b.x, ty: b.y, home: 0.09, drag: 0.9 });
    }
  }

  private kick(): void {
    if (this.raf || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(t: number): void {
    this.raf = 0;
    const dt = Math.min(3, (t - this.last) / 16.67);
    this.last = t;
    const g = this.g;
    g.clearRect(0, 0, 1920, 1080);
    let n = 0;
    g.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.alive = false;
        continue;
      }
      n++;
      if (p.home) {
        p.vx += (p.tx - p.x) * p.home * dt;
        p.vy += (p.ty - p.y) * p.home * dt;
      }
      p.vy += p.g * dt;
      p.vx *= Math.pow(p.drag, dt);
      p.vy *= Math.pow(p.drag, dt);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const k = 1 - p.life / p.max;
      g.globalAlpha = Math.max(0, k);
      g.fillStyle = p.color;
      g.strokeStyle = p.color;
      if (p.shape === 1) {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.beginPath();
        g.moveTo(-p.size / 2, -p.size / 3);
        g.lineTo(p.size / 2, 0);
        g.lineTo(-p.size / 3, p.size / 2);
        g.closePath();
        g.fill();
        g.restore();
      } else if (p.shape === 2) {
        g.lineWidth = 3 * k;
        g.beginPath();
        g.arc(p.x, p.y, p.size + (1 - k) * 60, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.beginPath();
        g.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (n > 0) this.kick();
  }

  clear(): void {
    for (const p of this.pool) p.alive = false;
    this.g.clearRect(0, 0, 1920, 1080);
  }
}
