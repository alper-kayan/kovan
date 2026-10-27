import { LoaderCircle } from 'lucide-react';
import { updateSettings } from '../services/settings';
import { cancelSignIn, signIn } from '../services/team';
import { useStore } from '../store';
import { KovanMark } from './Logo';

/** First-run screen: sign in through the browser, or keep working locally. */
export function SignIn() {
  const pending = useStore((s) => s.loginPending);
  const serverUrl = useStore((s) => s.serverUrl);

  return (
    <div className="signin">
      <div className="signin-inner">
        <div className="signin-mark">
          <KovanMark size={132} strokeWidth={1.4} />
        </div>
        <div className="signin-word">kovan</div>
        <div className="signin-tag">Your team and its agents, as one.</div>

        {pending ? (
          <>
            <div className="signin-wait">
              <LoaderCircle size={16} className="spin" />
              Finish signing in in your browser…
            </div>
            <button className="btn btn-lg btn-block" onClick={cancelSignIn}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={() => void signIn('login')}
            >
              Log in
            </button>
            <button className="btn btn-lg btn-block" onClick={() => void signIn('login')}>
              Sign up
            </button>
            <button
              className="link-btn signin-skip"
              onClick={() => void updateSettings({ signInSkipped: true })}
            >
              Continue without an account
            </button>
          </>
        )}
        <div className="signin-server mono">{serverUrl.replace(/^https?:\/\//, '')}</div>
      </div>
    </div>
  );
}
