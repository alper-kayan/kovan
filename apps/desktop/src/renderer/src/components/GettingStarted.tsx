import { ArrowRight, Bell, Bot, Check, FolderGit2, Mail, UserPlus, X } from 'lucide-react';
import { DialogKeys } from './DialogKeys';
import { GithubMark } from './Logo';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { completeStep, doneCount, STEPS, type StepId } from '../services/onboarding';
import { addWorkspace, refreshUser, sendVerification, signIn } from '../services/team';
import { notify, reportError, setState, showView, useStore, type SettingsSection } from '../store';
import type { Readiness, ReadyFix } from '../../../shared/agent';
import { ProgressRing } from './ui';
import { LoginCode } from './SignIn';

function useCountdown(until: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= now) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until, now]);
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function SignInFirst({ what }: { what: string }) {
  const pending = useStore((s) => s.loginPending);
  return (
    <div className="gs-actions">
      <button
        className="btn btn-primary"
        disabled={pending !== null}
        onClick={() => void signIn('login')}
      >
        {pending ? 'Waiting for the browser…' : 'Sign in'}
      </button>
      <span className="callout" style={{ margin: 0 }}>
        {what} needs an account.
      </span>
      {pending === 'login' && <LoginCode />}
    </div>
  );
}

const FIX: Record<ReadyFix, { label: string; section: SettingsSection } | null> = {
  provider: { label: 'Add a model key', section: 'providers' },
  billing: { label: 'Set up Kovan billing', section: 'billing' },
  accounts: { label: 'Add a Claude Code or Codex account', section: 'agents' },
  install: { label: 'See what to install', section: 'agents' },
  order: { label: 'Choose which agents to use', section: 'agents' },
  wait: null,
};

