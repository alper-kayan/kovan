import '../site';
import '../styles/home.css';
import { hive } from '../lib/hive';
import { t } from '../lib/i18n';
import { PLATFORM_LABEL, detectPlatform } from '../lib/platform';

const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
  root.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(selector),
];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A gate for looping scenes: `wait(ms)` resolves after `ms`, and then only once the element is
 * on screen, so scenes that scroll away stop where they are and pick up when they come back.
 */
function gate(el: Element) {
  let visible = false;
  let waiting: (() => void)[] = [];
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (visible) {
      for (const resume of waiting) resume();
      waiting = [];
    }
  }).observe(el);
  return (ms: number) =>
    new Promise<void>((resolve) =>
      setTimeout(() => (visible ? resolve() : waiting.push(resolve)), ms),
    );
}

/** Adds `is-on` while the element is in view, so its CSS animation replays each visit. */
function onWhileVisible(el: Element, threshold = 0.35) {
  new IntersectionObserver(
    ([entry]) => el.classList.toggle('is-on', entry?.isIntersecting ?? false),
    { threshold },
  ).observe(el);
}

/* ---------- reveal, progress, spotlight, tilt ---------- */

const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      revealer.unobserve(entry.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px' },
);
for (const el of $$('[data-reveal]')) revealer.observe(el);

const bar = $('[data-progress]');
if (bar) {
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.setProperty('--p', String(max > 0 ? window.scrollY / max : 0));
  };
  update();
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
}

