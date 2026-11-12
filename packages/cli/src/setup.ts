import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { t } from './i18n.js';
import { dirname } from 'node:path';
import { readConfigFile } from './config.js';

/** Writes `agent.json` with these fields changed (null removes one), readable only by its owner. */
export function saveConfig(file: string, patch: Record<string, string | null>): void {
  const current = readConfigFile(file) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key];
    else current[key] = value;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not every file system keeps modes (Windows) */
  }
}

export interface SetupDeps {
  out(s: string): void;
  /** Raw output, for taking a pasted key back off the screen. */
  write(s: string): void;
  readLine(prompt: string): Promise<string | null>;
  /** Where the choice is kept. */
  file: string;
  /** Signs in to a Kovan account (the browser confirms it); true when it worked. */
  signIn(): Promise<boolean>;
}

/**
 * Nothing set up to run models with: says the ways there are, in plain words, and sets up the
 * one the person picks. Nothing opens or is saved before they choose. True once a model is set.
 */
export async function chooseSetup(d: SetupDeps): Promise<boolean> {
  d.out(
    [
      '',
      t('Kovan needs a model to work with. Choose how:'),
      t('  1  Paste an OpenRouter key (kept in {file}, readable only by you)', { file: d.file }),
      t('  2  Sign in to a Kovan account and pay for models through Kovan (opens your browser)'),
      t('  3  Use a gateway of your own (an OpenAI-compatible address, a local model say)'),
      t('  q  Not now'),
      '',
    ].join('\n'),
  );
  for (;;) {
    const answer = (await d.readLine(t('1, 2, 3 or q › ')))?.trim().toLowerCase();
    if (answer === undefined || answer === 'q' || answer === 'quit') {
      d.out(t("Nothing was set up. Run 'kovan setup' when you're ready."));
      return false;
    }
    if (answer === '1') {
      const key = (
        await d.readLine(t('OpenRouter key (get one at https://openrouter.ai/keys) › '))
      )?.trim();
      // The pasted key leaves the screen as soon as it's read.
      d.write('\x1b[1A\x1b[2K');
      if (!key) continue;
      if (!/^sk-or-[\w-]{10,}$/.test(key)) {
        d.out(t("That doesn't look like an OpenRouter key: they start with sk-or-. Try again."));
        continue;
      }
      saveConfig(d.file, { apiKey: key, baseUrl: null, model: null, dialect: null });
      d.out(t("Key saved in {file}. To change it later, run 'kovan setup'.", { file: d.file }));
      return true;
    }
    if (answer === '2') return d.signIn();
    if (answer === '3') {
      const url = (
        await d.readLine(t('Address (for example http://localhost:11434/v1) › '))
      )?.trim();
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      } catch {
        d.out(t("That isn't an http:// or https:// address. Try again."));
        continue;
      }
      const model = (await d.readLine(t('Model name, as the gateway calls it › ')))?.trim();
      if (!model) continue;
      const key = (await d.readLine(t('Key, if it needs one (Enter for none) › ')))?.trim() ?? '';
      if (key) d.write('\x1b[1A\x1b[2K');
      saveConfig(d.file, { baseUrl: url, model, apiKey: key || null, dialect: null });
      d.out(t("Saved in {file}. To change it later, run 'kovan setup'.", { file: d.file }));
      return true;
    }
    d.out(t('Type 1, 2, 3 or q.'));
  }
}
