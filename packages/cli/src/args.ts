import type { PermissionMode } from '@kovan/harness';
import type { Effort } from '@kovan/model-gateway';

export type Command =
  'chat' | 'sessions' | 'config' | 'login' | 'logout' | 'whoami' | 'update' | 'help' | 'version';

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
      a.error ??= `${flag} needs a value`;
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
        else if (v) a.error ??= `unknown mode '${v}' (${MODES.join(', ')})`;
        i++;
        break;
      }
      case '--effort': {
        const v = value(i, arg);
        if (v && (EFFORTS as readonly string[]).includes(v)) a.effort = v as Effort;
        else if (v) a.error ??= `unknown effort '${v}' (${EFFORTS.join(', ')})`;
        i++;
        break;
      }
      default:
        if (arg.startsWith('-') && arg.length > 1) a.error ??= `unknown option: ${arg}`;
        else words.push(arg);
    }
  }
  if (a.command === 'sessions' && words[0] === 'export') {
    a.sessionId = words[1] ?? null;
    if (!a.sessionId) a.error ??= 'sessions export needs a session id';
  } else {
    a.task = words.join(' ').trim();
  }
  return a;
}