for (const el of $$('[data-spot]'))
  el.addEventListener('pointermove', (event) => {
    const box = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${event.clientX - box.left}px`);
    el.style.setProperty('--my', `${event.clientY - box.top}px`);
  });

const tilt = $('[data-tilt]');
if (tilt && !calm && window.matchMedia('(pointer: fine)').matches) {
  const host = tilt.closest('section') ?? tilt;
  host.addEventListener('pointermove', (event) => {
    const e = event as PointerEvent;
    const x = e.clientX / window.innerWidth - 0.5;
    const y = e.clientY / window.innerHeight - 0.5;
    tilt.style.setProperty('--ry', `${(x * 7).toFixed(2)}deg`);
    tilt.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
  });
  host.addEventListener('pointerleave', () => {
    tilt.style.setProperty('--ry', '0deg');
    tilt.style.setProperty('--rx', '0deg');
  });
}

/* ---------- hive backgrounds ---------- */

for (const canvas of $$<HTMLCanvasElement>('[data-hive]'))
  hive(canvas, canvas.dataset['hive'] === 'cta' ? { radius: 26, walkers: 6 } : {});

/* ---------- counters ---------- */

const counter = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    counter.unobserve(entry.target);
    const el = entry.target as HTMLElement;
    const target = Number(el.dataset['count']);
    const decimals = Number(el.dataset['decimals'] ?? 0);
    if (calm) {
      el.textContent = target.toFixed(decimals);
      continue;
    }
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / 1600);
      el.textContent = (target * (1 - (1 - t) ** 3)).toFixed(decimals);
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
});
for (const el of $$('[data-count]')) counter.observe(el);

/* ---------- streaming lanes (hero window and the multiplayer scene) ---------- */

type Event = [lane: number, kind: string, html: string];

function push(feed: HTMLElement, kind: string, html: string, keep: number) {
  const line = document.createElement('div');
  line.className = `ev ${kind}`;
  line.innerHTML = html;
  feed.append(line);
  while (feed.children.length > keep) feed.firstElementChild?.remove();
}

/** A tool row: the verb in bold, then what it acted on (markup of our own). */
const did = (verb: string, what: string) => `<b>${t(verb)}</b> ${what}`;

const HERO: Event[] = [
  [0, 'msg', t('Plan: 4 tasks in 2 waves. Tests wait for the limiter.')],
  [0, 'tool', did('Wrote', t('task graph · acceptance for each'))],
  [1, 'think', t('Token bucket in middleware, keyed by API token.')],
  [2, 'think', t('Waiting for “Limiter” before writing tests.')],
  [
    1,
    'tool',
    did('Edited', 'src/limits.ts <span class="add">+38</span> <span class="del">−2</span>'),
  ],
  [1, 'tool', did('Ran', 'pnpm typecheck')],
  [1, 'ok', t('✓ typecheck passed')],
  [2, 'tool', did('Edited', 'test/limits.test.ts <span class="add">+41</span>')],
  [0, 'msg', t('@Tests cover the 429 path before review.')],
  [2, 'tool', did('Ran', 'pnpm test')],
  [2, 'ok', t('✓ {count} tests passed', { count: 14 })],
  [0, 'ok', t('✓ Reviewed · 4/4 tasks · verified')],
];
/** Mini graph state after each hero event: [running, done...]. */
const HERO_GRAPH: Record<number, { run?: string; done?: string[] }> = {
  1: { run: 'n2', done: ['n1'] },
  6: { run: 'n3', done: ['n1', 'n2'] },
  7: { run: 'n4', done: ['n1', 'n2', 'n3'] },
  10: { run: 'n5', done: ['n1', 'n2', 'n3', 'n4'] },
  11: { done: ['n1', 'n2', 'n3', 'n4', 'n5'] },
};

const heroLanes = $('[data-hero-lanes]');
if (heroLanes) {
  const feeds = $$('.lane-feed', heroLanes);
  const graph = $('[data-mini-graph]');
  const budget = $('[data-hero-budget]');
  const spend = $('[data-hero-spend]');
  const setGraph = (state: { run?: string; done?: string[] }) => {
    for (const node of $$('.mg', graph ?? document)) {
      const name = [...node.classList].find((c) => /^n\d$/.test(c));
      node.classList.toggle('done', Boolean(name && state.done?.includes(name)));
      node.classList.toggle('run', name === state.run);
    }
  };
  const setSpend = (dollars: number) => {
    budget?.style.setProperty('--b', `${(dollars / 2) * 100}%`);
    if (spend) spend.textContent = `$${dollars.toFixed(2)}`;
  };
  if (calm) {
    for (const [lane, kind, html] of HERO) push(feeds[lane]!, kind, html, 5);
    setGraph(HERO_GRAPH[11]!);
    setSpend(0.42);
  } else {
    const wait = gate(heroLanes);
    void (async () => {
      for (;;) {
        for (const feed of feeds) feed.replaceChildren();
        setGraph({ run: 'n1' });
        setSpend(0);
        for (const [i, [lane, kind, html]] of HERO.entries()) {
          await wait(i === 0 ? 600 : 1100);
          push(feeds[lane]!, kind, html, 6);
          if (HERO_GRAPH[i]) setGraph(HERO_GRAPH[i]);
          setSpend(0.035 * (i + 1));
        }
        await wait(4000);
      }
    })();
  }
}

const lanesDemo = $('[data-lanes-demo]');
if (lanesDemo) {
  const feeds = $$('.ld-feed', lanesDemo);
  type Beat = Event | 'overlap' | 'ask' | 'approve' | 'clear';
  const BEATS: Beat[] = [
    [0, 'msg', t('Add a token bucket to the public routes.')],
    [1, 'msg', t('Review the 429 path when it lands.')],
    [2, 'tool', did('Editing', 'src/limits.ts')],
    'overlap',
    [0, 'think', t('Bob is on limits.ts. Joining his task instead.')],
    'clear',
    [0, 'tool', did('Joined', t('Bob · split: routes for me'))],
    [1, 'tool', did('Read', 'src/routes.ts')],
    [2, 'tool', did('Edited', 'src/limits.ts <span class="add">+38</span>')],
    'ask',
    'approve',
    [1, 'tool', did('Ran', 'pnpm test src/limits.test.ts')],
    'clear',
    [1, 'ok', t('✓ {count} tests passed', { count: 6 })],
    [2, 'msg', t('Handing “wire routes” to Ada, plan attached.')],
    [0, 'ok', t('✓ Picked up: wire routes')],
  ];
  if (calm) {
    for (const beat of BEATS) if (Array.isArray(beat)) push(feeds[beat[0]]!, beat[1], beat[2], 5);
  } else {
    const wait = gate(lanesDemo);
    void (async () => {
      for (;;) {
        for (const feed of feeds) feed.replaceChildren();
        for (const beat of BEATS) {
          await wait(beat === 'approve' ? 1600 : 1150);
          if (beat === 'overlap') lanesDemo.classList.add('overlap');
          else if (beat === 'ask') lanesDemo.classList.add('asking');
          else if (beat === 'approve') lanesDemo.classList.add('approved');
          else if (beat === 'clear') lanesDemo.classList.remove('overlap', 'asking', 'approved');
          else push(feeds[beat[0]]!, beat[1], beat[2], 7);
        }
        await wait(3500);
      }
    })();
  }
}

/* ---------- the flow story ---------- */

const stage = $('[data-stage]');
const steps = $$('.story-step');
const goalText = $('[data-goal-type]');
const GOAL = t('Add rate limiting to the public API, with a burst test.');
let typed = false;

async function typeGoal() {
  if (typed || !goalText) return;
  typed = true;
  if (calm) {
    goalText.textContent = GOAL;
    return;
  }
  for (let i = 1; i <= GOAL.length; i++) {
    goalText.textContent = GOAL.slice(0, i);
    await sleep(28 + Math.random() * 40);
  }
}

/** Draws the graph's edges between the nodes where they really are (nodes are centred boxes). */
const edges = $<SVGSVGElement>('[data-edges]');
if (stage && edges) {
  const draw = () => {
    const { clientWidth: w, clientHeight: h } = stage;
    edges.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const box = (name: string) => {
      const node = $(`.node.${name}`, stage)!;
      // offsetLeft/Top ignore the centring transform: they are the centre.
      return {
        x: node.offsetLeft,
        y: node.offsetTop,
        w: node.offsetWidth / 2,
        h: node.offsetHeight / 2,
      };
    };
    const paths = (edges.dataset['edges'] ?? '').split(' ').map((pair) => {
      const [a, b] = pair.split('-').map(box) as [ReturnType<typeof box>, ReturnType<typeof box>];
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // Room between them: side to side. Stacked: bottom to top. Otherwise an elbow from the
      // bottom of one to the side of the other.
      const gap = b.x - b.w - (a.x + a.w);
      const midY = (a.y + b.y) / 2;
      const d =
        gap > 24
          ? `M${a.x + a.w} ${a.y} C ${a.x + a.w + gap / 2} ${a.y}, ${b.x - b.w - gap / 2} ${b.y}, ${b.x - b.w} ${b.y}`
          : Math.abs(b.x - a.x) < a.w
            ? `M${a.x} ${a.y + a.h} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y - b.h}`
            : `M${a.x} ${a.y + a.h} C ${a.x} ${b.y}, ${a.x} ${b.y}, ${b.x - b.w} ${b.y}`;
      path.setAttribute('d', d);
      path.setAttribute('pathLength', '1');
      return path;
    });
    edges.replaceChildren(...paths);
  };
  draw();
  new ResizeObserver(draw).observe(stage);
}

if (stage && steps.length) {
  const setStep = (n: string) => {
    stage.dataset['at'] = n;
    for (const step of steps) step.classList.toggle('is-on', step.dataset['step'] === n);
    if (n === '1') void typeGoal();
  };
  setStep('1');
  const watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) setStep((entry.target as HTMLElement).dataset['step'] ?? '1');
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  for (const step of steps) watcher.observe(step);
}

/* ---------- AI teammates: disputed memories ---------- */

const brain = $('[data-brain]');
if (brain) {
  if (calm) brain.classList.add('clash');
  else {
    const wait = gate(brain);
    void (async () => {
      for (;;) {
        await wait(2200);
        brain.classList.add('clash');
        await wait(3200);
        brain.classList.remove('clash');
      }
    })();
  }
}

/* ---------- JevRouter ---------- */

const router = $('[data-router]');
if (router) {
  const prompts = $('[data-router-prompts]', router)!;
  const label = $('[data-router-class]', router)!;
  const wires = $$<SVGPathElement>('.w', router);
  const models = $$('.r-model', router);
  const PROMPTS: [text: string, kind: string, model: number][] = [
    [t('Design the plugin API and its versioning'), t('design · difficulty 4/5'), 0],
    [t('Rename userId to accountId in utils.ts'), t('edit · difficulty 1/5'), 2],
    [t('Fix the failing auth test'), t('debug · difficulty 3/5'), 1],
    [t('How do the packages of this repo fit together?'), t('read · whole repo'), 3],
    // The directive is syntax and stays as it is typed.
    [`[jev: only use Opus] ${t('review this migration')}`, t('pinned by directive'), 0],
  ];
  const light = (model: number | null) => {
    wires.forEach((w, i) => w.classList.toggle('on', i === model));
    models.forEach((m, i) => m.classList.toggle('on', i === model));
  };
  if (calm) {
    const [text, kind, model] = PROMPTS[0]!;
    const bubble = document.createElement('div');
    bubble.className = 'r-prompt';
    bubble.textContent = text;
    prompts.append(bubble);
    label.textContent = kind;
    light(model);
  } else {
    const wait = gate(router);
    void (async () => {
      for (let i = 0; ; i = (i + 1) % PROMPTS.length) {
        const [text, kind, model] = PROMPTS[i]!;
        const bubble = document.createElement('div');
        bubble.className = 'r-prompt';
        bubble.textContent = text;
        prompts.append(bubble);
        while (prompts.children.length > 4) prompts.firstElementChild?.remove();
        label.textContent = t('reading the conversation…');
        light(null);
        await wait(900);
        label.textContent = kind;
        bubble.classList.add('go');
        light(model);
        await wait(2200);
      }
    })();
  }
}

/* ---------- directive typer ---------- */

for (const el of $$('[data-typer]')) {
  const lines = (el.dataset['typer'] ?? '').split('|');
  const render = (text: string) => {
    const match = /^\[[^\]]*\]?/.exec(text)?.[0] ?? '';
    el.replaceChildren();
    const directive = document.createElement('span');
    directive.className = 'directive';
    directive.textContent = match;
    const caret = document.createElement('span');
    caret.className = 'caret';
    el.append(directive, text.slice(match.length), caret);
  };
  if (calm) {
    render(lines[0] ?? '');
    continue;
  }
  const wait = gate(el);
  void (async () => {
    for (let i = 0; ; i = (i + 1) % lines.length) {
      const line = lines[i]!;
      for (let n = 1; n <= line.length; n++) {
        render(line.slice(0, n));
        await wait(35 + Math.random() * 35);
      }
      await wait(1800);
      for (let n = line.length; n >= 0; n -= 2) {
        render(line.slice(0, n));
        await wait(14);
      }
      await wait(300);
    }
  })();
}

/* ---------- your order: limits running out, the next one taking over ---------- */

const order = $('[data-order]');
if (order) {
  const items = $$('li', order);
  const meter = (li: HTMLElement, value: number) =>
    $('.meter i', li)?.style.setProperty('--m', `${value}%`);
  if (calm) {
    items[0]?.classList.add('out');
    meter(items[0]!, 100);
    items[1]?.classList.add('on');
    meter(items[1]!, 40);
  } else {
    const wait = gate(order);
    void (async () => {
      for (;;) {
        for (const li of items) {
          li.classList.remove('on', 'out');
          meter(li, 0);
        }
        for (const [i, li] of items.entries()) {
          li.classList.add('on');
          const last = i === items.length - 1;
          for (let m = 0; m <= (last ? 55 : 100); m += 4) {
            meter(li, m);
            await wait(60);
          }
          if (last) break;
          li.classList.replace('on', 'out');
          await wait(500);
        }
        await wait(2600);
      }
    })();
  }
}

/* ---------- bento scenes ---------- */

for (const el of $$('[data-spend], [data-race], [data-impact]')) onWhileVisible(el);

const replay = $('[data-replay]');
if (replay) {
  const events = $$('.replay-events span', replay);
  const log = $('[data-replay-log]', replay);
  const at = (t: number) => {
    replay.style.setProperty('--t', `${t}%`);
    let last: HTMLElement | null = null;
    for (const ev of events) {
      const hit = Number.parseFloat(ev.style.getPropertyValue('--x')) <= t;
      ev.classList.toggle('hit', hit);
      if (hit) last = ev;
    }
    if (log) log.textContent = last?.dataset['log'] ?? '';
  };
  if (calm) at(100);
  else {
    const wait = gate(replay);
    void (async () => {
      for (;;) {
        for (let t = 0; t <= 100; t += 1) {
          at(t);
          await wait(55);
        }
        await wait(1600);
      }
    })();
  }
}

/* ---------- modes ---------- */

const modes = $('[data-modes]');
if (modes) {
  const tabs = $$<HTMLButtonElement>('[data-mode]', modes);
  const panels = $$('.mode-panel', modes);
  const tablist = $('.modes-tabs', modes)!;
  let chosen = false;
  const show = (n: number) => {
    tablist.style.setProperty('--m', String(n));
    tabs.forEach((tab, i) => tab.setAttribute('aria-selected', String(i === n)));
    panels.forEach((panel, i) => panel.classList.toggle('is-on', i === n));
  };
  tabs.forEach((tab, i) =>
    tab.addEventListener('click', () => {
      chosen = true;
      show(i);
    }),
  );
  if (!calm) {
    const wait = gate(modes);
    void (async () => {
      for (let n = 1; !chosen; n = (n + 1) % tabs.length) {
        await wait(3600);
        if (!chosen) show(n);
      }
    })();
  }
}

/* ---------- download label ---------- */

void detectPlatform().then((platform) => {
  const label = $('[data-download-label]');
  if (platform && label)
    label.textContent = t('Download for {platform}', { platform: t(PLATFORM_LABEL[platform]) });
});
