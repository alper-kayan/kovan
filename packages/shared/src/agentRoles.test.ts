import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLE_GROUPS,
  AGENT_ROLES,
  TEAMMATE_NAMES,
  agentRoleById,
  suggestRoleIds,
} from './agentRoles.js';
import { CreateAiAgentSchema } from './swarm.js';

describe('the role catalog', () => {
  it('has a good number of roles with unique ids, and every group is used', () => {
    expect(AGENT_ROLES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(AGENT_ROLES.map((r) => r.id)).size).toBe(AGENT_ROLES.length);
    for (const group of AGENT_ROLE_GROUPS)
      expect(AGENT_ROLES.some((r) => r.group === group)).toBe(true);
  });

  it('writes instructions the server accepts', () => {
    for (const role of AGENT_ROLES) {
      expect(role.instructions.length).toBeGreaterThanOrEqual(80);
      expect(role.instructions.length).toBeLessThanOrEqual(1000);
      const parsed = CreateAiAgentSchema.safeParse({
        name: 'Lena',
        model: 'kovan/jevrouter',
        effort: null,
        mode: 'allow',
        instructions: role.instructions,
        monthlyLimit: null,
      });
      expect(parsed.success, role.id).toBe(true);
    }
  });

  it('hands out names the server accepts as a person, without repeats', () => {
    expect(new Set(TEAMMATE_NAMES).size).toBe(TEAMMATE_NAMES.length);
    for (const name of TEAMMATE_NAMES) {
      const parsed = CreateAiAgentSchema.safeParse({
        name,
        model: 'm',
        effort: null,
        mode: 'allow',
        instructions: '',
        monthlyLimit: null,
      });
      expect(parsed.success, name).toBe(true);
    }
  });

  it('finds a role by id', () => {
    expect(agentRoleById('code-reviewer')?.group).toBe('Quality');
    expect(agentRoleById('nope')).toBeUndefined();
  });
});

describe('suggestRoleIds', () => {
  it('always starts with the lead', () => {
    expect(suggestRoleIds('do something')[0]).toBe('tech-lead');
  });

  it('picks the builders a goal points to', () => {
    const ids = suggestRoleIds(
      'Redesign the settings page component and add tests for the API endpoint',
    );
    expect(ids).toContain('frontend-developer');
    expect(ids.length).toBe(3);
  });

  it('falls back to a full-stack developer and a test engineer', () => {
    expect(suggestRoleIds('make it nicer')).toEqual([
      'tech-lead',
      'fullstack-developer',
      'test-automation-engineer',
    ]);
  });

  it('does not match short keywords inside other words', () => {
    // "ci" must not fire inside "decision", "ui" not inside "build"
    expect(suggestRoleIds('write the decision log')).not.toContain('devops-engineer');
  });
});
