import { useEffect } from 'react';
import { installKeybindings } from './commands';
import { Banner } from './components/Banner';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GettingStarted } from './components/GettingStarted';
import { IssueDialog } from './components/IssueDialog';
import { NavSidebar } from './components/NavSidebar';
import { Notices } from './components/Notices';
import { MissionControlPage as SessionsPage } from './components/MissionControl';
import { AgentsPage } from './components/Pages';
import { SessionRoom } from './components/SessionRoom';
import { BrainPage } from './components/BrainPage';
import { CommentDialog } from './components/Comments';
import { PeoplePage } from './components/People';
import { SetupView } from './components/SetupView';
import { updatePresence } from './services/team';
import { SettingsView } from './components/SettingsView';
import { SignIn } from './components/SignIn';
import { TitleBar } from './components/TitleBar';
import { WorkspaceView } from './components/WorkspaceView';
import { useStore } from './store';

export function App() {
  const view = useStore((s) => s.view);
  const workspace = useStore((s) => s.workspace);
  const navCollapsed = useStore((s) => s.navCollapsed);
  const signInSkipped = useStore((s) => s.settings.signInSkipped);
  const signedIn = useStore((s) => s.signedIn);

  useEffect(() => installKeybindings(), []);
  // Teammates see which workspace this machine has open.
  useEffect(() => updatePresence(), [view, workspace?.root, signedIn]);

  if (!signInSkipped && !signedIn) {
    return (
      <div className="app">
        <TitleBar />
        <SignIn />
        <Notices />
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      {view !== 'settings' && <Banner />}
      <div className="body">
        {view === 'settings' && (
          <ErrorBoundary label="Settings">
            <SettingsView />
          </ErrorBoundary>
        )}
        {view !== 'settings' && !navCollapsed && <NavSidebar />}
        {view === 'sessions' && (
          <ErrorBoundary label="Sessions">
            <SessionsPage />
          </ErrorBoundary>
        )}
        {view === 'session' && (
          <ErrorBoundary label="The session">
            <SessionRoom />
          </ErrorBoundary>
        )}
        {view === 'brain' && (
          <ErrorBoundary label="Brain">
            <BrainPage />
          </ErrorBoundary>
        )}
        {view === 'people' && (
          <ErrorBoundary label="People">
            <PeoplePage />
          </ErrorBoundary>
        )}
        {view === 'agents' && (
          <ErrorBoundary label="Agents">
            <AgentsPage />
          </ErrorBoundary>
        )}
        {view === 'setup' && (
          <ErrorBoundary label="Setup">
            <SetupView />
          </ErrorBoundary>
        )}
        {/* Kept mounted while hidden so terminals, editors and diffs survive navigation. */}
        {workspace && (
          <div style={{ flex: 1, minWidth: 0, display: view === 'workspace' ? 'flex' : 'none' }}>
            <ErrorBoundary label="The editor">
              <WorkspaceView />
            </ErrorBoundary>
          </div>
        )}
      </div>
      <CommandPalette />
      <GettingStarted />
      <IssueDialog />
      <CommentDialog />
      <Notices />
    </div>
  );
}
