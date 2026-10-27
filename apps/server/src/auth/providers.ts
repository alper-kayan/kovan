import type { Profile } from '../users.js';

export interface OAuthProvider {
  id: 'github' | 'google';
  label: string;
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchanges the callback code and returns the person's profile. */
  complete(code: string, redirectUri: string): Promise<Profile>;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw new Error(`${what} failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function githubProvider(clientId: string, clientSecret: string): OAuthProvider {
  const scope = 'read:user user:email';
  return {
    id: 'github',
    label: 'GitHub',
    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, state, allow_signup: 'true' })}`,
    async complete(code, redirectUri) {
      const token = await json<{
        access_token?: string;
        scope?: string;
        error_description?: string;
      }>(
        await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        }),
        'GitHub token exchange',
      );
      if (!token.access_token)
        throw new Error(token.error_description ?? 'GitHub did not return a token');
      const headers = {
        Authorization: `Bearer ${token.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Kovan',
      };
      const me = await json<{
        id: number;
        login: string;
        name: string | null;
        avatar_url: string | null;
      }>(await fetch('https://api.github.com/user', { headers }), 'GitHub profile');
      const emails = await json<{ email: string; primary: boolean; verified: boolean }[]>(
        await fetch('https://api.github.com/user/emails', { headers }),
        'GitHub emails',
      ).catch(() => []);
      const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified) ?? null;
      return {
        provider: 'github',
        providerUserId: String(me.id),
        name: me.name || me.login,
        email: primary?.email ?? null,
        emailVerified: primary?.verified ?? false,
        avatarUrl: me.avatar_url,
        login: me.login,
        accessToken: token.access_token,
        scopes: token.scope ?? scope,
      };
    },
  };
}

export function googleProvider(clientId: string, clientSecret: string): OAuthProvider {
  return {
    id: 'google',
    label: 'Google',
    authorizeUrl: (state, redirectUri) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' })}`,
    async complete(code, redirectUri) {
      const token = await json<{ access_token: string }>(
        await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        }),
        'Google token exchange',
      );
      const me = await json<{
        sub: string;
        name?: string;
        email?: string;
        email_verified?: boolean;
        picture?: string;
      }>(
        await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${token.access_token}` },
        }),
        'Google profile',
      );
      return {
        provider: 'google',
        providerUserId: me.sub,
        name: me.name || me.email?.split('@')[0] || 'Kovan user',
        email: me.email ?? null,
        emailVerified: me.email_verified === true,
        avatarUrl: me.picture ?? null,
        login: null,
        // Google tokens aren't needed after sign-in, so they aren't kept.
        accessToken: null,
        scopes: 'openid email profile',
      };
    },
  };
}
