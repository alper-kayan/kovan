import { git } from '@kovan/git-engine';
import type { ImpactLink, ChangeImpact } from '@kovan/shared';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|php)$/;
/** Lines that look like an HTTP route being defined. */
const ROUTE =
  /\b(app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete|route)\s*\(|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b|@(Get|Post|Put|Patch|Delete)\(/;
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const MAX_FILES = 5000;
const MAX_DEPTH = 3;

/** The files of the checkout: tracked and new (ignored files left out). */
async function filesOf(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return [...new Set(out.split('\n').filter(Boolean))].slice(0, MAX_FILES);
}

/** A relative import resolved to a file of the checkout, the way bundlers and Node look. */
function resolve(from: string, spec: string, files: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = normalize(join(dirname(from), spec)).replace(/\\/g, '/');
  const stem = base.replace(/\.(js|mjs|cjs)$/, '');
  const tries = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].flatMap((ext) => [stem + ext, base + ext]),
    ...['ts', 'tsx', 'js', 'jsx'].map((ext) => `${base}/index.${ext}`),
  ];
  return tries.find((t) => files.has(t)) ?? null;
}

/**
 * What a change can reach, and how sure that is. JavaScript and TypeScript imports are followed
 * for real (a file that imports a changed one, or imports one that does); tests and HTTP routes
 * among them are called out. Tests that only mention a changed file's name are linked less
 * surely, and so are files in other languages. It is a map for checking, not proof of safety.
 */
/** The checkout's JavaScript and TypeScript files and their relative imports, both ways. */
export interface ImportGraph {
  /** Every file of the checkout (tracked and new). */
  files: string[];
  /** For each file, the files it imports. */
  imports: Map<string, Set<string>>;
  /** For each file, the files that import it. */
  importers: Map<string, Set<string>>;
  /** Relative imports that point at no file of the checkout. */
  unresolved: number;
}

/** Reads the checkout's import graph (relative imports only; packages and aliases are not). */
export async function importGraph(root: string): Promise<ImportGraph> {
  const list = await filesOf(root);
  const files = new Set(list);
  const imports = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  let unresolved = 0;
  await Promise.all(
    list
      .filter((f) => CODE.test(f))
      .map(async (file) => {
        const text = await readFile(join(root, file), 'utf8').catch(() => '');
        for (const m of text.matchAll(IMPORT)) {
          const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
          if (!spec.startsWith('.')) continue;
          const target = resolve(file, spec, files);
          if (!target) {
            unresolved += 1;
            continue;
          }
          const out = imports.get(file) ?? new Set<string>();
          out.add(target);
          imports.set(file, out);
          const into = importers.get(target) ?? new Set<string>();
          into.add(file);
          importers.set(target, into);
        }
      }),
  );
  return { files: list, imports, importers, unresolved };
}

export async function changeImpact(root: string, changed: string[]): Promise<ChangeImpact> {
  const { files: list, importers, unresolved } = await importGraph(root);
  const files = new Set(list);

  const links = new Map<string, ImpactLink>();
  const isRoute = async (file: string) =>
    ROUTE.test(await readFile(join(root, file), 'utf8').catch(() => ''));
  // Breadth first from the changed files, so each link keeps its shortest chain.
  let frontier = changed.filter((f) => files.has(f)).map((f) => ({ path: f, via: [f] }));
  const seen = new Set(changed);
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: { path: string; via: string[] }[] = [];
    for (const { path, via } of frontier)
      for (const importer of importers.get(path) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        const chain = [...via, importer];
        links.set(importer, {
          path: importer,
          kind: TEST.test(importer) ? 'test' : (await isRoute(importer)) ? 'api' : 'module',
          certainty: depth === 1 ? 'imports' : 'imports_indirectly',
          via: chain,
        });
        next.push({ path: importer, via: chain });
      }
    frontier = next;
  }
  // The changed files themselves can be routes.
  for (const f of changed)
    if (CODE.test(f) && files.has(f) && (await isRoute(f)) && !links.has(f))
      links.set(f, { path: f, kind: 'api', certainty: 'changed', via: [f] });

  // Tests that only name a changed file: likely related, not followed through imports.
  const tests = list.filter((f) => TEST.test(f));
  for (const file of changed.filter((f) => SOURCE.test(f) && !TEST.test(f))) {
    const stem = file
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, '');
    if (stem.length < 3 || stem === 'index') continue;
    for (const t of tests) {
      if (links.has(t) || changed.includes(t)) continue;
      const text = await readFile(join(root, t), 'utf8').catch(() => '');
      if (text.includes(stem))
        links.set(t, { path: t, kind: 'test', certainty: 'mentions', via: [file, t] });
    }
  }

  const notes: string[] = [];
  if (changed.some((f) => SOURCE.test(f) && !CODE.test(f)))
    notes.push(
      'Only JavaScript and TypeScript imports are followed; other files are linked by name.',
    );
  if (unresolved)
    notes.push(`${unresolved} relative import${unresolved === 1 ? '' : 's'} couldn't be resolved.`);
  notes.push('Package imports and path aliases (like @app/x) are not followed.');
  if (list.length >= MAX_FILES) notes.push(`Only the first ${MAX_FILES} files were read.`);
  const order = { changed: 0, imports: 1, imports_indirectly: 2, mentions: 3 };
  return {
    changed,
    links: [...links.values()].sort(
      (a, b) => order[a.certainty] - order[b.certainty] || a.path.localeCompare(b.path),
    ),
    notes,
  };
}

/** One line for reports: "2 tests import it, 1 more mentions it · 1 API route". */
export function impactLine(impact: ChangeImpact): string | null {
  const tests = impact.links.filter((l) => l.kind === 'test');
  const sure = tests.filter((l) => l.certainty !== 'mentions').length;
  const named = tests.length - sure;
  const apis = impact.links.filter((l) => l.kind === 'api').length;
  const modules = impact.links.filter((l) => l.kind === 'module').length;
  const parts = [
    sure ? `${sure} test${sure === 1 ? '' : 's'} import it` : '',
    named ? `${named} test${named === 1 ? ' only mentions' : 's only mention'} it` : '',
    modules ? `${modules} module${modules === 1 ? ' depends' : 's depend'} on it` : '',
    apis ? `${apis} API route${apis === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
