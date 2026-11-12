import '@fontsource-variable/dm-sans';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/lilex';
import '../styles/demo.css';
import { h } from '../lib/dom';

/**
 * The sample app embedded on the landing page. Everything here is made-up sample data; the
 * document is a fixed 1440×900 and the screen is chosen by the URL hash.
 */

const SCREENS = ['board', 'room', 'people', 'agents', 'settings'] as const;
type Screen = (typeof SCREENS)[number];
type Color = 'pink' | 'blue' | 'teal' | 'orange' | 'purple';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- sample data ----------

const PEOPLE: Record<string, { name: string; initials: string; color: Color }> = {
  ada: { name: 'Ada', initials: 'AD', color: 'pink' },
  ben: { name: 'Ben', initials: 'BE', color: 'blue' },
  chen: { name: 'Chen', initials: 'CH', color: 'teal' },
  dia: { name: 'Dia', initials: 'DI', color: 'orange' },
  eli: { name: 'Eli', initials: 'EL', color: 'purple' },
};

interface Card {
  title: string;
  workspace: string;
  status: 'idle' | 'running' | 'approval';
  harness: string;
  people: string[];
  files: number;
}

const CARDS: Card[] = [
  {
    title: 'Add rate limiting',
    workspace: 'sample-api',
    status: 'approval',
    harness: 'kovan · claude',
    people: ['ben', 'ada', 'chen'],
    files: 4,
  },
  {
    title: 'Paginate the audit log',
    workspace: 'sample-api',
    status: 'running',
    harness: 'claude',
    people: ['chen'],
    files: 2,
  },
  {
    title: 'Rotate signing keys',
    workspace: 'sample-api',
    status: 'idle',
    harness: 'codex',
    people: ['eli', 'ada'],
    files: 0,
  },
  {
    title: 'Dark mode tokens',
    workspace: 'sample-web',
    status: 'idle',
    harness: 'kovan',
    people: ['ada'],
    files: 7,
  },
  {
    title: 'Checkout form errors',
    workspace: 'sample-web',
    status: 'running',
    harness: 'codex · kovan',
    people: ['dia', 'ben'],
    files: 3,
  },
  {
    title: 'Image lazy loading',
    workspace: 'sample-web',
    status: 'idle',
    harness: 'claude',
    people: ['dia'],
    files: 1,
  },
  {
    title: 'Link checker in CI',
    workspace: 'sample-docs',
    status: 'idle',
    harness: 'kovan',
    people: ['eli'],
    files: 2,
  },
  {
    title: 'Search index rebuild',
    workspace: 'sample-docs',
    status: 'idle',
    harness: 'codex',
    people: ['chen', 'eli'],
    files: 0,
  },
  {
    title: 'Webhook retries',
    workspace: 'sample-api',
    status: 'running',
    harness: 'kovan',
    people: ['ben'],
    files: 5,
  },
];

const STATUS_LABEL: Record<Card['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  approval: 'Needs approval',
};

type Step =
  | { kind: 'prompt'; text: string; time: string; rev: number }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; verb: string; path: string; add?: number; del?: number }
  | { kind: 'reply'; text: string; time: string }
  | { kind: 'approval'; command: string; rev: number };

interface Lane {
  person: string;
  you?: boolean;
  harness: string;
  model: string;
  mode: string;
  placeholder: string;
  steps: Step[];
}

