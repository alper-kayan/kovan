import { closeTab } from '../services/editor';
import { setState, useStore } from '../store';
import { X } from 'lucide-react';

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const agents = useStore((s) => s.liveAgents);
  const activeTabId = useStore((s) => s.activeTabId);
  if (tabs.length === 0) return null;

  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => {
        const dirty = tab.kind === 'file' && tab.dirty;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${tab.kind === 'diff' ? 'tab-diff' : ''}`}
            onClick={() => setState({ activeTabId: tab.id })}
            onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            title={tab.path}
          >
            <span className="tab-title">{tab.title}</span>
            {Object.values(agents)
              .filter((a) => a.path === tab.path)
              .map((a) => (
                <span
                  key={a.key}
                  className={`tab-agent ${a.phase}`}
                  style={{ background: a.color }}
                  title={`${a.label}: ${a.phase === 'reading' ? 'reading' : a.phase === 'typing' ? 'writing' : 'just wrote'} this file`}
                >
                  {initials(a.name)}
                </span>
              ))}
            <button
              className={`tab-close ${dirty ? 'dirty' : ''}`}
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              {dirty ? <span className="dirty-dot">●</span> : <X size={13} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
