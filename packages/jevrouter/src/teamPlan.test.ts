import { describe, expect, it } from 'vitest';
import { goalParts, suggestTeam, type TeamCandidate } from './teamPlan.js';

const TEAM: TeamCandidate[] = [
  { id: 'bob', name: 'Bob', instructions: 'Writes small, focused code changes.' },
  { id: 'wren', name: 'Wren', instructions: 'Leads: plans the work and reviews the results.' },
  { id: 'tess', name: 'Tess', instructions: 'Writes tests first and keeps coverage high.' },
  { id: 'moss', name: 'Moss', instructions: 'Database work and migrations.' },
];

describe('goalParts', () => {
  it('counts the pieces a goal lists', () => {
    expect(goalParts('Fix the typo in the README')).toBe(1);
    expect(goalParts('Add median(), range() and a summary()')).toBe(3);
    expect(goalParts('- add login\n- add logout\n- add a session table')).toBe(3);
  });
});

describe('suggestTeam', () => {
  it('keeps a small goal to one agent', () => {
    expect(suggestTeam('Fix the typo in the README', TEAM)).toMatchObject({
      leadId: 'wren',
      workerIds: [],
      maxParallel: 1,
    });
    expect(suggestTeam('Fix the typo in the README', TEAM)!.reason).toContain(
      "Wren alone: more agents wouldn't pay off",
    );
  });

  it('adds workers for more pieces, picking those whose instructions fit', () => {
    const s = suggestTeam('Add median() and range() helpers with tests', TEAM)!;
    expect(s.leadId).toBe('wren');
    expect(s.workerIds).toHaveLength(2);
    expect(s.workerIds[0]).toBe('tess');
    expect(s.maxParallel).toBe(2);
  });

  it('goes to three workers for a goal with many parts', () => {
    const s = suggestTeam(
      'Add a users table migration, a sign-up endpoint, a login page and tests across the whole codebase',
      TEAM,
    )!;
    expect(s.workerIds).toHaveLength(3);
    expect(s.workerIds).toContain('moss');
    expect(s.reason).toMatch(/difficulty \d\/5, 4 parts/);
  });

  it('says when there are fewer teammates than the goal wants', () => {
    const s = suggestTeam('Add login, logout, sign-up and a profile page across the app', [
      TEAM[1]!,
      TEAM[0]!,
    ])!;
    expect(s.workerIds).toEqual(['bob']);
    expect(s.reason).toContain('(only 1 other teammate free)');
  });

  it('has nothing to suggest without a goal or teammates', () => {
    expect(suggestTeam('', TEAM)).toBeNull();
    expect(suggestTeam('Add login', [])).toBeNull();
  });

  it('keeps a Solo workspace to two workers, and flags a goal one agent can do', () => {
    const goal =
      'Add a users table migration, a sign-up endpoint, a login page and tests across the whole codebase';
    expect(suggestTeam(goal, TEAM, { maxWorkers: 2 })!.workerIds).toHaveLength(2);
    expect(suggestTeam('Fix the typo in the README', TEAM)!.small).toBe(true);
    expect(suggestTeam(goal, TEAM)!.small).toBe(false);
  });
});
