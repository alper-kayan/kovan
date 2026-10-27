import '../site';
import '../styles/pages.css';
import type { AccountDeletionPlan } from '@kovan/shared';
import { api, signOut } from '../lib/api';
import { h } from '../lib/dom';
import { errorText, mountSession } from '../lib/session';

const root = document.querySelector<HTMLElement>('[data-app]')!;

mountSession(root, 'Account', ({ user, orgs }, view) => {
  const out = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Sign out');
  out.addEventListener('click', () => {
    out.disabled = true;
    void signOut().then(view.reload);
  });

  const orgList = h('dl', { class: 'fields' });
  for (const org of orgs)
    orgList.append(h('dt', {}, org.role === 'owner' ? 'Owner' : 'Member'), h('dd', {}, org.name));

  root.replaceChildren(
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'label' }, 'Account'),
      h('h1', {}, user.name),
      h('p', {}, 'Your Kovan account, as the app and this site see it.'),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Profile')),
      h(
        'dl',
        { class: 'fields' },
        h('dt', {}, 'Name'),
        h('dd', {}, user.name),
        h('dt', {}, 'Email'),
        h(
          'dd',
          {},
          user.email ?? 'No email on this account',
          user.email
            ? h(
                'span',
                { class: user.emailVerified ? 'tag-ok' : 'tag-warn' },
                user.emailVerified ? 'verified' : 'not verified',
              )
            : null,
        ),
        h('dt', {}, 'GitHub'),
        h('dd', {}, user.githubLogin ?? 'Not connected'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Organizations')),
      orgs.length
        ? orgList
        : h('p', { class: 'panel-text' }, 'You are not in an organization yet.'),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Billing and usage')),
      h(
        'p',
        { class: 'panel-text' },
        'Your allowance, saved card, invoices and the last 30 days of managed usage.',
      ),
      h('a', { class: 'btn btn-primary', href: '/account/billing/' }, 'Open billing'),
    ),
    deletion(view.reload),
    h('div', { class: 'actions' }, out),
    h(
      'p',
      { class: 'note' },
      'Name, connected accounts and privacy settings are changed in the desktop app. This tab forgets your session when you close it.',
    ),
  );
});

const WORD = 'delete';
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

/**
 * Deleting the account (also the page app stores link to for it): what goes and what stays is
 * shown first, and it takes typing a word to go ahead.
 */
function deletion(reload: () => void): HTMLElement {
  const start = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Delete account…');
  const body = h(
    'div',
    {},
    h(
      'p',
      { class: 'panel-text' },
      'Deletes your account and the workspaces only you are in, on every device. Shared workspaces stay with your teammates. It can’t be undone.',
    ),
    start,
  );
  start.addEventListener('click', () => {
    start.disabled = true;
    api
      .get<{ plan: AccountDeletionPlan }>('/api/me/deletion')
      .then(({ plan }) => body.replaceChildren(...confirmView(plan, reload)))
      .catch((error: unknown) => {
        start.disabled = false;
        body.append(h('p', { class: 'message bad' }, errorText(error)));
      });
  });
  return h(
    'section',
    { class: 'panel', id: 'delete' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Delete account')),
    body,
  );
}

function confirmView(plan: AccountDeletionPlan, reload: () => void): HTMLElement[] {
  const gone = h(
    'ul',
    { class: 'panel-text' },
    h('li', {}, 'Your account, its sign-ins, and the phones that get your notifications.'),
    plan.deleted.length
      ? h(
          'li',
          {},
          'Workspaces only you are in, with their sessions, transcripts and AI teammates: ',
          h('strong', {}, plan.deleted.map((w) => w.name).join(', ')),
          '.',
        )
      : null,
    h('li', {}, 'What you wrote in shared workspaces: your comments and your agent lanes.'),
    h('li', {}, 'Your saved card and billing details.'),
  );
  const handed = [
    ...plan.kept.map((w) => (w.owner ? `${w.name}: ${w.owner.name} becomes its owner` : w.name)),
    ...plan.orgsKept.flatMap((o) =>
      o.owner ? [`Organization ${o.name}: ${o.owner.name} becomes its owner`] : [],
    ),
  ];
  const parts: HTMLElement[] = [h('h3', {}, 'Deleted'), gone];
  if (handed.length)
    parts.push(
      h('h3', {}, 'Stays for the others'),
      h('ul', { class: 'panel-text' }, ...handed.map((line) => h('li', {}, line))),
    );
  parts.push(
    h(
      'p',
      { class: 'note' },
      'Repositories on GitHub and code on people’s computers aren’t touched.',
      plan.unbilled > 0
        ? ` Managed usage not charged yet (${usd(plan.unbilled)}) won’t be charged.`
        : '',
    ),
  );
  if (plan.blocker) {
    parts.push(h('p', { class: 'message bad' }, plan.blocker));
    return parts;
  }
  const input = h('input', {
    class: 'input',
    id: 'delete-word',
    autocomplete: 'off',
    placeholder: WORD,
  });
  const go = h(
    'button',
    { class: 'btn btn-primary', type: 'button', disabled: true },
    'Delete my account',
  );
  const status = h('div', { 'aria-live': 'polite' });
  input.addEventListener('input', () => {
    go.disabled = input.value.trim().toLowerCase() !== WORD;
  });
  go.addEventListener('click', () => {
    go.disabled = true;
    api
      .post('/api/me/delete', { confirm: true })
      .then(async () => {
        await signOut();
        document
          .querySelector<HTMLElement>('[data-app]')!
          .replaceChildren(h('p', { class: 'message ok' }, 'Your Kovan account was deleted.'));
      })
      .catch((error: unknown) => {
        go.disabled = false;
        status.replaceChildren(h('p', { class: 'message bad' }, errorText(error)));
        if (error instanceof Error && 'status' in error && error.status === 401) reload();
      });
  });
  parts.push(
    h('label', { for: 'delete-word', class: 'panel-text' }, `Type ${WORD} to confirm`),
    input,
    status,
    h('div', { class: 'actions' }, go),
  );
  return parts;
}
