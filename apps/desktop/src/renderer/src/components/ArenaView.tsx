import {
  arenaSummary,
  type ArenaConfig,
  type ArenaProgress,
  type ArenaRun,
  type CostKind,
} from '@kovan/shared';
import { Plus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { JEV_MODEL_ID } from '../../../shared/agent';
import { api } from '../services/api';
import { loadModels } from '../services/agent';
import { reportError, useStore } from '../store';

const EFFORTS = ['', 'low', 'medium', 'high'] as const;

const money = (n: number, kind: CostKind) =>
  `${kind === 'estimated' ? '≈ ' : ''}$${n.toFixed(4)}${kind === 'unknown' ? ' + ?' : ''}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const configName = (c: ArenaConfig) =>
  `${c.model === JEV_MODEL_ID ? 'JevRouter' : c.model}${c.effort ? ` (${c.effort})` : ''}`;

/**
 * Agent Arena: the same task for several configurations of Kovan's agent, each in a throwaway
 * copy of this repository at its current commit; then what each one did, measured.
 */
export function ArenaView() {
  const root = useStore((s) => s.workspace?.root);
  const models = useStore((s) => s.models);
  const [task, setTask] = useState('');
  const [configs, setConfigs] = useState<{ model: string; effort: string }[]>([
    { model: JEV_MODEL_ID, effort: '' },
    { model: '', effort: '' },
  ]);
  const [repeats, setRepeats] = useState(1);
  const [attempts, setAttempts] = useState(2);
  const [budget, setBudget] = useState('0.50');
  const [runs, setRuns] = useState<ArenaRun[]>([]);
  const [live, setLive] = useState<ArenaProgress | null>(null);
  const [running, setRunning] = useState(false);

  const reload = () =>
    void (api.invoke('arena:runs') as Promise<ArenaRun[]>).then(setRuns).catch(reportError);
  useEffect(() => {
    if (models.length === 0) void loadModels();
    reload();
    void (api.invoke('arena:running') as Promise<boolean>).then(setRunning);
    return api.on('arena:progress', (p) => {
      setLive(p);
      if (p.phase === 'done') {
        reload();
        if (p.run === p.total) setRunning(false);
      }
    });
  }, []);

  const known = (m: string) => m === JEV_MODEL_ID || models.some((x) => x.id === m);
  const chosen = configs.filter((c) => c.model.trim());
  const valid =
    Boolean(root) &&
    task.trim().length > 0 &&
    chosen.length > 0 &&
    chosen.every((c) => known(c.model.trim())) &&
    Number(budget) >= 0.01;

  const start = async () => {
    try {
      await api.invoke('arena:start', {
        task: task.trim(),
        configs: chosen.map((c) => ({
          model: c.model.trim(),
          effort: (c.effort || null) as ArenaConfig['effort'],
        })),
        repeats,
        maxAttempts: attempts,
        budgetPerRun: Number(budget),
      });
      setRunning(true);
      setLive(null);
    } catch (error) {
      reportError(error);
    }
  };

  // Newest arena first; each one's runs together.
  const arenas = useMemo(() => {
    const byId = new Map<string, ArenaRun[]>();
    for (const r of runs) byId.set(r.arenaId, [...(byId.get(r.arenaId) ?? []), r]);
    return [...byId.values()].reverse();
  }, [runs]);
  // Across arenas, by kind of work: which configuration passes how often.
  const byKind = useMemo(() => {
    const groups = new Map<string, Map<string, { runs: number; passed: number }>>();
    for (const r of runs) {
      const kind = `${r.taskType}, difficulty ${r.difficulty}/5`;
      const row = groups.get(kind) ?? new Map();
      const name = configName(r.config);
      const cell = row.get(name) ?? { runs: 0, passed: 0 };
      cell.runs += 1;
      if (r.status === 'passed') cell.passed += 1;
      row.set(name, cell);
      groups.set(kind, row);
    }
    return [...groups];
  }, [runs]);

  return (
    <div className="arena">
      <p className="setting-desc">
        Runs the same task for each configuration of Kovan's agent, one after another, each in its
        own throwaway copy of {root ? <b>{root.split('/').pop()}</b> : 'the open repository'} at its
        current commit (your checkout and uncommitted changes are left out). Each run is checked
        with the project's own checks and measured. Model calls are paid the way your agent's are
        (your model key, or Kovan billing), up to the budget per run.
      </p>
      <textarea
        className="input"
        rows={3}
        placeholder="The task, e.g. Add median() to src/stats.js with a test"
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <datalist id="arena-models">
        <option value={JEV_MODEL_ID}>JevRouter</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>
      <div className="arena-configs">
        {configs.map((c, i) => (
          <div key={i} className="arena-config">
            <input
              className={`input mono ${c.model && !known(c.model.trim()) ? 'invalid' : ''}`}
              list="arena-models"
              placeholder="Model id"
              value={c.model}
              onChange={(e) =>
                setConfigs(configs.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))
              }
            />
            <select
              className="select"
              value={c.effort}
              onChange={(e) =>
                setConfigs(configs.map((x, j) => (j === i ? { ...x, effort: e.target.value } : x)))
              }
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e || 'default effort'}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              title="Remove"
              disabled={configs.length === 1}
              onClick={() => setConfigs(configs.filter((_, j) => j !== i))}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {configs.length < 4 && (
          <button
            className="btn btn-sm"
            onClick={() => setConfigs([...configs, { model: '', effort: '' }])}
          >
            <Plus size={12} /> Configuration
          </button>
        )}
      </div>
      <div className="swarm-row">
        <label className="swarm-field">
          Runs each
          <select
            className="select"
            value={repeats}
            onChange={(e) => setRepeats(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label
          className="swarm-field"
          title="Tries per run: the first, then reworks after failed checks"
        >
          Tries
          <select
            className="select"
            value={attempts}
            onChange={(e) => setAttempts(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="swarm-field">
          Budget per run
          <input
            className="input mono"
            type="number"
            min={0.01}
            step="any"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <span className="spacer" />
        {running ? (
          <button className="btn btn-sm" onClick={() => void api.invoke('arena:stop')}>
            <Square size={11} /> Stop
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" disabled={!valid} onClick={() => void start()}>
            Run arena
          </button>
        )}
      </div>
      {running && live && (
        <div className="muted small">
          Run {live.run} of {live.total}: {configName(live.config)} #{live.repeat} · {live.phase}
        </div>
      )}

      {arenas.map((list) => {
        const first = list[0]!;
        const { rows, verdict } = arenaSummary(list);
        return (
          <div key={first.arenaId} className="arena-result">
            <div className="arena-result-head">
              <b>{first.task}</b>
            </div>
            <div className="muted small mono">
              {first.repo} @ {first.commit.slice(0, 7)} · {new Date(first.at).toLocaleString()} ·{' '}
              {first.taskType}, difficulty {first.difficulty}/5 · checks:{' '}
              {first.checks.map((c) => c.name).join(', ') || 'none found'} · Kovan{' '}
              {first.kovanVersion}
            </div>
            <table className="arena-table">
              <thead>
                <tr>
                  <th>Configuration</th>
                  <th>Passed</th>
                  <th>Verified</th>
                  <th>Cost / run</th>
                  <th>Time / run</th>
                  <th>Tries</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={configName(r.config)}>
                    <td className="mono">{configName(r.config)}</td>
                    <td>
                      {r.passed}/{r.runs}
                    </td>
                    <td>{r.verified}</td>
                    <td className="mono">{money(r.avgCost, r.costKind)}</td>
                    <td className="mono">{secs(r.avgDurationMs)}</td>
                    <td>{r.avgAttempts.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="arena-runs small">
              {list.map((r) => (
                <li key={r.id} className={`arena-run-${r.status}`}>
                  {configName(r.config)} #{r.repeat}: {r.status.replace('_', ' ')}
                  {r.error ? ` · ${r.error}` : ''}
                  {r.checks.length
                    ? ` · ${r.checks.map((c) => `${c.name} ${c.status}`).join(', ')}`
                    : ''}
                </li>
              ))}
            </ul>
            <div className="arena-verdict">{verdict}</div>
          </div>
        );
      })}
      {arenas.length > 0 && (
        <div className="arena-result">
          <div className="arena-result-head">
            <b>By kind of work</b>
          </div>
          {byKind.map(([kind, row]) => (
            <div key={kind} className="small">
              <span className="muted">{kind}:</span>{' '}
              {[...row].map(([name, c]) => `${name} ${c.passed}/${c.runs}`).join(' · ')}
            </div>
          ))}
          <div className="muted small">
            Costs marked ≈ were worked out from catalog prices, "+ ?" means some calls had no known
            price. Results hold for these tasks in this repository; they are not a general ranking.
          </div>
        </div>
      )}
    </div>
  );
}
