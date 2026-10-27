import { describe, expect, it } from 'vitest';
import { ACTION_MIN_ROLE, can, hasAtLeast, RoleSchema, type Action } from './roles.js';

describe('roles', () => {
  it('orders roles viewer < commenter < editor < owner', () => {
    expect(hasAtLeast('owner', 'editor')).toBe(true);
    expect(hasAtLeast('editor', 'commenter')).toBe(true);
    expect(hasAtLeast('commenter', 'editor')).toBe(false);
    expect(hasAtLeast('viewer', 'viewer')).toBe(true);
  });

  it('lets viewers only read', () => {
    expect(can('viewer', 'transcript.view')).toBe(true);
    expect(can('viewer', 'comment.create')).toBe(false);
  });

  it('lets commenters hold work without running agents', () => {
    expect(can('commenter', 'work.claim')).toBe(true);
    expect(can('commenter', 'agent.prompt')).toBe(false);
  });

  it('reserves membership and deletion for owners', () => {
    expect(can('editor', 'approval.answer')).toBe(true);
    expect(can('editor', 'workspace.delete')).toBe(false);
    expect(can('owner', 'workspace.delete')).toBe(true);
  });

  it('grants owners every action', () => {
    for (const action of Object.keys(ACTION_MIN_ROLE) as Action[]) {
      expect(can('owner', action)).toBe(true);
    }
  });

  it('rejects unknown roles at the boundary', () => {
    expect(RoleSchema.safeParse('admin').success).toBe(false);
  });
});
