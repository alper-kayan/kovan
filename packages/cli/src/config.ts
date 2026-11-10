import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Which model server `kovan` talks to, and as whom.
 *
 * Anything OpenAI-compatible works (OpenRouter, his own OmniRoute gateway, a local server); OpenRouter is the
 * default because that is what Kovan's own agent already uses. The key is read from the environment or one file,
 * and nothing here ever returns it in a message.
 */
export interface Provider {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenRouter's extensions (usage accounting, reasoning) or the plain Chat Completions API. */
  dialect: 'openrouter' | 'openai';
  /** For the screen: which server, never the key. */
  label: string;
}

export type ProviderResult = { ok: true; provider: Provider } | { ok: false; why: string };

export const CONFIG_FILE = join(homedir(), '.config', 'kovan', 'agent.json');
const OPENROUTER = 'https://openrouter.ai/api/v1';

interface FileConfig {
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown;
  dialect?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function readConfigFile(file: string): FileConfig {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return c && typeof c === 'object' ? (c as FileConfig) : {};
  } catch {
    return {};
  }
}

export function loadProvider(
  env: Record<string, string | undefined>,
  file: string = CONFIG_FILE,
): ProviderResult {
  const f = readConfigFile(file);
  const baseUrl = str(env['KOVAN_BASE_URL']) ?? str(f.baseUrl);
  const custom = baseUrl !== null && !/openrouter\.ai/.test(baseUrl);
  const model = str(env['KOVAN_MODEL']) ?? str(f.model);

  if (!custom) {
    const apiKey = str(env['KOVAN_API_KEY']) ?? str(env['OPENROUTER_API_KEY']) ?? str(f.apiKey);
    if (!apiKey) {
      return {
        ok: false,
        why: 'model anahtarı yok: OPENROUTER_API_KEY ver, ya da KOVAN_BASE_URL (+ KOVAN_API_KEY, KOVAN_MODEL) ile kendi ağ geçidini göster.',
      };
    }
    return {
      ok: true,
      provider: {
        baseUrl: (baseUrl ?? OPENROUTER).replace(/\/$/, ''),
        apiKey,
        model: model ?? 'openrouter/auto',
        dialect: 'openrouter',
        label: 'openrouter.ai',
      },
    };
  }

  // Someone else's server: the model has no sensible default, and a local one needs no key.
  if (!model)
    return {
      ok: false,
      why: `${baseUrl} için model adı yok: KOVAN_MODEL ver (ya da ${CONFIG_FILE} içinde "model").`,
    };
  const dialect = str(env['KOVAN_DIALECT']) ?? str(f.dialect);
  let label = baseUrl!;
  try {
    label = new URL(baseUrl!).host;
  } catch {
    /* shown as given */
  }
  return {
    ok: true,
    provider: {
      baseUrl: baseUrl!.replace(/\/$/, ''),
      apiKey: str(env['KOVAN_API_KEY']) ?? str(f.apiKey) ?? '',
      model,
      dialect: dialect === 'openrouter' ? 'openrouter' : 'openai',
      label,
    },
  };
}
