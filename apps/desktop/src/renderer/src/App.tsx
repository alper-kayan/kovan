import { useEffect } from 'react';
import { installKeybindings } from './commands';
import { installFocusRescue } from './focusRescue';
import { useLocale } from './i18n';
import { installDomTranslation } from './i18n/dom';
import { TR } from './i18n/tr';
import { Banner } from './components/Banner';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GettingStarted } from './components/GettingStarted';
import { IssueDialog } from './components/IssueDialog';
import { ActivityBar, SideBar } from './components/NavSidebar';
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
import { INTRODUCED } from './services/onboarding';
import { updateSettings } from './services/settings';
import { setState, useStore } from './store';

export function App() {
  const view = useStore((s) => s.view);
  const workspace = useStore((s) => s.workspace);
  const navCollapsed = useStore((s) => s.navCollapsed);
  const signInSkipped = useStore((s) => s.settings.signInSkipped);
  const signedIn = useStore((s) => s.signedIn);
  // Keyed on the language: changing it draws every screen again in the new one.
  const locale = useLocale();
  useEffect(() => (locale === 'en' ? undefined : installDomTranslation(TR)), [locale]);

  useEffect(() => installKeybindings(), []);
  useEffect(() => installFocusRescue(), []);
  // The first time past the sign-in screen, the guide opens by itself (once).
  const inApp = signedIn || signInSkipped;
  useEffect(() => {
    const onboarding = useStore.getState().settings.onboarding;
    // Someone who has opened a folder before has found their way already.
    if (!inApp || onboarding[INTRODUCED] || onboarding['start']) return;
    setState({ gettingStartedOpen: true });
    void updateSettings({ onboarding: { ...onboarding, [INTRODUCED]: true } });
  }, [inApp]);
  // Teammates see which workspace this machine has open.
  useEffect(() => updatePresence(), [view, workspace?.root, signedIn]);

  if (!signInSkipped && !signedIn) {
    return (
      <div className="app" key={locale} lang={locale}>
        <TitleBar />
        <SignIn />
        <Notices />
      </div>
    );
  }

  return (
    <div className="app" key={locale} lang={locale}>
      <TitleBar />
      {view !== 'settings' && <Banner />}
      <div className="body">
        {view === 'settings' && (
          <ErrorBoundary label="Settings">
            <SettingsView />
          </ErrorBoundary>
        )}
        {view !== 'settings' && <ActivityBar />}
        {view !== 'settings' && !navCollapsed && <SideBar />}
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
