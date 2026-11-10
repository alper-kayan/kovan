import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import type { ModelStreamer } from '@kovan/harness';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore } from './auth.js';
import { expandCommand } from './extras.js';
import { main, type Terminal } from './run.js';
import { ConversationStore } from './store.js';

/**
 * What Claude Code reads, `kovan` reads: skills (SKILL.md folders), your own CLAUDE.md, custom slash commands. All in a made-up home and repository,
 * with a scripted model that records what it was told.
 */
let base: string;
let repo: string;
let home: string;
let data: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'kovan-extras-'));
  repo = join(base, 'repo');
  home = join(base, 'home');
  data = join(base, 'data');
  for (const d of [repo, home, data]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const skill = (dir: string, name: string, description: string, body = `${name} gövdesi`) =>
  put(
    join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );

const done: StreamEvent = {
  type: 'done',
  finishReason: 'stop',
  model: 'm',
  reasoningDetails: [],
  usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
};
function model(): ModelStreamer & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push(structuredClone(request));
      yield { type: 'text', text: 'tamam' } as StreamEvent;
      yield done;
    },
  };
}
function terminal(lines: string[] = []) {
  const written: string[] = [];
  const queue = [...lines];
  const t: Terminal = {
    isTTY: false,
    write: (s) => void written.push(s),
    readLine: async () => queue.shift() ?? null,
    onInterrupt: () => {},
    close: () => {},
  };
  return { t, text: () => written.join('') };
}

function run(
  argv: string[],
  m: ModelStreamer,
  term = terminal(),
  env: Record<string, string> = {},
) {
  return main(argv, {
    env: { KOVAN_DATA_DIR: data, ...env },
    cwd: repo,
    home,
    terminal: term.t,
    store: new ConversationStore(join(base, 'conv')),
    auth: new AuthStore(join(base, 'k')),
    err: () => {},
    model: m,
    checkUpdates: false,
  });
}
const sent = (m: { requests: ChatRequest[] }, i = 0) => JSON.stringify(m.requests[i]);

describe('skills', () => {
  it('are found in the repository, in Claude’s own folder and in the desktop’s, and offered to the model', async () => {
    skill(join(repo, '.claude', 'skills'), 'repo-skill', 'Depodaki beceri');
    skill(join(home, '.claude', 'skills'), 'claude-skill', 'Claude klasöründeki beceri');
    skill(join(data, 'skills'), 'desktop-skill', 'Masaüstündeki beceri');
    const m = model();
    expect(await run(['selam'], m)).toBe(0);
    const req = sent(m);
    for (const d of ['Depodaki beceri', 'Claude klasöründeki beceri', 'Masaüstündeki beceri'])
      expect(req).toContain(d);
    expect((m.requests[0]!.tools ?? []).map((t) => t.name)).toContain('use_skill');
  });

  it('a repository without any offers no skill tool', async () => {
    const m = model();
    await run(['selam'], m);
    expect((m.requests[0]!.tools ?? []).map((t) => t.name)).not.toContain('use_skill');
  });

  it('KOVAN_NO_CLAUDE=1 leaves Claude’s own folder out, and nothing else', async () => {
    skill(join(home, '.claude', 'skills'), 'claude-skill', 'Claude klasöründeki beceri');
    skill(join(data, 'skills'), 'desktop-skill', 'Masaüstündeki beceri');
    const m = model();
    await run(['selam'], m, terminal(), { KOVAN_NO_CLAUDE: '1' });
    expect(sent(m)).not.toContain('Claude klasöründeki beceri');
    expect(sent(m)).toContain('Masaüstündeki beceri');
  });

  it('`/skill-name args` typed by you loads that skill for the turn', async () => {
    skill(
      join(home, '.claude', 'skills'),
      'frontend-design',
      'Arayüz tasarımı',
      'ÖZEL-BECERİ-GÖVDESİ: sade tasarla',
    );
    const m = model();
    await run([], m, terminal(['/frontend-design ana sayfa', '/exit']));
    expect(sent(m)).toContain('ÖZEL-BECERİ-GÖVDESİ');
    expect(sent(m)).toContain('ana sayfa');
  });

  it('a skill that cannot be read is named in /skills, not silently missing', async () => {
    put(join(home, '.claude', 'skills', 'bozuk', 'SKILL.md'), 'frontmatter yok burada');
    const term = terminal(['/skills', '/exit']);
    await run([], model(), term);
    expect(term.text()).toMatch(/skipped: ~[\\/]\.claude[\\/]skills[\\/]bozuk[\\/]SKILL\.md/);
  });

  it('`/skills` lists them with where they came from; with none it says where to put one', async () => {
    skill(join(home, '.claude', 'skills'), 'notebooklm', 'Defterlere sorar');
    const a = terminal(['/skills', '/skills yok-boyle-bir-sey', '/exit']);
    await run([], model(), a);
    expect(a.text()).toContain('/notebooklm');
    expect(a.text()).toContain('claude-code');
    expect(a.text()).toContain('No skills');
  });
});

