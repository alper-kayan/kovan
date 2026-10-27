import type { LaneEvent, Participant, SessionApproval } from '@kovan/shared';
import { Check, CircleAlert, CircleHelp, LoaderCircle, Minus, X } from 'lucide-react-native';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { harnessName, STATE_LABEL, usd } from '../lib/board';
import { foldLane, type LaneItem, toolLabel } from '../lib/lanes';
import { colors, fonts, radius, STATE_COLOR, tint } from '../lib/theme';
import { useActions } from '../lib/actions';
import { Act, Avatar, T } from './ui';

/** CLI lanes report "claude-code · claude-haiku-5-5"; the harness is already named. */
export function agentLine(p: Participant): string {
  const harness = harnessName(p.harness);
  const model = p.model?.replace(`${p.harness} · `, '') ?? null;
  return [harness, model && model !== 'default' ? model : null].filter(Boolean).join(' · ');
}

const TOOL_ICON = {
  running: { Icon: LoaderCircle, color: colors.fg3 },
  waiting: { Icon: CircleHelp, color: colors.warn },
  ok: { Icon: Check, color: colors.okSoft },
  failed: { Icon: X, color: colors.danger },
  denied: { Icon: Minus, color: colors.fg4 },
} as const;

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      accessibilityRole="button"
      accessibilityHint="Shows the agent's thinking"
    >
      <T muted numberOfLines={open ? undefined : 2} style={s.reasoning}>
        Thinking: {text.trim()}
      </T>
    </Pressable>
  );
}

const TEAMMATE_STATUS = {
  working: 'looking into it…',
  answered: 'answered',
  changed: 'answered · its change joined',
  failed: "couldn't finish",
  stopped: 'stopped',
} as const;

const Item = memo(function Item({ item }: { item: LaneItem }) {
  switch (item.kind) {
    case 'prompt':
      return (
        <View style={s.prompt}>
          <T selectable style={s.promptText}>
            {item.text}
          </T>
        </View>
      );
    case 'text':
      return (
        <T selectable style={s.text}>
          {item.text.trim()}
        </T>
      );
    case 'reasoning':
      return <Reasoning text={item.text} />;
    case 'tool': {
      const { Icon, color } = TOOL_ICON[item.status];
      return (
        <View style={s.tool}>
          <Icon size={13} color={color} />
          <T style={s.toolName}>{toolLabel(item.name)}</T>
          <T muted mono numberOfLines={1} style={s.toolSummary}>
            {item.summary}
          </T>
          {item.added !== null && <T style={[s.diff, { color: colors.okSoft }]}>+{item.added}</T>}
          {item.removed !== null && (
            <T style={[s.diff, { color: colors.danger }]}>−{item.removed}</T>
          )}
        </View>
      );
    }
    case 'note':
      return (
        <T style={[s.note, { color: item.tone === 'warn' ? colors.warn : colors.fg3 }]}>
          {item.text}
        </T>
      );
    case 'mention':
      return (
        <View style={s.prompt}>
          <T muted style={s.mentionTo}>
            to @{item.name}
          </T>
          <T selectable style={s.promptText}>
            {item.text}
          </T>
        </View>
      );
    case 'teammate': {
      const bad = item.status === 'failed' || item.status === 'stopped';
      return (
        <View style={s.teammate}>
          <View style={s.teammateHead}>
            <Avatar name={item.name} size={18} ai />
            <T style={s.teammateName}>{item.name}</T>
            <T style={s.aiTag}>AI</T>
            <T muted style={s.mentionTo}>
              {TEAMMATE_STATUS[item.status]}
            </T>
          </View>
          {item.text && (
            <T selectable muted={bad} style={s.text}>
              {item.text.trim()}
            </T>
          )}
        </View>
      );
    }
    case 'end':
      return (
        <View style={s.end}>
          {item.reason === 'error' && <CircleAlert size={12} color={colors.danger} />}
          <T
            muted
            mono
            style={[s.endText, item.reason === 'error' && { color: colors.danger }]}
            numberOfLines={3}
          >
            {item.reason === 'done'
              ? 'Done'
              : item.reason === 'stopped'
                ? 'Stopped'
                : item.reason === 'step_limit'
                  ? 'Stopped at the step limit'
                  : `Error${item.error ? `: ${item.error}` : ''}`}
            {item.cost > 0 ? ` · ${usd(item.cost)}` : ''}
          </T>
        </View>
      );
  }
});

/** The approval card a lane waits on; anyone allowed may answer, the first answer wins. */
function Waiting({ approval, canAnswer }: { approval: SessionApproval; canAnswer: boolean }) {
  const act = useActions();
  return (
    <View style={s.waiting}>
      <View style={s.waitingHead}>
        <CircleHelp size={14} color={colors.warn} />
        <T style={s.waitingTitle}>{approval.title}</T>
      </View>
      <T mono selectable numberOfLines={6} style={s.waitingDetail}>
        {approval.detail}
      </T>
      {canAnswer ? (
        <View style={s.waitingActions}>
          <Act small title="Approve" onPress={() => act.answerApproval(approval, true)} />
          <Act
            small
            kind="secondary"
            title="Deny"
            onPress={() => act.answerApproval(approval, false)}
          />
        </View>
      ) : (
        <T muted style={{ fontSize: 12.5 }}>
          Your role can watch; an editor answers it.
        </T>
      )}
    </View>
  );
}

