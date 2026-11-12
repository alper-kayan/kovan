import type { Org, User } from '@kovan/shared';
import { ApiError, api, getToken, signIn } from './api';
import { h } from './dom';

export interface Me {
  user: User;
  orgs: Org[];
}

export interface SessionView {
  /** Any failed request goes here: a 401 returns to the signed-out view, the rest are shown. */
  fail: (error: unknown) => void;
  /** Loads the signed-in view again from the server. */
  reload: () => void;
}

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Try again.';

/**
 * Runs a signed-in page: shows the sign-in view until there is a session, then hands the
 * account to `render`. Whenever the server answers 401 the page falls back to signed out.
 */
export function mountSession(
  root: HTMLElement,
  title: string,
  render: (me: Me, view: SessionView) => Promise<void> | void,
): void {
  const signedOut = (notice?: string, bad = false) => {
    const button = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }, 'Sign in');
    button.addEventListener('click', waiting);
    root.replaceChildren(
      h(
        'section',
        { class: 'signin' },
        h('p', { class: 'label' }, title),
        h('h1', {}, 'Sign in to Kovan'),
        h(
          'p',
          { class: 'panel-text' },
          'Use the account you use in the app. Signing in opens a new tab; this page picks up once you finish there.',
        ),
        notice ? h('p', { class: `message ${bad ? 'bad' : ''}` }, notice) : null,
        button,
      ),
    );
  };

  const waiting = () => {
    const handle = signIn();
    const link = h(
      'a',
      { class: 'link', target: '_blank', rel: 'noopener' },
      'Open the sign-in page',
    );
    const fallback = h('p', { class: 'panel-text', hidden: true }, 'No new tab? ', link, '.');
    const codeValue = h('strong', { class: 'signin-code' });
    const codeLine = h(
      'p',
      { class: 'panel-text', hidden: true },
      'Signing in with an email link? Its page asks for this code: ',
      codeValue,
    );
    void handle.code.then((code) => {
      if (!code) return;
      codeValue.textContent = code;
      codeLine.hidden = false;
    });
    void handle.url.then((url) => {
      link.href = url;
      fallback.hidden = false;
    });
    const cancel = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => {
      handle.cancel();
      signedOut();
    });
    root.replaceChildren(
      h(
        'section',
        { class: 'signin' },
        h('p', { class: 'label' }, title),
        h('h1', {}, 'Finish in the other tab'),
        h(
          'p',
          { class: 'panel-text' },
          'Choose how to sign in there. This page continues by itself when you are done.',
        ),
        codeLine,
        fallback,
        cancel,
      ),
    );
    handle.done.then(boot, (error: unknown) => {
      if (error instanceof ApiError && error.code === 'cancelled') return;
      signedOut(errorText(error), true);
    });
  };

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      signedOut('Your session ended. Sign in again to continue.');
      return;
    }
    const retry = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Try again');
    retry.addEventListener('click', boot);
    root.replaceChildren(
      h(
        'section',
        { class: 'signin' },
        h('p', { class: 'label' }, title),
        h('h1', {}, "This page couldn't load"),
        h('p', { class: 'message bad' }, errorText(error)),
        retry,
      ),
    );
  };

  function boot(): void {
    if (!getToken()) {
      signedOut();
      return;
    }
    root.replaceChildren(h('p', { class: 'panel-text' }, 'Loading your account…'));
    api
      .get<Me>('/api/me')
      .then((me) => render(me, { fail, reload: boot }))
      .catch(fail);
  }

  boot();
}
