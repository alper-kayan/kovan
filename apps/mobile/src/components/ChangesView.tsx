import { mentionedTeammate, type Comment, type LaneEvent, type Session } from '@kovan/shared';
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ago, usd } from '../lib/board';
import { parseDiff, type DiffFile, type DiffLine } from '../lib/diff';
import { t, useLocale } from '../lib/i18n';
import { laneSpend, onCode, useChanges, useComments } from '../lib/review';
import { useSession } from '../lib/session';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';
import { ToastHost, useToast } from '../lib/toast';
import { Avatar, Button, Chip, T } from './ui';
import { useTeammates } from './AddTeammate';
import { MentionChips } from './Composer';

/** Lines shown per file before "Show more" (a phone renders every line it shows). */
const PAGE = 300;

const STATUS = {
  added: { mark: () => t('New'), word: () => t('added'), color: colors.okSoft },
  deleted: { mark: () => t('Deleted'), word: () => t('deleted'), color: colors.danger },
  modified: { mark: () => t('Changed'), word: () => t('modified'), color: colors.warn },
  renamed: { mark: () => t('Renamed'), word: () => t('renamed'), color: colors.purple },
} as const;

/** A pull request's state in a word. */
const prState = (state: string) =>
  state === 'open'
    ? t('open')
    : state === 'merged'
      ? t('merged')
      : state === 'closed'
        ? t('closed')
        : state;

type CodeComment = Comment & { anchor: { kind: 'file' | 'hunk'; path: string; endLine: number } };

/** Where a new comment goes: one line of the new version of a file. */
interface Target {
  path: string;
  line: number;
  text: string;
  commit: string | null;
  /** Replying in a thread instead. */
  parent?: CodeComment;
}

/**
 * A session's changes for review on the phone: the pull request, what was spent, every
 * changed file and its diff, and comments pinned to lines (the desktop shows them on the code).
 */
