// Original bat drawings for Pod Cave.
import { useEffect, useRef } from 'react';

export const BAT_PATH =
  'M50 15 L46.5 6 L44.5 13.5 C38 12.4 30 8.6 21.5 7.2 C11.5 7.6 4 15 2.6 24 C8.4 20.6 14.4 21.4 17.6 26.6 C21.6 22.8 27.6 23.2 30.8 29.6 C35 25.8 41 27.8 42.8 35.2 L50 47 L57.2 35.2 C59 27.8 65 25.8 69.2 29.6 C72.4 23.2 78.4 22.8 82.4 26.6 C85.6 21.4 91.6 20.6 97.4 24 C96 15 88.5 7.6 78.5 7.2 C70 8.6 62 12.4 55.5 13.5 L53.5 6 Z';

/** Pod Cave logo: a bat with fully spread wings, drawn in the current text colour. */
export function BatEmblem({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.52} viewBox="0 0 100 52" className="emblem" aria-hidden>
      <path d={BAT_PATH} fill="currentColor" />
    </svg>
  );
}

interface Bat {
  dx: number;
  dy: number;
  dist: number;
  w0: number;
  w1: number;
  delay: number;
  dur: number;
  wobble: number;
  flap: number;
  phase: number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const BAT_COUNT = 34;

/**
 * Draws one bat in its own 100x52 box with each wing bent at the shoulder.
 * `lift` goes from about -0.3 (wings down) to 1 (wings raised).
 */
function drawBat(ctx: CanvasRenderingContext2D, shape: Path2D, lift: number) {
  // Raised wings also look narrower, as if seen edge-on.
  const narrow = 1 - 0.22 * Math.max(0, lift);
  for (const side of [-1, 1]) {
    const bend = 0.62 * lift * -side;
    ctx.save();
    // Shear around the body's centre line (x = 50) so the wing tip moves up or down.
    ctx.transform(narrow, bend, 0, 1, 50 * (1 - narrow), -bend * 50);
    ctx.beginPath();
    ctx.rect(side < 0 ? -2 : 49.5, -40, 52.5, 120);
    ctx.clip();
    ctx.fill(shape);
    ctx.restore();
  }
}

/**
 * Ops Mode burst: bats flap out from the point you clicked to every side of
 * the screen. Drawn on one canvas that ignores the mouse, so the page stays
 * usable while they fly.
 */
export function BatBurst({ from, onDone }: { from: { x: number; y: number }; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDone();
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const shape = new Path2D(BAT_PATH);
    // Black bats on light pages; on dark pages black would vanish, so use the text colour.
    ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#000' : getComputedStyle(document.body).color;

    // Spread evenly around the circle with jitter, each flying past the screen edge.
    const bats: Bat[] = Array.from({ length: BAT_COUNT }, (_, i) => {
      const a = (i / BAT_COUNT) * Math.PI * 2 + rnd(-0.15, 0.15);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const toEdge = Math.min(dx > 0 ? (W - from.x) / dx : dx < 0 ? -from.x / dx : Infinity, dy > 0 ? (H - from.y) / dy : dy < 0 ? -from.y / dy : Infinity);
      return {
        dx,
        dy,
        dist: toEdge + rnd(120, 240),
        w0: rnd(24, 36),
        w1: rnd(85, 140),
        delay: rnd(0, 0.3),
        dur: rnd(1.25, 1.75),
        wobble: rnd(-45, 45),
        flap: rnd(5, 7),
        phase: rnd(0, Math.PI * 2),
      };
    });
    const total = Math.max(...bats.map((b) => b.delay + b.dur));

    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const b of bats) {
        const p = clamp01((t - b.delay) / b.dur);
        if (p <= 0 || p >= 1) continue;
        // Gentle launch that picks up speed, with a slight sideways curve.
        const k = p ** 1.3;
        const curve = Math.sin(p * Math.PI) * b.wobble;
        const x = from.x + b.dx * b.dist * k - b.dy * curve;
        const y = from.y + b.dy * b.dist * k + b.dx * curve;
        const s = (b.w0 + (b.w1 - b.w0) * Math.min(1, p * 1.5)) / 100;
        const beat = Math.sin(t * b.flap * Math.PI * 2 + b.phase);
        const lift = 0.35 + 0.65 * beat;
        ctx.globalAlpha = Math.min(1, p * 10);
        ctx.save();
        // The body bobs up a little on each downstroke.
        ctx.translate(x, y + beat * 3 * s);
        ctx.rotate(b.dx * 0.3);
        ctx.scale(s, s);
        ctx.translate(-50, -26);
        drawBat(ctx, shape, lift);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (t < total) raf = requestAnimationFrame(frame);
      else onDone();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [from, onDone]);

  return <canvas ref={ref} className="bat-swarm" aria-hidden />;
}
