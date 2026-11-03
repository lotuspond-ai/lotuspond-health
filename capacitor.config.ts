import type { CapacitorConfig } from '@capacitor/cli';

// Native shells for iOS and Android. They load the same Vite build (dist/) from the device;
// nothing is fetched from a server, so the app works offline and data never leaves the phone.
const config: CapacitorConfig = {
  appId: 'ai.lotuspond.health',
  appName: 'LotusPond Health',
  // The app shell only (tools/build-mobile.mjs); the public website is not part of the apps.
  webDir: 'dist-mobile',
  backgroundColor: '#0c2528',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0c2528',
    // No long-press link previews: every page is local app content.
    allowsLinkPreview: false,
  },
  plugins: {
    SplashScreen: {
      // Hidden from code once stored data has loaded (src/native/index.ts).
      launchAutoHide: false,
      launchShowDuration: 0,
      backgroundColor: '#0c2528',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },
    SystemBars: {
      // Edge-to-edge on Android: the page pads itself using --safe-area-inset-* (see src/index.css).
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'LIGHT',
    },
  },
};

export default config;
