import { AGENT_ROLES, CreateAiAgentSchema } from '@kovan/shared';
import { describe, expect, it } from 'vitest';
import { ROLE_PREFACE, roleInstructions } from './roleInstructions';

describe('roleInstructions', () => {
  it('gives every role except the lead its full text, and the lead its own', () => {
    for (const role of AGENT_ROLES) {
      const text = roleInstructions(role.id);
      if (role.id === 'tech-lead') {
        expect(text).toBe(role.instructions);
      } else {
        expect(text.startsWith(ROLE_PREFACE), role.id).toBe(true);
        expect(text.length, role.id).toBeGreaterThan(3000);
      }
    }
  });

  it('is accepted by the server for every role', () => {
    for (const role of AGENT_ROLES) {
      const parsed = CreateAiAgentSchema.safeParse({
        name: 'Lena',
        model: 'kovan/jevrouter',
        effort: null,
        mode: 'allow',
        instructions: roleInstructions(role.id),
        role: role.title,
        monthlyLimit: null,
      });
      expect(parsed.success, role.id).toBe(true);
    }
  });

  it('is empty for a role that does not exist', () => {
    expect(roleInstructions('nope')).toBe('');
  });
});