export function ChangesView({
  session,
  lanes,
  canComment,
}: {
  session: Session;
  lanes: Record<string, LaneEvent[]>;
  canComment: boolean;
}) {
  useLocale();
  const changes = useChanges(session);
  const { comments, add } = useComments(session.workspaceId, session.id);
  const [viewIndex, setViewIndex] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<Target | null>(null);

  const view = changes.views[Math.min(viewIndex, changes.views.length - 1)] ?? null;
  const files = useMemo(() => (view?.diff ? parseDiff(view.diff) : []), [view?.diff]);
  const spend = laneSpend(lanes, session.participants);
  const code = comments.filter(onCode) as CodeComment[];
  const threads = code.filter((c) => !c.parentId);
  const repliesOf = (id: string) => code.filter((c) => c.parentId === id);
  const shown = new Set(files.map((f) => f.path));
  const elsewhere = threads.filter((c) => !shown.has(c.anchor.path));
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  // With one file, its diff is what you came for.
  const isOpen = (path: string) => open[path] ?? files.length === 1;

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={s.content}>
        {session.pr && <PrCard pr={session.pr} />}
        {(session.cost > 0 || spend.length > 0) && (
          <View style={s.card}>
            <T style={s.cardTitle}>{t('Spent here: {amount}', { amount: usd(session.cost) })}</T>
            {spend.map((r) => (
              <View key={r.userId} style={s.spendRow}>
                <Avatar name={r.name} size={18} />
                <T style={[s.small, { flex: 1 }]}>{r.name}</T>
                <T muted mono style={s.small}>
                  {usd(r.cost)}
                </T>
              </View>
            ))}
          </View>
        )}

        {!changes.loaded ? (
          <ActivityIndicator color={colors.fg3} style={{ marginTop: 24 }} />
        ) : changes.error ? (
          <T style={{ color: colors.danger }}>{changes.error}</T>
        ) : (
          <>
            {changes.views.length > 1 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={s.sources}>
                  {changes.views.map((v, i) => (
                    <Pressable
                      key={v.userId}
                      onPress={() => setViewIndex(i)}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: v === view }}
                      style={[s.source, v === view && s.sourceOn]}
                    >
                      <T style={[s.small, v === view && { color: colors.fg }]}>
                        {v.userName} · {ago(v.updatedAt)}
                      </T>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}
            <T muted style={s.small}>
              {session.status === 'ended'
                ? t('The final diff, from the machine that ended the session.')
                : view && session.machine
                  ? t('From {machine}, {when}, when its agents finished.', {
                      machine: session.machine.name,
                      when: ago(view.updatedAt),
                    })
                  : view
                    ? t("From {name}'s desktop, {when}. It updates as agents work.", {
                        name: view.userName,
                        when: ago(view.updatedAt),
                      })
                    : session.machine
                      ? t(
                          'Nothing has come in yet. {machine} sends the changes when its agents finish.',
                          { machine: session.machine.name },
                        )
                      : t(
                          'Nothing has come in yet. Changes show up here while agents work on a desktop.',
                        )}
            </T>
            {view && files.length === 0 && (
              <T muted style={s.empty}>
                {t('No changes on this branch yet.')}
              </T>
            )}
            {files.length > 0 && (
              <T mono style={s.small}>
                {files.length === 1
                  ? t('{n} file', { n: files.length })
                  : t('{n} files', { n: files.length })}{' '}
                ·{' '}
                <T mono style={[s.small, { color: colors.okSoft }]}>
                  +{added}
                </T>{' '}
                <T mono style={[s.small, { color: colors.danger }]}>
                  −{removed}
                </T>
              </T>
            )}
            {files.map((f) => (
              <FileDiff
                key={f.path}
                file={f}
                open={isOpen(f.path)}
                onToggle={() => setOpen((o) => ({ ...o, [f.path]: !isOpen(f.path) }))}
                threads={threads.filter((c) => c.anchor.path === f.path)}
                repliesOf={repliesOf}
                canComment={canComment && session.status === 'active'}
                onLine={(line) =>
                  setTarget({
                    path: f.path,
                    line: line.newNo!,
                    text: line.text,
                    commit: view?.commit ?? null,
                  })
                }
                onReply={(parent) =>
                  setTarget({
                    path: parent.anchor.path,
                    line: parent.anchor.endLine,
                    text: '',
                    commit: null,
                    parent,
                  })
                }
              />
            ))}
            {elsewhere.length > 0 && (
              <View style={{ gap: 8 }}>
                <T style={s.section}>{t('COMMENTS ON OTHER CODE')}</T>
                {elsewhere.map((c) => (
                  <Thread
                    key={c.id}
                    comment={c}
                    replies={repliesOf(c.id)}
                    where
                    onReply={
                      canComment ? () => setTarget({ ...asTarget(c), parent: c }) : undefined
                    }
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
      {target && (
        <CommentSheet
          session={session}
          target={target}
          onClose={() => setTarget(null)}
          onSaved={(c) => {
            add(c);
            setTarget(null);
          }}
        />
      )}
    </>
  );
}

function asTarget(c: CodeComment): Target {
  return { path: c.anchor.path, line: c.anchor.endLine, text: '', commit: null };
}

function PrCard({ pr }: { pr: NonNullable<Session['pr']> }) {
  useLocale();
  const color =
    pr.state === 'merged' ? colors.purple : pr.state === 'open' ? colors.okSoft : colors.fg3;
  return (
    <Pressable
      onPress={() => void Linking.openURL(pr.url)}
      accessibilityRole="link"
      accessibilityLabel={t('Pull request {n}, {state}', {
        n: pr.number,
        state: prState(pr.state),
      })}
      style={({ pressed }) => [s.card, s.pr, pressed && { backgroundColor: colors.bg4 }]}
    >
      <GitPullRequest size={16} color={color} />
      <View style={{ flex: 1, gap: 2 }}>
        <T>{t('Pull request #{n}', { n: pr.number })}</T>
        <T muted numberOfLines={1} style={s.small}>
          {pr.url.replace(/^https?:\/\//, '')}
        </T>
      </View>
      <Chip color={color}>{prState(pr.state)}</Chip>
      <ExternalLink size={14} color={colors.fg3} />
    </Pressable>
  );
}

function FileDiff({
  file,
  open,
  onToggle,
  threads,
  repliesOf,
  canComment,
  onLine,
  onReply,
}: {
  file: DiffFile;
  open: boolean;
  onToggle(): void;
  threads: CodeComment[];
  repliesOf(id: string): CodeComment[];
  canComment: boolean;
  onLine(line: DiffLine): void;
  onReply(parent: CodeComment): void;
}) {
  useLocale();
  const [limit, setLimit] = useState(PAGE);
  const st = STATUS[file.status];
  const lines = file.hunks.flatMap((h) => [
    { header: h.header, key: `h${h.lines[0]?.oldNo ?? 0}-${h.lines[0]?.newNo ?? 0}` },
    ...h.lines,
  ]);
  const visible = lines.slice(0, limit);
  const at = (n: number | null) =>
    n === null ? [] : threads.filter((c) => c.anchor.endLine === n);
  const total = lines.length;
  // Comments on lines the diff doesn't show stay with the file, at the top.
  const shownLines = new Set(
    visible.flatMap((l) => ('kind' in l && l.newNo !== null ? [l.newNo] : [])),
  );
  const loose = threads.filter((c) => !shownLines.has(c.anchor.endLine));
  const open1 = threads.filter((c) => c.status === 'open').length;
  return (
    <View style={s.file}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t('{path}, {status}, {added} added, {removed} removed', {
          path: file.path,
          status: st.word(),
          added: file.added,
          removed: file.removed,
        })}
        style={s.fileHead}
      >
        {open ? (
          <ChevronDown size={14} color={colors.fg3} />
        ) : (
          <ChevronRight size={14} color={colors.fg3} />
        )}
        <T mono style={[s.mark, { color: st.color }]}>
          {st.mark()}
        </T>
        <T mono numberOfLines={1} style={[s.path, { flex: 1 }]}>
          {file.path}
        </T>
        {open1 > 0 && <Chip color={colors.warn}>{open1}</Chip>}
        <T mono style={[s.tiny, { color: colors.okSoft }]}>
          +{file.added}
        </T>
        <T mono style={[s.tiny, { color: colors.danger }]}>
          −{file.removed}
        </T>
      </Pressable>
      {open && (
        <View style={s.body}>
          {file.oldPath && (
            <T muted mono style={[s.tiny, s.pad]}>
              {t('Renamed from {path}', { path: file.oldPath })}
            </T>
          )}
          {file.binary && (
            <T muted style={[s.small, s.pad]}>
              {t('A binary file: nothing to show as text.')}
            </T>
          )}
          {loose.map((c) => (
            <View key={c.id} style={s.pad}>
              <Thread
                comment={c}
                replies={repliesOf(c.id)}
                where
                onReply={canComment ? () => onReply(c) : undefined}
              />
            </View>
          ))}
          {visible.map((l, i) => {
            if (!('kind' in l))
              return (
                <View key={`${l.key}-${i}`} style={s.hunk}>
                  <T muted mono style={s.tiny} numberOfLines={1}>
                    {l.header ? `@@ ${l.header}` : '@@'}
                  </T>
                </View>
              );
            const here = l.kind === 'del' ? [] : at(l.newNo);
            const can = canComment && l.kind !== 'del';
            return (
              <View key={i}>
                <Pressable
                  onPress={can ? () => onLine(l) : undefined}
                  disabled={!can}
                  accessibilityRole={can ? 'button' : undefined}
                  accessibilityLabel={
                    can
                      ? t('Comment on line {n}: {text}', {
                          n: l.newNo ?? '',
                          text: l.text.trim() || t('empty line'),
                        })
                      : undefined
                  }
                  style={({ pressed }) => [
                    s.line,
                    l.kind === 'add' && s.add,
                    l.kind === 'del' && s.del,
                    pressed && { backgroundColor: colors.bg4 },
                  ]}
                >
                  <T mono style={s.no}>
                    {l.kind === 'del' ? l.oldNo : l.newNo}
                  </T>
                  <T
                    mono
                    style={[
                      s.sign,
                      l.kind === 'add' && { color: colors.okSoft },
                      l.kind === 'del' && { color: colors.danger },
                    ]}
                  >
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                  </T>
                  <T mono style={s.code}>
                    {l.text || ' '}
                  </T>
                </Pressable>
                {here.map((c) => (
                  <View key={c.id} style={s.inline}>
                    <Thread
                      comment={c}
                      replies={repliesOf(c.id)}
                      onReply={canComment ? () => onReply(c) : undefined}
                    />
                  </View>
                ))}
              </View>
            );
          })}
          {total > limit && (
            <Pressable onPress={() => setLimit((n) => n + PAGE)} style={s.more}>
              <T muted style={s.small}>
                {t('Show {n} more of {total} lines', {
                  n: Math.min(PAGE, total - limit),
                  total: total - limit,
                })}
              </T>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

function Thread({
  comment,
  replies,
  where,
  onReply,
}: {
  comment: CodeComment;
  replies: CodeComment[];
  /** Say which file and line it is on (when it isn't next to the line). */
  where?: boolean;
  onReply?: () => void;
}) {
  useLocale();
  const { api } = useSession();
  const { show } = useToast();
  const resolved = comment.status === 'resolved';
  const toggle = async () => {
    try {
      await api('PATCH', `/api/comments/${comment.id}`, {
        status: resolved ? 'open' : 'resolved',
      });
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  return (
    <View style={[s.thread, resolved && { opacity: 0.6 }]}>
      {where && (
        <T muted mono style={s.tiny}>
          {comment.anchor.path}:{comment.anchor.endLine}
        </T>
      )}
      {[comment, ...replies].map((c) => (
        <View key={c.id} style={s.comment}>
          <Avatar name={c.authorName} size={20} ai={c.authorKind === 'agent'} />
          <View style={{ flex: 1, gap: 2 }}>
            <View style={s.who}>
              <T style={s.author}>{c.authorName}</T>
              <T muted style={s.tiny}>
                {ago(c.createdAt)}
              </T>
              {c.outdated && <Chip color={colors.warn}>{t('outdated')}</Chip>}
              {c.kind === 'suggestion' && <Chip>{t('suggestion')}</Chip>}
            </View>
            <T selectable style={s.body2}>
              {c.body}
            </T>
            {c.proposal ? (
              <T mono selectable style={s.proposal}>
                {c.proposal}
              </T>
            ) : null}
          </View>
        </View>
      ))}
      {onReply && (
        <View style={s.threadActions}>
          <Pressable onPress={onReply} hitSlop={6} accessibilityRole="button">
            <T style={s.link}>{t('Reply')}</T>
          </Pressable>
          <Pressable onPress={() => void toggle()} hitSlop={6} accessibilityRole="button">
            <T style={s.link}>{resolved ? t('Reopen') : t('Resolve')}</T>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function CommentSheet({
  session,
  target,
  onClose,
  onSaved,
}: {
  session: Session;
  target: Target;
  onClose(): void;
  onSaved(comment: Comment): void;
}) {
  useLocale();
  const { api, user } = useSession();
  const { show } = useToast();
  const insets = useSafeAreaInsets();
  const [body, setBody] = useState('');
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const { agents } = useTeammates(session.workspaceId);
  const teammates = agents ?? [];
  const save = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const anchor = target.parent
        ? target.parent.anchor
        : {
            kind: 'hunk' as const,
            path: target.path,
            startLine: target.line,
            endLine: target.line,
            snippet: target.text.trimEnd(),
            commit: target.commit,
          };
      const { comment } = await api<{ comment: Comment }>(
        'POST',
        `/api/workspaces/${session.workspaceId}/comments`,
        {
          sessionId: session.id,
          parentId: target.parent?.id ?? null,
          anchor,
          kind: 'comment',
          body: body.trim(),
        },
      );
      onSaved(comment);
      // "@Name" calls that AI teammate in: it reads the thread and the code, and answers in it.
      const called = mentionedTeammate(body, teammates);
      if (called) {
        const where = `${target.path}:${target.line}`;
        const thread = [
          ...(target.parent ? [`${target.parent.authorName}: ${target.parent.body}`] : []),
          `${user?.name ?? 'Someone'}: ${body.trim()}`,
        ].join('\n');
        const code =
          'snippet' in anchor && anchor.snippet ? `\n\nThe code:\n${anchor.snippet}` : '';
        await api('POST', `/api/sessions/${session.id}/mention`, {
          agentId: called.id,
          text: body.trim(),
          context: `A comment thread on ${where}:\n${thread}${code}`,
          reply: { kind: 'comment', commentId: target.parent?.id ?? comment.id },
        });
        show(t('Sent to {name}. Its answer comes back in this thread.', { name: called.name }));
      } else
        show(target.parent ? t('Replied.') : t('Comment added. Your team sees it on the code.'));
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Pressable
          style={s.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('Close')}
        />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <T style={s.sheetTitle}>
            {target.parent
              ? t('Reply to {name}', { name: target.parent.authorName })
              : t('Comment on this line')}
          </T>
          <T muted mono style={s.tiny}>
            {target.path}:{target.line}
          </T>
          {!target.parent && target.text.trim() !== '' && (
            <T mono numberOfLines={3} style={s.snippet}>
              {target.text}
            </T>
          )}
          <MentionChips
            text={body}
            caret={caret}
            teammates={teammates}
            onPick={(next) => {
              setBody(next.text);
              setCaret(next.caret);
            }}
          />
          <TextInput
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            value={body}
            onChangeText={(value) => {
              setBody(value);
              setCaret(value.length);
            }}
            onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
            multiline
            autoFocus
            placeholder={
              teammates.length
                ? t('What should change here, or @ a teammate to ask')
                : t("What should change here, or what's good about it")
            }
            placeholderTextColor={colors.fg4}
            style={s.input}
            accessibilityLabel={t('Your comment')}
          />
          <Button
            title={target.parent ? t('Reply') : t('Comment')}
            busy={busy}
            disabled={!body.trim()}
            onPress={save}
          />
          <Button title={t('Cancel')} kind="secondary" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
      <ToastHost />
    </Modal>
  );
}

const s = StyleSheet.create({
  content: { padding: 12, gap: 12, paddingBottom: 32 },
  card: {
    gap: 6,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  cardTitle: { fontFamily: fonts.uiMedium, fontSize: 14 },
  pr: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sources: { flexDirection: 'row', gap: 6 },
  source: {
    paddingHorizontal: 10,
    minHeight: 30,
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  sourceOn: { backgroundColor: colors.bg4, borderColor: colors.bg4 },
  section: {
    color: colors.fg3,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 4,
  },
  small: { fontSize: 12.5, lineHeight: 17, color: colors.fg3 },
  tiny: { fontSize: 11 },
  empty: { padding: 24, textAlign: 'center' },
  file: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    overflow: 'hidden',
  },
  fileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    minHeight: 42,
    backgroundColor: colors.bg3,
  },
  mark: { fontSize: 11 },
  path: { fontSize: 12.5, color: colors.fg },
  body: { borderTopWidth: 1, borderTopColor: colors.line },
  pad: { padding: 10 },
  hunk: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.bg3 },
  line: { flexDirection: 'row', paddingRight: 8, minHeight: 20 },
  add: { backgroundColor: '#13261c' },
  del: { backgroundColor: '#2a1718' },
  no: {
    width: 38,
    paddingRight: 6,
    textAlign: 'right',
    fontSize: 11,
    color: colors.fg4,
    lineHeight: 18,
  },
  sign: { width: 14, fontSize: 12, lineHeight: 18, color: colors.fg4 },
  code: { flex: 1, fontSize: 12, lineHeight: 18, color: colors.fg },
  inline: { padding: 8, backgroundColor: colors.bg },
  more: { padding: 12, alignItems: 'center' },
  thread: {
    gap: 8,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  comment: { flexDirection: 'row', gap: 8 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  author: { fontFamily: fonts.uiMedium, fontSize: 13 },
  body2: { fontSize: 14, lineHeight: 19 },
  proposal: {
    fontSize: 12,
    padding: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.bg2,
  },
  threadActions: { flexDirection: 'row', gap: 18, paddingLeft: 28 },
  link: { fontSize: 13, color: colors.fg2, fontFamily: fonts.uiMedium },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    gap: 10,
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  sheetTitle: { fontFamily: fonts.uiBold, fontSize: 17 },
  snippet: {
    fontSize: 12,
    padding: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.bg2,
    color: colors.fg2,
  },
  input: {
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
