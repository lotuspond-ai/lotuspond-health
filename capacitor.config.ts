import type { CapacitorConfig } from '@capacitor/cli';

// Native shells for iOS and Android. They load the app shell (tools/build-mobile.mjs) from the device and call
// the LotusPond API with a token session (src/api/appSession.ts).

// Test builds can call a server on your computer over plain http: those with the server picker
// (VITE_SERVER_PICKER=1, as CI builds them) or built for an http VITE_API_ORIGIN. Android's web view runs on
// https://localhost and blocks http requests from it as mixed content unless this is allowed; release builds
// keep it blocked (they only call https).
const testBuild = process.env.VITE_SERVER_PICKER === '1' || /^http:\/\//i.test(process.env.VITE_API_ORIGIN ?? '');

const config: CapacitorConfig = {
  appId: 'ai.lotuspond.health',
  appName: 'LotusPond Health',
  // The app shell only (tools/build-mobile.mjs); the public website is not part of the apps.
  webDir: 'dist-mobile',
  backgroundColor: '#0c2528',
  android: {
    allowMixedContent: testBuild,
  },
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
