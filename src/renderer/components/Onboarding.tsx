import { Check, Copy, Settings, Terminal } from 'lucide-react'
import { useState } from 'react'

interface OnboardingProps {
  path: string
  error?: string
  onOpenSettings: () => void
}

export function Onboarding({ path, error, onOpenSettings }: OnboardingProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const command = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-symbol"><Terminal size={24} strokeWidth={1.5} /></div>
        <div className="eyebrow">One quick setup</div>
        <h1>Connect the Pi coding agent</h1>
        <p className="onboarding-lead">CodePi runs Pi locally in every thread. Install it once, then validate the binary path in Settings.</p>
        <div className="install-command">
          <code>{command}</code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(command)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1_600)
            }}
            aria-label="Copy install command"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="onboarding-meta">
          <span>Current path</span>
          <code>{path || 'pi'}</code>
        </div>
        {error && <div className="onboarding-error">{error}</div>}
        <button className="button button-primary onboarding-action" onClick={onOpenSettings}>
          <Settings size={14} /> Open Settings
        </button>
      </div>
    </div>
  )
}
