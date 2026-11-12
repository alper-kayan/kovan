import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Marked } from 'marked';
import type { Plugin } from 'vite';

/**
 * The site's build-time templating:
 *  - `<!--@head-->`, `<!--@nav-->`, `<!--@footer-->` are replaced with the shared partials, in the
 *    page's language (`<html lang="tr">` takes `nav.tr.html` and `footer.tr.html`);
 *  - `docs/index.html` is a template that becomes one page per `content/docs/*.md`, and
 *    `tr/docs/index.html` one page per `content/docs-tr/*.md` (same file names, Turkish text);
 *  - `<!--@changelog-->` is replaced with `content/changelog.md`.
 * A page with a version in the other language gets `hreflang` links to both, and the nav's
 * language switch (`__LANG_HREF__`) goes to its counterpart, or to the other home page.
 * Markdown is our own content, rendered here; nothing is rendered in the browser.
 */

type Locale = 'en' | 'tr';

interface DocPage {
  slug: string;
  title: string;
  description: string;
  html: string;
  headings: { id: string; text: string }[];
}

/** Where the site is published, for the absolute URLs `hreflang` links need. */
const SITE = 'https://kovan.alperkayan.dev';

const DOCS: Record<Locale, { dir: string; base: string; template: string }> = {
  en: { dir: 'content/docs', base: '/docs/', template: 'docs/index.html' },
  tr: { dir: 'content/docs-tr', base: '/tr/docs/', template: 'tr/docs/index.html' },
};

/** Pages other than the docs that also exist in Turkish, at `/tr` + the English path. */
const TRANSLATED_PAGES = new Set(['/', '/download/']);

const PAGER: Record<Locale, { prev: string; next: string }> = {
  en: { prev: 'Previous', next: 'Next' },
  tr: { prev: 'Önceki', next: 'Sonraki' },
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TURKISH_LETTERS: Record<string, string> = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
  â: 'a',
  î: 'i',
  û: 'u',
};

/** Heading ids: Turkish letters become their plain Latin ones, so "Giriş" is `#giris`. */
const slugify = (text: string) =>
  text
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (letter) => TURKISH_LETTERS[letter] ?? letter)
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

