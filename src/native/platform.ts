import { Capacitor } from '@capacitor/core';

/** True inside the iOS / Android app shells (Capacitor), false in a browser. */
export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';
