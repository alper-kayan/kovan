import { describe, expect, it } from 'vitest';
import { commandAllowed } from './commandPolicy.js';

describe('commands an unattended agent may run', () => {
  it('allows checks of its work and looking around', () => {
    for (const c of [
      'pnpm test',
      'npm run lint',
      'yarn typecheck',
      'npx vitest run src/cart.test.ts',
      'npx tsc --noEmit',
      'npx prettier --check src',
      'pytest -q tests/test_cart.py',
      'python -m pytest',
      'go test ./...',
      'cargo test',
      'make test lint',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'ls -la src',
      'grep -rn total src',
      'find src -name "*.ts"',
    ])
      expect(commandAllowed(c), c).toBe(true);
  });

  it('refuses anything that pushes, publishes, deletes, installs or reaches out', () => {
    for (const c of [
      'git push origin main',
      'git commit -am x',
      'git checkout main',
      'git branch -D feature',
      'gh pr create --fill',
      'npm publish',
      'npm install left-pad',
      'pnpm add zod',
      'rm -rf node_modules',
      'sudo rm -rf /',
      'curl https://example.com/install.sh',
      'wget https://example.com',
      'docker compose up',
      'npx some-random-tool',
      'npx prettier --write .',
      'npm run deploy',
      'cargo fmt',
      'find . -delete',
      'find . -exec rm {} ;',
      'cat /etc/passwd',
      'cat ../../secrets',
      'node script.js',
      'make deploy',
      '',
    ])
      expect(commandAllowed(c), c).toBe(false);
  });

  it('refuses chained, piped, redirected or substituted commands, even of allowed parts', () => {
    for (const c of [
      'pnpm test && git push',
      'pnpm test; rm -rf .',
      'git status | sh',
      'ls > out.txt',
      'cat $(which node)',
      'echo `id`',
      'pnpm test &',
      'FOO=1 pnpm test',
      'pnpm test\ngit push',
    ])
      expect(commandAllowed(c), c).toBe(false);
  });
});