/** Whether an agent could answer now; asked when the step shows, marked done once it can. */
function AiStep() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .invoke('agent:readiness', { auto: true, harness: 'kovan', model: 'auto' })
      .then((r) => {
        if (!live) return;
        setReadiness(r);
        if (r.ready) completeStep('ai');
      })
      .catch(() => live && setReadiness(null));
    return () => {
      live = false;
    };
  }, []);
  const go = (section: SettingsSection) => {
    setState({ settingsSection: section, gettingStartedOpen: false });
    showView('settings');
  };
  return (
    <>
      <h3>Get an AI agent ready</h3>
      <p>
        Your agent needs a model to think with. Any one of these works: a key from a model provider
        such as OpenRouter, Kovan billing (you pay what the model costs, plus 5%), or your own
        Claude Code or Codex account.
      </p>
      {readiness === null ? (
        <p className="muted">Checking…</p>
      ) : readiness.ready ? (
        <div className="callout">
          <Check size={15} /> An agent is ready. Open the chat with <Bot size={13} /> and ask it
          something.
        </div>
      ) : (
        <>
          <div className="callout">{readiness.why}</div>
          <div className="gs-actions">
            {FIX[readiness.fix] && (
              <button className="btn btn-primary" onClick={() => go(FIX[readiness.fix]!.section)}>
                {FIX[readiness.fix]!.label}
              </button>
            )}
            {readiness.fix !== 'provider' && (
              <button className="btn" onClick={() => go('providers')}>
                Use a model key instead
              </button>
            )}
            {readiness.fix !== 'accounts' && (
              <button className="btn" onClick={() => go('agents')}>
                Use Claude Code or Codex
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Detail({ id }: { id: StepId }) {
  const done = useStore((s) => s.settings.onboarding[id] === true);
  const workspace = useStore((s) => s.workspace);
  const user = useStore((s) => s.user);
  const signedIn = useStore((s) => s.signedIn);
  const resendAt = useStore((s) => s.verifyResendAt);
  const pending = useStore((s) => s.loginPending);
  const wait = useCountdown(resendAt);

  switch (id) {
    case 'ai':
      return <AiStep />;
    case 'verify-email':
      return (
        <>
          <h3>Verify your email</h3>
          {!signedIn || !user ? (
            <>
              <p>
                Invites and session alerts go to your email. Sign in first, then confirm the
                address.
              </p>
              <SignInFirst what="Verifying an email" />
            </>
          ) : user.emailVerified ? (
            <div className="callout">
              <Check size={15} /> {user.email} is verified.
            </div>
          ) : !user.email ? (
            <p>Your account has no email address yet. Sign in with email or Google to add one.</p>
          ) : (
            <>
              <p>
                Open the verification link for {user.email} on this computer to confirm the address.
                Invites and session alerts go there.
              </p>
              <div className="callout">
                <Mail size={15} /> Didn't get it? Check spam, or resend the link.
              </div>
              <div className="gs-actions">
                <button className="btn btn-primary" onClick={() => void refreshUser()}>
                  <Check size={14} /> I've verified my email
                </button>
                <button className="btn" disabled={wait > 0} onClick={() => void sendVerification()}>
                  {wait > 0 ? `Resend in ${wait}s` : resendAt ? 'Resend link' : 'Send link'}
                </button>
              </div>
            </>
          )}
        </>
      );
    case 'connect-github':
      return (
        <>
          <h3>Connect GitHub</h3>
          <p>
            Kovan uses GitHub to invite teammates by username and, later, to open pull requests.
            Your local git credentials and SSH keys stay on this machine.
          </p>
          {!signedIn ? (
            <SignInFirst what="Connecting GitHub" />
          ) : user?.githubLogin ? (
            <div className="callout">
              <Check size={15} /> Connected as @{user.githubLogin}.
            </div>
          ) : (
            <div className="gs-actions">
              <button
                className="btn btn-primary"
                disabled={pending !== null}
                onClick={() => void signIn('link')}
              >
                <GithubMark size={14} />{' '}
                {pending === 'link' ? 'Waiting for the browser…' : 'Connect GitHub'}
              </button>
            </div>
          )}
        </>
      );
    case 'start':
      return (
        <>
          <h3>Open a project folder</h3>
          <p>
            Pick the folder of a project you work on (a Git repository works best). You'll see its
            files, a terminal and your changes, and your AI agent works in it.
            {signedIn
              ? ' It becomes a workspace your team can share once you invite them; the files stay on this computer.'
              : ''}
          </p>
          <div className="gs-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                void addWorkspace().then(() => setState({ gettingStartedOpen: false }))
              }
            >
              <FolderGit2 size={14} /> {workspace ? 'Open another folder' : 'Open a folder'}
            </button>
            {done && (
              <span className="callout" style={{ margin: 0 }}>
                <Check size={14} /> Done
              </span>
            )}
          </div>
        </>
      );
    case 'notifications':
      return (
        <>
          <h3>Turn on notifications</h3>
          <p>
            Kovan tells you when an agent finishes or needs your approval, so you can work elsewhere
            while it runs. Notifications only appear while Kovan is in the background.
          </p>
          <div className="gs-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                api
                  .invoke(
                    'app:notify',
                    'Notifications are on',
                    'Kovan will tell you when an agent needs you.',
                    true,
                  )
                  .then((result) => {
                    if (result.shown) return completeStep('notifications');
                    notify({
                      kind: 'error',
                      title: 'The test notification was blocked',
                      message: result.hint ?? result.error ?? 'The system did not show it.',
                      sticky: true,
                    });
                  }, reportError)
              }
            >
              <Bell size={14} /> Send a test notification
            </button>
          </div>
        </>
      );
    case 'first-session':
      return (
        <>
          <h3>Start your first session</h3>
          <p>
            A session is one task your team works on together, on its own Git branch. Everyone in it
            brings their own AI agent, and all of them see what each agent does as it happens.
          </p>
          {!signedIn ? (
            <SignInFirst what="A shared session" />
          ) : (
            <div className="gs-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setState({ newSessionOpen: true, gettingStartedOpen: false });
                  showView('sessions');
                }}
              >
                New session
              </button>
              <span className="callout" style={{ margin: 0 }}>
                Working alone? The agent chat is enough; sessions are for working with others.
              </span>
            </div>
          )}
        </>
      );
    case 'invite':
      return (
        <>
          <h3>Invite a teammate to your workspace</h3>
          <p>
            Invite people by GitHub username or email and pick their role: viewer, commenter, editor
            or owner.
          </p>
          {!signedIn ? (
            <SignInFirst what="Inviting teammates" />
          ) : done ? (
            <div className="callout">
              <Check size={15} /> You've invited a teammate.
            </div>
          ) : (
            <div className="gs-actions">
              <button
                className="btn btn-primary"
                onClick={() =>
                  setState({ gettingStartedOpen: false, inviteOpen: true, view: 'people' })
                }
              >
                <UserPlus size={14} /> Invite a teammate
              </button>
            </div>
          )}
        </>
      );
  }
}

export function GettingStarted() {
  const open = useStore((s) => s.gettingStartedOpen);
  const onboarding = useStore((s) => s.settings.onboarding);
  const firstOpen = STEPS.find((s) => !onboarding[s.id])?.id ?? STEPS[0]!.id;
  const [selected, setSelected] = useState<StepId>(firstOpen);
  // Each time it opens: on the first step still to do.
  useEffect(() => {
    if (open) setSelected(firstOpen);
  }, [open]);
  if (!open) return null;
  const at = STEPS.findIndex((s) => s.id === selected);
  const next =
    STEPS.slice(at + 1).find((s) => !onboarding[s.id]) ??
    STEPS.find((s, i) => i !== at && !onboarding[s.id]);

  const close = () => setState({ gettingStartedOpen: false });
  const groups = [
    { id: 'setup' as const, label: 'Setup' },
    { id: 'milestones' as const, label: 'Milestones' },
  ];

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <div
        className="modal"
        role="dialog"
        aria-label="Getting started"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogKeys onClose={close} />
        <div className="modal-head">
          <h2 className="modal-title">
            Getting started <ProgressRing value={doneCount(onboarding)} total={STEPS.length} />
          </h2>
          <p className="modal-desc">
            A few steps to get you coding with an AI agent, then with your team. Come back any time
            with <b>Start</b> in the left bar.
          </p>
          <button className="icon-btn modal-close" title="Close" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="gs-body">
          <div className="gs-steps">
            {groups.map((group, gi) => {
              const steps = STEPS.filter((s) => s.group === group.id);
              return (
                <div key={group.id}>
                  {gi > 0 && <div className="gs-groupgap" />}
                  <div className="gs-group">
                    <span>{group.label}</span>
                    <span>
                      {doneCount(onboarding, group.id)}/{steps.length}
                    </span>
                  </div>
                  {steps.map((step) => (
                    <button
                      key={step.id}
                      className={`gs-step ${selected === step.id ? 'selected' : ''} ${onboarding[step.id] ? 'done' : ''}`}
                      onClick={() => setSelected(step.id)}
                    >
                      <span className="gs-num">
                        {onboarding[step.id] ? <Check size={11} /> : STEPS.indexOf(step) + 1}
                      </span>
                      {step.title}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="gs-detail">
            <Detail id={selected} />
            <div className="gs-next">
              {next ? (
                <button className="btn btn-ghost" onClick={() => setSelected(next.id)}>
                  Next: {next.title} <ArrowRight size={13} />
                </button>
              ) : (
                <button className="btn btn-ghost" onClick={close}>
                  All done <Check size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
