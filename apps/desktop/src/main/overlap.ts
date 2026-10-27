import { OpenRouterClient } from '@kovan/model-gateway';
import type { Plan, Session } from '@kovan/shared';
import type { OverlapWarning } from '../shared/api.js';
import type { BrainClient } from './brain.js';

const STOP = new Set(
  'a an and are as at be by do for from have i in is it its me my of on or our please that the this to we with you your add fix make use can should into when then also'.split(
    ' ',
  ),
);

function words(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Word overlap between two task descriptions (0..1), when no model is at hand. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Paths a prompt mentions ("src/lobby/join.ts"), to check along with the open files. */
export function mentionedPaths(text: string): string[] {
  return [
    ...new Set(
      text.match(
        /[\w.-]+(?:\/[\w.-]+)+\.\w+|[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|md|json|css)\b/g,
      ) ?? [],
    ),
  ];
}

/**
 * Before a prompt runs: does it collide with work in a live session the person isn't part of?
 * Same file, lock or branch → overlapping. A related task → adjacent: judged by a small model
 * on the person's own key when there is one, by word overlap otherwise. Fails open.
 */
export async function checkOverlap(
  brain: BrainClient,
  input: { workspaceId: string; text: string; paths: string[]; branch: string | null },
  openRouterKey: string | null,
): Promise<OverlapWarning[]> {
  const me = brain.status().user?.id;
  const { sessions } = await brain.request<{ sessions: Session[] }>(
    'GET',
    `/api/workspaces/${input.workspaceId}/sessions`,
  );
  const others = sessions.filter(
    (s) => !s.participants.some((p) => p.userId === me && p.mode === 'join'),
  );
  if (others.length === 0) return [];
  const paths = new Set([...input.paths, ...mentionedPaths(input.text)]);
  const plans = new Map<string, Plan>();
  await Promise.all(
    others.map(async (s) => {
      const r = await brain
        .request<{ plan: Plan }>('GET', `/api/sessions/${s.id}/plan`)
        .catch(() => null);
      if (r) plans.set(s.id, r.plan);
    }),
  );
  const people = (s: Session) => s.participants.filter((p) => p.mode === 'join').map((p) => p.name);
  const warnings: OverlapWarning[] = [];
  for (const s of others) {
    const planned = new Set((plans.get(s.id)?.steps ?? []).flatMap((st) => st.files));
    const locked = s.locks.map((l) => l.path);
    const hit =
      [...paths].find((p) => locked.includes(p)) ??
      [...paths].find((p) => s.touchedFiles.includes(p) || planned.has(p));
    if (hit)
      warnings.push({
        sessionId: s.id,
        title: s.title,
        people: people(s),
        kind: 'overlapping',
        reason: locked.includes(hit)
          ? `${hit} is locked in this session`
          : `${hit} is ${s.touchedFiles.includes(hit) ? 'being changed' : 'planned'} in this session`,
      });
    else if (input.branch && s.branch === input.branch)
      warnings.push({
        sessionId: s.id,
        title: s.title,
        people: people(s),
        kind: 'overlapping',
        reason: `it works on your branch, ${s.branch}`,
      });
  }
  const rest = others.filter((s) => !warnings.some((w) => w.sessionId === s.id));
  if (rest.length === 0 || input.text.trim().length < 8) return warnings;
  const described = rest.map(
    (s) => `${s.title}. ${(plans.get(s.id)?.steps ?? []).map((st) => st.title).join('. ')}`,
  );
  let related: number[];
  if (openRouterKey) {
    try {
      const client = new OpenRouterClient({ apiKey: openRouterKey, appName: 'Kovan' });
      let text = '';
      for await (const e of client.stream(
        {
          model: 'openai/gpt-5.6-luna',
          effort: 'none',
          maxTokens: 60,
          messages: [
            {
              role: 'system',
              content:
                'You compare a new coding task with tasks teammates are already doing. Reply with only a JSON array of the numbers of the related tasks (same feature, same code area, or one depends on the other), e.g. [2] or [].',
            },
            {
              role: 'user',
              content: `New task: ${input.text.slice(0, 1500)}\n\nTeammates' tasks:\n${described.map((d, i) => `${i + 1}. ${d.slice(0, 400)}`).join('\n')}`,
            },
          ],
        },
        AbortSignal.timeout(6000),
      ))
        if (e.type === 'text') text += e.text;
      related = (JSON.parse(/\[[\d,\s]*\]/.exec(text)?.[0] ?? '[]') as number[]).map((n) => n - 1);
    } catch {
      related = described.flatMap((d, i) => (similarity(input.text, d) >= 0.34 ? [i] : []));
    }
  } else {
    related = described.flatMap((d, i) => (similarity(input.text, d) >= 0.34 ? [i] : []));
  }
  for (const i of related) {
    const s = rest[i];
    if (s)
      warnings.push({
        sessionId: s.id,
        title: s.title,
        people: people(s),
        kind: 'adjacent',
        reason: 'it looks like related work',
      });
  }
  return warnings;
}
