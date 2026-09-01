import { createRoot } from 'react-dom/client'
// Inter is bundled, not fetched: the app has to render offline. Weight axis
// only — the opsz build would fight the per-step tracking in sidenote.css.
import '@fontsource-variable/inter/wght.css'
import '@fontsource-variable/inter/wght-italic.css'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import './sidenote.css'
import App from './App'
import { ipc } from './ipc'

window.addEventListener('error', (e) => void ipc.uiLog(`error: ${e.message} @${e.filename}:${e.lineno}`))
window.addEventListener('unhandledrejection', (e) => void ipc.uiLog(`rejection: ${String(e.reason?.stack ?? e.reason)}`))
void ipc.uiLog('ui: boot')

// No StrictMode: its double-mount destroys the first Crepe instance mid-create.
createRoot(document.getElementById('root')!).render(<App />)
