import { createHash } from 'node:crypto';

/**
 * The short code that ties an emailed sign-in link to the screen where the sign-in started:
 * that screen shows it, and the link's page asks for it. Someone who starts a sign-in with
 * another person's address can't get past the link's page without it, and the email itself
 * never carries it.
 */
export function signInCode(loginId: string): string {
  const hex = createHash('sha256').update(`kovan-sign-in-code:${loginId}`).digest('hex');
  const digits = String(parseInt(hex.slice(0, 12), 16) % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Whether what the person typed is the code, spaces and dashes aside. */
export function codeMatches(typed: string, loginId: string): boolean {
  const clean = typed.replace(/\D/g, '');
  return clean.length === 6 && clean === signInCode(loginId).replace(/\D/g, '');
}
