import { FileText, Monitor, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AppPreview } from './AppPreview'
import { FileViewer } from './FileViewer'

export type WorkspaceDockTab = 'files' | 'preview'

export interface WorkspaceDockProps {
  threadId: string
  activeTab: WorkspaceDockTab
  onTabChange: (tab: WorkspaceDockTab) => void
  onClose: () => void
  initialFilePath?: string
  initialPreviewUrl?: string
}

const TABS: Array<{
  value: WorkspaceDockTab
  label: string
  icon: typeof FileText
}> = [
  { value: 'files', label: 'Files', icon: FileText },
  { value: 'preview', label: 'Preview', icon: Monitor },
]

export function WorkspaceDock({
  threadId,
  activeTab,
  onTabChange,
  onClose,
  initialFilePath,
  initialPreviewUrl,
}: WorkspaceDockProps): React.JSX.Element {
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceDockTab>>(() => new Set([activeTab]))

  useEffect(() => setVisitedTabs(new Set([activeTab])), [threadId])
  useEffect(() => {
    setVisitedTabs((current) => {
      if (current.has(activeTab)) return current
      const next = new Set(current)
      next.add(activeTab)
      return next
    })
  }, [activeTab])

  return (
    <section className="workspace-dock" data-active-tab={activeTab} aria-label="Thread workspace">
      <header className="workspace-dock-header">
        <nav className="workspace-dock-tabs" role="tablist" aria-label="Workspace tools">
          {TABS.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.value}
                className={activeTab === tab.value ? 'is-active' : ''}
                onClick={() => onTabChange(tab.value)}
              >
                <Icon size={12} aria-hidden="true" />
                {tab.label}
              </button>
            )
          })}
        </nav>
        <button
          type="button"
          className="workspace-icon-button workspace-dock-close"
          onClick={onClose}
          title="Close workspace"
          aria-label="Close workspace"
        >
          <X size={13} />
        </button>
      </header>
      <div className="workspace-dock-content">
        {visitedTabs.has('files') && (
          <div className="workspace-dock-panel" role="tabpanel" hidden={activeTab !== 'files'}>
            <FileViewer key={threadId} threadId={threadId} initialPath={initialFilePath} />
          </div>
        )}
        {visitedTabs.has('preview') && (
          <div className="workspace-dock-panel" role="tabpanel" hidden={activeTab !== 'preview'}>
            <AppPreview
              key={threadId}
              threadId={threadId}
              initialUrl={initialPreviewUrl}
              active={activeTab === 'preview'}
            />
          </div>
        )}
      </div>
    </section>
  )
}
