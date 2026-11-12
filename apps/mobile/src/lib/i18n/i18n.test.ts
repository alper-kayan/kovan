import { PUSH_KINDS, ROLE_WORDS } from '@kovan/shared';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { locale, setLanguage, t } from './index';
import { tr } from './tr';

const SRC = join(__dirname, '..', '..');

/** Every text the app passes to `t` as written, file by file. */
function textsInApp(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && name !== 'tr.ts')
        files.push(path);
    }
  };
  walk(SRC);
  const texts = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't'
      ) {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)))
          texts.add(first.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...texts];
}

const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('the Turkish catalog', () => {
  afterEach(() => setLanguage('en'));

  it('has every text the app shows', () => {
    const texts = textsInApp();
    expect(texts.length).toBeGreaterThan(300);
    expect(texts.filter((x) => !(x in tr))).toEqual([]);
  });

  it("has @kovan/shared's texts the app shows (roles, notification kinds)", () => {
    const shared = [
      ...Object.values(ROLE_WORDS),
      ...PUSH_KINDS.flatMap((k) => [k.label, k.detail]),
    ];
    expect(shared.filter((x) => !(x in tr))).toEqual([]);
  });

  it('keeps every {value} of the English', () => {
    const wrong = Object.entries(tr).filter(
      ([en, text]) => slots(en).join() !== slots(text).join(),
    );
    expect(wrong).toEqual([]);
  });

  it('switches language, and falls back to English for what it lacks', () => {
    expect(t('Approve')).toBe('Approve');
    setLanguage('tr');
    expect(locale()).toBe('tr');
    expect(t('Approve')).toBe('Onayla');
    expect(t('{n} running', { n: 2 })).toBe('2 çalışıyor');
    expect(t('Not in the catalog')).toBe('Not in the catalog');
    setLanguage('en');
    expect(t('{n} running', { n: 2 })).toBe('2 running');
  });
});
