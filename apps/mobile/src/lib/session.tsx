import type { Org, User } from '@kovan/shared';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import { ApiError, DEFAULT_SERVER, request, STORE_KEYS as KEYS } from './api';
import { unregisterPush } from './push';
import { t } from './i18n';
import { pollSignIn, startSignIn } from './signInFlow';

const POLL_MS = 1500;
/** The server's last sign-in page sends the browser here, which brings the app back. */
const RETURN_TO = 'kovan://signed-in';

type Status = 'loading' | 'signedOut' | 'signingIn' | 'signedIn';

interface SessionState {
  status: Status;
  server: string;
  /** The session token, for the live connection. */
  token: string | null;
  user: User | null;
  orgs: Org[];
  /** Why the last sign-in didn't work, shown on the sign-in screen. */
  error: string | null;
  /** While a sign-in waits: the code an emailed link's page asks for. */
  loginCode: string | null;
  setServer(server: string): Promise<void>;
  signIn(): Promise<void>;
  /** Sign in with Apple (iPhone): no browser, Apple's sheet and the server. */
  signInWithApple(): Promise<void>;
  cancelSignIn(): void;
  /** `farewell`: a line the sign-in screen shows next ("Your account was deleted."). */
  signOut(farewell?: string): Promise<void>;
  /** What the last sign-out left to say, until the next sign-in. */
  farewell: string | null;
  /** The name teammates see; returns whether it was saved. */
  rename(name: string): Promise<void>;
  /** A request to Kovan's server as this person. */
  api<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T>;
}

const Context = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const value = useContext(Context);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

const nativeCrypto = {
  randomBytes: (n: number) => Crypto.getRandomBytes(n),
  sha256Base64: (text: string) =>
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
      encoding: Crypto.CryptoEncoding.BASE64,
    }),
};

