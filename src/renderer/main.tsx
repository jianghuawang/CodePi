import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { SettingsView } from './components/SettingsView'
import './styles.css'

const isSettingsWindow = new URLSearchParams(window.location.search).get('window') === 'settings'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isSettingsWindow ? <SettingsView /> : <App />}</React.StrictMode>,
)
