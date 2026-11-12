import { foldEvents, type ConversationEvent } from './agent.js';

export {
  insertMention,
  mentionedPeople,
  mentionedTeammate,
  mentionMatches,
  mentionQuery,
  type Mentionable,
} from '@kovan/shared';

/** How much of a conversation a called-in teammate reads (its newest part). */
const DIGEST_CHARS = 20_000;

/**
 * A conversation as a called-in teammate reads it: who said what, what the agent did (its
 * tool rows in one line each), newest last, cut from the start to a readable size.
 */
export function conversationDigest(events: ConversationEvent[], person: string): string | null {
  const lines: string[] = [];
  for (const item of foldEvents(events)) {
    if (item.kind === 'prompt') lines.push(`${person}: ${item.text}`);
    else if (item.kind === 'mention') lines.push(`${person} to @${item.name}: ${item.text}`);
    else if (item.kind === 'teammate' && item.text) lines.push(`${item.name}: ${item.text}`);
    else if (item.kind === 'text' && item.text.trim()) lines.push(`Agent: ${item.text.trim()}`);
    else if (item.kind === 'tool')
      lines.push(`  [${item.status === 'denied' ? 'denied' : item.name}] ${item.summary}`);
    else if (item.kind === 'note') lines.push(`  (${item.text})`);
  }
  if (!lines.length) return null;
  let out = '';
  for (const line of lines.reverse()) {
    const clipped = line.length > 4000 ? `${line.slice(0, 4000)}…` : line;
    if (out.length + clipped.length + 1 > DIGEST_CHARS) {
      out = `(earlier messages left out)\n${out}`;
      break;
    }
    out = out ? `${clipped}\n${out}` : clipped;
  }
  return out;
}
