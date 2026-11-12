/**
 * The app in another language without every string going through `t()`: while it isn't
 * English, text on screen (and the title, placeholder and aria-label attributes) that the
 * catalog has word for word is swapped for its translation as React draws it. React only writes
 * a text again when its own value changes, so a swapped text stays until the English changes,
 * and then it is swapped again. What people and agents write (the editor, the terminal, chats,
 * comments, file names) is left alone.
 */
const ATTRS = ['title', 'placeholder', 'aria-label'] as const;

/** Where text is content, not the app's own words. */
const SKIP =
  '.monaco-editor, .xterm, .agent-text, .prompt-text, .reasoning, .tool-output, .approval-detail, .comment-body, .note-text, .tree-name, .mono, code, pre, [data-no-translate], textarea, input';

/** Keys taken from JSX source may carry HTML entities; the screen shows the characters. */
const ENTITIES: Record<string, string> = {
  '&apos;': "'",
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&hellip;': '…',
  '&nbsp;': ' ',
};
const decode = (text: string) => text.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);

export function installDomTranslation(source: Readonly<Record<string, string>>): () => void {
  const catalog: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) catalog[decode(key)] = decode(value);
  const translate = (raw: string): string | null => {
    const text = raw.trim();
    if (!text) return null;
    const hit = catalog[text];
    if (!hit || hit === text) return null;
    // Keep the spaces around it: JSX puts words of one sentence in separate text nodes.
    const lead = raw.slice(0, raw.indexOf(text));
    const tail = raw.slice(raw.indexOf(text) + text.length);
    return lead + hit + tail;
  };

  const skipped = (el: Element | null) => !el || el.closest(SKIP) !== null;

  const doText = (node: Text) => {
    if (skipped(node.parentElement)) return;
    const next = translate(node.data);
    if (next !== null && next !== node.data) node.data = next;
  };

  const doElement = (el: Element) => {
    if (el.closest('.monaco-editor, .xterm, [data-no-translate]')) return;
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const next = translate(value);
      if (next !== null && next !== value) el.setAttribute(name, next);
    }
  };

  const walk = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const el = root as Element;
    if (el.matches('.monaco-editor, .xterm')) return;
    doElement(el);
    const texts = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = texts.nextNode(); n; n = texts.nextNode()) doText(n as Text);
    for (const child of el.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) doElement(child);
  };

  walk(document.body);
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') doText(r.target as Text);
      else if (r.type === 'attributes') doElement(r.target as Element);
      else for (const n of r.addedNodes) walk(n);
    }
  });
  watch.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
  return () => watch.disconnect();
}