const LANES: Lane[] = [
  {
    person: 'ben',
    harness: 'Kovan',
    model: 'JevRouter',
    mode: 'Ask first',
    placeholder: 'Ben is using Kovan with JevRouter. Steer their agent…',
    steps: [
      {
        kind: 'prompt',
        time: '11:37',
        rev: 12,
        text: 'Add a token bucket to the public routes and prove it with a burst test.',
      },
      {
        kind: 'thought',
        text: 'The limiter belongs in middleware, keyed by API token, so every public route gets it.',
      },
      { kind: 'tool', verb: 'Explored', path: 'src/routes/public.ts, src/middleware/' },
      { kind: 'tool', verb: 'Edited', path: 'src/limits.ts', add: 38, del: 2 },
      { kind: 'tool', verb: 'Edited', path: 'src/limits.test.ts', add: 51 },
      {
        kind: 'reply',
        time: '11:44',
        text: 'The bucket refills at the configured rate and a burst past it returns 429 with a Retry-After header. I need to run the tests to be sure.',
      },
      { kind: 'approval', command: 'pnpm test src/limits.test.ts', rev: 14 },
      { kind: 'tool', verb: 'Ran', path: 'pnpm test src/limits.test.ts · 6 passed' },
      {
        kind: 'reply',
        time: '11:46',
        text: 'All six cases pass, including the burst. Ready for review.',
      },
    ],
  },
  {
    person: 'ada',
    you: true,
    harness: 'Kovan',
    model: 'JevRouter',
    mode: 'Edit freely',
    placeholder: 'Prompt your agent. Uses your OpenRouter key.',
    steps: [
      {
        kind: 'prompt',
        time: '11:39',
        rev: 13,
        text: 'Document the new rate limit headers in the API reference.',
      },
      {
        kind: 'thought',
        text: 'Ben is editing src/limits.ts in this session; I will read it but only touch the docs.',
      },
      { kind: 'tool', verb: 'Read', path: 'src/limits.ts' },
      { kind: 'tool', verb: 'Edited', path: 'docs/api/limits.md', add: 27 },
      {
        kind: 'reply',
        time: '11:42',
        text: 'Added a Limits page with the three headers and an example 429 response. It links from the errors page.',
      },
    ],
  },
  {
    person: 'chen',
    harness: 'Claude Code',
    model: 'claude',
    mode: 'Plan only',
    placeholder: 'Chen is using Claude Code. Message their agent…',
    steps: [
      {
        kind: 'prompt',
        time: '11:41',
        rev: 13,
        text: 'Review the 429 path before this merges. Plan only.',
      },
      { kind: 'tool', verb: 'Explored', path: 'src/limits.ts, src/routes/public.ts' },
      {
        kind: 'thought',
        text: 'Two things to check: the key when a request has no token, and clock skew on refill.',
      },
      {
        kind: 'reply',
        time: '11:45',
        text: 'One gap: requests without a token all share a single bucket. I left a comment on limits.ts line 22 suggesting the client address as the fallback key.',
      },
    ],
  },
];

const MEMBERS = [
  { person: 'ada', handle: 'ada-sample', role: 'Owner', scope: 'All workspaces', you: true },
  { person: 'ben', handle: 'ben-sample', role: 'Editor', scope: '2 of 3 workspaces' },
  { person: 'chen', handle: 'chen-sample', role: 'Editor', scope: 'All workspaces' },
  { person: 'dia', handle: 'dia-sample', role: 'Commenter', scope: '1 of 3 workspaces' },
  { person: 'eli', handle: 'eli-sample', role: 'Viewer', scope: '2 of 3 workspaces' },
];

// ---------- rendering ----------

function avatar(person: string, size = ''): HTMLElement {
  const p = PEOPLE[person]!;
  return h('i', { class: `avatar ${p.color} ${size}` }, p.initials);
}

function renderBoard(): void {
  const board = document.querySelector<HTMLElement>('[data-board]');
  if (!board) return;
  for (const card of CARDS) {
    board.append(
      h(
        'a',
        { class: 'card', href: '#room' },
        h('div', { class: 'card-top' }, card.title, h('span', {}, '···')),
        h('div', { class: `pill is-${card.status}` }, STATUS_LABEL[card.status]),
        h('div', { class: 'card-meta' }, `${card.harness} · ${card.workspace}`),
        h(
          'div',
          { class: 'card-foot' },
          h('span', { class: 'stack' }, ...card.people.map((person) => avatar(person, 'sm'))),
          card.files ? `${card.files} files touched` : 'no changes yet',
        ),
      ),
    );
  }
}

function renderPeople(): void {
  const list = document.querySelector<HTMLElement>('[data-members]');
  for (const member of MEMBERS) {
    list?.append(
      h(
        'li',
        {},
        avatar(member.person, 'lg'),
        h('span', { class: 'name' }, PEOPLE[member.person]!.name.toLowerCase()),
        member.you ? h('span', { class: 'you' }, 'You') : null,
        h('span', { class: 'handle' }, member.handle),
        h('span', { class: 'role' }, member.role),
        h('span', { class: 'scope' }, member.scope),
      ),
    );
  }
  document
    .querySelector<HTMLElement>('[data-ai]')
    ?.append(
      h(
        'li',
        {},
        h('i', { class: 'avatar ai lg' }, 'SC'),
        h('span', { class: 'name' }, 'scout'),
        h('span', { class: 'badge' }, 'AI'),
        h('span', { class: 'handle' }, "Runs on ada's machine · paid by ada"),
        h('span', { class: 'role' }, 'Editor'),
        h('span', { class: 'scope' }, '1 of 3 workspaces'),
      ),
    );
}

