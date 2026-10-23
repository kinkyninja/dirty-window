// localStorage может бросать (приватный режим, запрет cookies) – игра работает и без него
const PREFIX = 'dirty-window:';

export const storage = {
  getNumber(key: string, fallback: number): number {
    try {
      const raw = window.localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  },

  setNumber(key: string, value: number) {
    try {
      window.localStorage.setItem(PREFIX + key, String(value));
    } catch {
      // не сохранилось – не страшно
    }
  },
};
