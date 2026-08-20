import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary'
import { installGlobalErrorHandlers } from './error-reporting'
import { registerServiceWorker } from './sw-register'

// Before the tree mounts, so a throw during the very first render is caught too.
installGlobalErrorHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// No-op in dev and in the native shell; see sw-register.ts.
registerServiceWorker()
