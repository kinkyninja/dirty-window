
export interface Point {
  x: number;
  y: number;
}

export enum GameStatus {
  START = 'START',
  PLAYING = 'PLAYING',
  CLEAN = 'CLEAN'
}

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type HapticNotificationType = 'error' | 'success' | 'warning';

export interface TelegramHapticFeedback {
  impactOccurred: (style: HapticImpactStyle) => void;
  notificationOccurred: (type: HapticNotificationType) => void;
  selectionChanged: () => void;
}

// Telegram WebApp API (подключается скриптом в index.html)
declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        expand: () => void;
        ready: () => void;
        disableVerticalSwipes: () => void;
        setHeaderColor?: (color: string) => void;
        setBackgroundColor?: (color: string) => void;
        headerColor: string;
        backgroundColor: string;
        version?: string;
        isVersionAtLeast?: (version: string) => boolean;
        HapticFeedback?: TelegramHapticFeedback;
      };
    };
  }
}
