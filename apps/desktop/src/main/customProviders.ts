import { OpenRouterClient, type ModelInfo } from '@kovan/model-gateway';
import { safeStorage } from 'electron';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseCustomModelId,
  type CustomProviderInfo,
  type CustomProviderInput,
} from '../shared/agent.js';
import { readJson, writeJson } from '@kovan/runner';

interface StoredProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** The saved catalog, so the models show up without asking the server each launch. */
  models: ModelInfo[];
  fetchedAt: number | null;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'custom'
  );
}

/** Normalizes what people paste: no trailing slash, and /v1 for the bare Ollama/LM Studio port. */
export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Use an http:// or https:// address');
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '') path = '/v1';
  return `${url.origin}${path}`;
}

/**
 * Custom OpenAI-compatible providers. The list lives in `custom-providers.json`; their keys are
 * kept together, encrypted with the OS keychain, in `custom-provider-keys.bin`.
 */
export class CustomProviders {
  private providers: StoredProvider[] | null = null;
  private keys: Record<string, string> | null = null;

  constructor(private readonly dir: string) {}

  private get listFile() {
    return join(this.dir, 'custom-providers.json');
  }

  private get keysFile() {
    return join(this.dir, 'custom-provider-keys.bin');
  }

  private async load(): Promise<StoredProvider[]> {
    this.providers ??= ((await readJson(this.listFile)) as StoredProvider[] | undefined) ?? [];
    return this.providers;
  }

  private async loadKeys(): Promise<Record<string, string>> {
    if (this.keys) return this.keys;
    const raw = safeStorage.isEncryptionAvailable()
      ? await readFile(this.keysFile).catch(() => null)
      : null;
    try {
      this.keys = raw ? (JSON.parse(safeStorage.decryptString(raw)) as Record<string, string>) : {};
    } catch {
      this.keys = {};
    }
    return this.keys;
  }

  private async saveKeys(keys: Record<string, string>): Promise<void> {
    this.keys = keys;
    if (Object.keys(keys).length === 0) {
      await rm(this.keysFile, { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('This system has no secure storage for keys');
    await writeFile(this.keysFile, safeStorage.encryptString(JSON.stringify(keys)), {
      mode: 0o600,
    });
  }

  async list(): Promise<CustomProviderInfo[]> {
    const keys = await this.loadKeys();
    return (await this.load()).map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      hasKey: Boolean(keys[p.id]),
      models: p.models.map((m) => m.id),
      fetchedAt: p.fetchedAt,
    }));
  }

  private clientFor(baseUrl: string, apiKey: string): OpenRouterClient {
    return new OpenRouterClient({ apiKey, baseUrl, dialect: 'openai' });
  }

  /** Lists the server's models; this is also how a new provider and key are checked. */
  private async discover(p: StoredProvider, apiKey: string): Promise<ModelInfo[]> {
    let models: ModelInfo[];
    try {
      models = await this.clientFor(p.baseUrl, apiKey).listModels(AbortSignal.timeout(15_000));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`${p.name} didn't list its models at ${p.baseUrl}/models: ${why}`, {
        cause: error,
      });
    }
    if (models.length === 0) throw new Error(`${p.name} has no models to offer`);
    // The server's own ids, under the provider's prefix. Tool use can't be checked up front;
    // Kovan's agent needs it, so a model that can't call tools fails on its first turn.
    return models.map((m) => ({
      ...m,
      id: `@${p.id}/${m.id}`,
      name: m.name === m.id ? m.id : m.name,
      provider: p.name,
      tools: true,
    }));
  }

  async save(input: CustomProviderInput): Promise<CustomProviderInfo[]> {
    const providers = await this.load();
    const keys = { ...(await this.loadKeys()) };
    const name = input.name.trim();
    if (!name) throw new Error('Give the provider a name');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const existing = input.id ? providers.find((p) => p.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('That provider no longer exists');
    let id = existing?.id ?? slug(name);
    if (!existing) {
      const base = id;
      for (let n = 2; providers.some((p) => p.id === id); n++) id = `${base}-${n}`;
    }
    const apiKey = input.apiKey === undefined ? (keys[id] ?? '') : (input.apiKey ?? '');
    const draft: StoredProvider = { id, name, baseUrl, models: [], fetchedAt: null };
    draft.models = await this.discover(draft, apiKey);
    draft.fetchedAt = Date.now();

    if (apiKey) keys[id] = apiKey;
    else delete keys[id];
    await this.saveKeys(keys);
    this.providers = existing
      ? providers.map((p) => (p.id === id ? draft : p))
      : [...providers, draft];
    await writeJson(this.listFile, this.providers);
    return this.list();
  }

  async refresh(id: string): Promise<CustomProviderInfo[]> {
    const providers = await this.load();
    const p = providers.find((x) => x.id === id);
    if (!p) throw new Error('That provider no longer exists');
    p.models = await this.discover(p, (await this.loadKeys())[id] ?? '');
    p.fetchedAt = Date.now();
    await writeJson(this.listFile, providers);
    return this.list();
  }

  async remove(id: string): Promise<CustomProviderInfo[]> {
    const keys = { ...(await this.loadKeys()) };
    delete keys[id];
    await this.saveKeys(keys);
    this.providers = (await this.load()).filter((p) => p.id !== id);
    await writeJson(this.listFile, this.providers);
    return this.list();
  }

  /** Every saved model, ready to merge into the catalog. */
  async models(): Promise<ModelInfo[]> {
    return (await this.load()).flatMap((p) => p.models);
  }

  /** The client and the server's own model id for an "@provider/model" id. */
  async resolve(modelId: string): Promise<{ client: OpenRouterClient; model: string } | null> {
    const parsed = parseCustomModelId(modelId);
    if (!parsed) return null;
    const p = (await this.load()).find((x) => x.id === parsed.provider);
    if (!p) throw new Error(`The provider for ${modelId} was removed; pick another model`);
    const key = (await this.loadKeys())[p.id] ?? '';
    return { client: this.clientFor(p.baseUrl, key), model: parsed.model };
  }
}
