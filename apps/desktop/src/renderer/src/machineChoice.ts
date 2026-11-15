import { normalizeRepoUrl, type Machine } from '@kovan/shared';

/** Where a swarm can run: on this computer, or on a registered machine (agentd). */
export interface MachineOption {
  /** "here", "auto" or the machine's id. */
  value: string;
  label: string;
  /** Why it can't take the work now; null when it can. */
  unavailable: string | null;
}

const holds = (m: Machine, repoUrl: string | null) =>
  repoUrl !== null && m.repos.some((r) => (normalizeRepoUrl(r.remote) ?? r.remote) === repoUrl);

/** Why one machine can't take this workspace's work now, or null. */
function blocker(m: Machine, repoUrl: string | null): string | null {
  if (!m.online) return 'offline';
  if (!holds(m, repoUrl)) return "doesn't hold this repository";
  if (m.running >= m.slots) return 'busy';
  return null;
}

/**
 * The places a swarm of this workspace can run, for the setup's "Run on" choice: this
 * computer, "auto" (Kovan picks the least busy machine holding the repository) and each
 * machine, with why it can't take the work when it can't.
 */
export function machineOptions(machines: Machine[], repoUrl: string | null): MachineOption[] {
  const url = repoUrl ? (normalizeRepoUrl(repoUrl) ?? repoUrl) : null;
  const each = machines
    .map((m) => {
      const why = blocker(m, url);
      return {
        value: m.id,
        label: `${m.name}${why ? '' : ` · ${m.slots - m.running} of ${m.slots} free`}`,
        unavailable: why,
      };
    })
    .sort((a, b) => Number(a.unavailable !== null) - Number(b.unavailable !== null));
  const free = each.some((o) => o.unavailable === null);
  return [
    { value: 'here', label: 'This computer', unavailable: null },
    ...(machines.length
      ? [
          {
            value: 'auto',
            label: 'Auto: least busy machine',
            unavailable: free ? null : 'no machine can take it now',
          },
        ]
      : []),
    ...each,
  ];
}

/** Who does the work on a machine, in words for the setup ("Runs on pi with …"). */
export function machineWorker(m: Machine | undefined): string {
  const worker = m?.agents.find((a) => a.works)?.name;
  if (!worker) return 'the agent set up there';
  return worker === 'claude'
    ? "Claude Code, on its owner's subscription"
    : "Kovan's agent, with that machine's OpenRouter key";
}

/** Whether a machine's work runs on a Claude Code or Codex subscription, and that agent is signed in. */
export function runsOnSubscription(m: Machine): boolean {
  const subscription = (name: string) => name === 'claude' || name === 'codex';
  const worker = m.agents.find((a) => a.works);
  // agentd says which agent does the work; when it doesn't, a signed-in Claude Code or Codex does.
  return worker
    ? subscription(worker.name) && worker.ready
    : m.agents.some((a) => subscription(a.name) && a.ready);
}

/** The free machine that holds the repository and runs on a subscription, the least busy first. */
export function subscriptionMachine(machines: Machine[], repoUrl: string | null): Machine | null {
  const url = repoUrl ? (normalizeRepoUrl(repoUrl) ?? repoUrl) : null;
  const free = machines
    .filter((m) => runsOnSubscription(m) && blocker(m, url) === null)
    .sort((a, b) => b.slots - b.running - (a.slots - a.running) || a.name.localeCompare(b.name));
  return free[0] ?? null;
}

/**
 * Where a swarm started from one sentence runs: the id of a free subscription machine of the
 * workspace (agentd on Claude Code or Codex: nothing is billed per use), or "here", this
 * computer's own agent, which is billed per use. A machine wins when the person's first choice is
 * a subscription or when this computer has no model of its own.
 */
export function placeForSwarm(
  thisComputerReady: boolean,
  machines: Machine[],
  repoUrl: string | null,
  preferSubscription = false,
): 'here' | (string & {}) {
  if (thisComputerReady && !preferSubscription) return 'here';
  return subscriptionMachine(machines, repoUrl)?.id ?? 'here';
}
