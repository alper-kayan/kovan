/** An AI teammate someone can call in with @. */
export interface Mentionable {
  id: string;
  name: string;
}

/** The name being typed after an "@" right before the caret ("@Bo|" → "Bo"), or null. */
export function mentionQuery(text: string, caret: number): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? m[1]! : null;
}

/** The teammates whose name starts with what is typed. */
export function mentionMatches<T extends Mentionable>(query: string, teammates: T[]): T[] {
  const q = query.toLocaleLowerCase();
  return teammates.filter((t) => t.name.toLocaleLowerCase().startsWith(q));
}

/** Puts "@Name " in place of the "@query" before the caret; returns the text and the new caret. */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${name} `);
  return { text: before + text.slice(caret).replace(/^ /, ''), caret: before.length };
}

/** A letter, digit or underscore (any script): what can't follow a name for it to count. */
const WORD = /[0-9A-Za-z_\u00C0-\uFFFF]/;

/** The teammate a message calls in ("@Bob, is this right?"), the longest name winning. */
export function mentionedTeammate<T extends Mentionable>(text: string, teammates: T[]): T | null {
  const lower = text.toLocaleLowerCase();
  for (const t of [...teammates].sort((a, b) => b.name.length - a.name.length)) {
    const at = `@${t.name.toLocaleLowerCase()}`;
    let i = lower.indexOf(at);
    while (i !== -1) {
      const before = i === 0 ? ' ' : lower[i - 1]!;
      const after = lower[i + at.length] ?? ' ';
      if (/[\s([{]/.test(before) && !WORD.test(after)) return t;
      i = lower.indexOf(at, i + 1);
    }
  }
  return null;
}
