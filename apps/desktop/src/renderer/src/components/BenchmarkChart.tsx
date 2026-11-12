import benchmark from '../../../shared/jevrouter-benchmark.json';

interface Point {
  config: string;
  name: string;
  score: number;
  costPerTask: number;
  solved: number;
  total: number;
}

const W = 520;
const H = 260;
const PAD = { left: 44, right: 34, top: 16, bottom: 36 };

/** "Score vs cost per task" from the latest JevRouter eval run. */
export function BenchmarkChart() {
  const points = (benchmark.points ?? []) as Point[];
  if (points.length === 0) {
    return (
      <p className="setting-desc">
        No eval results yet. Run `pnpm --filter @kovan/jevrouter eval` to measure models on the task
        set.
      </p>
    );
  }
  // Everyone solved everything: a chart of dots on one line says nothing, the costs do.
  const sameScore = points.every((p) => p.score === points[0]!.score);
  const maxCost = Math.max(...points.map((p) => p.costPerTask)) * 1.15 || 1;
  const minScore = Math.max(
    0,
    Math.floor((Math.min(...points.map((p) => p.score)) - 20) / 20) * 20,
  );
  const x = (cost: number) => PAD.left + (cost / maxCost) * (W - PAD.left - PAD.right);
  const y = (score: number) =>
    H - PAD.bottom - ((score - minScore) / (100 - minScore)) * (H - PAD.top - PAD.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxCost);
  const scoreTicks = Array.from({ length: 5 }, (_, i) => minScore + ((100 - minScore) / 4) * i);

  return (
    <div className="bench">
      {!sameScore && (
        <div className="bench-caption mono">
          Fig. 01 <span>›</span> Score vs cost per task
        </div>
      )}
      {!sameScore && (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="bench-svg"
          role="img"
          aria-label="Score versus cost per task"
        >
          {scoreTicks.map((s) => (
            <g key={s}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(s)} y2={y(s)} className="bench-grid" />
              <text x={PAD.left - 8} y={y(s) + 3} className="bench-axis" textAnchor="end">
                {Math.round(s)}
              </text>
            </g>
          ))}
          {ticks.map((c) => (
            <text
              key={c}
              x={x(c)}
              y={H - PAD.bottom + 16}
              className="bench-axis"
              textAnchor="middle"
            >
              ${c < 0.01 ? c.toFixed(4) : c.toFixed(3)}
            </text>
          ))}
          <text x={(W + PAD.left) / 2} y={H - 4} className="bench-axis" textAnchor="middle">
            Cost per task
          </text>
          {points.map((p) => {
            const jev = p.config === 'kovan/jevrouter';
            return (
              <g key={p.config} className={jev ? 'bench-jev' : 'bench-point'}>
                <circle cx={x(p.costPerTask)} cy={y(p.score)} r={jev ? 6 : 4.5} />
                <text
                  x={x(p.costPerTask) + (x(p.costPerTask) > W - 140 ? -10 : 10)}
                  y={y(p.score) - 8}
                  textAnchor={x(p.costPerTask) > W - 140 ? 'end' : 'start'}
                >
                  {p.name}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <table className="models-table bench-table">
        <thead className="mono">
          <tr>
            <th>Model</th>
            <th>Solved</th>
            <th>Score</th>
            <th>Cost / task</th>
          </tr>
        </thead>
        <tbody>
          {[...points]
            .sort((a, b) => b.score - a.score || a.costPerTask - b.costPerTask)
            .map((p) => (
              <tr key={p.config} className={p.config === 'kovan/jevrouter' ? 'bench-row-jev' : ''}>
                <td>{p.name}</td>
                <td className="mono">
                  {p.solved}/{p.total}
                </td>
                <td className="mono">{p.score}%</td>
                <td className="mono">${p.costPerTask.toFixed(5)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className="setting-desc">
        Kovan's own eval: {benchmark.taskCount} self-checking coding tasks (easy to hard), run{' '}
        {benchmark.date ? new Date(benchmark.date).toLocaleDateString() : ''}. Score: tasks solved.
        Cost: one full task, as billed by OpenRouter. Results vary by workload.
      </p>
      <p className="setting-desc">
        JevRouter gives each step to the cheapest model likely to get it right and moves to a
        stronger one when a step is hard.
        {sameScore
          ? ' On this small set every model solved every task, so a fixed cheap model cost least; JevRouter pays off on mixed work, where a cheap model alone gets stuck. If your tasks are simple, pick a cheap model in Agents.'
          : ''}
      </p>
    </div>
  );
}
