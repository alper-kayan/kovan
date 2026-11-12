import '../site';
import '../styles/pages.css';
import type { InviteLookup } from '@kovan/shared';
import { ApiError, api } from '../lib/api';
import { h } from '../lib/dom';
import { errorText, mountSession } from '../lib/session';

const invite = document.querySelector<HTMLElement>('[data-invite]')!;
const root = document.querySelector<HTMLElement>('[data-app]')!;
const token = new URLSearchParams(window.location.search).get('t') ?? '';
// The token is a secret: it leaves the address bar, so it isn't shared by a copied URL.
if (token) window.history.replaceState(null, '', '/join/');

// Role words come from @kovan/shared at build time (see vite.config.ts).
const ROLE_WORDS = __ROLE_WORDS__;

const onPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function needs(lookup: InviteLookup): HTMLElement {
  return h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'What you need')),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        h('strong', {}, 'Kovan on your computer. '),
        'That is where agents work on the code. ',
        h('a', { href: '/download/' }, 'Download it'),
        '. To only follow along, the Kovan phone app is enough.',
      ),
      lookup.repoUrl
        ? h(
            'li',
            {},
            h('strong', {}, 'Access to the repository. '),
            `Kovan opens ${lookup.repoUrl} with your own Git access. If you can't open it, ask ${lookup.inviterName ?? 'the person who invited you'} to add you there too.`,
          )
        : null,
      h(
        'li',
        {},
        h('strong', {}, 'A way to run AI models, '),
        'when you want an agent of your own: your OpenRouter key, your Claude Code or Codex account, or paying through Kovan. Kovan asks the first time you need it.',
      ),
    ),
  );
}

async function showInvite(): Promise<InviteLookup | null> {
  if (!token) {
    invite.replaceChildren(
      h(
        'header',
        { class: 'page-head' },
        h('p', { class: 'label' }, 'Invite'),
        h('h1', {}, 'This link has no invite in it'),
        h('p', {}, 'Open the link from your invite email again, or ask for a new one.'),
      ),
    );
    return null;
  }
  try {
    const lookup = await api.get<InviteLookup>(
      `/api/invites/lookup?t=${encodeURIComponent(token)}`,
    );
    const who = lookup.inviterName ?? 'Someone';
    const parts: (HTMLElement | null)[] = [
      h(
        'header',
        { class: 'page-head' },
        h('p', { class: 'label' }, 'Invite'),
        h('h1', {}, `${who} invited you to ${lookup.workspaceName}`),
        h(
          'p',
          {},
          `You'd join as ${ROLE_WORDS[lookup.role]}. Kovan is where a team and its AI coding agents work on the same code together.`,
        ),
      ),
      lookup.status === 'pending' ? needs(lookup) : null,
      onPhone && lookup.status === 'pending'
        ? h(
            'p',
            { class: 'panel-text' },
            'Kovan on this phone? ',
            h(
              'a',
              { class: 'btn btn-secondary', href: `kovan://join?t=${encodeURIComponent(token)}` },
              'Open the invite in the app',
            ),
          )
        : null,
    ];
    invite.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
    return lookup;
  } catch (error) {
    invite.replaceChildren(
      h(
        'header',
        { class: 'page-head' },
        h('p', { class: 'label' }, 'Invite'),
        h('h1', {}, "This invite can't be used"),
        h('p', { class: 'message bad' }, errorText(error)),
      ),
    );
    return null;
  }
}

void showInvite().then((lookup) => {
  if (!lookup) return;
  if (lookup.status === 'revoked') {
    root.replaceChildren(
      h('p', { class: 'message bad' }, 'This invite was taken back. Ask for a new one.'),
    );
    return;
  }
  mountSession(root, 'Join', ({ user }, view) => {
    const join = h(
      'button',
      { class: 'btn btn-primary btn-lg', type: 'button' },
      `Join as ${user.name}`,
    );
    const note = h('p', { class: 'panel-text' });
    join.addEventListener('click', () => {
      join.disabled = true;
      void api
        .post<{ workspaceName: string; role: string }>('/api/invites/accept', { token })
        .then((done) => {
          root.replaceChildren(
            h(
              'section',
              { class: 'panel' },
              h('div', { class: 'panel-head' }, h('h2', {}, `You're in ${done.workspaceName}`)),
              h(
                'p',
                { class: 'panel-text' },
                `Open Kovan on your computer or your phone, signed in as ${user.email ?? user.name}: ${done.workspaceName} is in your workspaces.`,
              ),
              h('a', { class: 'btn btn-secondary', href: '/download/' }, 'Get Kovan'),
            ),
          );
        })
        .catch((error: unknown) => {
          join.disabled = false;
          if (error instanceof ApiError && error.status === 401) return view.fail(error);
          note.className = 'message bad';
          note.textContent = errorText(error);
        });
    });
    root.replaceChildren(
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Join')),
        h(
          'p',
          { class: 'panel-text' },
          `You're signed in as ${user.email ?? user.name}. The invite went to ${lookup.sentTo}; you can join with this account either way.`,
        ),
        join,
        note,
      ),
    );
  });
});
