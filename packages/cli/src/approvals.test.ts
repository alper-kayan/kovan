import { describe, expect, it } from 'vitest';
import { alwaysKey, alwaysLabel } from './approvals.js';

const cmd = (detail: string) => ({ kind: 'command' as const, tool: 'run_command', detail });

describe('always this command', () => {
  it('covers the same command with other arguments, not another command of the same tool', () => {
    expect(alwaysKey(cmd('npm test -- --watch'))).toBe(alwaysKey(cmd('npm test')));
    expect(alwaysKey(cmd('npm publish'))).not.toBe(alwaysKey(cmd('npm test')));
    expect(alwaysKey(cmd('git status'))).not.toBe(alwaysKey(cmd('git push --force')));
    expect(alwaysKey(cmd('ls -la'))).toBe(alwaysKey(cmd('ls')));
  });

  it('matches a chained or substituted command only word for word', () => {
    expect(alwaysKey(cmd('npm test && rm -rf /'))).not.toBe(alwaysKey(cmd('npm test')));
    expect(alwaysKey(cmd('echo $(cat ~/.ssh/id_rsa)'))).toBe('exact:echo $(cat ~/.ssh/id_rsa)');
    expect(alwaysKey(cmd('cat a | sh'))).toBe('exact:cat a | sh');
  });

  it('keeps tool-wide answers for edits and says what each covers', () => {
    expect(alwaysKey({ kind: 'edit', tool: 'edit_file', detail: 'src/a.ts' })).toBe(
      'tool:edit_file',
    );
    expect(alwaysLabel(cmd('npm test -- --watch'))).toBe('always "npm test …" this session');
    expect(alwaysLabel(cmd('a && b'))).toBe('always this exact command this session');
  });
});
