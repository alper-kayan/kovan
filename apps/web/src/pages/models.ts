import '../site';
import '../styles/pages.css';
import { h } from '../lib/dom';

/** OpenRouter's catalog shape, as the server passes it on. Prices are USD-per-token strings. */
interface CatalogModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
}

interface Row {
  id: string;
  name: string;
  provider: string;
  context: number | null;
  /** USD per million tokens; null when the catalog has no fixed price (routers, for example). */
  input: number | null;
  output: number | null;
}

type SortKey = 'name' | 'provider' | 'context' | 'input' | 'output' | 'managed';

const COLUMNS: { key: SortKey; label: string; text?: boolean }[] = [
  { key: 'name', label: 'Model', text: true },
  { key: 'provider', label: 'Provider', text: true },
  { key: 'context', label: 'Context' },
  { key: 'input', label: 'Input $/M' },
  { key: 'output', label: 'Output $/M' },
  { key: 'managed', label: `Managed × ${__MANAGED_MARKUP__}` },
];

const host = document.querySelector<HTMLElement>('[data-models]')!;
const search = document.querySelector<HTMLInputElement>('[data-search]')!;
const count = document.querySelector<HTMLElement>('[data-count]')!;

let rows: Row[] = [];
let sort: { key: SortKey; dir: 1 | -1 } = { key: 'name', dir: 1 };

function perMillion(value: unknown): number | null {
  const perToken = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isFinite(perToken) && perToken >= 0 ? perToken * 1_000_000 : null;
}

function toRow(model: CatalogModel): Row | null {
  if (typeof model.id !== 'string' || !model.id) return null;
  const name = typeof model.name === 'string' && model.name ? model.name : model.id;
  const context = Number(model.context_length);
  return {
    id: model.id,
    // "Anthropic: Claude …" repeats the provider column; keep the model's own name.
    name: name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name,
    provider: model.id.includes('/') ? model.id.slice(0, model.id.indexOf('/')) : 'other',
    context: Number.isFinite(context) && context > 0 ? context : null,
    input: perMillion(model.pricing?.prompt),
    output: perMillion(model.pricing?.completion),
  };
}

function money(value: number | null): string {
  if (value === null) return 'varies';
  if (value === 0) return '$0';
  return `$${value < 1 ? value.toFixed(3).replace(/0$/, '') : value.toFixed(2)}`;
}

function contextLabel(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

const managed = (value: number | null) => (value === null ? null : value * __MANAGED_MARKUP__);

function sortValue(row: Row, key: SortKey): string | number | null {
  if (key === 'managed') return managed(row.input);
  return row[key];
}

function visibleRows(): Row[] {
  const query = search.value.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const matched = rows.filter((row) => {
    const text = `${row.name} ${row.id} ${row.provider}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return matched.sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    // Rows without a value go last, whichever way the column is sorted.
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const order = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
    return order * sort.dir || a.name.localeCompare(b.name);
  });
}

function state(title: string, text: string, retry = false): void {
  count.textContent = '';
  const box = h('div', { class: 'state' }, h('h2', {}, title), h('p', {}, text));
  if (retry) {
    const button = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Try again');
    button.addEventListener('click', () => void load());
    box.append(button);
  }
  host.replaceChildren(box);
}

function render(): void {
  const shown = visibleRows();
  count.textContent =
    shown.length === rows.length
      ? `${rows.length} models`
      : `${shown.length} of ${rows.length} models`;

  const head = h('tr', {});
  for (const column of COLUMNS) {
    const button = h('button', { class: 'sort', type: 'button' }, column.label);
    button.addEventListener('click', () => {
      // Text starts A to Z; numbers start with the largest context or the lowest price.
      const first: 1 | -1 = column.key === 'context' ? -1 : 1;
      sort =
        sort.key === column.key
          ? { key: column.key, dir: sort.dir === 1 ? -1 : 1 }
          : { key: column.key, dir: first };
      render();
      host.querySelector<HTMLElement>(`[data-key="${column.key}"] .sort`)?.focus();
    });
    head.append(
      h(
        'th',
        {
          scope: 'col',
          class: column.text ? 'left' : null,
          'data-key': column.key,
          'aria-sort':
            sort.key === column.key ? (sort.dir === 1 ? 'ascending' : 'descending') : null,
        },
        button,
      ),
    );
  }

  const body = h('tbody', {});
  for (const row of shown) {
    const fixed = row.input !== null && row.output !== null;
    body.append(
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h('span', { class: 'model-name' }, row.name),
          h('span', { class: 'model-id' }, row.id),
        ),
        h('td', { class: 'left' }, row.provider),
        h('td', { class: 'num' }, contextLabel(row.context)),
        h('td', { class: 'num' }, money(row.input)),
        h('td', { class: 'num' }, money(row.output)),
        h(
          'td',
          { class: 'num managed' },
          fixed ? `${money(managed(row.input))} / ${money(managed(row.output))}` : 'varies',
        ),
      ),
    );
  }

  if (!shown.length) {
    host.replaceChildren(
      h(
        'div',
        { class: 'state' },
        h('h2', {}, 'No models match'),
        h('p', {}, 'Try a provider name such as "anthropic", or part of a model name.'),
      ),
    );
    return;
  }
  host.replaceChildren(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data-table' },
        h('caption', { class: 'sr-only' }, 'Models, context size and price per million tokens'),
        h('thead', {}, head),
        body,
      ),
    ),
  );
}

async function load(): Promise<void> {
  state('Loading the catalog…', 'Fetching the current list of models.');
  try {
    const res = await fetch('/api/catalog/models', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { data?: unknown };
    if (!Array.isArray(data.data)) throw new Error('shape');
    rows = (data.data as CatalogModel[]).map(toRow).filter((row): row is Row => row !== null);
  } catch {
    rows = [];
    state(
      "The catalog isn't available right now",
      'The model list could not be loaded. The models themselves are unaffected; try again in a moment.',
      true,
    );
    return;
  }
  if (!rows.length) {
    state('No models listed', 'The catalog came back empty. Try again in a moment.', true);
    return;
  }
  render();
}

search.addEventListener('input', () => {
  if (rows.length) render();
});
void load();
