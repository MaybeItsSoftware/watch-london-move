import { useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const IS_NATIVE = Capacitor.isNativePlatform();

/**
 * Whether the app is in the foreground.
 *
 * Two sources because neither is sufficient alone: `visibilitychange` is the
 * only signal in a browser tab, but iOS does not reliably fire it when a
 * WKWebView is suspended, so the native lifecycle event is authoritative there.
 * Both resolve to the same boolean, so overlapping events are harmless.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => document.visibilityState !== 'hidden');

  useEffect(() => {
    const onVisibility = () => setActive(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);

    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      setActive(isActive);
    });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      listener.then((handle) => handle.remove());
    };
  }, []);

  return active;
}

/**
 * Native chrome. No-ops in a browser.
 *
 * `ready` gates the splash screen: `launchAutoHide` is off in
 * capacitor.config.ts because a timer would uncover an empty canvas while
 * MapLibre is still fetching its style, so the app dismisses it once there is
 * something to look at.
 */
export function useNativeShell(ready: boolean) {
  useEffect(() => {
    if (!IS_NATIVE) {
      return;
    }
    // Light content — the bar sits over the app's near-black background.
    StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
    // Android only; iOS rejects it. Draws the map full-bleed behind the bar,
    // which App.css then keeps the panels clear of.
    StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_NATIVE || !ready) {
      return;
    }
    SplashScreen.hide().catch(() => {});
  }, [ready]);
}
