import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAccelerator } from '../../../shared/keybindings';
import { availableCommands, currentKeybindings, runCommand } from '../commands';
import { fuzzyFilter } from '../fuzzy';
import { api } from '../services/api';
import { openFile } from '../services/editor';
import { reveal } from '../services/explorer';
import { reportError, setState, useStore } from '../store';

interface Item {
  key: string;
  label: string;
  detail?: string;
  run: () => void;
}

export function CommandPalette() {
  const mode = useStore((s) => s.palette);
  const isMac = useStore((s) => s.isMac);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setQuery('');
    setSelected(0);
    if (mode === 'files') {
      setFiles(null);
      api.invoke('fs:listFiles').then(setFiles, (error) => {
        reportError(error);
        setFiles([]);
      });
    }
  }, [mode]);

  const items: Item[] = useMemo(() => {
    const close = () => setState({ palette: null });
    if (mode === 'commands') {
      const keys = currentKeybindings();
      return fuzzyFilter(query, availableCommands(), (c) => c.title).map((c) => ({
        key: c.id,
        label: c.title,
        ...(keys[c.id] ? { detail: formatAccelerator(keys[c.id]!, isMac) } : {}),
        run: () => {
          close();
          runCommand(c.id);
        },
      }));
    }
    if (mode === 'files') {
      return fuzzyFilter(query, files ?? [], (f) => f, 100).map((f) => {
        const at = f.lastIndexOf('/');
        return {
          key: f,
          label: f.slice(at + 1),
          detail: at === -1 ? '' : f.slice(0, at),
          run: () => {
            close();
            void openFile(f);
            void reveal(f);
          },
        };
      });
    }
    return [];
  }, [mode, query, files, isMac]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!mode) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[selected]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setState({ palette: null });
    }
  };

  return (
    <div className="overlay" onMouseDown={() => setState({ palette: null })}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder={mode === 'commands' ? 'Type a command…' : 'Search files by name…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list" ref={list}>
          {mode === 'files' && files === null && <li className="palette-empty">Loading files…</li>}
          {items.length === 0 && (mode === 'commands' || files !== null) && (
            <li className="palette-empty">No matches</li>
          )}
          {items.map((item, i) => (
            <li
              key={item.key}
              className={`palette-item ${i === selected ? 'selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={item.run}
            >
              <span className="palette-label">{item.label}</span>
              {item.detail &&
                (mode === 'commands' ? (
                  <kbd>{item.detail}</kbd>
                ) : (
                  <span className="palette-detail">{item.detail}</span>
                ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
