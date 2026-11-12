import '../site';
import '../styles/pages.css';
import type { AccountDeletionPlan, User, Workspace } from '@kovan/shared';
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
    orgList.append(h('dt', {}, org.name), h('dd', {}, org.role === 'owner' ? 'Owner' : 'Member'));

  // The workspaces you're in, read-only: where to look for your team's work.
  const spaces = h('div', {}, h('p', { class: 'panel-text' }, 'Loading…'));
  void api
    .get<{ workspaces: Workspace[] }>('/api/workspaces')
    .then(({ workspaces }) => {
      if (!workspaces.length) {
        spaces.replaceChildren(
          h(
            'p',
            { class: 'panel-text' },
            'None yet. Open a project folder in the desktop app to make one, or ask a teammate to invite you.',
          ),
        );
        return;
      }
      const list = h('dl', { class: 'fields' });
      for (const w of workspaces)
        list.append(h('dt', {}, w.name), h('dd', {}, w.role[0]!.toUpperCase() + w.role.slice(1)));
      spaces.replaceChildren(list);
    })
    .catch(view.fail);

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
        h('dd', {}, nameEditor(user)),
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
      h('div', { class: 'panel-head' }, h('h2', {}, 'Workspaces')),
      spaces,
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'The apps')),
      h(
        'p',
        { class: 'panel-text' },
        'Agents run in the desktop app (or the terminal); the phone app follows and answers them.',
      ),
      h(
        'div',
        { class: 'actions' },
        h('a', { class: 'btn btn-primary', href: '/download/' }, 'Desktop app'),
        h('a', { class: 'btn btn-secondary', href: '/download/#phone' }, 'Phone app'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Billing and usage')),
      h(
        'p',
        { class: 'panel-text' },
        'Your monthly limit, saved card, invoices and the last 30 days of models paid through Kovan.',
      ),
      h('a', { class: 'btn btn-primary', href: '/account/billing/' }, 'Open billing'),
    ),
    deletion(view.reload),
    h('div', { class: 'actions' }, out),
    h(
      'p',
      { class: 'note' },
      'Connected accounts and privacy settings are changed in the desktop app. This tab forgets your session when you close it.',
    ),
  );
});

/** Your name as teammates see it, changed in place. */
function nameEditor(user: User): HTMLElement {
  const input = h('input', {
    class: 'input',
    value: user.name,
    maxlength: '80',
    'aria-label': 'Your name',
  }) as HTMLInputElement;
  const save = h('button', { class: 'btn btn-secondary', type: 'button' }, 'Save');
  const note = h('span', { class: 'panel-text' });
  save.addEventListener('click', () => {
    const name = input.value.trim();
    if (!name) return;
    save.disabled = true;
    api
      .patch<{ user: User }>('/api/me', { name })
      .then(() => (note.textContent = ' Saved. Teammates see it from now on.'))
      .catch((e: unknown) => (note.textContent = ` ${errorText(e)}`))
      .finally(() => (save.disabled = false));
  });
  return h('span', { class: 'name-edit' }, input, save, note);
}

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
        ? ` Kovan billing usage not charged yet (${usd(plan.unbilled)}) is charged to your card as the account is deleted (under $0.50, it’s waived).`
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