describe('your own notes and the repository’s', () => {
  it('~/.claude/CLAUDE.md and ~/.kovan/KOVAN.md are in the system prompt', async () => {
    put(join(home, '.claude', 'CLAUDE.md'), 'Her zaman kısa yaz KİŞİSEL-CLAUDE');
    put(join(home, '.kovan', 'KOVAN.md'), 'Commit mesajı Türkçe KİŞİSEL-KOVAN');
    const m = model();
    await run(['selam'], m);
    expect(sent(m)).toContain('KİŞİSEL-CLAUDE');
    expect(sent(m)).toContain('KİŞİSEL-KOVAN');
  });

  it('KOVAN_NO_CLAUDE=1 drops Claude’s notes but keeps your own', async () => {
    put(join(home, '.claude', 'CLAUDE.md'), 'KİŞİSEL-CLAUDE');
    put(join(home, '.kovan', 'KOVAN.md'), 'KİŞİSEL-KOVAN');
    const m = model();
    await run(['selam'], m, terminal(), { KOVAN_NO_CLAUDE: '1' });
    expect(sent(m)).not.toContain('KİŞİSEL-CLAUDE');
    expect(sent(m)).toContain('KİŞİSEL-KOVAN');
  });

  it('the repository’s CLAUDE.md, AGENTS.md and KOVAN.md are read, as the harness always did', async () => {
    put(join(repo, 'CLAUDE.md'), 'DEPO-CLAUDE-KURALI');
    put(join(repo, 'AGENTS.md'), 'DEPO-AGENTS-KURALI');
    put(join(repo, 'KOVAN.md'), 'DEPO-KOVAN-KURALI');
    const m = model();
    await run(['selam'], m);
    for (const r of ['DEPO-CLAUDE-KURALI', 'DEPO-AGENTS-KURALI', 'DEPO-KOVAN-KURALI'])
      expect(sent(m)).toContain(r);
  });

  it('a huge notes file is cut, not carried whole', async () => {
    put(join(home, '.claude', 'CLAUDE.md'), `BAŞ ${'x'.repeat(50_000)} SON-İŞARET`);
    const m = model();
    await run(['selam'], m);
    expect(sent(m)).toContain('BAŞ');
    expect(sent(m)).not.toContain('SON-İŞARET');
  });
});

describe('custom slash commands', () => {
  it('the file is the prompt, with what you typed put where $ARGUMENTS is', async () => {
    put(
      join(repo, '.claude', 'commands', 'review.md'),
      '---\ndescription: Kod incele\n---\nŞu dosyayı incele: $ARGUMENTS. Sadece hataları yaz.\n',
    );
    const m = model();
    await run([], m, terminal(['/review src/a.ts', '/exit']));
    expect(sent(m)).toContain('Şu dosyayı incele: src/a.ts. Sadece hataları yaz.');
    expect(sent(m)).not.toContain('description: Kod incele'); // the frontmatter is not part of the prompt
  });

  it('works as one message too', async () => {
    put(join(repo, '.claude', 'commands', 'ozet.md'), 'Depoyu özetle: $1 klasörüne odaklan');
    const m = model();
    await run(['/ozet', 'lib'], m);
    expect(sent(m)).toContain('Depoyu özetle: lib klasörüne odaklan');
  });

  it('the repository’s own comes before yours, and your own folders work too', async () => {
    put(join(home, '.claude', 'commands', 'ben.md'), 'BENIM-KOMUTUM $ARGUMENTS');
    put(join(repo, '.kovan', 'commands', 'ben.md'), 'DEPONUN-KOMUTU $ARGUMENTS');
    put(join(home, '.claude', 'commands', 'sadece-ben.md'), 'SADECE-BENDE $ARGUMENTS');
    const m = model();
    await run([], m, terminal(['/ben x', '/sadece-ben y', '/exit']));
    expect(sent(m, 0)).toContain('DEPONUN-KOMUTU x');
    expect(sent(m, 1)).toContain('SADECE-BENDE y');
  });

  it('a command that is not there, and not a skill either, is said to be unknown and sends nothing', async () => {
    const m = model();
    const term = terminal(['/yok-boyle-bir-sey', '/exit']);
    await run([], m, term);
    expect(m.requests).toHaveLength(0);
    expect(term.text()).toContain('Unknown command');
  });

  it('a name that tries to leave the commands folder finds nothing', async () => {
    put(join(base, 'gizli.md'), 'SIZDI');
    const m = model();
    const term = terminal(['/../../gizli', '/exit']);
    await run([], m, term);
    expect(m.requests).toHaveLength(0); // not a command, so nothing was sent to the model
    expect(term.text()).toContain('Unknown command');
    expect(term.text()).not.toContain('SIZDI');
  });
});

describe('expandCommand', () => {
  it('replaces $ARGUMENTS and $1…$9', () => {
    expect(expandCommand('a $ARGUMENTS b', 'x y')).toBe('a x y b');
    expect(expandCommand('$2-$1', 'ilk ikinci')).toBe('ikinci-ilk');
    expect(expandCommand('$3', 'bir')).toBe('');
  });
  it('with no placeholder, the arguments follow the text; with no arguments, the text alone', () => {
    expect(expandCommand('Özetle', 'src')).toBe('Özetle\n\nsrc');
    expect(expandCommand('Özetle', '')).toBe('Özetle');
  });
});
