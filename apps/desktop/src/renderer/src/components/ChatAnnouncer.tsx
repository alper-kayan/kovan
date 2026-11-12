import { useEffect, useRef, useState } from 'react';
import { formatAccelerator, resolveKeybindings } from '../../../shared/keybindings';
import type { ChatItem } from '../../../shared/agent';
import { useStore } from '../store';

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * What a screen reader should hear about your own chat, said once each: the agent started,
 * it asks for approval (at once, with the key that reaches the buttons), and how the turn
 * ended with the start of its answer. The transcript itself isn't a live region: streaming text
 * would be read out word by word.
 */
export function ChatAnnouncer({ items, running }: { items: ChatItem[]; running: boolean }) {
  const [polite, setPolite] = useState('');
  const [urgent, setUrgent] = useState('');
  const asked = useRef(new Set<string>());
  const wasRunning = useRef(running);
  const isMac = useStore((s) => s.isMac);
  const bindings = useStore((s) => s.settings.keybindings);

  useEffect(() => {
    for (const item of items) {
      if (item.kind !== 'tool' || item.status !== 'waiting' || !item.approval) continue;
      if (asked.current.has(item.approval.id)) continue;
      asked.current.add(item.approval.id);
      const key = resolveKeybindings(bindings)['agent.approval'];
      setUrgent(
        `Your agent asks: ${clip(item.approval.title, 120)}.${key ? ` Press ${formatAccelerator(key, isMac)} to answer.` : ''}`,
      );
    }
  }, [items, bindings, isMac]);

  useEffect(() => {
    if (running && !wasRunning.current) setPolite('Agent is working.');
    if (!running && wasRunning.current) {
      const end = [...items].reverse().find((i) => i.kind === 'end');
      const reply = [...items].reverse().find((i) => i.kind === 'text');
      if (end?.kind === 'end' && end.reason === 'error')
        setPolite(`Agent stopped with an error: ${clip(end.error ?? 'unknown error', 200)}`);
      else if (end?.kind === 'end' && end.reason === 'stopped') setPolite('Agent stopped.');
      else
        setPolite(
          `Agent finished.${reply?.kind === 'text' ? ` ${clip(reply.text.trim(), 300)}` : ''}`,
        );
    }
    wasRunning.current = running;
  }, [running, items]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive">
        {urgent}
      </div>
    </>
  );
}
