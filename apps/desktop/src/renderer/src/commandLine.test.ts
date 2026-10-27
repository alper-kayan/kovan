import { describe, expect, it } from 'vitest';
import { joinCommand, splitCommand } from './commandLine';

describe('command lines', () => {
  it('split like a shell', () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-github')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
    expect(splitCommand(`node "my server.js" --name 'a b' x\\ y ""`)).toEqual([
      'node',
      'my server.js',
      '--name',
      'a b',
      'x y',
      '',
    ]);
  });

  it('join back to the same arguments', () => {
    const args = ['node', '/a b/server.js', "it's", '--flag=1'];
    expect(splitCommand(joinCommand(args))).toEqual(args);
  });
});
