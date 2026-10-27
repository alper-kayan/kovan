import type { Tier } from './policy.js';

/** Steering written into a prompt, e.g. "[jev: only use Opus]". */
export type Directive =
  | { kind: 'pin'; query: string }
  | { kind: 'tier'; tier: Tier }
  | { kind: 'cap'; tier: Tier }
  | { kind: 'auto' };

const DIRECTIVE = /\[\s*jev\s*:\s*([^\]]+)\]/gi;
const TIERS: Tier[] = ['economy', 'balanced', 'frontier'];

function parseOne(body: string): Directive | null {
  const text = body.trim().toLowerCase();
  if (text === 'auto' || text === 'reset') return { kind: 'auto' };
  const tier = /^(?:tier|use tier|always)\s+(economy|balanced|frontier)$/.exec(text);
  if (tier) return { kind: 'tier', tier: tier[1] as Tier };
  const cap =
    /^(?:no frontier|max (economy|balanced|frontier)|at most (economy|balanced|frontier))$/.exec(
      text,
    );
  if (cap) return { kind: 'cap', tier: ((cap[1] ?? cap[2]) as Tier | undefined) ?? 'balanced' };
  if (TIERS.includes(text as Tier)) return { kind: 'tier', tier: text as Tier };
  const pin = /^(?:only use|use|pin|always use)\s+(.+)$/.exec(text);
  if (pin) return { kind: 'pin', query: pin[1]!.trim() };
  return null;
}

/** Finds the last directive in a prompt and returns the prompt without any directive text. */
export function parseDirectives(text: string): { directive: Directive | null; cleaned: string } {
  let directive: Directive | null = null;
  const cleaned = text.replace(DIRECTIVE, (_match, body: string) => {
    directive = parseOne(body) ?? directive;
    return '';
  });
  return { directive, cleaned: cleaned.replace(/[ \t]{2,}/g, ' ').trim() };
}
