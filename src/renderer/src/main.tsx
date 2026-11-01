import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import { AuthGate } from './components/AuthGate'
import '@docx-editor.dev/react/styles.css'
import './styles/global.css'
import './styles/workbench.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AuthGate><App /></AuthGate>
      <Toaster position="bottom-right" theme="light" richColors closeButton />
    </HashRouter>
  </React.StrictMode>
)
