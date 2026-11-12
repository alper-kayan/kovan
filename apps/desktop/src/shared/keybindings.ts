// Keyboard accelerators look like "Mod+Shift+P". "Mod" is Cmd on macOS and Ctrl elsewhere.

export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'palette.commands': 'Mod+K',
  'palette.files': 'Mod+P',
  'workspace.open': 'Mod+O',
  'file.save': 'Mod+S',
  'tab.close': 'Mod+W',
  'go.sessions': 'Mod+1',
  'go.people': 'Mod+2',
  'go.agents': 'Mod+3',
  'go.workspace': 'Mod+4',
  'view.explorer': 'Mod+Shift+E',
  'view.git': 'Mod+Shift+G',
  'view.toggleSidebar': 'Mod+B',
  'view.toggleTerminal': 'Mod+J',
  'view.agent': 'Mod+L',
  'terminal.new': 'Mod+Shift+`',
  'settings.open': 'Mod+,',
  'agent.approval': 'Mod+Shift+A',
};

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface Chord {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function parseAccelerator(accelerator: string): Chord | null {
  const parts = accelerator.split('+').map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  const chord: Chord = {
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: key.toLowerCase(),
  };
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'mod' || p === 'cmdorctrl') chord.mod = true;
    else if (p === 'ctrl' || p === 'control') chord.ctrl = true;
    else if (p === 'cmd' || p === 'meta' || p === 'command') chord.meta = true;
    else if (p === 'alt' || p === 'option') chord.alt = true;
    else if (p === 'shift') chord.shift = true;
    else return null;
  }
  return chord;
}

/** Normalizes a KeyboardEvent key so Shift doesn't change it ("<" -> ",", "~" -> "`"). */
function baseKey(key: string): string {
  const shifted: Record<string, string> = {
    '<': ',',
    '>': '.',
    '?': '/',
    '~': '`',
    '{': '[',
    '}': ']',
    '|': '\\',
    ':': ';',
    '"': "'",
    _: '-',
    '+': '=',
  };
  const k = key.toLowerCase();
  return shifted[k] ?? k;
}

export function matches(event: KeyEventLike, accelerator: string, isMac: boolean): boolean {
  const chord = parseAccelerator(accelerator);
  if (!chord) return false;
  const wantMeta = chord.meta || (chord.mod && isMac);
  const wantCtrl = chord.ctrl || (chord.mod && !isMac);
  return (
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift &&
    baseKey(event.key) === baseKey(chord.key)
  );
}

/** The effective keybindings: defaults with user overrides applied. An empty override unbinds. */
export function resolveKeybindings(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_KEYBINDINGS };
  for (const [command, accelerator] of Object.entries(overrides)) {
    if (accelerator === '') delete out[command];
    else out[command] = accelerator;
  }
  return out;
}

export function findCommand(
  event: KeyEventLike,
  bindings: Record<string, string>,
  isMac: boolean,
): string | null {
  for (const [command, accelerator] of Object.entries(bindings)) {
    if (matches(event, accelerator, isMac)) return command;
  }
  return null;
}

/** Display form of an accelerator for the current platform, e.g. "⌘⇧P" or "Ctrl+Shift+P". */
export function formatAccelerator(accelerator: string, isMac: boolean): string {
  const chord = parseAccelerator(accelerator);
  if (!chord) return accelerator;
  const key =
    chord.key.length === 1
      ? chord.key.toUpperCase()
      : chord.key[0]!.toUpperCase() + chord.key.slice(1);
  if (isMac) {
    return [
      chord.ctrl ? '⌃' : '',
      chord.alt ? '⌥' : '',
      chord.shift ? '⇧' : '',
      chord.meta || chord.mod ? '⌘' : '',
      key,
    ].join('');
  }
  return [
    chord.ctrl || chord.mod ? 'Ctrl' : '',
    chord.meta ? 'Win' : '',
    chord.alt ? 'Alt' : '',
    chord.shift ? 'Shift' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}
