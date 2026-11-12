import * as SecureStore from 'expo-secure-store';
import { LOCALES } from '@kovan/shared';
import { setLanguage, type LanguageChoice } from './index';

/** Where the language picked in Account is kept, next to the server address. */
const KEY = 'kovan.language';

const isChoice = (value: string | null): value is LanguageChoice =>
  value === 'system' || (LOCALES as readonly string[]).includes(value ?? '');

/** The language picked on an earlier run, put in place before the first screen draws. */
export async function loadLanguage(): Promise<void> {
  const saved = await SecureStore.getItemAsync(KEY).catch(() => null);
  if (isChoice(saved)) setLanguage(saved);
}

/** Switches the language now and keeps the choice for the next run. */
export async function saveLanguage(choice: LanguageChoice): Promise<void> {
  // The choice holds for this run even if it can't be saved for the next one.
  setLanguage(choice);
  await SecureStore.setItemAsync(KEY, choice).catch((e: unknown) =>
    console.warn("Couldn't save the language:", e),
  );
}
