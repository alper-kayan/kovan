/**
 * Stops a model that has stopped making progress, so a broken run doesn't keep spending: one
 * reply that never ends or repeats the same few words, tool calls that keep failing to parse,
 * or the same call giving the same result again and again.
 */

/** One model reply (text, reasoning and tool arguments together) longer than this is cut off. */
export const MAX_REPLY_CHARS = 200_000;
/** Steps in a row whose every tool call was unknown or had broken arguments. */
export const MAX_INVALID_STEPS = 3;
/** The same call with the same result, this many times in a row. */
export const MAX_SAME_CALLS = 5;
/** …while the files didn't change either: a warning at the second, a pause at the third. */
export const WARN_UNCHANGED = 2;
export const MAX_UNCHANGED = 3;

/** What the model is told when it repeats itself while nothing changes. */
export const NO_PROGRESS_NOTE =
  'You just made the same call again with the same result, and nothing in the files changed in between. Doing it again will not help: try a different approach, or stop and say what blocks you.';

const TAIL = 3_000;
const MAX_PERIOD = 300;

/** True when the end of `text` is one short piece repeated over and over. */
export function isRepeating(text: string): boolean {
  if (text.length < TAIL) return false;
  const tail = text.slice(-TAIL);
  for (let period = 1; period <= MAX_PERIOD; period++) {
    if (tail.slice(period) === tail.slice(0, TAIL - period)) return true;
  }
  return false;
}

export const RUNAWAY_MESSAGES = {
  repeating: 'The model kept repeating itself, so Kovan stopped this reply. Try another model.',
  tooLong: 'The model’s reply ran far too long, so Kovan stopped it. Try another model.',
  invalid:
    'The model kept calling tools that don’t exist or with broken arguments, so Kovan stopped the turn. Try another model.',
  same: 'The model kept making the same call with the same result, so Kovan stopped the turn.',
  stuck:
    'The agent made the same call three times with the same result while nothing in the files changed, so Kovan paused the turn. Tell it how to go on.',
} as const;

export type RunawayReason = keyof typeof RUNAWAY_MESSAGES;

/** Watches one model reply as it streams. */
export class ReplyWatch {
  private text = '';
  private reasoning = '';
  private total = 0;
  private checkedText = 0;
  /** Characters the reply streamed so far: text, reasoning and tool arguments. */
  get size(): number {
    return this.total;
  }

  private checkedReasoning = 0;

  /** Returns why the reply should be stopped, or null while it looks fine. */
  add(kind: 'text' | 'reasoning' | 'arguments', chunk: string): RunawayReason | null {
    this.total += chunk.length;
    if (this.total > MAX_REPLY_CHARS) return 'tooLong';
    if (kind === 'arguments') return null;
    if (kind === 'text') {
      this.text = (this.text + chunk).slice(-TAIL * 2);
      this.checkedText += chunk.length;
      if (this.checkedText < 1_000) return null;
      this.checkedText = 0;
      return isRepeating(this.text) ? 'repeating' : null;
    }
    this.reasoning = (this.reasoning + chunk).slice(-TAIL * 2);
    this.checkedReasoning += chunk.length;
    if (this.checkedReasoning < 1_000) return null;
    this.checkedReasoning = 0;
    return isRepeating(this.reasoning) ? 'repeating' : null;
  }
}

/** Watches the steps of one turn. */
export class StepWatch {
  private invalidSteps = 0;
  private lastCall: string | null = null;
  private sameCalls = 0;
  private lastTree: string | null = null;
  private unchanged = 0;

  /**
   * Records one step's calls: `invalid` when the call couldn't run at all (unknown tool, broken
   * JSON). `tree` is the state of the files after the step when it is known (null otherwise):
   * the same call with the same result while it stays the same is no progress. Returns why the
   * turn should stop, and whether to warn the model first.
   */
  step(
    calls: { name: string; args: string; output: string; invalid: boolean }[],
    tree: string | null = null,
  ): { stop: RunawayReason | null; warn: boolean } {
    if (calls.length === 0) return { stop: null, warn: false };
    this.invalidSteps = calls.every((c) => c.invalid) ? this.invalidSteps + 1 : 0;
    if (this.invalidSteps >= MAX_INVALID_STEPS) return { stop: 'invalid', warn: false };
    const key = calls.length === 1 ? JSON.stringify(calls[0]) : null;
    const repeat = key !== null && key === this.lastCall;
    this.sameCalls = repeat ? this.sameCalls + 1 : 1;
    this.unchanged = repeat && tree !== null && tree === this.lastTree ? this.unchanged + 1 : 1;
    this.lastCall = key;
    this.lastTree = tree;
    if (this.unchanged >= MAX_UNCHANGED) return { stop: 'stuck', warn: false };
    if (key !== null && this.sameCalls >= MAX_SAME_CALLS) return { stop: 'same', warn: false };
    return { stop: null, warn: this.unchanged === WARN_UNCHANGED };
  }
}