function loadDocs(root: string, locale: Locale): DocPage[] {
  const dir = join(root, DOCS[locale].dir);
  if (!existsSync(dir)) return [];
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

/** `<link rel="alternate" hreflang>` for a page that exists in both languages. */
function alternateLinks(en: string, tr: string): string {
  return [
    `<link rel="alternate" hreflang="en" href="${SITE}${en}" />`,
    `<link rel="alternate" hreflang="tr" href="${SITE}${tr}" />`,
    `<link rel="alternate" hreflang="x-default" href="${SITE}${en}" />`,
  ].join('\n');
}

/**
 * The page in the other language: its counterpart when there is one, the other home page when
 * not. `alternates` is the hreflang markup, empty when the page has no counterpart.
 */
function counterpart(
  path: string,
  locale: Locale,
  hasPair: (enPath: string) => boolean,
  fallback = { en: '/', tr: '/tr/' },
): { href: string; alternates: string } {
  if (locale === 'tr') {
    const en = path.replace(/^\/tr\//, '/');
    return hasPair(en)
      ? { href: en, alternates: alternateLinks(en, path) }
      : { href: fallback.en, alternates: '' };
  }
  return hasPair(path)
    ? { href: `/tr${path}`, alternates: alternateLinks(path, `/tr${path}`) }
    : { href: fallback.tr, alternates: '' };
}

/** Fills in the language switch and the hreflang links (left as markers by the partials). */
const fillLanguage = (html: string, other: { href: string; alternates: string }) =>
  html.replaceAll('__LANG_HREF__', other.href).replace('<!--@alternates-->', other.alternates);

function renderDoc(
  template: string,
  locale: Locale,
  pages: DocPage[],
  page: DocPage,
  otherSlugs: Set<string>,
): string {
  const base = DOCS[locale].base;
  const index = pages.indexOf(page);
  const sidebar = pages
    .map((p) => {
      const current = p === page ? ' aria-current="page"' : '';
      return `<li><a href="${base}${p.slug}/"${current}>${escapeHtml(p.title)}</a></li>`;
    })
    .join('\n');
  const toc = page.headings
    .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('\n');
  const words = PAGER[locale];
  const link = (p: DocPage | undefined, rel: 'prev' | 'next') =>
    p
      ? `<a class="docs-pager-link docs-pager-${rel}" rel="${rel}" href="${base}${p.slug}/"><span>${words[rel]}</span>${escapeHtml(p.title)}</a>`
      : '<span></span>';
  const pager = `${link(pages[index - 1], 'prev')}${link(pages[index + 1], 'next')}`;
  const path = `${base}${page.slug}/`;
  const other = counterpart(
    path,
    locale,
    (en) => otherSlugs.has(en.slice(DOCS.en.base.length, -1)),
    { en: DOCS.en.base, tr: DOCS.tr.base },
  );
  return fillLanguage(template, other)
    .replaceAll('__DOC_TITLE__', escapeHtml(page.title))
    .replaceAll('__DOC_DESCRIPTION__', escapeHtml(page.description))
    .replaceAll('__DOC_SLUG__', page.slug)
    .replace('<!--@docs:sidebar-->', sidebar)
    .replace('<!--@docs:toc-->', toc)
    .replace('<!--@docs:content-->', page.html)
    .replace('<!--@docs:pager-->', pager);
}

/** Renders every docs page of one language from that language's template. */
function renderDocs(root: string, locale: Locale, template: string) {
  const pages = loadDocs(root, locale);
  const otherSlugs = new Set(loadDocs(root, locale === 'en' ? 'tr' : 'en').map((p) => p.slug));
  return pages.map((page) => ({
    page,
    html: renderDoc(template, locale, pages, page, otherSlugs),
  }));
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

/** "/tr/download/index.html" → "/tr/download/"; "/404.html" stays as it is. */
const pagePath = (file: string) => {
  const path = `/${file.replace(/^\/+/, '').split('?')[0] ?? ''}`;
  return path.endsWith('/index.html') ? path.slice(0, -'index.html'.length) : path;
};

const DOCS_URL = /^(\/tr)?\/docs\/([a-z0-9-]+)\/?(\?.*)?$/;

export function sitePlugin(root: string): Plugin {
  const partial = (name: string) => readFileSync(join(root, 'src/partials', name), 'utf8');

  return {
    name: 'kovan-site',
    enforce: 'post',

    configureServer(server) {
      // In dev every /docs/<slug>/ is the one template, filled in by transformIndexHtml below.
      server.middlewares.use((req, _res, next) => {
        const match = req.url ? DOCS_URL.exec(req.url) : null;
        if (match) req.url = `${match[1] ?? ''}/docs/index.html`;
        next();
      });
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const locale: Locale = /<html[^>]*\slang="tr"/.test(html) ? 'tr' : 'en';
        const suffix = locale === 'tr' ? '.tr' : '';
        let out = html
          .replace('<!--@head-->', `${partial('head.html')}<!--@alternates-->`)
          .replace('<!--@nav-->', partial(`nav${suffix}.html`))
          .replace('<!--@footer-->', partial(`footer${suffix}.html`));
        if (out.includes('<!--@changelog-->'))
          out = out.replace('<!--@changelog-->', renderChangelog(root));
        if (out.includes('<!--@docs:content-->')) {
          // Docs pages are filled in per page: here in dev, in generateBundle for a build.
          if (!ctx.server) return out;
          const slug = DOCS_URL.exec(ctx.originalUrl ?? '')?.[2];
          const rendered = renderDocs(root, locale, out);
          return (rendered.find((r) => r.page.slug === slug) ?? rendered[0])?.html ?? out;
        }
        const path = pagePath(ctx.path);
        return fillLanguage(
          out,
          counterpart(path, locale, (en) => TRANSLATED_PAGES.has(en)),
        );
      },
    },

    // In a build each template is fanned out after Vite has put the hashed assets into it.
    generateBundle(_options, bundle) {
      for (const locale of ['en', 'tr'] as const) {
        const { template: name, base } = DOCS[locale];
        const template = bundle[name];
        if (!template || template.type !== 'asset') continue;
        const rendered = renderDocs(root, locale, String(template.source));
        for (const { page, html } of rendered) {
          this.emitFile({
            type: 'asset',
            fileName: `${base.slice(1)}${page.slug}/index.html`,
            source: html,
          });
        }
        if (rendered[0]) template.source = rendered[0].html;
      }
    },
  };
}
