import { Bell, Check, FolderGit2, Mail, UserPlus, X } from 'lucide-react';
import { GithubMark } from './Logo';
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { completeStep, doneCount, STEPS, type StepId } from '../services/onboarding';
import { addWorkspace, refreshUser, sendVerification, signIn } from '../services/team';
import { notify, reportError, setState, useStore } from '../store';
import { ProgressRing } from './ui';

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
    </div>
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
          <h3>Start with Kovan</h3>
          <p>
            A workspace is a repository on this machine. Open one to browse its files, run a
            terminal and review changes; sessions and agents build on it.
          </p>
          <div className="gs-actions">
            <button
              className="btn btn-primary"
              onClick={() =>
                void addWorkspace().then(() => setState({ gettingStartedOpen: false }))
              }
            >
              <FolderGit2 size={14} /> {workspace ? 'Open another repository' : 'Open a repository'}
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
            A session is one task on one branch with one plan, shared by everyone in it. Each person
            works in their own lane with their own agent, side by side.
          </p>
          <div className="callout">Shared sessions arrive after accounts and the team server.</div>
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
  const firstOpen = STEPS.find((s) => !onboarding[s.id])?.id ?? 'verify-email';
  const [selected, setSelected] = useState<StepId>(firstOpen);
  if (!open) return null;

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
        <div className="modal-head">
          <h2 className="modal-title">
            Getting started <ProgressRing value={doneCount(onboarding)} total={STEPS.length} />
          </h2>
          <p className="modal-desc">
            Kovan lets you code with AI and teammates. A workspace is a repository; a session is a
            shared task. Agents do the work, and Swarm lets several agents coordinate.
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
          </div>
        </div>
      </div>
    </div>
  );
}
