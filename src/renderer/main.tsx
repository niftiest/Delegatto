import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './api'
import { setModelPrices } from '../shared/models'
import { AppDialogHost } from './components/AppDialog'
// The themes' fonts, bundled so nothing loads from the web (all SIL Open Font License 1.1).
import '@fontsource-variable/geist'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/figtree'
import './styles.css'
import { applyCachedTheme } from './theme'
import { loadClaudeModels } from './components/useClaudeModels'

applyCachedTheme()
void loadClaudeModels()

// Costs show from the first paint, so this comes before it. Main has its answer ready within a
// moment, or a second or two straight after Claude Code has updated.
void api.modelPrices().then(setModelPrices).catch(() => { /* the built-in prices stand */ }).finally(() => {
  createRoot(document.getElementById('root')!).render(<><App /><AppDialogHost /></>)
})
