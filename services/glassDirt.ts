// Грязь на стекле: запотевший слой с конденсатом и упрямые пятна поверх.
// Всё рисуется от сида окна, поэтому «Запотеть заново» повторяет тот же узор.

type Rng = () => number;
type Rgb = [number, number, number];

// Альфа ниже порога – пиксель считаем чистым
export const ALPHA_CLEAN_THRESHOLD = 16;
// Для прогресса смотрим точки сетки с шагом 9 px (примерно каждый 81-й пиксель).
// Именно сетка, а не каждый N-й пиксель подряд: при ширине, кратной шагу,
// линейный шаг попадал бы всё время в одни и те же редкие столбцы
const SAMPLE_PITCH = 9;
const SAMPLE_OFFSET = SAMPLE_PITCH >> 1;
// Высота полосы под HUD сверху стекла, где пятна не рисуем
const TOP_HUD_SPACE = 80;

// mulberry32: маленький и быстрый генератор, для узоров его хватает
const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const windowSeed = (index: number) => (Math.imul(index + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

// ---------- Запотевший слой ----------

const drawDroplet = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, clarity: number) => {
  // Сквозь каплю видно чуть больше, чем сквозь туман
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0, 0, 0, ${clarity})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalCompositeOperation = 'source-over';
  // Тень по нижнему краю
  ctx.strokeStyle = 'rgba(110, 120, 140, 0.35)';
  ctx.lineWidth = Math.max(0.6, r * 0.3);
  ctx.beginPath();
  ctx.arc(x, y, r * 0.85, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
  // Блик сверху слева
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.35, Math.max(0.5, r * 0.3), 0, Math.PI * 2);
  ctx.fill();
};

// Капля сползла вниз и оставила полупрозрачную дорожку
const drawStreak = (ctx: CanvasRenderingContext2D, rng: Rng, width: number, height: number) => {
  const lineWidth = 2 + rng() * 3;
  const length = height * (0.12 + rng() * 0.3);
  let x = rng() * width;
  let y = rng() * height * 0.55;

  const path = new Path2D();
  path.moveTo(x, y);
  for (let travelled = 0; travelled < length; travelled += 6) {
    x += (rng() - 0.5) * 1.6;
    y += 6;
    path.lineTo(x, y);
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = lineWidth;
  ctx.stroke(path);

  // Тонкий блик вдоль левого края дорожки
  ctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.translate(-lineWidth * 0.3, 0);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = Math.max(0.6, lineWidth * 0.25);
  ctx.stroke(path);
  ctx.restore();

  drawDroplet(ctx, x, y + lineWidth * 0.4, lineWidth * 1.2, 0.45);
};

export const paintFog = (ctx: CanvasRenderingContext2D, width: number, height: number, seed: number) => {
  const rng = createRng(seed ^ 0x1b873593);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(235, 240, 250, 0.98)');
  gradient.addColorStop(1, 'rgba(215, 220, 235, 0.96)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const area = width * height;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  const specks = Math.round(area / 28);
  for (let i = 0; i < specks; i++) {
    ctx.fillRect(rng() * width, rng() * height, 1, 1);
  }

  const streaks = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < streaks; i++) drawStreak(ctx, rng, width, height);

  // Конденсат: много мелких капель и немного крупных
  const drops = clamp(Math.round(area / 1300), 120, 700);
  for (let i = 0; i < drops; i++) {
    const r = 0.8 + Math.pow(rng(), 3) * 4.5;
    drawDroplet(ctx, rng() * width, rng() * height, r, 0.25 + rng() * 0.2);
  }
  ctx.globalCompositeOperation = 'source-over';
};

// ---------- Упрямые пятна ----------

const DIRT_PALETTES: Array<{ inner: Rgb; rim: Rgb }> = [
  { inner: [128, 98, 70], rim: [74, 54, 36] }, // грязь
  { inner: [142, 137, 128], rim: [86, 82, 76] }, // пыль
  { inner: [152, 118, 80], rim: [98, 70, 42] }, // глина
  { inner: [108, 92, 76], rim: [60, 50, 40] }, // земля
];

// Неровная клякса: окружность, искажённая синусоидами и шумом, слегка вытянутая
// в случайную сторону и сглаженная кривыми
const blobPath = (rng: Rng, cx: number, cy: number, r: number) => {
  const count = 22 + Math.floor(rng() * 10);
  const waves = [
    { k: 2 + Math.floor(rng() * 3), a: 0.1 + rng() * 0.14, p: rng() * Math.PI * 2 },
    { k: 5 + Math.floor(rng() * 4), a: 0.05 + rng() * 0.08, p: rng() * Math.PI * 2 },
    { k: 9 + Math.floor(rng() * 5), a: 0.02 + rng() * 0.04, p: rng() * Math.PI * 2 },
  ];
  const stretch = 1 + rng() * 0.4;
  const axis = rng() * Math.PI;
  const cosA = Math.cos(axis);
  const sinA = Math.sin(axis);

  const points = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    const wobble = waves.reduce((sum, w) => sum + w.a * Math.sin(w.k * angle + w.p), 0);
    const radius = r * (1 + wobble + (rng() - 0.5) * 0.16);
    // Вытягиваем вдоль оси axis, площадь сохраняется
    const u = (Math.cos(angle) * cosA + Math.sin(angle) * sinA) * radius * stretch;
    const v = (-Math.cos(angle) * sinA + Math.sin(angle) * cosA) * radius / stretch;
    return { x: cx + u * cosA - v * sinA, y: cy + u * sinA + v * cosA };
  });

  const path = new Path2D();
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(points[count - 1], points[0]);
  path.moveTo(start.x, start.y);
  points.forEach((point, i) => {
    const next = mid(point, points[(i + 1) % count]);
    path.quadraticCurveTo(point.x, point.y, next.x, next.y);
  });
  path.closePath();
  return path;
};

