import type { ChatRequest, StreamEvent } from '@kovan/model-gateway';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, type AgentEvent, type ModelStreamer } from './agent.js';
import { readAgentFiles } from './prompt.js';
import {
  discoverSkills,
  parseFrontmatter,
  parseSkillCommand,
  skillCatalog,
  type SkillPlaces,
} from './skills.js';

let base: string;
let repo: string;
let places: SkillPlaces;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'kovan-skills-'));
  repo = join(base, 'repo');
  places = {
    root: repo,
    userDir: join(base, 'user-skills'),
    claudeDir: join(base, 'claude-skills'),
  };
  await mkdir(repo, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function skill(dir: string, folder: string, frontmatter: string, body = 'Do the thing.') {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe('frontmatter', () => {
  it('reads plain, quoted and folded values and skips lists', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'name: release-notes',
        'description: >',
        '  Writes release notes',
        '  from merged changes.',
        'allowed-tools:',
        '  - Read',
        "title: 'It''s quoted'",
        '---',
        '# Body',
      ].join('\n'),
    );
    expect(parsed?.data).toMatchObject({
      name: 'release-notes',
      description: 'Writes release notes from merged changes.',
      title: "It's quoted",
    });
    expect(parsed?.body).toBe('# Body');
    expect(parseFrontmatter('# no frontmatter')).toBeNull();
    expect(parseFrontmatter('---\nname: x\n')).toBeNull();
  });
});

describe('discovering skills', () => {
  it('looks in four places, the higher one winning a clash, and warns about broken ones', async () => {
    await skill(join(repo, '.kovan/skills'), 'release-notes', 'description: Kovan one');
    await skill(
      join(repo, '.claude/skills'),
      'release-notes',
      'name: release-notes\ndescription: Claude repo one',
    );
    await skill(join(repo, '.claude/skills'), 'changelog', 'description: Changelog');
    await skill(places.userDir!, 'mine', 'description: Mine');
    await skill(places.claudeDir!, 'from-claude', 'description: From Claude Code');
    await skill(places.userDir!, 'broken', 'name: broken'); // no description
    await mkdir(join(places.userDir!, 'nothing'), { recursive: true }); // no SKILL.md: ignored
    await skill(places.userDir!, 'bad-name', 'name: Bad Name\ndescription: x');

    const found = await discoverSkills({ ...places, off: ['changelog'] });
    expect(found.skills.map((s) => [s.name, s.source, s.description, s.enabled])).toEqual([
      ['release-notes', 'repo', 'Kovan one', true],
      ['changelog', 'repo-claude', 'Changelog', false],
      ['mine', 'user', 'Mine', true],
      ['from-claude', 'claude-code', 'From Claude Code', true],
    ]);
    expect(found.warnings.map((w) => w.problem)).toEqual([
      expect.stringContaining("isn't valid"),
      'No description in the frontmatter',
    ]);

    // Claude Code's skills only when the person chose them.
    const without = await discoverSkills({ ...places, claudeDir: null });
    expect(without.skills.map((s) => s.name)).not.toContain('from-claude');
  });

  it('lists only names and descriptions, and only switched-on skills', async () => {
    await skill(places.userDir!, 'a', 'description: Does A', 'SECRET BODY');
    await skill(places.userDir!, 'b', 'description: Does B');
    const { skills } = await discoverSkills({ ...places, off: ['b'] });
    const catalog = skillCatalog(skills)!;
    expect(catalog).toContain('- a: Does A');
    expect(catalog).not.toContain('Does B');
    expect(catalog).not.toContain('SECRET BODY');
    expect(skillCatalog([])).toBeNull();
    expect(parseSkillCommand('/a for 2.1', skills)?.rest).toBe('for 2.1');
    expect(parseSkillCommand('/b', skills)).toBeNull();
    expect(parseSkillCommand('/unknown x', skills)).toBeNull();
  });
});

describe('repository notes for agents', () => {
  it('reads KOVAN.md, AGENTS.md and CLAUDE.md, leaving out imports of what is already there', async () => {
    await writeFile(join(repo, 'KOVAN.md'), 'Kovan rules');
    await writeFile(join(repo, 'AGENTS.md'), 'Agent rules');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    const text = await readAgentFiles(repo);
    expect(text).toContain("The repository's KOVAN.md:\nKovan rules");
    expect(text).toContain("The repository's AGENTS.md:\nAgent rules");
    expect(text).not.toContain('CLAUDE.md');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\nAlso this.');
    expect(await readAgentFiles(repo)).toContain("The repository's CLAUDE.md:\nAlso this.");
  });
});

