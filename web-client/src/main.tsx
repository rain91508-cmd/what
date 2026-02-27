import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Import kdbStorage to expose it to global scope for WASM
import './core/storage/kdbStorage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
