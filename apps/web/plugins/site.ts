import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';
import type { Plugin } from 'vite';

/**
 * The site's build-time templating:
 *  - `<!--@head-->`, `<!--@nav-->`, `<!--@footer-->` are replaced with the shared partials;
 *  - `docs/index.html` is a template that becomes one page per `content/docs/*.md`;
 *  - `<!--@changelog-->` is replaced with `content/changelog.md`.
 * Markdown is our own content, rendered here; nothing is rendered in the browser.
 */

interface DocPage {
  slug: string;
  title: string;
  description: string;
  html: string;
  headings: { id: string; text: string }[];
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function renderMarkdown(source: string): { html: string; headings: DocPage['headings'] } {
  const headings: DocPage['headings'] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 1) return `<h1>${inner}</h1>\n`;
        const id = slugify(token.text);
        if (token.depth === 2) headings.push({ id, text: token.text });
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      table(token) {
        const cells = (row: typeof token.header, tag: 'th' | 'td') =>
          row.map((cell) => `<${tag}>${this.parser.parseInline(cell.tokens)}</${tag}>`).join('');
        const head = `<thead><tr>${cells(token.header, 'th')}</tr></thead>`;
        const body = token.rows.map((row) => `<tr>${cells(row, 'td')}</tr>`).join('');
        return `<div class="table-scroll"><table>${head}<tbody>${body}</tbody></table></div>\n`;
      },
    },
  });
  return { html: marked.parse(source, { async: false }), headings };
}

function loadDocs(root: string): DocPage[] {
  const dir = join(root, 'content/docs');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const source = readFileSync(join(dir, name), 'utf8');
      const title = /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ?? name;
      // The first paragraph doubles as the page description.
      const lead = /^(?!#)(\S.+)$/m.exec(source.replace(/^#\s+.+$/m, ''))?.[1] ?? '';
      return {
        slug: name.replace(/^\d+-/, '').replace(/\.md$/, ''),
        title,
        description: lead.replace(/[*_`[\]]/g, '').slice(0, 180),
        ...renderMarkdown(source),
      };
    });
}

function renderDoc(template: string, pages: DocPage[], page: DocPage): string {
  const index = pages.indexOf(page);
  const sidebar = pages
    .map((p) => {
      const current = p === page ? ' aria-current="page"' : '';
      return `<li><a href="/docs/${p.slug}/"${current}>${escapeHtml(p.title)}</a></li>`;
    })
    .join('\n');
  const toc = page.headings
    .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('\n');
  const link = (p: DocPage | undefined, rel: 'prev' | 'next') =>
    p
      ? `<a class="docs-pager-link docs-pager-${rel}" rel="${rel}" href="/docs/${p.slug}/"><span>${rel === 'prev' ? 'Previous' : 'Next'}</span>${escapeHtml(p.title)}</a>`
      : '<span></span>';
  const pager = `${link(pages[index - 1], 'prev')}${link(pages[index + 1], 'next')}`;
  return template
    .replaceAll('__DOC_TITLE__', escapeHtml(page.title))
    .replaceAll('__DOC_DESCRIPTION__', escapeHtml(page.description))
    .replaceAll('__DOC_SLUG__', page.slug)
    .replace('<!--@docs:sidebar-->', sidebar)
    .replace('<!--@docs:toc-->', toc)
    .replace('<!--@docs:content-->', page.html)
    .replace('<!--@docs:pager-->', pager);
}

/** `## 0.1.0 · 2026-10-13` starts a release; everything up to the next one is its notes. */
function renderChangelog(root: string): string {
  const source = readFileSync(join(root, 'content/changelog.md'), 'utf8');
  return source
    .split(/^##\s+/m)
    .slice(1)
    .map((entry) => {
      const [heading = '', ...rest] = entry.split('\n');
      const [version = '', date = ''] = heading.split('·').map((part) => part.trim());
      const { html } = renderMarkdown(rest.join('\n'));
      return `<article class="release" id="v${escapeHtml(version)}">
<header class="release-head"><h2>${escapeHtml(version)}</h2><time datetime="${escapeHtml(date)}">${escapeHtml(date)}</time></header>
<div class="prose">${html}</div>
</article>`;
    })
    .join('\n');
}

export function sitePlugin(root: string): Plugin {
  const partial = (name: string) => readFileSync(join(root, 'src/partials', name), 'utf8');
  const DOCS_TEMPLATE = 'docs/index.html';

  return {
    name: 'kovan-site',
    enforce: 'post',

    configureServer(server) {
      // In dev every /docs/<slug>/ is the one template, filled in by transformIndexHtml below.
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/docs\/[a-z0-9-]+\/?(\?.*)?$/.test(req.url)) req.url = '/docs/index.html';
        next();
      });
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        let out = html
          .replace('<!--@head-->', partial('head.html'))
          .replace('<!--@nav-->', partial('nav.html'))
          .replace('<!--@footer-->', partial('footer.html'));
        if (out.includes('<!--@changelog-->'))
          out = out.replace('<!--@changelog-->', renderChangelog(root));
        if (ctx.server && out.includes('<!--@docs:content-->')) {
          const pages = loadDocs(root);
          const slug = /^\/docs\/([a-z0-9-]+)/.exec(ctx.originalUrl ?? '')?.[1];
          const page = pages.find((p) => p.slug === slug) ?? pages[0];
          if (page) out = renderDoc(out, pages, page);
        }
        return out;
      },
    },

    // In a build the template is fanned out after Vite has put the hashed assets into it.
    generateBundle(_options, bundle) {
      const template = bundle[DOCS_TEMPLATE];
      if (!template || template.type !== 'asset') return;
      const html = String(template.source);
      const pages = loadDocs(root);
      for (const page of pages) {
        this.emitFile({
          type: 'asset',
          fileName: `docs/${page.slug}/index.html`,
          source: renderDoc(html, pages, page),
        });
      }
      if (pages[0]) template.source = renderDoc(html, pages, pages[0]);
    },
  };
}
