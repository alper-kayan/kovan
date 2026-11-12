import { PanelLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { runCommand } from '../commands';
import { useStore } from '../store';

/** Page title row; shows the sidebar toggle while the sidebar is hidden. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  const collapsed = useStore((s) => s.navCollapsed);
  return (
    <div className="page-header">
      {collapsed && (
        <button
          className="icon-btn"
          title="Show sidebar"
          onClick={() => runCommand('view.toggleSidebar')}
        >
          <PanelLeft size={15} />
        </button>
      )}
      <h1 className="page-title" tabIndex={-1}>
        {title}
      </h1>
      <div className="page-actions">{children}</div>
    </div>
  );
}
