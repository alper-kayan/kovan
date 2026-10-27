/** Splits a pasted command line the way a shell would (quotes and backslashes). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]!;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < line.length) word = (word ?? '') + line[++i]!;
    else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}

/** Joins arguments back into one line that splits the same way. */
export function joinCommand(parts: string[]): string {
  return parts
    .map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}
