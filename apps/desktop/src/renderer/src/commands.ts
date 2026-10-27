import { findCommand, resolveKeybindings } from '../../shared/keybindings';
import { api } from './services/api';
import { setDraft, stopAgent } from './services/agent';
import { closeActiveTab, saveActive } from './services/editor';
import { refreshGitStatus } from './services/git';
import { newTerminal, toggleTerminal } from './services/terminal';
import { openWorkspaceDialog } from './services/workspace';
import { getState, setState, showView, writeLocal, type RightTab } from './store';

export interface Command {
  id: string;
  title: string;
  /** Only offered while this returns true. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const hasWorkspace = () => getState().workspace !== null;

/** Shows a tab of the right panel, or hides the panel when that tab is already showing. */
export function toggleRightTab(tab: RightTab): void {
  const { view, agentOpen, rightTab } = getState();
  const showing = view === 'workspace' && agentOpen && rightTab === tab;
  setState({ agentOpen: !showing, rightTab: tab });
  writeLocal('kovan.agentOpen', !showing);
  writeLocal('kovan.rightTab', tab);
  showView('workspace');
  if (tab === 'git' && !showing) void refreshGitStatus();
}

function toggleNav(): void {
  const navCollapsed = !getState().navCollapsed;
  setState({ navCollapsed });
  writeLocal('kovan.navCollapsed', navCollapsed);
}

export const COMMANDS: Command[] = [
  {
    id: 'palette.commands',
    title: 'Show All Commands',
    run: () => setState({ palette: 'commands' }),
  },
  {
    id: 'palette.files',
    title: 'Go to File…',
    when: hasWorkspace,
    run: () => setState({ palette: 'files' }),
  },
  { id: 'workspace.open', title: 'Open Repository…', run: openWorkspaceDialog },
  { id: 'go.sessions', title: 'Go to Sessions', run: () => showView('sessions') },
  { id: 'go.people', title: 'Go to People', run: () => showView('people') },
  { id: 'go.agents', title: 'Go to Agents', run: () => showView('agents') },
  {
    id: 'go.workspace',
    title: 'Go to Editor',
    when: hasWorkspace,
    run: () => showView('workspace'),
  },
  {
    id: 'gettingStarted.open',
    title: 'Getting Started',
    run: () => setState({ gettingStartedOpen: true }),
  },
  { id: 'file.save', title: 'Save', when: hasWorkspace, run: saveActive },
  {
    id: 'tab.close',
    title: 'Close Tab',
    when: () => getState().activeTabId !== null,
    run: closeActiveTab,
  },
  {
    id: 'view.explorer',
    title: 'Toggle Explorer',
    when: hasWorkspace,
    run: () => toggleRightTab('explorer'),
  },
  {
    id: 'view.git',
    title: 'Toggle Source Control',
    when: hasWorkspace,
    run: () => toggleRightTab('git'),
  },
  { id: 'view.toggleSidebar', title: 'Toggle Sidebar', run: toggleNav },
  { id: 'view.toggleTerminal', title: 'Toggle Terminal', run: toggleTerminal },
  {
    id: 'view.agent',
    title: 'Toggle Agent',
    when: hasWorkspace,
    run: () => toggleRightTab('agents'),
  },
  {
    id: 'agent.stop',
    title: 'Stop Agent',
    when: () => getState().conversation?.running === true,
    run: stopAgent,
  },
  {
    id: 'agent.issue',
    title: 'Create GitHub Issue…',
    when: hasWorkspace,
    // The agent drafts it from what you describe; the card then lets you edit and approve.
    run: () => {
      const key = getState().conversation?.id ?? 'new';
      if (!getState().drafts[key]?.trim()) setDraft(key, 'Open a GitHub issue for: ');
      setState({ agentOpen: true, rightTab: 'agents' });
      showView('workspace');
      setTimeout(() => document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus(), 50);
    },
  },
  { id: 'terminal.new', title: 'New Terminal', run: newTerminal },
  { id: 'settings.open', title: 'Open Settings', run: () => showView('settings') },
  { id: 'git.refresh', title: 'Git: Refresh Status', when: hasWorkspace, run: refreshGitStatus },
];

export function availableCommands(): Command[] {
  return COMMANDS.filter((c) => !c.when || c.when());
}

export function runCommand(id: string): void {
  const command = COMMANDS.find((c) => c.id === id);
  if (!command || (command.when && !command.when())) return;
  void command.run();
}

export function currentKeybindings(): Record<string, string> {
  return resolveKeybindings(getState().settings.keybindings);
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm') !== null;
}

/** Global shortcuts, handled in the capture phase so they win over Monaco and xterm. */
export function installKeybindings(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    // The shortcut recorder in Settings needs the raw key press.
    if (event.target instanceof Element && event.target.closest('.keybinding.recording')) return;
    if (event.key === 'Escape' && (getState().palette || getState().gettingStartedOpen)) {
      event.preventDefault();
      setState(getState().palette ? { palette: null } : { gettingStartedOpen: false });
      return;
    }
    // Escape interrupts a running agent from anywhere in the app.
    if (
      event.key === 'Escape' &&
      getState().conversation?.running &&
      !document.querySelector('.model-picker, .menu, .overlay')
    ) {
      stopAgent();
      return;
    }
    const { isMac } = getState();
    const command = findCommand(event, currentKeybindings(), isMac);
    if (!command) return;
    // On Windows/Linux, Ctrl+<key> belongs to the shell (Ctrl+K kills a line); only Shift chords
    // reach the app from inside a terminal. Cmd never conflicts on macOS.
    if (!isMac && inTerminal(event.target) && !event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    runCommand(command);
  };
  window.addEventListener('keydown', onKeyDown, true);
  const offMenu = api.on('menu:command', runCommand);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    offMenu();
  };
}
