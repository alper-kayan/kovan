/**
 * The hive behind the hero: a honeycomb of faint cells with a few agents walking from cell to
 * cell. Cells an agent passes through (or the pointer comes near) light up in its colour and
 * slowly fade. Drawn only while on screen; with reduced motion it is one still frame.
 */

const COLORS = ['#ffb829', '#3ff0b2', '#9b7bff', '#4cc2ff', '#ff5c8a'];
const SQRT3 = Math.sqrt(3);

interface Cell {
  x: number;
  y: number;
  heat: number;
  color: string;
}

interface Walker {
  from: number;
  to: number;
  prev: number;
  t: number;
  speed: number;
  color: string;
}

export function hive(
  canvas: HTMLCanvasElement,
  options: { radius?: number; walkers?: number } = {},
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const r = options.radius ?? 30;
  const w = SQRT3 * r;
  let cols = 0;
  let rows = 0;
  let cells: Cell[] = [];
  let grid = new Path2D();
  let walkers: Walker[] = [];
  let running = false;
  let frame = 0;
  const pointer = { x: -1e4, y: -1e4 };

  const index = (c: number, row: number) => row * cols + c;
  const neighbours = (i: number): number[] => {
    const c = i % cols;
    const row = Math.floor(i / cols);
    const odd = row & 1;
    const deltas = odd
      ? [
          [1, 0],
          [-1, 0],
          [1, -1],
          [0, -1],
          [1, 1],
          [0, 1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [0, -1],
          [-1, -1],
          [0, 1],
          [-1, 1],
        ];
    return deltas
      .map(([dc, dr]) => [c + dc!, row + dr!] as const)
      .filter(([nc, nr]) => nc >= 0 && nr >= 0 && nc < cols && nr < rows)
      .map(([nc, nr]) => index(nc, nr));
  };

  const hexPath = (path: Path2D | CanvasRenderingContext2D, x: number, y: number, size: number) => {
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      const px = x + size * Math.cos(a);
      const py = y + size * Math.sin(a);
      if (k === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
  };

  const layout = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { clientWidth: width, clientHeight: height } = canvas;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(width / w) + 2;
    rows = Math.ceil(height / (1.5 * r)) + 2;
    cells = [];
    grid = new Path2D();
    for (let row = 0; row < rows; row++)
      for (let c = 0; c < cols; c++) {
        const x = c * w + (row & 1 ? w / 2 : 0) - w / 2;
        const y = row * 1.5 * r - r / 2;
        cells.push({ x, y, heat: 0, color: COLORS[0]! });
        hexPath(grid, x, y, r - 1.5);
      }
    const count = options.walkers ?? Math.max(4, Math.round((width * height) / 160_000));
    walkers = Array.from({ length: count }, (_, k) => {
      const from = Math.floor(Math.random() * cells.length);
      return {
        from,
        to: neighbours(from)[0] ?? from,
        prev: -1,
        t: Math.random(),
        speed: 0.012 + Math.random() * 0.014,
        color: COLORS[k % COLORS.length]!,
      };
    });
  };

  const step = () => {
    for (const walker of walkers) {
      walker.t += walker.speed;
      if (walker.t < 1) continue;
      walker.t = 0;
      const cell = cells[walker.to]!;
      cell.heat = 1;
      cell.color = walker.color;
      const options = neighbours(walker.to).filter((n) => n !== walker.prev);
      walker.prev = walker.from;
      walker.from = walker.to;
      walker.to = options[Math.floor(Math.random() * options.length)] ?? walker.prev;
    }
    for (const cell of cells) {
      const d = Math.hypot(cell.x - pointer.x, cell.y - pointer.y);
      if (d < r * 2.2 && cell.heat < 0.7) {
        cell.heat = 0.7;
        cell.color = COLORS[0]!;
      }
      cell.heat *= 0.982;
    }
  };

  const draw = () => {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(160, 170, 230, 0.07)';
    ctx.stroke(grid);
    for (const cell of cells) {
      if (cell.heat < 0.02) continue;
      ctx.beginPath();
      hexPath(ctx, cell.x, cell.y, r - 1.5);
      ctx.globalAlpha = cell.heat * 0.16;
      ctx.fillStyle = cell.color;
      ctx.fill();
      ctx.globalAlpha = cell.heat * 0.7;
      ctx.strokeStyle = cell.color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const walker of walkers) {
      const a = cells[walker.from]!;
      const b = cells[walker.to]!;
      const e = walker.t * walker.t * (3 - 2 * walker.t);
      const x = a.x + (b.x - a.x) * e;
      const y = a.y + (b.y - a.y) * e;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 16);
      glow.addColorStop(0, walker.color);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - 16, y - 16, 32, 32);
      ctx.globalAlpha = 1;
      ctx.fillStyle = walker.color;
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const tick = () => {
    if (!running) return;
    step();
    draw();
    frame = requestAnimationFrame(tick);
  };

  layout();
  if (calm) {
    // One still frame with a few lit cells.
    for (let k = 0; k < 40; k++) {
      const cell = cells[Math.floor(Math.random() * cells.length)]!;
      cell.heat = Math.random() * 0.8;
      cell.color = COLORS[k % COLORS.length]!;
    }
    draw();
    return;
  }

  new ResizeObserver(() => {
    layout();
    if (!running) draw();
  }).observe(canvas);

  new IntersectionObserver(([entry]) => {
    const visible = entry?.isIntersecting ?? false;
    if (visible && !running) {
      running = true;
      frame = requestAnimationFrame(tick);
    } else if (!visible && running) {
      running = false;
      cancelAnimationFrame(frame);
    }
  }).observe(canvas);

  const host = canvas.parentElement ?? canvas;
  host.addEventListener('pointermove', (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
  });
  host.addEventListener('pointerleave', () => {
    pointer.x = pointer.y = -1e4;
  });
}
