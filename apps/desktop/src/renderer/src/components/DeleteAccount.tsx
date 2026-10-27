import type { AccountDeletionPlan } from '@kovan/shared';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { deleteAccount, loadDeletionPlan } from '../services/team';

const WORD = 'delete';

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * Deleting the account: what goes and what stays is shown first (the server works it out), and
 * it takes typing a word to go ahead. It can't be undone.
 */
export function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [plan, setPlan] = useState<AccountDeletionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadDeletionPlan()
      .then(setPlan)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const submit = async () => {
    if (typed.trim().toLowerCase() !== WORD || !plan || plan.blocker) return;
    setBusy(true);
    try {
      await deleteAccount();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const handedOver = [
    ...(plan?.kept.flatMap((w) =>
      w.owner ? [`${w.name}: ${w.owner.name} becomes its owner`] : [w.name],
    ) ?? []),
    ...(plan?.orgsKept.flatMap((o) =>
      o.owner ? [`Organization ${o.name}: ${o.owner.name} becomes its owner`] : [],
    ) ?? []),
  ];
  return (
    <div className="overlay modal-overlay" onMouseDown={onClose}>
      <form
        className="modal dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <h2 className="modal-title">Delete your account</h2>
          <p className="modal-desc">For good, on every device. It can&apos;t be undone.</p>
          <button type="button" className="icon-btn modal-close" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          {!plan && !error && <p className="setting-desc">Working out what it would delete…</p>}
          {error && <p className="setting-desc danger-text">{error}</p>}
          {plan && (
            <>
              <div>
                <div className="setting-title">Deleted</div>
                <ul className="setting-desc delete-list">
                  <li>Your account, its sign-ins, and the phones that get your notifications.</li>
                  {plan.deleted.length > 0 && (
                    <li>
                      Workspaces only you are in, with their sessions, transcripts and AI teammates:{' '}
                      <strong>{plan.deleted.map((w) => w.name).join(', ')}</strong>.
                    </li>
                  )}
                  <li>What you wrote in shared workspaces: your comments and your agent lanes.</li>
                  <li>Your saved card and billing details.</li>
                </ul>
              </div>
              {handedOver.length > 0 && (
                <div>
                  <div className="setting-title">Stays for the others</div>
                  <ul className="setting-desc delete-list">
                    {handedOver.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="setting-desc">
                Repositories on GitHub and code on this computer aren&apos;t touched.
                {plan.unbilled > 0
                  ? ` Managed usage not charged yet (${usd(plan.unbilled)}) won't be charged.`
                  : ''}
              </p>
              {plan.blocker ? (
                <p className="setting-desc danger-text">{plan.blocker}</p>
              ) : (
                <label className="field-label">
                  Type {WORD} to confirm
                  <input
                    className="input"
                    autoFocus
                    value={typed}
                    placeholder={WORD}
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-danger-ghost"
            disabled={busy || !plan || !!plan.blocker || typed.trim().toLowerCase() !== WORD}
          >
            {busy ? 'Deleting…' : 'Delete my account'}
          </button>
        </div>
      </form>
    </div>
  );
}
