import type { ModelInfo } from '@kovan/model-gateway';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '../fuzzy';
import { JEV_MODEL_ID } from '../../../shared/agent';
import { loadModels, setModel, chooseJevRouter } from '../services/agent';
import { useStore } from '../store';
import { useFloating } from './ui';

/** Frontier picks shown first when nothing is typed. */
const FEATURED = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-sol',
  'openai/gpt-5.6-luna',
  'google/gemini-3.5-flash',
  'z-ai/glm-5.3-flash',
];

const price = (n: number) => (n === 0 ? 'free' : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const context = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0)}M`
    : `${Math.round(n / 1000)}K`;

export function ModelPicker({ current, onClose }: { current: string; onClose: () => void }) {
  const models = useStore((s) => s.models);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const floating = useFloating<HTMLDivElement>();

  useEffect(() => {
    if (models.length === 0) void loadModels();
  }, [models.length]);

  const shown: ModelInfo[] = useMemo(() => {
    if (query.trim()) return fuzzyFilter(query, models, (m) => `${m.name} ${m.id}`, 60);
    const featured = FEATURED.map((id) => models.find((m) => m.id === id)).filter(
      (m): m is ModelInfo => Boolean(m),
    );
    const rest = [...models]
      .sort((a, b) => b.created - a.created)
      .filter((m) => !FEATURED.includes(m.id));
    return [...featured, ...rest].slice(0, 80);
  }, [models, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (m: ModelInfo | undefined) => {
    if (!m) return;
    setModel(m);
    onClose();
  };

  return (
    <div className="model-picker" ref={floating} onMouseDown={(e) => e.stopPropagation()}>
      <div className="model-search">
        <input
          autoFocus
          className="input"
          placeholder={`Search ${models.length} models…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(shown[selected]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <button
          className="icon-btn"
          title="Refresh the catalog"
          onClick={() => {
            setRefreshing(true);
            void loadModels(true).finally(() => setRefreshing(false));
          }}
        >
          <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
        </button>
      </div>
      <div className="model-head mono">
        <span>Model</span>
        <span>Context</span>
        <span>In / Out per 1M</span>
      </div>
      <div className="model-list" ref={list}>
        {!query.trim() && (
          <button
            className={`model-row model-auto ${current === JEV_MODEL_ID ? 'current' : ''}`}
            onClick={() => {
              chooseJevRouter();
              onClose();
            }}
          >
            <span className="model-name">
              <span>JevRouter (Auto)</span>
              <span className="model-id mono">Picks a model per task · keeps the cache warm</span>
            </span>
            <span className="mono model-ctx">auto</span>
            <span className="mono model-price">varies</span>
          </button>
        )}
        {models.length === 0 && <div className="menu-empty">Loading models…</div>}
        {shown.map((m, i) => (
          <button
            key={m.id}
            className={`model-row ${i === selected ? 'selected' : ''} ${m.id === current ? 'current' : ''}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => choose(m)}
          >
            <span className="model-name">
              <span>{m.name}</span>
              <span className="model-id mono">
                {m.id}
                {m.reasoning && <span className="tag">reasoning</span>}
                {m.vision && <span className="tag">vision</span>}
              </span>
            </span>
            <span className="mono model-ctx">{context(m.contextLength)}</span>
            <span className="mono model-price">
              {price(m.pricing.input)} / {price(m.pricing.output)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
