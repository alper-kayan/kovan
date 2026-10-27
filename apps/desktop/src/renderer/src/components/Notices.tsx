import { CircleAlert, Info, X } from 'lucide-react';
import { dismissNotice, useStore } from '../store';

/** Corner cards for errors, confirmations and calls to action. */
export function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`}>
          <span className="notice-icon">
            {n.kind === 'error' ? <CircleAlert size={15} /> : <Info size={15} />}
          </span>
          <div>
            {n.title && <div className="notice-title">{n.title}</div>}
            <div className="notice-message">{n.message}</div>
            {n.action && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  n.action?.run();
                  dismissNotice(n.id);
                }}
              >
                {n.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn" title="Dismiss" onClick={() => dismissNotice(n.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