function placeNodes(): void {
  for (const node of document.querySelectorAll<HTMLElement>('.node')) {
    node.style.left = `${node.dataset['x'] ?? 0}px`;
    node.style.top = `${node.dataset['y'] ?? 0}px`;
  }
}

// ---------- lanes ----------

let current: Screen = 'board';

/** Waits, and keeps waiting while the room is not the screen being shown. */
async function pause(ms: number): Promise<void> {
  if (reducedMotion) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
  while (current !== 'room' || document.hidden)
    await new Promise((resolve) => setTimeout(resolve, 400));
}

async function type(target: HTMLElement, text: string): Promise<void> {
  if (reducedMotion) {
    target.textContent = text;
    return;
  }
  target.classList.add('typing');
  for (let at = 0; at < text.length; at += 3) {
    target.textContent = text.slice(0, at + 3);
    await pause(34);
  }
  target.classList.remove('typing');
}

function buildLane(lane: Lane): { root: HTMLElement; play: () => Promise<void> } {
  const person = PEOPLE[lane.person]!;
  const state = h('span', { class: 'lane-state' }, 'idle');
  const stream = h('div', { class: 'lane-stream' });
  const root = h(
    'div',
    { class: 'lane' },
    h(
      'div',
      { class: 'lane-head' },
      avatar(lane.person, 'sm'),
      h('b', {}, lane.you ? `${person.name} (you)` : person.name),
      h('small', {}, lane.harness),
      state,
    ),
    stream,
    h(
      'div',
      { class: 'composer' },
      h('span', { class: 'composer-owner' }, lane.you ? 'Me' : person.name),
      h('p', {}, lane.placeholder),
      h(
        'div',
        { class: 'composer-row' },
        h('span', { class: 'chip' }, lane.harness),
        h('span', { class: 'chip' }, lane.mode),
        h('span', { class: `chip ${lane.model === 'JevRouter' ? 'is-jev' : ''}` }, lane.model),
        h('span', { class: 'send' }, '↑'),
      ),
    ),
  );
  root.style.setProperty('--who', `var(--u-${person.color})`);

  const setState = (value: 'idle' | 'working' | 'waiting') => {
    state.textContent = value;
    state.className = `lane-state ${value}`;
  };

  const show = async (step: Step): Promise<void> => {
    switch (step.kind) {
      case 'prompt':
        stream.append(
          h(
            'div',
            { class: 'prompt' },
            h(
              'div',
              { class: 'prompt-head' },
              avatar(lane.person, 'sm'),
              h('b', {}, person.name),
              'prompt',
              h('time', {}, step.time),
            ),
            h('div', {}, step.text),
            h('span', { class: 'rev' }, `rev ${step.rev}`),
          ),
        );
        setState('working');
        return pause(900);
      case 'thought': {
        const line = h('p', { class: 'thought' });
        stream.append(line);
        await type(line, `✻ ${step.text}`);
        return pause(500);
      }
      case 'tool':
        stream.append(
          h(
            'div',
            { class: 'tool' },
            h('b', {}, step.verb),
            h('span', { class: 'path' }, step.path),
            step.add ? h('span', { class: 'add' }, `+${step.add}`) : null,
            step.del ? h('span', { class: 'del' }, `−${step.del}`) : null,
          ),
        );
        return pause(1100);
      case 'reply': {
        const text = h('p', {});
        stream.append(
          h(
            'div',
            { class: 'reply' },
            h(
              'div',
              { class: 'reply-head' },
              h('b', {}, `${lane.harness} · ${lane.model}`),
              ' ',
              h('time', {}, step.time),
            ),
            text,
          ),
        );
        await type(text, step.text);
        return pause(900);
      }
      case 'approval': {
        setState('waiting');
        const actions = h('div', { class: 'approval-actions' });
        const card = h(
          'div',
          { class: 'approval' },
          h(
            'div',
            { class: 'approval-head' },
            'Run this?',
            h('span', { class: 'rev' }, `rev ${step.rev}`),
          ),
          h('pre', {}, step.command),
          actions,
        );
        stream.append(card);
        const answer = await new Promise<string>((resolve) => {
          const approve = h(
            'button',
            { class: 'btn btn-primary btn-sm', type: 'button' },
            '✓ Approve',
          );
          const deny = h('button', { class: 'btn btn-sm', type: 'button' }, '✕ Deny');
          approve.addEventListener('click', () => resolve('Approved by you'));
          deny.addEventListener('click', () => resolve('Denied by you'));
          actions.append(approve, deny, h('span', {}, 'any editor · first answer wins'));
          // Nobody clicked: a teammate answers, as they could in a real session.
          if (!reducedMotion) void pause(9000).then(() => resolve('Approved by Chen'));
        });
        actions.replaceWith(
          h('div', { class: 'approval-result' }, `${answer} · this exact action, once`),
        );
        setState('working');
        if (answer.startsWith('Denied')) {
          stream.append(
            h(
              'div',
              { class: 'tool' },
              h('b', {}, 'Skipped'),
              h('span', { class: 'path' }, step.command),
            ),
          );
          throw new Error('denied');
        }
        return pause(700);
      }
    }
  };

  const play = async (): Promise<void> => {
    do {
      stream.replaceChildren();
      setState('idle');
      await pause(600);
      try {
        for (const step of lane.steps) await show(step);
      } catch {
        // A denied approval ends the turn there.
      }
      setState('idle');
      await pause(9000);
    } while (!reducedMotion);
  };

  return { root, play };
}

