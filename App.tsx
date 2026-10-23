import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import { audioService } from './services/audioService';
import { haptics } from './services/haptics';
import { storage } from './services/storage';
import { ALPHA_CLEAN_THRESHOLD, countDirtSamples, paintFog, paintStubborn, sampleGlass, windowSeed } from './services/glassDirt';
import { GameStatus, Point } from './types';

// Порог очистки 0.85
const CLEAN_THRESHOLD = 0.85;
// Упрямые пятна должны сойти хотя бы на 90%
const STUBBORN_CLEAN_SHARE = 0.9;
// Сколько снимает с пятна один отпечаток кисти (туман стирается целиком)
const STUBBORN_ERASE_ALPHA = 0.1;
const PROGRESS_CHECK_MS = 120;
const HAPTIC_INTERVAL_MS = 80;
// Скорость мазка перед разворотом, после которой стекло может скрипнуть, px/мс
const SQUEAK_SPEED = 0.9;
const HINT_TEXT = 'Остались пятна';
const HINT_DURATION_MS = 2800;
// Картинка не загрузилась – пробуем ту же ещё 3 раза: через 0.8, 1.6 и 3.2 с
const IMG_AUTO_RETRIES = 3;
const IMG_RETRY_BASE_MS = 800;

const STORAGE_INDEX_KEY = 'windowIndex';

// Линейная структура уровней (70 изображений), картинки лежат в public/backgrounds
const TOTAL_WINDOWS = 70;
const backgroundImages = Array.from({ length: TOTAL_WINDOWS }, (_, i) => `${import.meta.env.BASE_URL}backgrounds/${i + 1}.jpg`);

const seriesList = [
  { emoji: "🌅", name: "Тихое пробуждение" },
  { emoji: "🥐", name: "Вкус жизни" },
  { emoji: "🌊", name: "Дыхание моря" },
  { emoji: "🎨", name: "Игра цвета" },
  { emoji: "🏔️", name: "Величие вершин" },
  { emoji: "🌃", name: "Огни мегаполиса" },
  { emoji: "☁️", name: "Небесная высь" },
];

const loadSavedIndex = () => {
  const saved = Math.floor(storage.getNumber(STORAGE_INDEX_KEY, 0));
  return saved >= 0 && saved < TOTAL_WINDOWS ? saved : 0;
};

// Отпечаток кисти рисуем один раз и дальше просто штампуем drawImage
const makeBrush = (radius: number) => {
  const brush = document.createElement('canvas');
  brush.width = brush.height = radius * 2;
  const ctx = brush.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.6, 'rgba(255, 255, 255, 0.7)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, radius * 2, radius * 2);
  }
  return brush;
};

// Состояние текущего мазка: живёт в ref, чтобы не перерисовывать React на каждый пиксель
interface Stroke {
  pointerId: number;
  rect: DOMRect;
  lastStamp: Point | null;
  lastMove: Point & { t: number };
  dir: Point | null;
  runPeakSpeed: number;
}

// Флаги одного «запотевания» окна
interface Round {
  initialDirt: number;
  startedAt: number | null;
  hintShown: boolean;
  half: boolean;
  threeQuarters: boolean;
}

const freshRound = (initialDirt = 0): Round => ({
  initialDirt,
  startedAt: null,
  hintShown: false,
  half: false,
  threeQuarters: false,
});

