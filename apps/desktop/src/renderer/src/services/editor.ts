import { monaco } from '../monaco';
import { getState, reportError, setState, toast, updateTab, type Tab } from '../store';
import { api } from './api';
import { refreshGitStatus } from './git';

interface OpenModel {
  model: monaco.editor.ITextModel;
  /** Alternative version id at the last load or save; differs from the current one when dirty. */
  savedVersion: number;
  listener: monaco.IDisposable;
  /** The file changed on disk (a teammate's synced change) while this buffer had unsaved edits. */
  diskChanged?: boolean;
}

const models = new Map<string, OpenModel>();
/** A line to reveal once a file's editor is showing (from "path:line" links). */
const pendingReveal = new Map<string, number>();

export function takePendingReveal(path: string): number | undefined {
  const line = pendingReveal.get(path);
  pendingReveal.delete(path);
  return line;
}
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

const fileTabId = (path: string) => `file:${path}`;
const diffTabId = (path: string, staged: boolean) => `diff:${staged ? 'staged' : 'work'}:${path}`;
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function uriFor(path: string): monaco.Uri {
  const root = getState().workspace?.root ?? '';
  return monaco.Uri.file(`${root}/${path}`);
}

function isDirty(entry: OpenModel): boolean {
  return entry.model.getAlternativeVersionId() !== entry.savedVersion;
}

function syncDirty(path: string): void {
  const entry = models.get(path);
  if (!entry) return;
  const dirty = isDirty(entry);
  const tab = getState().tabs.find((t) => t.id === fileTabId(path));
  if (tab?.kind === 'file' && tab.dirty !== dirty) updateTab(tab.id, { dirty });
}

function createModel(path: string, content: string): OpenModel {
  const model = monaco.editor.createModel(content, undefined, uriFor(path));
  const entry: OpenModel = {
    model,
    savedVersion: model.getAlternativeVersionId(),
    listener: model.onDidChangeContent(() => syncDirty(path)),
  };
  models.set(path, entry);
  return entry;
}

export function getModel(path: string): monaco.editor.ITextModel | null {
  return models.get(path)?.model ?? null;
}

/** Loads a file's text model, reading it from disk if it isn't open yet. */
export async function ensureModel(path: string): Promise<monaco.editor.ITextModel | null> {
  const existing = models.get(path);
  if (existing) return existing.model;
  const file = await api.invoke('fs:readFile', path);
  if (file.kind !== 'text') return null;
  return (models.get(path) ?? createModel(path, file.content)).model;
}

function activate(tab: Tab): void {
  setState((s) => ({
    tabs: s.tabs.some((t) => t.id === tab.id) ? s.tabs : [...s.tabs, tab],
    activeTabId: tab.id,
  }));
}

export async function openFile(path: string, line?: number): Promise<void> {
  setState({ view: 'workspace', lastAppView: 'workspace' });
  if (line) pendingReveal.set(path, line);
  const id = fileTabId(path);
  const existing = getState().tabs.find((t) => t.id === id);
  if (existing) {
    setState({ activeTabId: id });
    return;
  }
  try {
    // A file only an agent has (written in its own copy): its draft, read-only, until it arrives here.
    const draft = getState().agentFiles[path]?.some((m) => m.text !== null);
    const onDisk = models.has(path) || !draft ? true : await fileExists(path);
    if (!onDisk) {
      openDraft(path);
      return;
    }
    const file = models.has(path) ? null : await api.invoke('fs:readFile', path);
    if (file && file.kind !== 'text') {
      activate({ id, kind: 'file', path, title: basename(path), dirty: false, content: file.kind });
      return;
    }
    if (file && !models.has(path)) createModel(path, file.content);
    activate({ id, kind: 'file', path, title: basename(path), dirty: false, content: 'text' });
    syncDirty(path);
  } catch (error) {
    reportError(error);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await api.invoke('fs:readFile', path);
    return true;
  } catch {
    return false;
  }
}

/** An agent's new file that isn't in this checkout yet, read-only (see DraftFileView). */
export function openDraft(path: string): void {
  setState({ view: 'workspace', lastAppView: 'workspace' });
  activate({ id: `draft:${path}`, kind: 'draft', path, title: `${basename(path)} (new)` });
}

/**
 * A file of a session that runs on a registered machine: not in this checkout, so it opens
 * read-only from the session's branch on the remote (as far as the machine has pushed it).
 */