describe('an agent with skills', () => {
  type Step = StreamEvent[];
  const done: StreamEvent = {
    type: 'done',
    finishReason: 'stop',
    model: 'test/model',
    reasoningDetails: [],
    usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, cost: 0 },
  };
  const call = (id: string, name: string, args: object): StreamEvent => ({
    type: 'tool_call',
    call: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  });
  function scripted(steps: Step[]): ModelStreamer & { requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    return {
      requests,
      async *stream(request) {
        requests.push(structuredClone(request));
        for (const event of steps.shift() ?? []) yield event;
      },
    };
  }
  function agent(model: ModelStreamer) {
    const events: AgentEvent[] = [];
    const a = new Agent({
      model,
      modelId: 'test/model',
      effort: null,
      mode: 'request',
      root: repo,
      isRepo: false,
      systemPrompt: 'system',
      approve: async () => true,
      onEvent: (e) => events.push(e),
      skills: () => discoverSkills(places),
    });
    return { agent: a, events };
  }

  it('sees the list, loads a skill and reads its files outside the workspace, but cannot write there', async () => {
    await skill(
      places.userDir!,
      'release-notes',
      'description: Writes release notes',
      'Use the template in template.md.',
    );
    await writeFile(join(places.userDir!, 'release-notes', 'template.md'), '## Added');
    const template = join(places.userDir!, 'release-notes', 'template.md');
    const model = scripted([
      [call('1', 'use_skill', { name: 'release-notes' }), done],
      [
        call('2', 'read_file', { path: template }),
        call('3', 'write_file', { path: template, content: 'x' }),
        call('4', 'read_file', { path: join(base, 'outside.txt') }),
        done,
      ],
      [{ type: 'text', text: 'Done' }, done],
    ]);
    await writeFile(join(base, 'outside.txt'), 'private');
    const { agent: a, events } = agent(model);
    await a.send('Write the release notes');

    const first = model.requests[0]!;
    expect(first.tools?.map((t) => t.name)).toContain('use_skill');
    expect(JSON.stringify(first.messages)).toContain('- release-notes: Writes release notes');
    expect(JSON.stringify(first.messages)).not.toContain('Use the template');
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends[0]).toMatchObject({ ok: true });
    expect((ends[0] as { output: string }).output).toContain('Use the template in template.md.');
    expect((ends[0] as { output: string }).output).toContain('template.md');
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      summary: 'Used skill release-notes',
    });
    expect(ends[1]).toMatchObject({ ok: true, output: expect.stringContaining('## Added') });
    expect(ends[2]).toMatchObject({ ok: false, output: expect.stringContaining('outside') });
    expect(ends[3]).toMatchObject({ ok: false, output: expect.stringContaining('outside') });
  });

  it('loads a skill the person invoked with /name together with their message', async () => {
    await skill(join(repo, '.kovan/skills'), 'release-notes', 'description: Notes', 'STEPS');
    const model = scripted([[{ type: 'text', text: 'ok' }, done]]);
    const { agent: a, events } = agent(model);
    await a.send('/release-notes for 2.1');
    const user = model.requests[0]!.messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('/release-notes for 2.1');
    expect(user?.content).toContain('STEPS');
    expect(user?.content).toContain('.kovan/skills/release-notes');
    expect(events.find((e) => e.type === 'tool_start')).toMatchObject({
      name: 'use_skill',
      summary: 'Used skill release-notes',
    });
  });

  it("names a plugin's skills plugin:skill and lets the person invoke them", async () => {
    const plugin = join(base, 'plugins', 'release-tools', 'skills');
    await skill(plugin, 'notes', 'description: Plugin notes');
    await skill(places.userDir!, 'notes', 'description: Mine');
    const { skills } = await discoverSkills({
      ...places,
      plugins: [{ name: 'release-tools', dir: plugin }],
    });
    expect(skills.map((s) => [s.name, s.source, s.plugin])).toEqual([
      ['notes', 'user', undefined],
      ['release-tools:notes', 'plugin', 'release-tools'],
    ]);
    expect(parseSkillCommand('/release-tools:notes for 2.1', skills)).toMatchObject({
      skill: { name: 'release-tools:notes' },
      rest: 'for 2.1',
    });
  });

  it('follows a linked skill folder', async () => {
    await skill(join(base, 'elsewhere'), 'linked', 'description: Linked');
    await mkdir(places.userDir!, { recursive: true });
    await symlink(join(base, 'elsewhere', 'linked'), join(places.userDir!, 'linked'));
    expect((await discoverSkills(places)).skills.map((s) => s.name)).toEqual(['linked']);
  });
});
