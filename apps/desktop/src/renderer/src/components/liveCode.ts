import { useEffect, useMemo, useRef, useState } from 'react';
import { monaco } from '../monaco';
import { settle, type LiveAgent } from '../services/liveAgents';
import { TICK_MS, advance, itemsOf, keptPrefix, landedAt, worksIn } from './liveTyping';
import { useStore } from '../store';

const MAX_ZONE_LINES = 24;

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** One CSS class per agent: its color, and its name on the caret flag. */
function agentClass(agent: LiveAgent): string {
  // Keyed by what it shows, so a name or colour that arrives later gets its own rule.
  const cls = `kv-a-${hash(`${agent.key}|${agent.label}|${agent.color}`)}`;
  let style = document.getElementById('kv-agent-styles') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'kv-agent-styles';
    document.head.appendChild(style);
  }
  if (!style.textContent?.includes(`.${cls} `)) {
    const label = agent.label.replace(/["\\]/g, '');
    style.textContent += `.${cls} { --agent: ${agent.color}; }\n.kv-caret.${cls}::after { content: "${label}"; }\n`;
  }
  return cls;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

interface Zone {
  id: string;
  dom: HTMLDivElement;
  code: HTMLDivElement;
  afterLine: number;
  lines: number;
  version: number;
}

/** How long an edit that arrived stays highlighted once fully shown. */
const LANDED_MS = 5000;

/**
 * Shows the agents working in this file: a caret with a name flag where each one reads or
 * writes, the lines an edit replaces, and the new code typed out at a pace that can be
 * followed. An edit already in the file is revealed in place, letter by letter; one that
 * finished elsewhere (a swarm worker's copy, a teammate's machine) stays in its box, marked as
 * on its way, until it arrives here.
 */
export function useLiveAgents(
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>,
  path: string | null,
): void {
  const all = useStore((s) => s.liveAgents);
  // Every agent working on this file shows in it, whichever copy of the repository it works in: its typing as it goes,
  // and its finished edits until they arrive here.
  const here = useMemo(() => Object.values(all).filter((a) => worksIn(a, path)), [all, path]);
  const items = useMemo(() => here.flatMap((a) => itemsOf(a, path)), [here, path]);

  // Typing: how much of each edit is shown, at a steady pace, also after its tool has ended.
  const shown = useRef(new Map<string, number>());
  const landedSince = useRef(new Map<string, number>());
  // The file as it was before an edit arrived, so revealing it starts where it differs.
  const before = useRef(new Map<string, string>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const behind = items.some((i) => i.text && (shown.current.get(i.id) ?? 0) < i.text.length);
    const lingering = landedSince.current.size > 0;
    if (!behind && !lingering) return;
    const timer = setTimeout(
      () => {
        for (const i of items)
          if (i.text) shown.current.set(i.id, advance(shown.current.get(i.id) ?? 0, i.text.length));
        setTick((t) => t + 1);
      },
      behind ? TICK_MS : 500,
    );
    return () => clearTimeout(timer);
  }, [items, tick]);

  const decorations = useRef<{
    editor: monaco.editor.ICodeEditor;
    collection: monaco.editor.IEditorDecorationsCollection;
  } | null>(null);
  const zones = useRef(new Map<string, Zone>());

  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    if (decorations.current?.editor !== ed) {
      decorations.current = { editor: ed, collection: ed.createDecorationsCollection() };
      zones.current.clear();
    }
    const content = model.getValue();
    const marks: monaco.editor.IModelDeltaDecoration[] = [];
    const wantedZones = new Map<
      string,
      { afterLine: number; text: string; cls: string; note: string | null }
    >();
    const caret = (line: number, column: number, cls: string) =>
      marks.push({
        range: new monaco.Range(line, column, line, column),
        options: { beforeContentClassName: `kv-caret ${cls}`, stickiness: 1 },
      });
    const rangeOf = (from: number, to: number) => {
      const a = model.getPositionAt(from);
      const b = model.getPositionAt(to);
      return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    };

    for (const a of here) {
      const cls = agentClass(a);
      const reading = a.phase === 'reading' || a.path !== path;
      if (a.phase === 'reading' && a.path === path)
        caret(Math.min(a.line ?? 1, model.getLineCount()), 1, cls);
      const list = itemsOf(a, path);
      // Where each of its boxes sits, so a later edit of text still in a box goes below it.
      const boxLines: { text: string; afterLine: number }[] = [];
      for (const [n, item] of list.entries()) {
        const last = n === list.length - 1 && !reading;
        let count = shown.current.get(item.id) ?? 0;
        const landed = landedAt(content, item);
        if (landed < 0) before.current.set(item.id, content);

        // Already in the file: revealed in place up to what has been typed, then highlighted.
        if (landed >= 0 && item.text) {
          // What it kept of the file isn't typed again: start where it differs. Without a
          // before (it arrived while another file was open), a whole-file write just shows.
          const was = before.current.get(item.id);
          if (count < item.text.length && (was !== undefined || item.anchor === null)) {
            count = Math.max(
              count,
              was === undefined ? item.text.length : keptPrefix(was, landed, item.text),
            );
            shown.current.set(item.id, count);
          }
          before.current.delete(item.id);
          const upTo = landed + Math.min(count, item.text.length);
          const end = landed + item.text.length;
          if (upTo > landed)
            marks.push({ range: rangeOf(landed, upTo), options: { className: `kv-wrote ${cls}` } });
          if (upTo < end)
            marks.push({
              range: rangeOf(upTo, end),
              options: { inlineClassName: 'kv-unrevealed' },
            });
          if (count >= item.text.length) {
            const since = landedSince.current.get(item.id) ?? Date.now();
            landedSince.current.set(item.id, since);
            if (Date.now() - since > LANDED_MS) {
              landedSince.current.delete(item.id);
              if (item.pending) settle(item.agentKey, item.toolId);
              continue;
            }
          }
          if (last || upTo < end) {
            const p = model.getPositionAt(upTo);
            caret(p.lineNumber, p.column, cls);
          }
          continue;
        }

        // Being written, or written elsewhere: the lines it replaces, and the new code in a box
        // below them. Edits usually repeat the lines they keep: only what changes is typed.
        const full = item.text ?? '';
        const typed = item.done && !item.pending ? full : full.slice(0, count);
        const typedLines = typed.split('\n');
        let kept = 0;
        let afterLine = 0;
        const at = item.anchor ? content.indexOf(item.anchor) : -1;
        if (at >= 0 && item.anchor) {
          const anchorLines = item.anchor.split('\n');
          // Only finished lines count; the last one may still be being written.
          while (
            kept < anchorLines.length &&
            kept < typedLines.length - 1 &&
            anchorLines[kept] === typedLines[kept]
          )
            kept++;
          // A line still being written that so far matches the old one adds nothing yet.
          if (
            kept === typedLines.length - 1 &&
            kept < anchorLines.length &&
            anchorLines[kept]!.startsWith(typedLines[kept]!)
          )
            kept++;
          const start = model.getPositionAt(at);
          const end = model.getPositionAt(at + item.anchor.length);
          if (kept < anchorLines.length)
            marks.push({
              range: new monaco.Range(start.lineNumber + kept, 1, end.lineNumber, end.column),
              options: { className: `kv-replacing ${cls}` },
            });
          afterLine = end.lineNumber;
        } else if (item.anchor) {
          // Its anchor is text of an earlier edit still on its way: go below that box.
          afterLine = boxLines.findLast((b) => b.text.includes(item.anchor!))?.afterLine ?? 0;
        }
        const text = typedLines.slice(kept).join('\n');
        boxLines.push({ text: full, afterLine });
        if (item.text === null || text.length === 0) {
          if (last) caret(Math.max(1, afterLine || 1), 1, cls);
          continue;
        }
        const waiting = item.pending && count >= full.length;
        wantedZones.set(item.id, {
          afterLine,
          text,
          cls: `${cls}${waiting ? ' kv-pending' : ''}${last && !waiting ? ' kv-active' : ''}`,
          note: waiting ? `${a.name}'s edit · not in your copy yet, it arrives after checks` : null,
        });
      }
    }
    decorations.current.collection.set(marks);
    // Forget edits no longer shown.
    const live = new Set(items.map((i) => i.id));
    for (const id of shown.current.keys()) if (!live.has(id)) shown.current.delete(id);
    for (const id of landedSince.current.keys()) if (!live.has(id)) landedSince.current.delete(id);
    for (const id of before.current.keys()) if (!live.has(id)) before.current.delete(id);

    // View zones for the code being typed or on its way.
    const lineHeight = ed.getOption(monaco.editor.EditorOption.lineHeight);
    const language = model.getLanguageId();
    ed.changeViewZones((acc) => {
      for (const [key, z] of zones.current)
        if (!wantedZones.has(key) || wantedZones.get(key)!.afterLine !== z.afterLine) {
          acc.removeZone(z.id);
          zones.current.delete(key);
        }
      for (const [key, want] of wantedZones) {
        const lines = Math.min(MAX_ZONE_LINES, want.text.split('\n').length) + (want.note ? 1 : 0);
        let z = zones.current.get(key);
        if (!z) {
          const dom = document.createElement('div');
          const code = document.createElement('div');
          code.className = 'kv-typing-code';
          dom.appendChild(code);
          z = { id: '', dom, code, afterLine: want.afterLine, lines, version: 0 };
          z.id = acc.addZone({
            afterLineNumber: want.afterLine,
            heightInLines: lines,
            domNode: dom,
          });
          zones.current.set(key, z);
        } else if (z.lines !== lines) {
          acc.removeZone(z.id);
          z.id = acc.addZone({
            afterLineNumber: want.afterLine,
            heightInLines: lines,
            domNode: z.dom,
          });
          z.lines = lines;
        }
        z.dom.className = `kv-typing ${want.cls}`;
        // Plain text at once, colours when the tokenizer is done; the caret sits at the end.
        const version = ++z.version;
        const tail = want.cls.includes('kv-active')
          ? `<span class="kv-caret kv-caret-inline ${want.cls.split(' ')[0]}"></span>`
          : '';
        const note = want.note ? `<div class="kv-typing-note">${escapeHtml(want.note)}</div>` : '';
        const visible = want.text.split('\n').slice(-MAX_ZONE_LINES).join('\n');
        z.code.innerHTML = escapeHtml(visible).replace(/\n/g, '<br/>') + tail + note;
        z.code.style.lineHeight = `${lineHeight}px`;
        void monaco.editor.colorize(visible, language, {}).then((html) => {
          if (z.version !== version) return;
          z.code.innerHTML = html.replace(/(<br\/>)+$/, '') + tail + note;
        });
      }
    });
  }, [editorRef, here, items, tick, path]);

  // Leaving a file (or unmounting) clears its zones.
  useEffect(() => {
    const zs = zones.current;
    return () => {
      const ed = decorations.current?.editor;
      if (!ed) return;
      ed.changeViewZones((acc) => {
        for (const z of zs.values()) acc.removeZone(z.id);
      });
      zs.clear();
    };
  }, [path]);
}
