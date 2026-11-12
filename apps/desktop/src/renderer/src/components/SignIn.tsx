import { LoaderCircle } from 'lucide-react';
import { t } from '../i18n';
import { updateSettings } from '../services/settings';
import { cancelSignIn, signIn } from '../services/team';
import { useStore } from '../store';
import { KovanMark } from './Logo';

/**
 * While a sign-in waits: the code an emailed link's page will ask for. The link opens on any
 * device, so the code is what ties it to this screen.
 */
export function LoginCode() {
  const code = useStore((s) => s.loginCode);
  if (!code) return null;
  return (
    <div className="login-code" role="status">
      <span>{t('Signing in with an email link? Its page asks for this code:')}</span>
      <strong className="login-code-value mono">{code}</strong>
    </div>
  );
}

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
        <h1 className="signin-word">kovan</h1>
        <div className="signin-tag">
          {t('A code editor where your team and its AI agents work side by side.')}
        </div>

        {pending ? (
          <>
            <div className="signin-wait">
              <LoaderCircle size={16} className="spin" />
              {t('Finish signing in in your browser…')}
            </div>
            <LoginCode />
            <button className="btn btn-lg btn-block" onClick={cancelSignIn}>
              {t('Cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={() => void signIn('login')}
            >
              {t('Sign in or create an account')}
            </button>
            <div className="signin-note">{t('New here? Signing in creates your account.')}</div>
            <button
              className="link-btn signin-skip"
              onClick={() => void updateSettings({ signInSkipped: true })}
            >
              {t('Continue without an account')}
            </button>
            <div className="signin-note">
              {t(
                'Your own folders with your own AI keys. Teams, shared sessions and the phone app need an account; you can sign in any time from Settings.',
              )}
            </div>
          </>
        )}
        {/* Only a development or self-hosted server is worth naming. */}
        {serverUrl.startsWith('http://') && (
          <div className="signin-server mono" title={t('The Kovan server this app talks to')}>
            {t('Server:')} {serverUrl.replace(/^https?:\/\//, '')}
          </div>
        )}
      </div>
    </div>
  );
}
