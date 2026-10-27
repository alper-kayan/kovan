import type { ModelInfo } from '@kovan/model-gateway';
import { Check, Copy, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fuzzyFilter } from '../fuzzy';
import { BenchmarkChart } from './BenchmarkChart';
import { api } from '../services/api';
import { loadModels } from '../services/agent';
import { useStore } from '../store';

type Sort = 'newest' | 'input' | 'output' | 'context' | 'name';

const SORTS: { id: Sort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'input', label: 'Cheapest input' },
  { id: 'output', label: 'Cheapest output' },
  { id: 'context', label: 'Longest context' },
  { id: 'name', label: 'Name (A to Z)' },
];

const PAGE = 50;
const money = (n: number | null) =>
  n === null ? '—' : n === 0 ? 'free' : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
const ctx = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}K`;

export function sortModels(models: ModelInfo[], sort: Sort): ModelInfo[] {
  const list = [...models];
  switch (sort) {
    case 'newest':
      return list.sort((a, b) => b.created - a.created);
    case 'input':
      return list.sort((a, b) => a.pricing.input - b.pricing.input);
    case 'output':
      return list.sort((a, b) => a.pricing.output - b.pricing.output);
    case 'context':
      return list.sort((a, b) => b.contextLength - a.contextLength);
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      title="Copy model ID"
      onClick={() => {
        void navigator.clipboard.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/** The model catalog as a browsable price list, like the website's /models page. */
export function ModelsPage() {
  const models = useStore((s) => s.models);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [vision, setVision] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void api.invoke('models:checkedAt').then(setCheckedAt);
  }, [models]);

  const providers = useMemo(() => [...new Set(models.map((m) => m.provider))].sort(), [models]);
  const shown = useMemo(() => {
    let list = models.filter(
      (m) =>
        (provider === 'all' || m.provider === provider) &&
        (!vision || m.vision) &&
        (!reasoning || m.reasoning),
    );
    list = query.trim()
      ? fuzzyFilter(query, list, (m) => `${m.name} ${m.id}`, 500)
      : sortModels(list, sort);
    return list;
  }, [models, query, provider, sort, vision, reasoning]);

  useEffect(() => setLimit(PAGE), [query, provider, sort, vision, reasoning]);

  return (
    <div className="settings-group models-page">
      <div className="models-stats">
        <div>
          <div className="stat mono">{models.length}</div>
          <div className="setting-desc">models with tool use</div>
        </div>
        <div>
          <div className="stat mono">{providers.length}</div>
          <div className="setting-desc">providers</div>
        </div>
        <div className="models-checked">
          <span className="setting-desc">
            {checkedAt
              ? `Prices checked ${new Date(checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
              : 'Prices not loaded yet'}
          </span>
          <button
            className="btn btn-sm"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              void loadModels(true).finally(() => setRefreshing(false));
            }}
          >
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>
      <h2>JevRouter</h2>
      <BenchmarkChart />
      <h2 style={{ marginTop: 24 }}>Catalog</h2>
      <div className="models-filters">
        <label className="filter models-search">
          <Search size={13} />
          <input
            placeholder="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={sort}
          disabled={Boolean(query.trim())}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button className={`pill ${vision ? 'pill-on' : ''}`} onClick={() => setVision(!vision)}>
          vision
        </button>
        <button
          className={`pill ${reasoning ? 'pill-on' : ''}`}
          onClick={() => setReasoning(!reasoning)}
        >
          reasoning
        </button>
      </div>
      <table className="models-table">
        <thead className="mono">
          <tr>
            <th>Model</th>
            <th>Context</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache read</th>
            <th>Cache write</th>
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, limit).map((m) => (
            <tr key={m.id}>
              <td>
                <div className="models-name">{m.name}</div>
                <div className="models-id mono">
                  {m.id}
                  <CopyId id={m.id} />
                  {m.reasoning && <span className="tag">reasoning</span>}
                  {m.vision && <span className="tag">vision</span>}
                </div>
              </td>
              <td className="mono">{ctx(m.contextLength)}</td>
              <td className="mono">{money(m.pricing.input)}</td>
              <td className="mono">{money(m.pricing.output)}</td>
              <td className="mono">{money(m.pricing.cacheRead)}</td>
              <td className="mono">{money(m.pricing.cacheWrite)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="models-foot setting-desc">
        Showing {Math.min(limit, shown.length)} of {shown.length} · USD per 1M tokens, as listed by
        OpenRouter. Long prompts can cost more on some models (for example GPT-5.6 above 272K input
        tokens: 2× input, 1.5× output).
        {shown.length > limit && (
          <button className="link-btn" onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        )}
      </div>
    </div>
  );
}