/** Who is signed in, to which server; the token lives in the device's secure storage. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [server, setServerState] = useState(DEFAULT_SERVER);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState<string | null>(null);
  const [farewell, setFarewell] = useState<string | null>(null);
  const attempt = useRef(0);

  const loadMe = useCallback(async (at: string, tok: string) => {
    const me = await request<{ user: User; orgs: Org[] }>(at, tok, 'GET', '/api/me');
    setUser(me.user);
    setOrgs(me.orgs);
  }, []);

  useEffect(() => {
    void (async () => {
      const savedServer = (await SecureStore.getItemAsync(KEYS.server)) ?? DEFAULT_SERVER;
      const savedToken = await SecureStore.getItemAsync(KEYS.token);
      setServerState(savedServer);
      if (!savedToken) return setStatus('signedOut');
      setToken(savedToken);
      try {
        await loadMe(savedServer, savedToken);
        setStatus('signedIn');
      } catch (e) {
        // A revoked session signs out; being offline keeps it (the screens say so).
        if (e instanceof ApiError && e.status === 401) {
          await SecureStore.deleteItemAsync(KEYS.token);
          setToken(null);
          setStatus('signedOut');
        } else setStatus('signedIn');
      }
    })();
  }, [loadMe]);

  // Started while the server didn't answer: who you are comes in once it does.
  useEffect(() => {
    if (status !== 'signedIn' || user || !token) return;
    const retry = setInterval(() => void loadMe(server, token).catch(() => undefined), 8_000);
    return () => clearInterval(retry);
  }, [status, user, token, server, loadMe]);

  const setServer = useCallback(async (next: string) => {
    // The choice holds for this run even if it can't be saved for the next one.
    setServerState(next);
    await SecureStore.setItemAsync(KEYS.server, next).catch((e: unknown) =>
      console.warn("Couldn't save the server address:", e),
    );
  }, []);

  /** A session token from either way in: kept on the device, and the person loaded. */
  const adopt = useCallback(
    async (tok: string, who: User | null) => {
      await SecureStore.setItemAsync(KEYS.token, tok);
      setToken(tok);
      setUser(who);
      await loadMe(server, tok).catch(() => undefined);
      setStatus('signedIn');
    },
    [server, loadMe],
  );

  const signIn = useCallback(async () => {
    const mine = ++attempt.current;
    setError(null);
    setStatus('signingIn');
    try {
      const pending = await startSignIn(server, nativeCrypto, RETURN_TO);
      setLoginCode(pending.code);
      // The browser sits on top while the phone polls. iOS closes it once the server says done;
      // Android can't, so there it's an auth session that closes on the redirect to the app.
      const browser =
        Platform.OS === 'android'
          ? WebBrowser.openAuthSessionAsync(pending.url, RETURN_TO)
          : WebBrowser.openBrowserAsync(pending.url, {
              dismissButtonStyle: 'cancel',
              presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
            });
      void browser.then((result) => {
        if (result.type === 'cancel' && attempt.current === mine) {
          attempt.current++;
          setStatus('signedOut');
        }
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (attempt.current !== mine) return;
        const result = await pollSignIn(server, pending);
        if (result.status === 'pending') continue;
        // Done with this attempt: on Android the tab can still be open (signed in from a mail
        // app, say), and closing it later must not read as cancelling.
        attempt.current++;
        if (Platform.OS === 'ios') await WebBrowser.dismissBrowser().catch(() => undefined);
        if (result.status === 'failed') throw new Error(result.error);
        await adopt(result.token, result.user);
        return;
      }
    } catch (e) {
      if (attempt.current !== mine) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('signedOut');
    }
  }, [server, adopt]);

  // The code belongs to a sign-in that is waiting; any other state has none.
  useEffect(() => {
    if (status !== 'signingIn') setLoginCode(null);
  }, [status]);

  const signInWithApple = useCallback(async () => {
    const mine = ++attempt.current;
    setError(null);
    setStatus('signingIn');
    try {
      // Apple puts the hash of this nonce in its token; the server gets the nonce itself, so a
      // token taken from somewhere else is useless there.
      const nonce = Array.from(Crypto.getRandomBytes(16), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
      let credential: AppleAuthentication.AppleAuthenticationCredential;
      try {
        credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
          nonce: hashed,
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') throw e;
        // Apple's own errors say little ("failed for an unknown reason"); most often the phone
        // isn't signed in to an Apple Account.
        throw new Error(
          t(
            "Sign in with Apple didn't work. Check that this iPhone is signed in to an Apple Account, or use another way.",
          ),
          { cause: e },
        );
      }
      if (!credential.identityToken)
        throw new Error(t("Apple didn't confirm who you are. Try again."));
      const result = await request<{ token: string; user: User }>(
        server,
        null,
        'POST',
        '/auth/apple',
        {
          identityToken: credential.identityToken,
          authorizationCode: credential.authorizationCode,
          nonce,
          name: credential.fullName
            ? {
                givenName: credential.fullName.givenName,
                familyName: credential.fullName.familyName,
              }
            : null,
        },
      );
      if (attempt.current !== mine) return;
      attempt.current++;
      await adopt(result.token, result.user);
    } catch (e) {
      if (attempt.current !== mine) return;
      attempt.current++;
      // Closing Apple's sheet is not an error.
      const canceled = (e as { code?: string }).code === 'ERR_REQUEST_CANCELED';
      setError(canceled ? null : e instanceof Error ? e.message : String(e));
      setStatus('signedOut');
    }
  }, [server, adopt]);

  const cancelSignIn = useCallback(() => {
    attempt.current++;
    if (Platform.OS === 'ios') void WebBrowser.dismissBrowser().catch(() => undefined);
    setStatus('signedOut');
  }, []);

  const signOut = useCallback(
    async (note?: string) => {
      setFarewell(note ?? null);
      if (token) {
        // This phone stops getting their notifications before the sign-in goes.
        await unregisterPush((method, path, body) => request(server, token, method, path, body));
        await request(server, token, 'POST', '/auth/logout').catch(() => undefined);
      }
      await SecureStore.deleteItemAsync(KEYS.token);
      setToken(null);
      setUser(null);
      setOrgs([]);
      setStatus('signedOut');
    },
    [server, token],
  );

  const api = useCallback(
    async <T,>(method: Parameters<SessionState['api']>[0], path: string, body?: unknown) => {
      try {
        return await request<T>(server, token, method, path, body);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await SecureStore.deleteItemAsync(KEYS.token);
          setToken(null);
          setStatus('signedOut');
        }
        throw e;
      }
    },
    [server, token],
  );

  const rename = useCallback(
    async (name: string) => {
      const r = await api<{ user: User }>('PATCH', '/api/me', { name });
      setUser(r.user);
    },
    [api],
  );

  const value = useMemo<SessionState>(
    () => ({
      status,
      server,
      token,
      user,
      orgs,
      error,
      loginCode,
      setServer,
      signIn,
      signInWithApple,
      cancelSignIn,
      signOut,
      farewell,
      rename,
      api,
    }),
    [
      status,
      server,
      token,
      user,
      orgs,
      error,
      loginCode,
      setServer,
      signIn,
      signInWithApple,
      cancelSignIn,
      signOut,
      farewell,
      rename,
      api,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
