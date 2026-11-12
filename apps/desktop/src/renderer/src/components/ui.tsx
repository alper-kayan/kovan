import { KOVAN_AVATAR } from '@kovan/shared';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

const PERSON_COLORS = ['--u-pink', '--u-blue', '--u-teal', '--u-orange', '--u-purple'];
/** The colors a workspace's icon can have (picked by name until its owner chooses one). */
export const WORKSPACE_COLORS = [
  '#f06595',
  '#8b8f96',
  '#e5484d',
  '#f76b15',
  '#e5a000',
  '#30a46c',
  '#12a594',
  '#8e4ec6',
  '#d6409f',
];

function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.slice(0, 2);
  return letters.toUpperCase();
}

export function personColor(name: string): string {
  return `var(${PERSON_COLORS[hash(name) % PERSON_COLORS.length]})`;
}

export function Avatar({
  name,
  src,
  size = 26,
  online,
}: {
  name: string;
  src?: string | null;
  size?: number;
  /** Shows a presence dot when set. */
  online?: boolean;
}) {
  // Kovan's own picture: the initials on the dark theme instead of a photo.
  const kovan = src === KOVAN_AVATAR;
  return (
    <span
      className={kovan ? 'avatar avatar-kovan' : 'avatar'}
      style={{
        width: size,
        height: size,
        ...(kovan ? {} : { background: personColor(name) }),
        fontSize: size * 0.36,
      }}
      title={name}
    >
      {src && !kovan ? <img src={src} alt="" width={size} height={size} /> : initials(name)}
      {online !== undefined && <span className={`presence-dot ${online ? 'on' : ''}`} />}
    </span>
  );
}

export function WorkspaceIcon({ name, color }: { name: string; color?: string | null }) {
  return (
    <span
      className="ws-icon"
      style={{ background: color ?? WORKSPACE_COLORS[hash(name) % WORKSPACE_COLORS.length] }}
    >
      {initials(name)}
    </span>
  );
}

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error';

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: 'Nothing running',
  running: 'Working',
  waiting: 'Needs a yes',
  error: 'Error',
};

/** Full-width status pill on session cards: ○ Idle, (•) Running, and so on. */
export function StatusPill({ status }: { status: SessionStatus }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Overlapping avatars, as at the bottom of a session card. */
export function AvatarStack({
  people,
  size = 20,
  max = 5,
}: {
  people: { name: string; avatarUrl?: string | null }[];
  size?: number;
  max?: number;
}) {
  const shown = people.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((p) => (
        <Avatar key={p.name} name={p.name} src={p.avatarUrl ?? null} size={size} />
      ))}
      {people.length > max && <span className="avatar-more">+{people.length - max}</span>}
    </span>
  );
}

/** Small circular progress ring, as next to "Getting started". */
export function ProgressRing({
  value,
  total,
  size = 14,
}: {
  value: number;
  total: number;
  size?: number;
}) {
  const r = (size - 2) / 2;
  const c = 2 * Math.PI * r;
  const done = total === 0 ? 0 : value / total;
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--line2)"
        strokeWidth={1.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--fg2)"
        strokeWidth={1.5}
        strokeDasharray={`${c * done} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The Off | On control used instead of switches. */
export function OnOff({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Segmented
      value={value ? 'on' : 'off'}
      options={[
        { value: 'off', label: 'Off' },
        { value: 'on', label: 'On' },
      ]}
      onChange={(v) => onChange(v === 'on')}
    />
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">{icon}</div>
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

/**
 * Keeps a composer popover (menu, model picker) on screen. It opens above its anchor, fixed to
 * the window rather than inside its lane, so a narrow lane or the panel edge can't clip it, and
 * slides sideways to stay within the window.
 */
export function useFloating<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(el.offsetWidth, window.innerWidth - 2 * margin);
      const left = Math.min(Math.max(margin, a.right - width), window.innerWidth - width - margin);
      Object.assign(el.style, {
        position: 'fixed',
        left: `${left}px`,
        right: 'auto',
        top: 'auto',
        bottom: `${window.innerHeight - a.top + 6}px`,
        maxWidth: `${window.innerWidth - 2 * margin}px`,
        maxHeight: `${Math.max(160, a.top - 2 * margin)}px`,
        overflowY: 'auto',
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []);
  return ref;
}

/**
 * A row that is clicked (it holds buttons of its own, so it can't be a button) also works from
 * the keyboard: in the Tab order, Enter or Space does what a click does.
 */
export function pressable(run: () => void, label?: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    ...(label ? { 'aria-label': label } : {}),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      run();
    },
  };
}
