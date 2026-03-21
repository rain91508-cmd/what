import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Import kdbStorage to expose it to global scope for WASM
import './core/storage/kdbStorage'

// i18n
import { I18nProvider } from './i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)