const drawSplat = (
  ctx: CanvasRenderingContext2D,
  rng: Rng,
  cx: number,
  cy: number,
  r: number,
  palette: { inner: Rgb; rim: Rgb },
) => {
  const outline = blobPath(rng, cx, cy, r);

  // Середина светлее, к краю темнее – так высыхает грязная капля
  const gx = cx + (rng() - 0.5) * r * 0.4;
  const gy = cy + (rng() - 0.5) * r * 0.4;
  const fill = ctx.createRadialGradient(gx, gy, r * 0.1, cx, cy, r * 1.25);
  fill.addColorStop(0, rgba(palette.inner, 0.58));
  fill.addColorStop(0.65, rgba(palette.inner, 0.72));
  fill.addColorStop(1, rgba(palette.rim, 0.9));
  ctx.fillStyle = fill;
  ctx.fill(outline);

  ctx.strokeStyle = rgba(palette.rim, 0.55);
  ctx.lineWidth = Math.max(1.5, r * 0.07);
  ctx.lineJoin = 'round';
  ctx.stroke(outline);

  // Зернистость внутри пятна
  ctx.save();
  ctx.clip(outline);
  const grains = Math.round((r * r) / 14);
  for (let i = 0; i < grains; i++) {
    ctx.fillStyle = rng() < 0.6 ? rgba(palette.rim, 0.22 + rng() * 0.2) : 'rgba(255, 250, 240, 0.12)';
    const size = 0.8 + rng() * 2;
    ctx.fillRect(cx - r * 1.3 + rng() * r * 2.6, cy - r * 1.3 + rng() * r * 2.6, size, size);
  }
  ctx.restore();

  // Брызги вокруг
  const drops = 3 + Math.floor(rng() * 6);
  ctx.fillStyle = rgba(palette.rim, 0.7);
  for (let i = 0; i < drops; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = r * (1.15 + rng() * 0.7);
    const dropR = r * (0.05 + rng() * 0.1);
    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(angle) * distance,
      cy + Math.sin(angle) * distance,
      dropR * (1 + rng() * 0.5),
      dropR,
      angle,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
};

export const paintStubborn = (ctx: CanvasRenderingContext2D, width: number, height: number, seed: number) => {
  const rng = createRng(seed ^ 0x85ebca6b);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);

  // 4–7 пятен, вместе примерно 6–12% стекла
  const count = 4 + Math.floor(rng() * 4);
  const coverage = 0.06 + rng() * 0.06;
  const weights = Array.from({ length: count }, () => 0.5 + rng());
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const placed: Array<{ x: number; y: number; r: number }> = [];

  weights.forEach((weight) => {
    const area = (width * height * coverage * weight) / weightSum;
    // Брызги и неровный край добавляют площади – основу берём чуть меньше
    const r = Math.sqrt(area / Math.PI) * 0.92;
    // Отступ от краёв: скруглённые углы стекла не должны прятать пятно,
    // а сверху – плашка прогресса и кнопка «Запотеть заново»
    const margin = r * 1.6 + 12;
    const top = Math.max(margin, TOP_HUD_SPACE + r * 1.3);
    let x = width / 2;
    let y = height / 2;
    for (let attempt = 0; attempt < 40; attempt++) {
      x = margin + rng() * Math.max(0, width - margin * 2);
      y = top + rng() * Math.max(0, height - top - margin);
      if (placed.every((spot) => Math.hypot(spot.x - x, spot.y - y) > (spot.r + r) * 1.1)) break;
    }
    placed.push({ x, y, r });
    drawSplat(ctx, rng, x, y, r, DIRT_PALETTES[Math.floor(rng() * DIRT_PALETTES.length)]);
  });
};

// ---------- Замер чистоты ----------

// Читаем только строки сетки, а не весь холст: на большом экране это в 9 раз меньше байт
const sampleRow = (ctx: CanvasRenderingContext2D, width: number, y: number) =>
  ctx.getImageData(0, y, width, 1).data;

export const countDirtSamples = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  if (!width || !height) return 0;
  let count = 0;
  for (let y = SAMPLE_OFFSET; y < height; y += SAMPLE_PITCH) {
    const row = sampleRow(ctx, width, y);
    for (let x = SAMPLE_OFFSET; x < width; x += SAMPLE_PITCH) {
      if (row[x * 4 + 3] >= ALPHA_CLEAN_THRESHOLD) count++;
    }
  }
  return count;
};

// cleanShare – доля точек, чистых на обоих слоях; dirtLeft – сколько точек пятен ещё видно.
// Сетка та же, что в countDirtSamples, иначе dirtLeft не сравнить с initialDirt
export const sampleGlass = (
  fogCtx: CanvasRenderingContext2D,
  dirtCtx: CanvasRenderingContext2D,
  width: number,
  height: number,
) => {
  let total = 0;
  let clean = 0;
  let dirtLeft = 0;
  if (!width || !height) return { cleanShare: 0, dirtLeft };
  for (let y = SAMPLE_OFFSET; y < height; y += SAMPLE_PITCH) {
    const fog = sampleRow(fogCtx, width, y);
    const dirt = sampleRow(dirtCtx, width, y);
    for (let x = SAMPLE_OFFSET; x < width; x += SAMPLE_PITCH) {
      const i = x * 4 + 3;
      total++;
      if (dirt[i] >= ALPHA_CLEAN_THRESHOLD) dirtLeft++;
      else if (fog[i] < ALPHA_CLEAN_THRESHOLD) clean++;
    }
  }
  return { cleanShare: total ? clean / total : 0, dirtLeft };
};
