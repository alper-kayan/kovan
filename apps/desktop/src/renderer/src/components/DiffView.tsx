import { useEffect, useRef, useState } from 'react';
import { monaco } from '../monaco';
import { api } from '../services/api';
import { ensureModel } from '../services/editor';
import { useStore } from '../store';
import { addCommentAction, editorOptions } from './CodeEditor';

let snapshotCounter = 0;

function snapshotModel(content: string, path: string, side: string): monaco.editor.ITextModel {
  // A unique URI per snapshot; the file name at the end still drives language detection.
  const uri = monaco.Uri.parse(`kovan-diff:/${side}/${++snapshotCounter}/${path}`);
  return monaco.editor.createModel(content, undefined, uri);
}

function setIfChanged(model: monaco.editor.ITextModel, content: string): void {
  if (model.getValue() !== content) model.setValue(content);
}

/**
 * Side-by-side diff. Working-tree diffs edit the real file model (so edits here are the same as
 * in the file's tab); staged diffs are read-only snapshots. Models are kept for the life of the
 * view and only their text is refreshed, so scroll position survives status updates.
 */
export function DiffView({
  path,
  staged,
  version,
}: {
  path: string;
  staged: boolean;
  /** Compare a teammate's kept version (left) with your file (right). */
  version?: string | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.gitStatus);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const owned = useRef<{
    original: monaco.editor.ITextModel | null;
    modified: monaco.editor.ITextModel | null;
  }>({
    original: null,
    modified: null,
  });

  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.createDiffEditor(host.current, {
      automaticLayout: true,
      readOnly: staged,
      originalEditable: false,
      renderSideBySide: true,
      ...editorOptions(useStore.getState().settings),
    });
    editorRef.current = instance;
    const models = owned.current;
    // Comments on a diff are pinned to the changed (right) side.
    const action = addCommentAction(instance.getModifiedEditor(), () => path, 'hunk');
    return () => {
      action.dispose();
      instance.setModel(null);
      instance.dispose();
      models.original?.dispose();
      models.modified?.dispose();
      models.original = null;
      models.modified = null;
      editorRef.current = null;
    };
  }, [path, staged]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sides = version
          ? { original: (await api.invoke('sync:version', version)) ?? '', modified: null }
          : await api.invoke('git:diffSides', path, staged);
        const instance = editorRef.current;
        if (cancelled || !instance) return;
        const models = owned.current;

        if (models.original) setIfChanged(models.original, sides.original);
        else models.original = snapshotModel(sides.original, path, 'original');

        let modified: monaco.editor.ITextModel | null = null;
        if (sides.modified !== null) {
          if (models.modified) setIfChanged(models.modified, sides.modified);
          else models.modified = snapshotModel(sides.modified, path, 'modified');
          modified = models.modified;
        } else {
          modified = await ensureModel(path).catch(() => null);
          if (cancelled) return;
          if (!modified) {
            // Deleted from the working tree: compare against empty.
            models.modified ??= snapshotModel('', path, 'deleted');
            modified = models.modified;
          }
        }

        const current = instance.getModel();
        if (current?.original !== models.original || current?.modified !== modified) {
          instance.setModel({ original: models.original, modified });
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, staged, status, version]);

  useEffect(() => {
    editorRef.current?.updateOptions(editorOptions(settings));
  }, [settings]);

  return (
    <div className="diff-wrapper">
      {error && <div className="diff-error">{error}</div>}
      <div className="monaco-host" ref={host} />
    </div>
  );
}
