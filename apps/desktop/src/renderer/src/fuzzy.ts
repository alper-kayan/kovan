/**
 * Scores how well `query` matches `text` as a subsequence. Higher is better; null means no match.
 * Rewards consecutive characters, matches at word starts and matches in the file name.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return 0;
  const t = text.toLowerCase();
  const nameStart = text.lastIndexOf('/') + 1;
  const isWordStart = (i: number) => i === 0 || /[/\-_. ]/.test(text[i - 1] ?? '');
  const lengthPenalty = text.length * 0.01;

  // A contiguous match scores from its own position, so a scattered greedy alignment can't
  // hide it; best of all in the file name and at a word start.
  const exact = t.lastIndexOf(q);
  if (exact !== -1) {
    let score = q.length * 6 + 20;
    if (exact >= nameStart) score += 10;
    if (isWordStart(exact)) score += 5;
    return score - lengthPenalty;
  }

  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prev + 1) score += 5;
    if (isWordStart(found)) score += 4;
    if (found >= nameStart) score += 2;
    prev = found;
    ti = found + 1;
  }
  return score - lengthPenalty;
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 200,
): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}
