/**
 * The desktop app's design tokens (apps/desktop/src/renderer/src/styles.css, dark), so both
 * apps feel like one product. Dark only for now, like the desktop's default.
 */
export const colors = {
  bg: '#101010',
  bg2: '#0b0b0b',
  bg3: '#181818',
  bg4: '#242424',
  line: '#252525',
  line2: '#303030',
  fg: '#d8d8d8',
  fg2: '#a7a7a7',
  fg3: '#858585',
  fg4: '#676767',
  chip: '#1a1a1a',
  pop: '#e8e8e8',
  popfg: '#111111',
  ok: '#30a46c',
  okSoft: '#4cc38a',
  danger: '#e5484d',
  warn: '#e5a000',
  jev: '#ffa94d',
  purple: '#b197fc',
} as const;

/**
 * How far text grows with the system's text size. Large accessibility sizes still apply, up to
 * where rows, pills and tabs keep their shape.
 */
export const MAX_FONT_SCALE = 1.6;

/** Washes the desktop mixes from a colour and the card background (color-mix 7%, 45%). */
export const tint = {
  warnBg: '#262116',
  warnLine: '#81621a',
  dangerBg: '#261b1c',
  dangerLine: '#813b3d',
} as const;

/** The colour of a session or lane state, as on the desktop board. */
export const STATE_COLOR = {
  running: colors.okSoft,
  waiting: colors.warn,
  awaiting: colors.danger,
  idle: colors.fg3,
  ended: colors.fg3,
} as const;

const PERSON_COLORS = ['#f06595', '#4dabf7', '#38d9a9', '#ffa94d', '#b197fc'];

export const WORKSPACE_COLORS = [
  '#f06595',
  '#8b8f96',
  '#e5484d',
  '#f76b15',
  '#e5a000',
  '#30a46c',
  '#12a594',
  '#8e4ec6',
  '#d6409f',
];

export function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/** The same colour a person gets on the desktop. */
export function personColor(name: string): string {
  return PERSON_COLORS[hash(name) % PERSON_COLORS.length]!;
}

export function workspaceColor(name: string, color: string | null): string {
  return color ?? WORKSPACE_COLORS[hash(name) % WORKSPACE_COLORS.length]!;
}

export function initials(name: string): string {
  // Letters and digits only: "Deniz (test)" is DT, not D(.
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

export const fonts = {
  ui: 'DMSans_400Regular',
  uiMedium: 'DMSans_500Medium',
  uiBold: 'DMSans_600SemiBold',
  mono: 'GeistMono_400Regular',
} as const;

export const radius = { sm: 6, md: 8, lg: 10 } as const;
