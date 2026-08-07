import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Store-facing app identity, following the maybeitssoftware convention
  // (uk.co.…, matching open-parliament). Must stay in sync with the match
  // provisioning profile and the Play packageName — see RELEASING.md.
  appId: 'uk.co.maybeitssoftware.watchlondonmove',
  appName: 'Watch London Move',
  // The Vite build, unmodified. `npx cap sync` copies it into both platforms.
  webDir: 'dist',
  server: {
    // Fixes the WebView's origin, which is what the backend's CORS allowlist
    // has to match: capacitor://localhost on iOS, https://localhost here.
    // Changing this means changing CORS_ORIGIN in backend/fly.toml too.
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  android: {
    // Both stores' networking is TLS-only anyway, and the backend must be
    // https/wss regardless; this makes a cleartext regression fail loudly.
    allowMixedContent: false,
  },
  ios: {
    // The map fills the window and manages its own insets via
    // env(safe-area-inset-*) in App.css, so the WebView must not add its own.
    contentInset: 'never',
  },
  plugins: {
    SplashScreen: {
      // Held until the map's first frame; App.tsx hides it. Auto-hiding on a
      // timer would show an empty canvas while MapLibre fetches its style.
      launchAutoHide: false,
      backgroundColor: '#0b0f1a',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0f1a',
    },
  },
};

export default config;
