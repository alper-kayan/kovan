/**
 * A model provider's error in words a person can act on: what happened and what to do, with
 * the provider's own line kept at the end for whoever wants it. Words the usage-limit check
 * looks for ("rate limit", "out of credits") stay in, so switching agents still works.
 */
export function plainModelError(input: {
  status: number;
  /** What the provider said, if anything. */
  said: string | null;
  /** Who answered: "OpenRouter", "localhost:11434", "Kovan". */
  host: string;
  model?: string | null;
}): string {
  const { status, host } = input;
  const said = input.said?.trim() || null;
  const tail = said ? ` (${host} said: ${said.slice(0, 300)})` : '';
  if (status === 401 || status === 403)
    return `${host} refused the key: it's wrong, expired or was revoked. Check the key you gave Kovan for it.${tail}`;
  if (status === 402)
    return `${host} says the account is out of credits. Add credits there, or pick another model.${tail}`;
  if (status === 429)
    return `${host} hit a rate limit and is turning requests away for now. Wait a moment and try again, or pick another model.${tail}`;
  if (status === 404)
    return `${host} doesn't offer ${input.model ? `the model ${input.model}` : 'that model'}. Pick another one.${tail}`;
  if (status === 408 || status === 504) return `${host} took too long to answer. Try again.${tail}`;
  if (status >= 500)
    return `${host} had a problem on its side (HTTP ${status}). Try again in a moment.${tail}`;
  if (status === 400)
    return `${host} didn't accept the request${said ? `: ${said.slice(0, 300)}` : ''}.`;
  return `${host} turned the request away (HTTP ${status}).${tail}`;
}

/** The name a person knows a model server by: OpenRouter, Kovan, or its address. */
export function hostLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (/(^|\.)openrouter\.ai$/.test(url.hostname)) return 'OpenRouter';
    if (url.pathname.includes('/api/inference')) return 'Kovan';
    return url.host;
  } catch {
    return baseUrl;
  }
}

/** A network failure (nothing answered) in words. */
export function unreachable(host: string): string {
  return `Can't reach ${host}. Check your connection${/^(localhost|127\.|\[::1\])/.test(host) ? `, and that the server at ${host} is running` : ''}, then try again.`;
}
