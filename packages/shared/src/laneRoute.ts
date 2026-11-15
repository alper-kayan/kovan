/**
 * What a lane runs on and who pays for it, in words for the person watching: a Claude Code or
 * Codex lane runs on their own subscription; a Kovan agent lane calls a model that is billed per
 * use (OpenRouter on the key of the machine that runs it, or Kovan's billing).
 */
export interface LaneRoute {
  kind: 'subscription' | 'paid' | 'unknown';
  /** The English text, with `{name}` slots filled from `values`: translate `key`, then fill. */
  key: string;
  values: Record<string, string>;
  /** One sentence for a tooltip. */
  detail: string;
}

const SUBSCRIPTION_DETAIL = 'Runs on your own subscription: nothing is billed per use.';
const PAID_DETAIL =
  "Billed per use: by OpenRouter to the key on the machine that runs it, or by Kovan if you use Kovan's billing.";

export function laneRoute(p: { harness: string | null; model: string | null }): LaneRoute {
  const model = (p.model ?? '').replace(/^(claude-code|codex) · /, '');
  if (p.harness === 'claude-code')
    return {
      kind: 'subscription',
      key: 'Claude Code · your subscription',
      values: {},
      detail: SUBSCRIPTION_DETAIL,
    };
  if (p.harness === 'codex')
    return {
      kind: 'subscription',
      key: 'Codex · your subscription',
      values: {},
      detail: SUBSCRIPTION_DETAIL,
    };
  if (p.harness === 'kovan' || (p.harness === null && model)) {
    const custom = /^@([^/]+)\//.exec(model);
    if (custom)
      return {
        kind: 'paid',
        key: '{provider} · your key',
        values: { provider: custom[1]! },
        detail: PAID_DETAIL,
      };
    if (model === 'kovan/jevrouter')
      return { kind: 'paid', key: 'JevRouter · paid models', values: {}, detail: PAID_DETAIL };
    return {
      kind: 'paid',
      key: 'OpenRouter · {model}',
      values: { model: model.replace(/^[^/]+\//, '') || 'default' },
      detail: PAID_DETAIL,
    };
  }
  return { kind: 'unknown', key: '', values: {}, detail: '' };
}
