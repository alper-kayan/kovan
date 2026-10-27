import type { AiAgent } from '@kovan/shared';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { insertMention, mentionMatches, mentionQuery } from '../../../shared/mentions';
import { loadAiAgents } from '../services/swarm';
import { useStore } from '../store';
import { Avatar } from './ui';

/** The AI teammates of a workspace that can be called in with @ (loaded once when needed). */
export function useTeammates(workspaceId: string | null | undefined): AiAgent[] {
  const agents = useStore((s) => (workspaceId ? s.aiAgents[workspaceId] : undefined));
  useEffect(() => {
    if (workspaceId && !agents) void loadAiAgents(workspaceId);
  }, [workspaceId, agents]);
  return (agents ?? []).filter((a) => !a.archived);
}

/**
 * Typing "@" in a text box: the teammates whose name matches, picked with the arrows and
 * Enter or Tab. `keyDown` returns true when the menu took the key.
 */
export function useMentionMenu(
  text: string,
  setText: (text: string) => void,
  teammates: AiAgent[],
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
  const pick = (agent: AiAgent) => {
    const next = insertMention(text, caret, agent.name);
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
    <div className="menu menu-wide mention-menu" role="listbox" aria-label="Teammates">
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
          <Avatar name={a.name} size={18} />
          <span>
            <span className="menu-title">@{a.name}</span>
            <span className="menu-hint">
              {a.instructions?.split('\n')[0]?.slice(0, 90) || 'AI teammate'}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
