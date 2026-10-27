import {
  mentionedTeammate,
  type LaneEvent,
  type Member,
  type Participant,
  type Session,
} from '@kovan/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActions } from '../lib/actions';
import { ToastHost } from '../lib/toast';
import { ago } from '../lib/board';
import { confirm } from '../lib/confirm';
import { useSession } from '../lib/session';
import { colors, fonts, radius } from '../lib/theme';
import { Composer } from './Composer';
import { Act, Avatar, Button, Chip, T } from './ui';
import { agentLine } from './LaneView';
import { useTeammates } from './AddTeammate';
import { foldLane, laneDigest } from '../lib/lanes';

/**
 * The box for your own agent: a prompt goes to your desktop; "@Name" calls that AI teammate in
 * instead, with your lane so far, and it answers in your lane.
 */
export function useAsk(session: Session, events: readonly LaneEvent[]) {
  const { user } = useSession();
  const act = useActions();
  const { agents } = useTeammates(session.workspaceId);
  const teammates = agents ?? [];
  return {
    teammates,
    send: (text: string) => {
      const called = mentionedTeammate(text, teammates);
      if (!called || !user) return act.prompt(session.id, text);
      return act.mention(session.id, called.name, {
        agentId: called.id,
        text,
        context: laneDigest(foldLane(events), user.name),
        reply: { kind: 'lane', laneUserId: user.id },
      });
    },
  };
}

/** Teammates to hand your lane to: people only (an AI teammate can't pick work up). */
function HandOffSheet({ session, onClose }: { session: Session; onClose(): void }) {
  const { api, user } = useSession();
  const act = useActions();
  const insets = useSafeAreaInsets();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ members: Member[] }>('GET', `/api/workspaces/${session.workspaceId}/members`)
      .then((r) => setMembers(r.members.filter((m) => m.kind === 'human' && m.userId !== user?.id)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, session.workspaceId, user?.id]);
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <T style={s.sheetTitle}>Hand your work to</T>
        <T muted style={s.small}>
          Your agent stops at a checkpoint on your desktop and its work is snapshotted for them.
        </T>
        {error && <T style={{ color: colors.danger }}>{error}</T>}
        {!members && !error && <ActivityIndicator color={colors.fg3} />}
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
          {members?.map((m) => (
            <Pressable
              key={m.userId}
              style={({ pressed }) => [s.member, pressed && { backgroundColor: colors.bg4 }]}
              accessibilityRole="button"
              accessibilityLabel={`${m.name}, ${m.role}`}
              onPress={() => {
                onClose();
                void act.desk({ kind: 'handoff', sessionId: session.id, toUserId: m.userId });
              }}
            >
              <Avatar name={m.name} size={26} />
              <T style={{ flex: 1 }}>{m.name}</T>
              <Chip>{m.role}</Chip>
            </Pressable>
          ))}
          {members?.length === 0 && (
            <T muted style={s.small}>
              Nobody else is in this workspace yet.
            </T>
          )}
        </ScrollView>
        <Button title="Cancel" kind="secondary" onPress={onClose} />
      </View>
      <ToastHost />
    </Modal>
  );
}

/**
 * Under a lane: a prompt for your own agent (your desktop runs it: a new turn, or guidance while
 * it works), a message for an AI teammate (its host's desktop runs it), guidance for a teammate's
 * working agent; then taking it over or, for your own lane, handing it off. Each only when the
 * role allows it.
 */
export function LaneControls({
  session,
  participant,
  events,
  canSteer,
  canTakeOver,
}: {
  session: Session;
  participant: Participant;
  /** The lane so far: what a teammate called in from your lane reads. */
  events: readonly LaneEvent[];
  canSteer: boolean;
  canTakeOver: boolean;
}) {
  const { user } = useSession();
  const act = useActions();
  const ask = useAsk(session, events);
  const [handingOff, setHandingOff] = useState(false);
  if (session.status !== 'active' || participant.mode !== 'join') return null;
  const mine = participant.userId === user?.id;
  const ai = participant.kind === 'agent';
  const running = participant.state === 'running' || participant.state === 'waiting';
  const name = mine ? 'Your' : `${participant.name}'s`;
  const host = participant.hostId === user?.id ? 'your' : `${participant.hostName ?? 'its host'}'s`;
  // Where an AI teammate's work runs: the session's machine (agentd), or its host's desktop.
  const where = session.machine ? session.machine.name : `${host} desktop`;

  let composer: ReactNode = null;
  if (mine)
    composer = (
      <Composer
        placeholder={
          running ? 'Steer your agent, or @ a teammate…' : 'Ask your agent, or @ a teammate…'
        }
        label="Prompt for your agent"
        teammates={ask.teammates}
        onSend={ask.send}
      />
    );
  else if (canSteer && (ai || running))
    composer = (
      <Composer
        placeholder={ai ? `Message ${participant.name}…` : `Steer ${name.toLowerCase()} agent…`}
        label={ai ? `Message for ${participant.name}` : `Guidance for ${name.toLowerCase()} agent`}
        onSend={(text) =>
          act.steer(
            session.id,
            participant.userId,
            text,
            ai && !running ? `Sent to ${participant.name}: it starts on ${where}.` : undefined,
          )
        }
      />
    );

  return (
    <View style={s.box}>
      {composer}
      <View style={s.bar}>
        <T muted style={[s.small, { flex: 1 }]} numberOfLines={2}>
          {ai
            ? `AI teammate · runs on ${where} · ${agentLine(participant)}`
            : running
              ? `${mine ? 'Runs' : 'Guidance runs'} on ${mine ? 'your' : `${participant.name}'s`} account · ${agentLine(participant)}`
              : participant.state === 'awaiting'
                ? `${name} agent stopped (${participant.awaitingReason ?? 'usage limit'}).`
                : participant.snapshotAt
                  ? `Idle · last checkpoint ${ago(participant.snapshotAt)}`
                  : mine
                    ? 'Idle · your desktop runs what you ask'
                    : 'Idle'}
        </T>
        {mine ? (
          <Button small kind="secondary" title="Hand off" onPress={() => setHandingOff(true)} />
        ) : (
          canTakeOver &&
          !ai && (
            <Act
              small
              kind={participant.state === 'awaiting' ? 'primary' : 'secondary'}
              title="Take over"
              onPress={async () =>
                (await confirm(
                  `Take over ${participant.name}'s lane?`,
                  participant.state === 'awaiting'
                    ? 'Your desktop picks up their work from the last checkpoint, on your account.'
                    : 'Their agent stops at a safe checkpoint; then your desktop carries on, on your account.',
                  'Take over',
                )) &&
                act.desk({
                  kind: 'takeover',
                  sessionId: session.id,
                  laneUserId: participant.userId,
                })
              }
            />
          )
        )}
      </View>
      {handingOff && <HandOffSheet session={session} onClose={() => setHandingOff(false)} />}
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg2,
  },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34 },
  small: { fontSize: 12.5, lineHeight: 17 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    gap: 12,
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  sheetTitle: { fontFamily: fonts.uiBold, fontSize: 17 },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: radius.md,
  },
});