/** One lane: the newest at the bottom, staying there as the agent works. */
export function LaneView({
  participant,
  events,
  approvals,
  canAnswer,
  machine = null,
}: {
  participant: Participant;
  events: LaneEvent[];
  approvals: SessionApproval[];
  canAnswer: boolean;
  /** The registered machine running the session (agentd), when one does. */
  machine?: string | null;
}) {
  const items = useMemo(() => foldLane(events), [events]);
  // An inverted list keeps the newest in view without measuring anything.
  const reversed = useMemo(() => [...items].reverse(), [items]);
  const list = useRef<FlatList<LaneItem>>(null);
  // A new approval card is brought into view: it is what the lane waits on.
  const asking = approvals.length;
  useEffect(() => {
    if (asking > 0) list.current?.scrollToOffset({ offset: 0, animated: true });
  }, [asking]);
  return (
    <View style={s.lane}>
      <View style={s.head}>
        <T style={[s.state, { color: STATE_COLOR[participant.state] }]}>
          {STATE_LABEL[participant.state]}
        </T>
        <T muted mono numberOfLines={1} style={s.agent}>
          {participant.mode === 'watch' ? 'watching' : agentLine(participant) || 'no agent yet'}
          {participant.kind === 'agent' && (machine || participant.hostName)
            ? ` · on ${machine ?? `${participant.hostName}'s machine`}`
            : ''}
        </T>
      </View>
      {participant.awaitingReason && participant.state === 'awaiting' && (
        <T style={s.awaiting}>Stopped: {participant.awaitingReason}</T>
      )}
      <FlatList
        ref={list}
        inverted
        // With the steer box focused, a tap on Approve answers instead of only closing the keyboard.
        keyboardShouldPersistTaps="handled"
        style={s.list}
        contentContainerStyle={s.content}
        data={reversed}
        keyExtractor={(i) => i.key}
        renderItem={({ item }) => <Item item={item} />}
        ListHeaderComponent={
          approvals.length > 0 ? (
            <View style={{ gap: 8 }}>
              {approvals.map((a) => (
                <Waiting key={a.requestId} approval={a} canAnswer={canAnswer} />
              ))}
            </View>
          ) : participant.state === 'running' ? (
            <View style={s.workingRow}>
              <LoaderCircle size={13} color={colors.okSoft} />
              <T style={{ color: colors.okSoft, fontSize: 13 }}>Working…</T>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <T muted style={s.empty}>
            {participant.mode === 'watch'
              ? `${participant.name} is watching.`
              : 'Nothing in this lane yet.'}
          </T>
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  lane: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  state: { fontFamily: fonts.uiMedium, fontSize: 13 },
  agent: { flex: 1, fontSize: 11.5 },
  awaiting: {
    color: colors.danger,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: tint.dangerBg,
  },
  list: { flex: 1 },
  // Inverted: the top padding here is the bottom of the screen.
  content: { padding: 16, gap: 12, flexGrow: 1 },
  prompt: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radius.lg,
    backgroundColor: colors.bg4,
  },
  promptText: { fontSize: 14.5, lineHeight: 20 },
  mentionTo: { fontSize: 12, marginBottom: 2 },
  teammate: {
    gap: 6,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: colors.line2,
    borderLeftColor: colors.warn,
    backgroundColor: colors.bg2,
  },
  aiTag: { fontSize: 10, fontFamily: fonts.mono, color: colors.warn },
  teammateHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  teammateName: { fontSize: 13.5, fontFamily: fonts.uiBold, color: colors.warn },
  text: { fontSize: 14.5, lineHeight: 21, color: colors.fg },
  reasoning: { fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
  },
  toolName: { fontFamily: fonts.uiMedium, fontSize: 13 },
  toolSummary: { flex: 1, fontSize: 11.5 },
  diff: { fontFamily: fonts.mono, fontSize: 11 },
  note: { fontSize: 12.5, lineHeight: 17 },
  end: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  endText: { fontSize: 11 },
  waiting: {
    gap: 8,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tint.warnLine,
    backgroundColor: tint.warnBg,
  },
  waitingHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitingTitle: { flex: 1, fontFamily: fonts.uiMedium, fontSize: 14 },
  waitingDetail: { fontSize: 11.5, color: colors.fg2 },
  waitingActions: { flexDirection: 'row', gap: 8 },
  workingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  empty: { textAlign: 'center', paddingVertical: 40, transform: [{ scaleY: -1 }] },
});
