import type { Comment, Memory } from '@kovan/shared';
import { useEffect, useRef } from 'react';
import type { Settings } from '../../../shared/settings';
import { monaco } from '../monaco';
import { getModel, getViewState, saveViewState, takePendingReveal } from '../services/editor';
import { activeTeamWorkspace, toast, useStore } from '../store';
import { api } from '../services/api';
import { startCodeComment } from './Comments';
import { useLiveAgents } from './liveCode';

const NO_COMMENTS: Comment[] = [];
const NO_NOTES: Memory[] = [];

/** "Comment" on the selected lines (or the cursor's line); the dialog does the rest. */
export function addCommentAction(
  editor: monaco.editor.IStandaloneCodeEditor,
  path: () => string | null,
  kind: 'file' | 'hunk',
): monaco.IDisposable {
  return editor.addAction({
    id: 'kovan.comment',
    label: 'Comment on these lines',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyM],
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 0,
    run: async (ed) => {
      const file = path();
      const model = ed.getModel();
      const selection = ed.getSelection();
      if (!file || !model || !selection) return;
      const start = selection.startLineNumber;
      // A selection that ends at column 1 doesn't include that line.
      const end =
        selection.endColumn === 1 && selection.endLineNumber > start
          ? selection.endLineNumber - 1
          : selection.endLineNumber;
      const snippet = model
        .getLinesContent()
        .slice(start - 1, end)
        .map((l) => l.trimEnd())
        .join('\n');
      const commit = await api.invoke('git:head').catch(() => null);
      if (!startCodeComment(file, start, end, snippet, kind, commit))
        toast('Comments are shared with your team: open a shared workspace to comment.', 'error');
    },
  });
}

/** Gutter marks for open comments and Brain notes on this file, with the text on hover. */
export function useCodeMarks(
  editor: React.MutableRefObject<monaco.editor.ICodeEditor | null>,
  path: string | null,
): void {
  const ws = useStore(activeTeamWorkspace);
  const comments = useStore((s) => (ws ? (s.comments[ws.id] ?? NO_COMMENTS) : NO_COMMENTS));
  const notes = useStore((s) => (ws ? (s.memories[ws.id] ?? NO_NOTES) : NO_NOTES));
  // Bound to the editor it was made on: the editor can be recreated (StrictMode, remounts).
  const decorations = useRef<{
    editor: monaco.editor.ICodeEditor;
    collection: monaco.editor.IEditorDecorationsCollection;
  } | null>(null);
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    if (decorations.current?.editor !== ed)
      decorations.current = { editor: ed, collection: ed.createDecorationsCollection() };
    const marks: monaco.editor.IModelDeltaDecoration[] = [];
    for (const c of comments) {
      const a = c.anchor;
      if (
        c.parentId ||
        c.status !== 'open' ||
        (a.kind !== 'file' && a.kind !== 'hunk') ||
        a.path !== path
      )
        continue;
      marks.push({
        range: new monaco.Range(a.startLine, 1, a.endLine, 1),
        options: {
          isWholeLine: true,
          className: 'kv-comment-line',
          glyphMarginClassName: 'kv-comment-glyph',
          glyphMarginHoverMessage: {
            value: `**${c.authorName}**${c.kind === 'suggestion' ? ' suggests' : ''}${c.outdated ? ' *(outdated)*' : ''}: ${c.body}`,
          },
        },
      });
    }
    for (const n of notes) {
      if (n.path !== path || !n.startLine) continue;
      marks.push({
        range: new monaco.Range(n.startLine, 1, n.endLine ?? n.startLine, 1),
        options: {
          glyphMarginClassName: n.status === 'flagged' ? 'kv-note-glyph flagged' : 'kv-note-glyph',
          glyphMarginHoverMessage: {
            value: `**Brain · ${n.kind}**${n.status === 'flagged' ? ` *(flagged: ${n.flagReason ?? 'the code changed'})*` : ''}: ${n.text}`,
          },
        },
      });
    }
    decorations.current.collection.set(marks);
  }, [editor, path, comments, notes]);
}

export function editorOptions(
  settings: Settings,
): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  return {
    fontFamily: settings.editorFontFamily,
    fontSize: settings.editorFontSize,
    tabSize: settings.editorTabSize,
    wordWrap: settings.editorWordWrap ? 'on' : 'off',
    minimap: { enabled: settings.editorMinimap },
  };
}

/** One Monaco editor that swaps models as file tabs change, keeping each file's scroll and cursor. */
export function CodeEditor({ path }: { path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const currentPath = useRef<string | null>(null);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, {
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      fontLigatures: true,
      padding: { top: 8 },
      glyphMargin: true,
      ...editorOptions(useStore.getState().settings),
    });
    editor.current = instance;
    const action = addCommentAction(instance, () => currentPath.current, 'file');
    return () => {
      action.dispose();
      if (currentPath.current) saveViewState(currentPath.current, instance.saveViewState());
      instance.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    if (currentPath.current && currentPath.current !== path) {
      saveViewState(currentPath.current, instance.saveViewState());
    }
    const model = getModel(path);
    instance.setModel(model);
    currentPath.current = path;
    const view = getViewState(path);
    if (view) instance.restoreViewState(view);
    const line = takePendingReveal(path);
    if (line) {
      instance.revealLineInCenter(line);
      instance.setPosition({ lineNumber: line, column: 1 });
    }
    instance.focus();
  }, [path]);

  useEffect(() => {
    editor.current?.updateOptions(editorOptions(settings));
  }, [settings]);

  useCodeMarks(editor, path);
  useLiveAgents(editor, path);

  return <div className="monaco-host" ref={host} />;
}