function renderLanes(): void {
  const host = document.querySelector<HTMLElement>('[data-lanes]');
  if (!host) return;
  LANES.forEach((lane, index) => {
    const { root, play } = buildLane(lane);
    host.append(root);
    // Lanes start a moment apart so they don't move in lockstep.
    setTimeout(() => void play(), reducedMotion ? 0 : index * 1300);
  });
}

// ---------- shell ----------

function route(): void {
  const wanted = window.location.hash.slice(1) as Screen;
  current = SCREENS.includes(wanted) ? wanted : 'board';
  for (const shell of document.querySelectorAll<HTMLElement>('[data-shell]'))
    shell.hidden = (shell.dataset['shell'] === 'settings') !== (current === 'settings');
  for (const screen of document.querySelectorAll<HTMLElement>('[data-screen]'))
    screen.hidden = screen.dataset['screen'] !== current;
  for (const link of document.querySelectorAll<HTMLElement>('[data-nav]'))
    link.classList.toggle('is-current', link.dataset['nav'] === current);
}

function initSegmented(): void {
  for (const group of document.querySelectorAll<HTMLElement>('[data-segmented]')) {
    group.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button) return;
      for (const other of group.querySelectorAll('button'))
        other.classList.toggle('on', other === button);
      const theme = button.dataset['theme'];
      if (theme) document.documentElement.dataset['theme'] = theme;
    });
  }
}

/** Standing alone in a small window, the fixed-size app shrinks to fit. */
function fit(): void {
  const app = document.querySelector<HTMLElement>('[data-app]');
  if (!app) return;
  const scale = Math.min(1, window.innerWidth / 1440, window.innerHeight / 900);
  app.style.transform = scale < 1 ? `scale(${scale})` : '';
}

/**
 * Opened on its own (from a link, not inside the home page): a thin bar says what this is and
 * leads back, and on a phone that the sample is made for a computer screen.
 */
function siteBar(): void {
  if (window.top !== window.self) return;
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  const phone = window.screen.width < 700;
  bar.innerHTML = `<span><b>A sample of the Kovan desktop app</b>, with made-up data: click around${
    phone ? '. It is made for a computer screen; pinch to zoom' : ''
  }.</span><a href="/">Back to the site</a><a class="demo-bar-cta" href="/download/">Download</a>`;
  document.body.prepend(bar);
  document.body.classList.add('has-demo-bar');
}

siteBar();
renderBoard();
renderPeople();
placeNodes();
initSegmented();
route();
renderLanes();
fit();
window.addEventListener('hashchange', route);
window.addEventListener('resize', fit);