const App: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fogCanvasRef = useRef<HTMLCanvasElement>(null);
  const dirtCanvasRef = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<GameStatus>(GameStatus.START);
  const [showVictoryUI, setShowVictoryUI] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [mousePos, setMousePos] = useState<Point>({ x: -100, y: -100 });
  const [bgIndex, setBgIndex] = useState(loadSavedIndex);
  const [isImgLoading, setIsImgLoading] = useState(true);
  const [surfaceSize, setSurfaceSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [hint, setHint] = useState<string | null>(null);
  // Номер попытки загрузить картинку окна: от него зависит src, чтобы браузер запросил заново
  const [imgAttempt, setImgAttempt] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);

  const lastCheckTime = useRef<number>(0);
  const imgAutoRetries = useRef<number>(0);
  const imgRetryTimer = useRef<number | null>(null);
  const statusRef = useRef<GameStatus>(status);
  const bgIndexRef = useRef(bgIndex);
  const strokeRef = useRef<Stroke | null>(null);
  const roundRef = useRef<Round>(freshRound());
  const lastHapticAt = useRef<number>(0);

  // Статус дублируем в ref: события указателя могут прийти раньше перерисовки
  const changeStatus = (next: GameStatus) => {
    statusRef.current = next;
    setStatus(next);
  };

  // Telegram Initialization
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;
    try {
      webApp.ready();
      webApp.expand();
      webApp.setHeaderColor?.('#f2ede4');
      webApp.setBackgroundColor?.('#f2ede4');
      // Свайпы отключаются с API 7.7, в старых версиях вызов только ругается в консоль
      if (webApp.disableVerticalSwipes && (webApp.isVersionAtLeast?.('7.7') ?? true)) {
        webApp.disableVerticalSwipes();
      }
    } catch (e) {
      console.warn("Telegram WebApp init failed", e);
    }
  }, []);

  useEffect(() => {
    storage.setNumber(STORAGE_INDEX_KEY, bgIndex);
  }, [bgIndex]);

  const currentSeriesIndex = Math.floor(bgIndex / 10);
  const levelInSeries = (bgIndex % 10) + 1;

  const seriesConfig = useMemo(() => {
    const config = seriesList[currentSeriesIndex];
    return {
      ...config,
      subtitle: config.name === "Тихое пробуждение" ? "Мир всё еще размыт после сна. Протри, чтобы сфокусироваться." :
                config.name === "Вкус жизни" ? "Ароматы витают в воздухе. Очисти стекло, чтобы увидеть блюдо." :
                config.name === "Дыхание моря" ? "Соленый ветер и волны. Сотри брызги, чтобы увидеть горизонт." :
                config.name === "Игра цвета" ? "Палитра эмоций скрыта. Очисти фон, чтобы вернуть яркость." :
                config.name === "Величие вершин" ? "Свежий воздух и свобода. Сотри туман, чтобы увидеть простор." :
                config.name === "Огни мегаполиса" ? "Город не спит. Сотри темноту, чтобы найти свет." :
                "Ты на вершине мира. Коснись облаков своей рукой."
    };
  }, [currentSeriesIndex]);

  const currentImageUrl = useMemo(() => {
    return backgroundImages[bgIndex];
  }, [bgIndex]);

  useEffect(() => {
    const nextIndex = (bgIndex + 1) % backgroundImages.length;
    const nextUrl = backgroundImages[nextIndex];
    const img = new Image();
    img.src = nextUrl;
  }, [bgIndex]);

  const currentBrushRadius = useMemo(() => {
    return surfaceSize.width < 768 ? 50 : 80;
  }, [surfaceSize.width]);

  const brush = useMemo(() => makeBrush(currentBrushRadius), [currentBrushRadius]);

  // Рисует оба слоя грязи для окна index. Узор зависит только от index и размера,
  // поэтому повторный вызов возвращает то же самое стекло.
  const setupLayers = useCallback((index: number) => {
    const fog = fogCanvasRef.current;
    const dirt = dirtCanvasRef.current;
    const surface = fog?.parentElement;
    if (!fog || !dirt || !surface) return;

    const fogCtx = fog.getContext('2d', { willReadFrequently: true });
    const dirtCtx = dirt.getContext('2d', { willReadFrequently: true });
    if (!fogCtx || !dirtCtx) return;

    const width = surface.clientWidth;
    const height = surface.clientHeight;
    setSurfaceSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));

    fog.width = dirt.width = width;
    fog.height = dirt.height = height;

    const seed = windowSeed(index);
    paintFog(fogCtx, width, height, seed);
    paintStubborn(dirtCtx, width, height, seed);

    roundRef.current = freshRound(countDirtSamples(dirtCtx, width, height));
    strokeRef.current = null;
    setIsDrawing(false);
    audioService.stopScrubbing();
    setProgress(0);
    setHint(null);
  }, []);

  // До отрисовки, чтобы при смене окна не мелькнуло старое стекло
  useLayoutEffect(() => {
    bgIndexRef.current = bgIndex;
    setupLayers(bgIndex);
  }, [bgIndex, setupLayers]);

  // Пересоздаём слои, только если размер стекла правда изменился
  const syncLayerSize = useCallback(() => {
    const fog = fogCanvasRef.current;
    const surface = fog?.parentElement;
    if (!fog || !surface) return;
    if (fog.width === surface.clientWidth && fog.height === surface.clientHeight) return;
    // Окно уже начали тереть – протёртое не стираем: холст остаётся прежним, CSS
    // растягивает его на новое стекло, а точки пальца пересчитывает toCanvasPoint.
    // Под новый размер перерисуем на следующем окне или по «Запотеть заново»
    if (statusRef.current === GameStatus.PLAYING && roundRef.current.startedAt !== null) {
      if (strokeRef.current) strokeRef.current.rect = fog.getBoundingClientRect();
      return;
    }
    setupLayers(bgIndexRef.current);
  }, [setupLayers]);

  // Стекло может поменять размер и без resize окна (вьюпорт Telegram, Tailwind с CDN
  // применяется уже после первой отрисовки), поэтому следим за самим стеклом
  useEffect(() => {
    const surface = fogCanvasRef.current?.parentElement;
    if (!surface) return;
    syncLayerSize();
    window.addEventListener('resize', syncLayerSize);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncLayerSize) : null;
    observer?.observe(surface);
    return () => {
      window.removeEventListener('resize', syncLayerSize);
      observer?.disconnect();
    };
  }, [syncLayerSize]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const preventDefault = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button')) {
        return;
      }
      if (e.cancelable) {
        e.preventDefault();
      }
    };

    container.addEventListener('touchstart', preventDefault, { passive: false });
    container.addEventListener('touchmove', preventDefault, { passive: false });

    return () => {
      container.removeEventListener('touchstart', preventDefault);
      container.removeEventListener('touchmove', preventDefault);
    };
  }, []);

  useEffect(() => {
    if (status !== GameStatus.CLEAN) return;
    const victoryTimer = window.setTimeout(() => setShowVictoryUI(true), 1000);
    return () => clearTimeout(victoryTimer);
  }, [status]);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), HINT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  const startGame = () => {
    audioService.resume();
    // Подстраховка для WebView без ResizeObserver
    syncLayerSize();
    changeStatus(GameStatus.PLAYING);
  };

  const cancelImgRetry = () => {
    if (imgRetryTimer.current !== null) {
      clearTimeout(imgRetryTimer.current);
      imgRetryTimer.current = null;
    }
  };

  useEffect(() => cancelImgRetry, []);

  const nextWindow = () => {
    // Панель ещё уезжает после первого нажатия – второе не должно пропустить окно
    if (statusRef.current !== GameStatus.CLEAN) return;
    audioService.resume();
    const nextIdx = (bgIndex + 1) % backgroundImages.length;
    setBgIndex(nextIdx);
    setProgress(0);
    setIsImgLoading(true);
    cancelImgRetry();
    imgAutoRetries.current = 0;
    setImgAttempt(0);
    setImgFailed(false);
    setShowVictoryUI(false);
    changeStatus(nextIdx % 10 === 0 ? GameStatus.START : GameStatus.PLAYING);
  };

  const downloadImage = async () => {
    try {
      const response = await fetch(currentImageUrl);
      const blob = await response.blob();
      const fileName = `window-cleaning-level-${bgIndex + 1}.jpg`;
      const file = new File([blob], fileName, { type: 'image/jpeg' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Моё идеально чистое окно',
          text: 'Посмотри, как красиво!'
        });
      } else {
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.target = "_blank";
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error("Failed to share/download image", e);
      window.open(currentImageUrl, '_blank');
    }
  };

  const finishWindow = () => {
    changeStatus(GameStatus.CLEAN);
    strokeRef.current = null;
    setIsDrawing(false);
    setHint(null);
    audioService.stopScrubbing();
    audioService.chime();
    haptics.success();

    // Это окно уже чистое – при следующем запуске продолжим со следующего
    storage.setNumber(STORAGE_INDEX_KEY, (bgIndex + 1) % backgroundImages.length);
  };

  const calculateProgress = () => {
    if (statusRef.current !== GameStatus.PLAYING) return;
    const fog = fogCanvasRef.current;
    const fogCtx = fog?.getContext('2d');
    const dirtCtx = dirtCanvasRef.current?.getContext('2d');
    if (!fog || !fogCtx || !dirtCtx || !fog.width || !fog.height) return;

    const { cleanShare, dirtLeft } = sampleGlass(fogCtx, dirtCtx, fog.width, fog.height);
    setProgress(Math.floor(cleanShare * 100));

    const round = roundRef.current;
    if (cleanShare >= 0.75 && !round.threeQuarters) {
      round.half = round.threeQuarters = true;
      haptics.selection();
    } else if (cleanShare >= 0.5 && !round.half) {
      round.half = true;
      haptics.selection();
    }

    if (cleanShare <= CLEAN_THRESHOLD) return;
    const dirtRemoved = round.initialDirt > 0 ? 1 - dirtLeft / round.initialDirt : 1;
    if (dirtRemoved >= STUBBORN_CLEAN_SHARE) {
      finishWindow();
    } else if (!round.hintShown) {
      round.hintShown = true;
      setHint(HINT_TEXT);
    }
  };

  // Точка на экране → пиксель холста. Обычно это одно и то же, но если стекло
  // поменяло размер посреди раунда, холст растянут CSS и масштаб уже не 1
  const toCanvasPoint = (stroke: Stroke, clientX: number, clientY: number): Point => {
    const fog = fogCanvasRef.current;
    const { rect } = stroke;
    const scaleX = fog && rect.width ? fog.width / rect.width : 1;
    const scaleY = fog && rect.height ? fog.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const scrub = (clientX: number, clientY: number) => {
    const stroke = strokeRef.current;
    const fogCtx = fogCanvasRef.current?.getContext('2d');
    const dirtCtx = dirtCanvasRef.current?.getContext('2d');
    if (!stroke || !fogCtx || !dirtCtx || statusRef.current !== GameStatus.PLAYING) return;

    const r = currentBrushRadius;
    const stamp = (x: number, y: number) => {
      fogCtx.globalCompositeOperation = 'destination-out';
      fogCtx.drawImage(brush, x - r, y - r);
      // Пятна сходят понемногу – по ним надо пройтись несколько раз
      dirtCtx.globalCompositeOperation = 'destination-out';
      dirtCtx.globalAlpha = STUBBORN_ERASE_ALPHA;
      dirtCtx.drawImage(brush, x - r, y - r);
      dirtCtx.globalAlpha = 1;
    };

    const point = toCanvasPoint(stroke, clientX, clientY);
    const last = stroke.lastStamp;
    if (!last) {
      stamp(point.x, point.y);
      stroke.lastStamp = point;
    } else {
      // Отпечатки с шагом в треть радиуса: быстрый мазок не оставляет пропусков,
      // а оттирание зависит от пройденного пути, а не от времени
      const dx = point.x - last.x;
      const dy = point.y - last.y;
      const dist = Math.hypot(dx, dy);
      const spacing = Math.max(2, r / 3);
      const steps = Math.floor(dist / spacing);
      if (steps > 0) {
        const stepX = (dx / dist) * spacing;
        const stepY = (dy / dist) * spacing;
        for (let i = 1; i <= steps; i++) {
          stamp(last.x + stepX * i, last.y + stepY * i);
        }
        stroke.lastStamp = { x: last.x + stepX * steps, y: last.y + stepY * steps };
      }
    }

    const now = performance.now();
    if (now - lastCheckTime.current > PROGRESS_CHECK_MS) {
      lastCheckTime.current = now;
      calculateProgress();
    }
  };

  const isOverDirt = (stroke: Stroke, clientX: number, clientY: number) => {
    const dirtCtx = dirtCanvasRef.current?.getContext('2d');
    if (!dirtCtx) return false;
    const point = toCanvasPoint(stroke, clientX, clientY);
    return dirtCtx.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data[3] >= ALPHA_CLEAN_THRESHOLD;
  };

  // Вибро и скрип по движению пальца
  const feelMovement = (clientX: number, clientY: number) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    const now = performance.now();
    const dx = clientX - stroke.lastMove.x;
    const dy = clientY - stroke.lastMove.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    const dt = Math.max(1, now - stroke.lastMove.t);
    stroke.lastMove = { x: clientX, y: clientY, t: now };

    // Палец увели за пределы стекла – там нечего тереть
    const { rect } = stroke;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    if (now - lastHapticAt.current >= HAPTIC_INTERVAL_MS) {
      lastHapticAt.current = now;
      // По пятну чуть ощутимее – чувствуется сопротивление
      haptics.impact(isOverDirt(stroke, clientX, clientY) ? 'light' : 'soft');
    }

    if (dist < 3) return;
    const dir = { x: dx / dist, y: dy / dist };
    const speed = dist / dt;
    const reversed = stroke.dir !== null && dir.x * stroke.dir.x + dir.y * stroke.dir.y < -0.3;
    if (reversed) {
      // Иногда скрипнуть на резком развороте после быстрого мазка
      if (stroke.runPeakSpeed > SQUEAK_SPEED && Math.random() < 0.5) {
        audioService.squeak();
      }
      stroke.runPeakSpeed = speed;
    } else {
      stroke.runPeakSpeed = Math.max(stroke.runPeakSpeed, speed);
    }
    stroke.dir = dir;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    audioService.resume();
    if (statusRef.current !== GameStatus.PLAYING) return;
    if ((e.target as HTMLElement).closest('button')) return;
    // Второй палец не рисует, пока ведёт первый. Новый основной указатель значит,
    // что прежние уже отпущены, – старый мазок (если потерялся pointerup) сбрасываем
    if (strokeRef.current && !e.isPrimary) return;
    const fog = fogCanvasRef.current;
    if (!fog) return;

    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // указатель уже отпущен – мазок всё равно начнём
    }
    const now = performance.now();
    strokeRef.current = {
      pointerId: e.pointerId,
      rect: fog.getBoundingClientRect(),
      lastStamp: null,
      lastMove: { x: e.clientX, y: e.clientY, t: now },
      dir: null,
      runPeakSpeed: 0,
    };
    if (roundRef.current.startedAt === null) roundRef.current.startedAt = now;

    audioService.startScrubbing();
    setIsDrawing(true);
    setMousePos({ x: e.clientX, y: e.clientY });
    scrub(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== e.pointerId || statusRef.current !== GameStatus.PLAYING) return;
    feelMovement(e.clientX, e.clientY);
    scrub(e.clientX, e.clientY);
  };

  const handlePointerEnd = (e: React.PointerEvent) => {
    // Для касаний именно pointerup считается жестом, после которого iOS включает звук
    audioService.resume();
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== e.pointerId) return;
    strokeRef.current = null;
    setIsDrawing(false);
    audioService.stopScrubbing();
    calculateProgress();
  };

  // Картинки лежат рядом с игрой, так что ошибка – это почти всегда обрыв сети.
  // Пробуем то же окно ещё раз, а не перескакиваем на следующее
  const handleImageError = () => {
    cancelImgRetry();
    if (imgAutoRetries.current >= IMG_AUTO_RETRIES) {
      setImgFailed(true);
      return;
    }
    const delay = IMG_RETRY_BASE_MS * 2 ** imgAutoRetries.current;
    imgAutoRetries.current++;
    imgRetryTimer.current = window.setTimeout(() => {
      imgRetryTimer.current = null;
      setImgAttempt((attempt) => attempt + 1);
    }, delay);
  };

  const retryImage = () => {
    cancelImgRetry();
    imgAutoRetries.current = 0;
    setImgFailed(false);
    setImgAttempt((attempt) => attempt + 1);
  };

  const isResuming = levelInSeries > 1;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 w-full h-full bg-[#f2ede4] text-[#1e1b26] overflow-hidden flex flex-col pt-[calc(env(safe-area-inset-top,0px)+10px)] px-[10px] pb-[calc(env(safe-area-inset-bottom,0px)+80px)] sm:pb-[110px] touch-none overscroll-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      {/* Top HUD */}
      <div className="flex flex-col items-center mb-3 select-none">
        <p className="hud-series">
          <span>{seriesConfig.name}</span>
          <span className="hud-count">{levelInSeries}/10</span>
        </p>
        <div className="flex items-center gap-3 mt-1.5">
          {seriesList.map((item, idx) => (
            <span
              key={idx}
              className={`text-[14px] transition-all duration-300 ${idx === currentSeriesIndex ? 'scale-125 opacity-100 filter-none' : idx < currentSeriesIndex ? 'scale-100 opacity-100 grayscale-0' : 'scale-100 opacity-30 grayscale'}`}
            >
              {item.emoji}
            </span>
          ))}
        </div>
      </div>

      <div className="relative flex-1 bg-[#1e1b26] rounded-[28px] overflow-hidden">
        <img
          src={imgAttempt ? `${currentImageUrl}?r=${imgAttempt}` : currentImageUrl}
          alt=""
          className={`absolute block top-0 left-0 w-full h-full object-cover pointer-events-none z-0 transition-opacity duration-700 ${isImgLoading ? 'opacity-0' : 'opacity-100'}`}
          style={{
            filter: status === GameStatus.CLEAN ? 'none' : `blur(${Math.max(0, 25 - progress * 1.5)}px)`,
            transition: 'filter 0.3s ease-out, opacity 0.7s ease-in'
          }}
          onLoad={() => setIsImgLoading(false)}
          onError={handleImageError}
        />

        {isImgLoading && !imgFailed && (
          <div className="absolute inset-0 z-0 flex items-center justify-center text-white/40 text-[13px] font-medium animate-pulse">
            Загрузка…
          </div>
        )}

        {/* Картинка так и не загрузилась – даём повторить вручную */}
        {imgFailed && (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-6 pointer-events-none select-none">
            <button
              onClick={(e) => { e.stopPropagation(); retryImage(); }}
              className="pointer-events-auto bg-[#f2ede4] text-[#1e1b26] px-5 py-3 rounded-full text-[14px] font-medium transition-all active:scale-95 touch-auto"
            >
              Не загрузилось – повторить
            </button>
          </div>
        )}

        {/* Запотевшее стекло */}
        <canvas
          ref={fogCanvasRef}
          className={`glass-layer z-10 transition-opacity duration-1000 touch-none overscroll-none ${status === GameStatus.CLEAN ? 'opacity-0' : 'opacity-100'}`}
        />

        {/* Упрямые пятна поверх тумана */}
        <canvas
          ref={dirtCanvasRef}
          className={`glass-layer z-[11] transition-opacity duration-1000 touch-none overscroll-none ${status === GameStatus.CLEAN ? 'opacity-0' : 'opacity-100'}`}
        />

        {status === GameStatus.PLAYING && (
          <div className="absolute top-6 left-6 z-20 pointer-events-none select-none flex flex-col gap-2">
            <div className="bg-black/40 backdrop-blur-md px-3 py-2 rounded-full text-white flex items-center gap-2.5">
              <div className="w-16 h-1 bg-white/25 rounded-full overflow-hidden">
                <div className="h-full bg-white transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-[12px] font-medium tabular-nums">{progress}%</p>
            </div>
          </div>
        )}

        {status === GameStatus.PLAYING && (
          <div className="absolute top-6 right-6 z-20">
            <button
              onClick={(e) => { e.stopPropagation(); setupLayers(bgIndex); }}
              className="bg-black/40 backdrop-blur-md p-3 rounded-full text-white transition-all active:scale-90 touch-auto"
              title="Запотеть заново"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </svg>
            </button>
          </div>
        )}

        {/* Подсказка про оставшиеся пятна */}
        {hint && status === GameStatus.PLAYING && (
          <div className="absolute bottom-6 inset-x-0 z-20 flex justify-center px-6 pointer-events-none select-none">
            <div className="animate-toast bg-[#f2ede4] text-[#1e1b26] px-4 py-2 rounded-full text-[14px] font-medium text-center">
              {hint}
            </div>
          </div>
        )}

        {/* Start Modal */}
        {status === GameStatus.START && (
          <div className="absolute inset-0 z-30 flex items-center justify-center p-6 bg-[#f2ede4]/80 backdrop-blur-[8px]">
            <div className="bg-[#f2ede4] border border-[#1e1b26]/10 p-7 rounded-[28px] text-center max-w-sm w-full animate-in fade-in zoom-in duration-300">
              <div className="text-[44px] mb-4 leading-none select-none">
                {seriesConfig.emoji}
              </div>
              <h2 className="start-title mb-2">
                {seriesConfig.name}
              </h2>
              <p className="text-[#5f5a66] text-[15px] leading-snug mb-6">
                {seriesConfig.subtitle}
              </p>
              <button
                onClick={(e) => { e.stopPropagation(); startGame(); }}
                className="start-btn w-full bg-[#1e1b26] text-[#f2ede4] py-4 rounded-full active:scale-95 transition-all touch-auto"
              >
                {isResuming ? 'Продолжить' : 'Начать'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Victory Bottom Control Panel */}
      <div
        className={`fixed left-0 right-0 bottom-0 bg-[#f2ede4] px-6 py-4 transition-transform duration-500 ease-out z-40 border-t border-[#1e1b26]/10 flex items-center justify-center gap-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] ${showVictoryUI ? 'translate-y-0' : 'translate-y-full pointer-events-none'}`}
      >
        <button
          onClick={(e) => { e.stopPropagation(); downloadImage(); }}
          className="w-12 h-12 flex items-center justify-center border border-[#1e1b26]/15 text-[#1e1b26] rounded-full transition-all active:scale-90 touch-auto"
          title="Поделиться"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); nextWindow(); }}
          className="next-btn px-9 h-12 flex items-center gap-2 bg-[#1e1b26] text-[#f2ede4] rounded-full transition-all active:scale-95 touch-auto"
        >
          <span>Дальше</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </button>
      </div>

      <div
        className="cursor-brush"
        style={{
          left: mousePos.x,
          top: mousePos.y,
          width: currentBrushRadius * 2,
          height: currentBrushRadius * 2,
          opacity: (status !== GameStatus.PLAYING || isDrawing) ? 0 : 0.4,
          background: 'radial-gradient(circle, rgba(255,255,255,0.7) 0%, transparent 70%)',
          border: '1px solid rgba(255,255,255,0.2)'
        }}
      />
    </div>
  );
};

export default App;
