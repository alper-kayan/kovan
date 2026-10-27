import { describe, expect, it } from 'vitest';
import { parseBeforeBuild, parseRequiredChecks } from './prompt.js';

describe('parseBeforeBuild', () => {
  it('reads the code blocks under the Before Build heading, and only those', () => {
    const md = [
      '# Rules',
      '```sh',
      'echo not this',
      '```',
      '## Before Build',
      'Install first.',
      '```sh',
      'pnpm install --frozen-lockfile',
      '```',
      '- `pnpm --filter @kovan/shared build`',
      '```bash',
      'cp .env.example .env',
      'echo ready',
      '```',
      '### A subsection still counts',
      '- `docker compose up -d db`',
      '## Testing',
      '```sh',
      'pnpm test',
      '```',
    ].join('\n');
    expect(parseBeforeBuild(md)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm --filter @kovan/shared build',
      'cp .env.example .env\necho ready',
      'docker compose up -d db',
    ]);
  });

  it('is empty without the section', () => {
    expect(parseBeforeBuild('# Rules\n\nBe nice.\n')).toEqual([]);
  });
});

describe('parseRequiredChecks', () => {
  it('reads the commands under "Required Checks", apart from Before Build', () => {
    const md = [
      '# Rules',
      '## Before Build',
      '- `pnpm install`',
      '## Required Checks',
      '- `pnpm typecheck`',
      '```sh',
      'pnpm test --run',
      '```',
      '## Other',
      '- `not this`',
    ].join('\n');
    expect(parseRequiredChecks(md)).toEqual(['pnpm typecheck', 'pnpm test --run']);
    expect(parseBeforeBuild(md)).toEqual(['pnpm install']);
  });
});