export function openBranchFile(
  at: { workspaceId: string; branch: string; where: string },
  path: string,
  line?: number,
): void {
  setState({ view: 'workspace', lastAppView: 'workspace' });
  const clean = path.replace(/^\.\//, '');
  activate({
    id: `branch:${at.branch}:${clean}`,
    kind: 'branch',
    path: clean,
    title: `${basename(clean)} (${at.branch})`,
    ...at,
    ...(line ? { line } : {}),
  });
}

export function openDiff(path: string, staged: boolean): void {
  setState({ view: 'workspace', lastAppView: 'workspace' });
  activate({
    id: diffTabId(path, staged),
    kind: 'diff',
    path,
    staged,
    title: `${basename(path)} (${staged ? 'staged' : 'working tree'})`,
  });
}

/** Compares a teammate's kept version of a file with yours ("2 versions"). */
export function openVersion(path: string, version: { id: string; peerName: string }): void {
  setState({ view: 'workspace', lastAppView: 'workspace' });
  activate({
    id: `version:${version.id}`,
    kind: 'diff',
    path,
    staged: false,
    version: version.id,
    title: `${basename(path)} (${version.peerName}'s ↔ yours)`,
  });
}

export async function saveFile(path: string): Promise<void> {
  const entry = models.get(path);
  if (!entry) return;
  try {
    // Never drop a teammate's change that synced in under unsaved edits: keep it beside yours.
    if (entry.diskChanged && getState().sync) {
      await api.invoke('sync:keepDisk', path);
      toast(
        `${basename(path)} changed on disk while you edited; that version is kept as "2 versions".`,
      );
    }
    entry.diskChanged = false;
    await api.invoke('fs:writeFile', path, entry.model.getValue());
    entry.savedVersion = entry.model.getAlternativeVersionId();
    syncDirty(path);
    void refreshGitStatus();
  } catch (error) {
    reportError(error);
  }
}

export async function saveActive(): Promise<void> {
  const { tabs, activeTabId } = getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab?.kind === 'file' || tab?.kind === 'diff') await saveFile(tab.path);
}

/** Drops a file's model once no tab (file or working-tree diff) shows it anymore. */
function releaseModelIfUnused(path: string): void {
  const stillUsed = getState().tabs.some(
    (t) =>
      (t.kind === 'file' && t.path === path) || (t.kind === 'diff' && !t.staged && t.path === path),
  );
  if (stillUsed) return;
  const entry = models.get(path);
  entry?.listener.dispose();
  entry?.model.dispose();
  models.delete(path);
  viewStates.delete(path);
}

export function closeTab(id: string): void {
  const { tabs, activeTabId } = getState();
  const index = tabs.findIndex((t) => t.id === id);
  const tab = tabs[index];
  if (!tab) return;
  const entry = models.get(tab.path);
  const otherTabUsesModel = tabs.some(
    (t) =>
      t.id !== id && (t.kind === 'file' || (t.kind === 'diff' && !t.staged)) && t.path === tab.path,
  );
  const losesEdits = entry !== undefined && isDirty(entry) && !otherTabUsesModel;
  if (losesEdits && !window.confirm(`${tab.title} has unsaved changes. Close it anyway?`)) {
    return;
  }
  const remaining = tabs.filter((t) => t.id !== id);
  const nextActive =
    activeTabId === id
      ? (remaining[Math.min(index, remaining.length - 1)]?.id ?? null)
      : activeTabId;
  setState({ tabs: remaining, activeTabId: nextActive });
  releaseModelIfUnused(tab.path);
}

export function closeActiveTab(): void {
  const { activeTabId } = getState();
  if (activeTabId) closeTab(activeTabId);
}

export function saveViewState(
  path: string,
  state: monaco.editor.ICodeEditorViewState | null,
): void {
  viewStates.set(path, state);
}

export function getViewState(path: string): monaco.editor.ICodeEditorViewState | null {
  return viewStates.get(path) ?? null;
}

/**
 * Reloads open files that changed on disk. Files with unsaved edits are left alone and the
 * person is told; real conflict handling arrives with live sync.
 */
export async function reloadChangedFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    const entry = models.get(path);
    if (!entry) continue;
    let file;
    try {
      file = await api.invoke('fs:readFile', path);
    } catch {
      continue; // Deleted: keep the buffer so nothing is lost.
    }
    if (file.kind !== 'text' || file.content === entry.model.getValue()) continue;
    if (isDirty(entry)) {
      entry.diskChanged = true;
      toast(`${basename(path)} changed on disk; your unsaved edits were kept.`);
      continue;
    }
    // Replace through an edit so undo still works.
    entry.model.pushEditOperations(
      [],
      [{ range: entry.model.getFullModelRange(), text: file.content }],
      () => null,
    );
    entry.savedVersion = entry.model.getAlternativeVersionId();
    syncDirty(path);
  }
}

/** Forgets every model, e.g. when another workspace is opened. */
export function resetEditor(): void {
  for (const entry of models.values()) {
    entry.listener.dispose();
    entry.model.dispose();
  }
  models.clear();
  viewStates.clear();
  setState({ tabs: [], activeTabId: null });
}

export function hasUnsavedChanges(): boolean {
  return [...models.values()].some(isDirty);
}
