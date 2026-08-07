import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the same bundle works served from a web root and
  // from the Capacitor WebView, whose origin (capacitor://localhost on iOS) is
  // not a normal http origin.
  base: './',
})
