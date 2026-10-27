import type { GraphCommit } from '@kovan/git-engine';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { reportError, useStore } from '../store';

const ROW = 26;
const COL = 12;
const COLORS = [
  'var(--u-blue)',
  'var(--u-pink)',
  'var(--u-teal)',
  'var(--u-orange)',
  'var(--u-purple)',
];

interface Row {
  commit: GraphCommit;
  col: number;
  /** Lanes passing through this row (column → color index), before and after the commit. */
  through: { from: number; to: number }[];
  /** Lines from this commit's dot down to its parents' columns. */
  down: number[];
  width: number;
}

/** Lays history out in columns: one per line of work, merges joining them. */
function layout(commits: GraphCommit[]): Row[] {
  const lanes: (string | null)[] = [];
  const rows: Row[] = [];
  for (const commit of commits) {
    let col = lanes.indexOf(commit.sha);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.push(null) - 1;
    }
    const before = lanes.slice();
    // Other lanes waiting for this commit end here (they merge into its column).
    for (let i = 0; i < lanes.length; i++)
      if (i !== col && lanes[i] === commit.sha) lanes[i] = null;
    lanes[col] = commit.parents[0] ?? null;
    const down = commit.parents[0] ? [col] : [];
    for (const parent of commit.parents.slice(1)) {
      let at = lanes.indexOf(parent);
      if (at === -1) {
        at = lanes.indexOf(null);
        if (at === -1) at = lanes.push(null) - 1;
        lanes[at] = parent;
      }
      down.push(at);
    }
    const through: Row['through'] = [];
    before.forEach((sha, i) => {
      if (sha && i !== col) {
        const to = sha === commit.sha ? col : i;
        through.push({ from: i, to });
      }
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    rows.push({
      commit,
      col,
      through,
      down,
      width: Math.max(before.length, lanes.length, col + 1),
    });
  }
  return rows;
}

const x = (col: number) => 8 + col * COL;

/** The repository's history as a graph: branches, merges, and where each ref points. */
export function CommitGraph() {
  const head = useStore((s) => s.gitStatus?.head);
  const [commits, setCommits] = useState<GraphCommit[] | null>(null);
  useEffect(() => {
    api.invoke('git:graph', 150).then(setCommits, reportError);
  }, [head]);
  const rows = useMemo(() => (commits ? layout(commits) : []), [commits]);
  if (!commits) return <p className="empty-note">Loading history…</p>;
  if (!commits.length) return <p className="empty-note">No commits yet.</p>;
  const width = 8 + Math.max(...rows.map((r) => r.width)) * COL;

  return (
    <div className="graph">
      {rows.map((r) => (
        <div
          key={r.commit.sha}
          className="graph-row"
          title={`${r.commit.sha.slice(0, 7)} · ${r.commit.author}`}
        >
          <svg width={width} height={ROW} className="graph-lines">
            {r.through.map((t, i) => (
              <path
                key={i}
                d={`M${x(t.from)} 0 C${x(t.from)} ${ROW / 2} ${x(t.to)} ${ROW / 2} ${x(t.to)} ${ROW}`}
                stroke={COLORS[t.to % COLORS.length]}
                fill="none"
                strokeWidth={1.5}
              />
            ))}
            {rows.indexOf(r) > 0 && (
              <line
                x1={x(r.col)}
                y1={0}
                x2={x(r.col)}
                y2={ROW / 2}
                stroke={COLORS[r.col % COLORS.length]}
                strokeWidth={1.5}
              />
            )}
            {r.down.map((to, i) => (
              <path
                key={`d${i}`}
                d={`M${x(r.col)} ${ROW / 2} C${x(r.col)} ${ROW} ${x(to)} ${ROW / 2} ${x(to)} ${ROW}`}
                stroke={COLORS[to % COLORS.length]}
                fill="none"
                strokeWidth={1.5}
              />
            ))}
            <circle
              cx={x(r.col)}
              cy={ROW / 2}
              r={r.commit.sha === head ? 4.5 : 3.5}
              fill={r.commit.sha === head ? 'var(--fg)' : COLORS[r.col % COLORS.length]}
              stroke="var(--bg2)"
              strokeWidth={1.5}
            />
          </svg>
          <span className="graph-subject">{r.commit.subject}</span>
          {r.commit.refs.map((ref) => (
            <span
              key={ref}
              className={`graph-ref ${ref.includes('/') && ref.startsWith('origin/') ? 'remote' : ''}`}
            >
              {ref}
            </span>
          ))}
          <span className="graph-meta">{r.commit.author.split(' ')[0]}</span>
        </div>
      ))}
    </div>
  );
}
