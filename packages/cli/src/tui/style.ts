/** The few colours the screen uses, in one place. A terminal that cannot show them still shows the text. */
export const sgr = (...codes: (number | string)[]): string => `\u001b[${codes.join(';')}m`;
export const RESET = sgr(0);

export const S = {
  bold: sgr(1),
  dim: sgr(2),
  italic: sgr(3),
  underline: sgr(4),
  inverse: sgr(7),
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  gray: sgr(90),
  accent: sgr('38;5;81'),
  accentBold: sgr(1, '38;5;81'),
  userBar: sgr('38;5;75'),
  code: sgr('38;5;180'),
  add: sgr('38;5;78'),
  del: sgr('38;5;203'),
  heading: sgr(1, '38;5;222'),
} as const;

export const paint = (style: string, text: string): string =>
  text ? `${style}${text}${RESET}` : '';

export const MODE_STYLE: Record<string, string> = {
  allow: sgr('38;5;78'),
  plan: sgr('38;5;221'),
  request: sgr('38;5;176'),
  full: sgr('38;5;203'),
};
