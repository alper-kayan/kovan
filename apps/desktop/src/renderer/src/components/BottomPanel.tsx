import { closeTerminal, newTerminal } from '../services/terminal';
import { pressable } from './ui';
import { setState, useStore } from '../store';
import { ChevronDown, Plus, SquareTerminal, X } from 'lucide-react';
import { TerminalView } from './TerminalView';

export function BottomPanel() {
  const open = useStore((s) => s.terminalOpen);
  const terminals = useStore((s) => s.terminals);
  const active = useStore((s) => s.activeTerminal);

  // Terminals stay mounted while the panel is hidden so scrollback and running programs survive.
  return (
    <section
      className="bottom-panel"
      style={{ display: open && terminals.length > 0 ? 'flex' : 'none' }}
    >
      <div className="panel-tabs">
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`panel-tab ${t.id === active ? 'active' : ''} ${t.exited ? 'exited' : ''}`}
            onClick={() => setState({ activeTerminal: t.id })}
            {...pressable(() => setState({ activeTerminal: t.id }))}
            role="tab"
            aria-selected={t.id === active}
          >
            <SquareTerminal size={13} />
            <span>{t.title}</span>
            {t.exited && <span className="muted small">(exited)</span>}
            <button
              className="icon-btn"
              title="Kill terminal"
              onClick={(e) => {
                e.stopPropagation();
                void closeTerminal(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="icon-btn" title="New terminal" onClick={() => void newTerminal()}>
          <Plus size={14} />
        </button>
        <div className="panel-spacer" />
        <button
          className="icon-btn"
          title="Hide panel"
          onClick={() => setState({ terminalOpen: false })}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="panel-body">
        {terminals.map((t) => (
          <TerminalView key={t.id} id={t.id} visible={open && t.id === active} />
        ))}
      </div>
    </section>
  );
}
