import type { AiAgent } from '@kovan/shared';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { insertMention, mentionMatches, mentionQuery } from '../../../shared/mentions';
import { loadAiAgents } from '../services/swarm';
import { reloadMembers } from '../services/team';
import { useStore } from '../store';
import { Avatar } from './ui';

/** Someone "@" can name: an AI teammate (called in to answer) or a person (told about it). */
export interface MentionTarget {
  id: string;
  name: string;
  kind: 'ai' | 'person';
  hint: string;
  avatarUrl?: string | null;
}

/** The AI teammates of a workspace that can be called in with @ (loaded once when needed). */
export function useTeammates(workspaceId: string | null | undefined): AiAgent[] {
  const agents = useStore((s) => (workspaceId ? s.aiAgents[workspaceId] : undefined));
  useEffect(() => {
    if (workspaceId && !agents) void loadAiAgents(workspaceId);
  }, [workspaceId, agents]);
  return useMemo(() => (agents ?? []).filter((a) => !a.archived), [agents]);
}

const aiTargets = (agents: AiAgent[]): MentionTarget[] =>
  agents.map((a) => ({
    id: a.id,
    name: a.name,
    kind: 'ai',
    hint: a.instructions?.split('\n')[0]?.slice(0, 90) || 'AI teammate',
  }));

/** What "@" lists in a chat with your agent: the AI teammates it can call in. */
export function useAiTargets(workspaceId: string | null | undefined): MentionTarget[] {
  const agents = useTeammates(workspaceId);
  return useMemo(() => aiTargets(agents), [agents]);
}

/**
 * What "@" lists in a comment: the AI teammates, then the people of the workspace (not you),
 * who get a notification when named.
 */
export function useCommentTargets(workspaceId: string | null | undefined): MentionTarget[] {
  const agents = useTeammates(workspaceId);
  const members = useStore((s) => (workspaceId ? s.members[workspaceId] : undefined));
  const me = useStore((s) => s.user?.id);
  useEffect(() => {
    if (workspaceId && !members) void reloadMembers(workspaceId);
  }, [workspaceId, members]);
  return useMemo(
    () => [
      ...aiTargets(agents),
      ...(members?.members ?? [])
        .filter((m) => m.kind === 'human' && m.userId !== me)
        .map((m): MentionTarget => ({
          id: m.userId,
          name: m.name,
          kind: 'person',
          hint: m.githubLogin ? `@${m.githubLogin} · gets a notification` : 'Gets a notification',
          avatarUrl: m.avatarUrl,
        })),
    ],
    [agents, members, me],
  );
}

/**
 * Typing "@" in a text box: the names that match, picked with the arrows and
 * Enter or Tab. `keyDown` returns true when the menu took the key.
 */
export function useMentionMenu(
  text: string,
  setText: (text: string) => void,
  teammates: MentionTarget[],
  input: React.RefObject<HTMLTextAreaElement | null>,
) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const query = teammates.length ? mentionQuery(text, caret) : null;
  const matches =
    query !== null && closedFor !== text ? mentionMatches(query, teammates).slice(0, 8) : [];
  useEffect(() => setActive(0), [query]);
  const index = Math.min(active, Math.max(0, matches.length - 1));
  const pick = (target: MentionTarget) => {
    const next = insertMention(text, caret, target.name);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  return {
    matches,
    active: index,
    pick,
    /** Keep in step with the box's caret (on change, click and arrow keys). */
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length),
    keyDown: (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!matches.length || e.nativeEvent.isComposing) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const by = e.key === 'ArrowDown' ? 1 : -1;
        setActive((index + by + matches.length) % matches.length);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pick(matches[index]!);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setClosedFor(text);
        return true;
      }
      return false;
    },
  };
}

export function MentionMenu({ menu }: { menu: ReturnType<typeof useMentionMenu> }) {
  if (!menu.matches.length) return null;
  return (
    <div className="menu menu-wide mention-menu" role="listbox" aria-label="Who to mention">
      {menu.matches.map((a, i) => (
        <button
          key={a.id}
          role="option"
          aria-selected={i === menu.active}
          className={`menu-item ${i === menu.active ? 'on' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep the focus in the box
            menu.pick(a);
          }}
        >
          <Avatar name={a.name} src={a.avatarUrl ?? null} size={18} />
          <span>
            <span className="menu-title">
              @{a.name}
              {a.kind === 'ai' && <span className="ai-badge">AI</span>}
            </span>
            <span className="menu-hint">{a.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
