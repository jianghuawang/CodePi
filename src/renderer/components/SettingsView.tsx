import { Check, Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppSettings } from '../../shared/contracts'
import { useTheme } from '../hooks/useTheme'

interface EnvRow {
  id: string
  key: string
  value: string
  revealed: boolean
}

function settingsToRows(settings: AppSettings): EnvRow[] {
  return Object.entries(settings.env).map(([key, value], index) => ({ id: `${key}-${index}`, key, value, revealed: false }))
}

export function SettingsView(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>()
  const [envRows, setEnvRows] = useState<EnvRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const [validation, setValidation] = useState<{ available: boolean; version?: string; error?: string }>()
  const [validating, setValidating] = useState(false)
  useTheme(settings?.theme ?? 'system')

  useEffect(() => {
    void window.codePi.getSettings()
      .then((value) => {
        setSettings(value)
        setEnvRows(settingsToRows(value))
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
  }, [])

  const env = useMemo(() => Object.fromEntries(envRows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value])), [envRows])

  const save = async () => {
    if (!settings) return
    setSaving(true)
    setSaved(false)
    setError(undefined)
    try {
      const next = await window.codePi.saveSettings({ ...settings, env })
      setSettings(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1_800)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settings, envRows])

  if (loading) return <div className="settings-loading"><span className="spinner" /> Loading settings…</div>
  if (!settings) return <div className="settings-loading error-text">{error ?? 'Settings could not be loaded.'}</div>

  return (
    <main className="settings-window">
      <div className="settings-titlebar drag-region">
        <div>
          <h1>Settings</h1>
          <p>CodePi</p>
        </div>
      </div>
      <div className="settings-scroll">
        <section className="settings-section">
          <h2>Pi agent</h2>
          <p className="settings-description">The command CodePi starts for every thread.</p>
          <label className="field-label" htmlFor="pi-path">Pi binary</label>
          <div className="input-action-row">
            <input
              id="pi-path"
              className="text-input mono-input"
              value={settings.piPath}
              onChange={(event) => {
                setSettings({ ...settings, piPath: event.target.value })
                setValidation(undefined)
              }}
              spellCheck={false}
              placeholder="pi"
            />
            <button
              className="button button-secondary"
              disabled={validating || !settings.piPath.trim()}
              onClick={async () => {
                setValidating(true)
                setValidation(undefined)
                try {
                  setValidation(await window.codePi.validatePi(settings.piPath.trim()))
                } finally {
                  setValidating(false)
                }
              }}
            >
              <RefreshCw size={13} className={validating ? 'spin' : ''} /> Validate
            </button>
          </div>
          {validation && (
            <div className={`validation-result ${validation.available ? 'is-valid' : 'is-invalid'}`}>
              {validation.available ? <Check size={12} /> : null}
              {validation.available ? `Pi ${validation.version ?? ''} is ready.` : validation.error ?? 'Pi was not found at this path.'}
            </div>
          )}

          <label className="field-label" htmlFor="default-model">Default model</label>
          <input
            id="default-model"
            className="text-input"
            value={settings.defaultModel}
            onChange={(event) => setSettings({ ...settings, defaultModel: event.target.value })}
            placeholder="Use Pi default"
          />
        </section>

        <section className="settings-section">
          <h2>Appearance</h2>
          <div className="segmented-control" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((theme) => (
              <button
                key={theme}
                className={settings.theme === theme ? 'is-selected' : ''}
                role="radio"
                aria-checked={settings.theme === theme}
                onClick={() => setSettings({ ...settings, theme })}
              >
                {theme[0].toUpperCase() + theme.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-heading">
            <div>
              <h2>Provider environment</h2>
              <p className="settings-description">Passed only to newly started Pi processes.</p>
            </div>
            <button
              className="button button-secondary compact"
              onClick={() => setEnvRows((rows) => [...rows, { id: crypto.randomUUID(), key: '', value: '', revealed: false }])}
            >
              <Plus size={12} /> Add
            </button>
          </div>
          <div className="env-editor">
            {envRows.length === 0 && <div className="env-empty">No environment variables configured.</div>}
            {envRows.map((row) => (
              <div className="env-row" key={row.id}>
                <input
                  className="text-input mono-input"
                  value={row.key}
                  onChange={(event) => setEnvRows((rows) => rows.map((item) => item.id === row.id ? { ...item, key: event.target.value.toUpperCase() } : item))}
                  placeholder="OPENAI_API_KEY"
                  aria-label="Environment variable name"
                  spellCheck={false}
                />
                <div className="secret-input">
                  <input
                    className="text-input mono-input"
                    type={row.revealed ? 'text' : 'password'}
                    value={row.value}
                    onChange={(event) => setEnvRows((rows) => rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
                    placeholder="Value"
                    aria-label={`${row.key || 'Environment variable'} value`}
                    spellCheck={false}
                  />
                  <button
                    className="secret-reveal"
                    onClick={() => setEnvRows((rows) => rows.map((item) => item.id === row.id ? { ...item, revealed: !item.revealed } : item))}
                    aria-label={row.revealed ? 'Hide value' : 'Reveal value'}
                  >
                    {row.revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <button className="icon-button" onClick={() => setEnvRows((rows) => rows.filter((item) => item.id !== row.id))} aria-label="Remove environment variable">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="settings-footer">
        {error && <span className="settings-error" role="alert">{error}</span>}
        {saved && <span className="saved-indicator"><Check size={12} /> Saved</span>}
        <button className="button button-secondary" onClick={() => window.close()}>Done</button>
        <button className="button button-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </footer>
    </main>
  )
}
