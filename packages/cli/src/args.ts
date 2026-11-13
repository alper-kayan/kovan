import type { PermissionMode } from '@kovan/harness';
import type { Effort } from '@kovan/model-gateway';
import { t } from './i18n.js';

export type Command =
  | 'chat'
  | 'sessions'
  | 'config'
  | 'setup'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'update'
  | 'help'
  | 'version';

export interface Args {
  command: Command;
  /** Words that are not flags: one message for a one-shot run. Empty opens the prompt. */
  task: string;
  /** For `sessions export <id>`. */
  sessionId: string | null;
  continueLast: boolean;
  /** `-r <name|id>`: continue that conversation, in whichever folder it was held. */
  resume: string | null;
  model: string | null;
  mode: PermissionMode | null;
  effort: Effort | null;
  /** A file of extra instructions appended to the system prompt (what a surrounding tool knows). */
  contextFile: string | null;
  cwd: string | null;
  /** `login --server <url>`: a Kovan server other than the default. */
  server: string | null;
  json: boolean;
  /** Show the model's reasoning instead of one quiet line. */
  reasoning: boolean;
  /** The old line-by-line prompt instead of the full-screen interface. */
  plain: boolean;
  error: string | null;
}

export const MODES: readonly PermissionMode[] = ['plan', 'request', 'allow', 'full'];
export const EFFORTS: readonly Effort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const COMMANDS = new Set([
  'sessions',
  'config',
  'setup',
  'login',
  'logout',
  'whoami',
  'update',
  'help',
  'version',
]);

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    command: 'chat',
    task: '',
    sessionId: null,
    continueLast: false,
    resume: null,
    model: null,
    mode: null,
    effort: null,
    contextFile: null,
    cwd: null,
    server: null,
    json: false,
    reasoning: false,
    plain: false,
    error: null,
  };
  const words: string[] = [];
  const value = (i: number, flag: string): string | null => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      a.error ??= t('{flag} needs a value', { flag });
      return null;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (i === 0 && COMMANDS.has(arg)) {
      a.command = arg as Command;
      continue;
    }
    switch (arg) {
      case '-h':
      case '--help':
        a.command = 'help';
        break;
      case '-v':
      case '--version':
        a.command = 'version';
        break;
      case '-c':
      case '--continue':
        a.continueLast = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--reasoning':
        a.reasoning = true;
        break;
      case '--plain':
        a.plain = true;
        break;
      case '-m':
      case '--model': {
        const v = value(i, arg);
        if (v) a.model = v;
        i++;
        break;
      }
      case '-r':
      case '--resume': {
        const v = value(i, arg);
        if (v) a.resume = v;
        i++;
        break;
      }
      case '--context-file': {
        const v = value(i, arg);
        if (v) a.contextFile = v;
        i++;
        break;
      }
      case '--cwd': {
        const v = value(i, arg);
        if (v) a.cwd = v;
        i++;
        break;
      }
      case '--server': {
        const v = value(i, arg);
        if (v) a.server = v;
        i++;
        break;
      }
      case '--mode': {
        const v = value(i, arg);
        if (v && (MODES as readonly string[]).includes(v)) a.mode = v as PermissionMode;
        else if (v)
          a.error ??= t("Unknown mode '{v}'. Choose one of: {list}.", {
            v,
            list: MODES.join(', '),
          });
        i++;
        break;
      }
      case '--effort': {
        const v = value(i, arg);
        if (v && (EFFORTS as readonly string[]).includes(v)) a.effort = v as Effort;
        else if (v)
          a.error ??= t("Unknown effort '{v}'. Choose one of: {list}.", {
            v,
            list: EFFORTS.join(', '),
          });
        i++;
        break;
      }
      default:
        if (arg.startsWith('-') && arg.length > 1)
          a.error ??= t("Unknown option '{arg}'. See 'kovan --help'.", { arg });
        else words.push(arg);
    }
  }
  if (a.command === 'sessions' && words[0] === 'export') {
    a.sessionId = words[1] ?? null;
    if (!a.sessionId)
      a.error ??= t("'kovan sessions export' needs a chat id: see 'kovan sessions'.");
  } else {
    a.task = words.join(' ').trim();
    // One short word that is nearly a command is a typo, not a task for the agent.
    const guess = words.length === 1 && a.command === 'chat' ? nearCommand(words[0]!) : null;
    if (guess)
      a.error ??= t(
        "'{word}' is not a command. Did you mean 'kovan {guess}'? To give the agent a task, write it as a sentence in quotes.",
        { word: words[0]!, guess },
      );
  }
  return a;
}

/** The command a mistyped word is one or two keystrokes from, if there is one. */
export function nearCommand(word: string): string | null {
  if (!/^[a-z]{4,}$/.test(word) || COMMANDS.has(word)) return null;
  let best: string | null = null;
  let bestDistance = 3;
  for (const command of COMMANDS) {
    const d = distance(word, command);
    if (d < bestDistance) {
      best = command;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}
