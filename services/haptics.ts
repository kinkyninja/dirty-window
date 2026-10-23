import type { HapticImpactStyle, TelegramHapticFeedback } from '../types';

// Вибро есть только внутри Telegram с API 6.1+. Вне Telegram скрипт тоже создаёт
// WebApp, но с версией 6.0, и вызовы HapticFeedback там бросают исключение.
const getHaptics = (): TelegramHapticFeedback | null => {
  try {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.HapticFeedback) return null;
    if (webApp.isVersionAtLeast && !webApp.isVersionAtLeast('6.1')) return null;
    return webApp.HapticFeedback;
  } catch {
    return null;
  }
};

const run = (action: (haptics: TelegramHapticFeedback) => void) => {
  const haptics = getHaptics();
  if (!haptics) return;
  try {
    action(haptics);
  } catch {
    // старый клиент – просто без вибро
  }
};

export const haptics = {
  impact: (style: HapticImpactStyle = 'soft') => run((h) => h.impactOccurred(style)),
  selection: () => run((h) => h.selectionChanged()),
  success: () => run((h) => h.notificationOccurred('success')),
};
