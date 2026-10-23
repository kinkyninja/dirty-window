// Скрип не чаще раза в 250 мс
const SQUEAK_MIN_INTERVAL_MS = 250;
// Ми–соль–до: мягкий восходящий перезвон
const CHIME_NOTES = [659.25, 783.99, 1046.5];

class AudioService {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private isInitialized = false;
  private lastSqueakAt = 0;

  private init() {
    if (this.isInitialized) return;

    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      const bufferSize = this.audioContext.sampleRate * 2;
      const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const noiseNode = this.audioContext.createBufferSource();
      noiseNode.buffer = noiseBuffer;
      noiseNode.loop = true;

      const filterNode = this.audioContext.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.value = 600; // Чуть выше частота для мобильных динамиков
      filterNode.Q.value = 0.5;

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 0;

      noiseNode.connect(filterNode);
      filterNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);

      noiseNode.start();
      this.isInitialized = true;
    } catch (e) {
      console.error("Audio initialization failed", e);
    }
  }

  // Короткие эффекты играем только в живом контексте, иначе они прозвучат пачкой позже
  private runningContext(): AudioContext | null {
    return this.audioContext?.state === 'running' ? this.audioContext : null;
  }

  // iOS разрешает звук только после жеста: зовём на каждом касании и нажатии кнопок.
  // Состояние может быть и 'interrupted' (звонок, свернули Telegram), поэтому проверяем на 'running'.
  public resume() {
    if (!this.isInitialized) this.init();
    const ctx = this.audioContext;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
      ctx.resume().catch(() => {});
    }
  }

  public startScrubbing() {
    this.resume();
    if (this.gainNode && this.audioContext) {
      // Громкость 0.1 вместо 0.04 для лучшей слышимости
      this.gainNode.gain.setTargetAtTime(0.1, this.audioContext.currentTime, 0.05);
    }
  }

  public stopScrubbing() {
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setTargetAtTime(0, this.audioContext.currentTime, 0.15);
    }
  }

  // Тихий «скрип» по стеклу: быстрый синус с глиссандо
  public squeak() {
    const ctx = this.runningContext();
    if (!ctx) return;
    const now = performance.now();
    if (now - this.lastSqueakAt < SQUEAK_MIN_INTERVAL_MS) return;
    this.lastSqueakAt = now;

    const t = ctx.currentTime;
    const base = 1500 + Math.random() * 900;
    const target = Math.random() < 0.6 ? base * 1.45 : base * 0.7;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(target, t + 0.09);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.03, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);

    osc.connect(gain).connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(t);
    osc.stop(t + 0.15);
  }

  // Три мягкие ноты-колокольчика на чистое окно
  public chime() {
    const ctx = this.runningContext();
    if (!ctx) return;
    const start = ctx.currentTime + 0.05;

    CHIME_NOTES.forEach((freq, i) => {
      const t = start + i * 0.14;
      // Основной тон и тихий обертон октавой выше – звучит как колокольчик
      [
        { mult: 1, peak: 0.06, decay: 1.1 },
        { mult: 2, peak: 0.015, decay: 0.5 },
      ].forEach(({ mult, peak, decay }) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * mult, t);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

        osc.connect(gain).connect(ctx.destination);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
        osc.start(t);
        osc.stop(t + decay + 0.05);
      });
    });
  }
}

export const audioService = new AudioService();
