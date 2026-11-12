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
import { useDesktopOnline } from '../lib/desktop';
import { roleName, t, useLocale } from '../lib/i18n';
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
  useLocale();
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
        accessibilityLabel={t('Close')}
      />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <T style={s.sheetTitle}>{t('Hand your work to')}</T>
        <T muted style={s.small}>
          {t(
            'Your agent stops at a checkpoint on your desktop and its work is snapshotted for them.',
          )}
        </T>
        {error && <T style={{ color: colors.danger }}>{error}</T>}
        {!members && !error && <ActivityIndicator color={colors.fg3} />}
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
          {members?.map((m) => (
            <Pressable
              key={m.userId}
              style={({ pressed }) => [s.member, pressed && { backgroundColor: colors.bg4 }]}
              accessibilityRole="button"
              accessibilityLabel={`${m.name}, ${roleName(m.role)}`}
              onPress={() => {
                onClose();
                void act.desk({ kind: 'handoff', sessionId: session.id, toUserId: m.userId });
              }}
            >
              <Avatar name={m.name} size={26} />
              <T style={{ flex: 1 }}>{m.name}</T>
              <Chip>{roleName(m.role)}</Chip>
            </Pressable>
          ))}
          {members?.length === 0 && (
            <T muted style={s.small}>
              {t('Nobody else is in this workspace yet.')}
            </T>
          )}
        </ScrollView>
        <Button title={t('Cancel')} kind="secondary" onPress={onClose} />
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
  useLocale();
  const { user } = useSession();
  const act = useActions();
  const ask = useAsk(session, events);
  const desktop = useDesktopOnline();
  const [handingOff, setHandingOff] = useState(false);
  if (session.status !== 'active' || participant.mode !== 'join') return null;
  const mine = participant.userId === user?.id;
  const ai = participant.kind === 'agent';
  const running = participant.state === 'running' || participant.state === 'waiting';
  // Where an AI teammate's work runs: the session's machine (agentd), or its host's desktop.
  const where = session.machine
    ? session.machine.name
    : participant.hostId === user?.id
      ? t('your desktop')
      : t("{name}'s desktop", { name: participant.hostName ?? t('its host') });

  let composer: ReactNode = null;
  if (mine)
    composer = (
      <Composer
        placeholder={
          running
            ? t('Guide your agent as it works, or @ a teammate…')
            : desktop === false
              ? t('Open Kovan on your computer to give your agent work (@ a teammate works now)…')
              : t('Ask your agent, or @ a teammate…')
        }
        label={t('Prompt for your agent')}
        teammates={ask.teammates}
        onSend={ask.send}
      />
    );
  else if (canSteer && (ai || running))
    composer = (
      <Composer
        placeholder={
          ai
            ? t('Message {name}…', { name: participant.name })
            : t("Guide {name}'s agent as it works…", { name: participant.name })
        }
        label={
          ai
            ? t('Message for {name}', { name: participant.name })
            : t("Guidance for {name}'s agent", { name: participant.name })
        }
        onSend={(text) =>
          act.steer(
            session.id,
            participant.userId,
            text,
            ai && !running
              ? t('Sent to {name}: it starts on {where}.', { name: participant.name, where })
              : undefined,
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
            ? t('AI teammate · runs on {where} · {agent}', { where, agent: agentLine(participant) })
            : running
              ? mine
                ? t('Runs on your account · {agent}', { agent: agentLine(participant) })
                : t("Guidance runs on {name}'s account · {agent}", {
                    name: participant.name,
                    agent: agentLine(participant),
                  })
              : participant.state === 'awaiting'
                ? mine
                  ? t('Your agent stopped ({reason}).', {
                      reason: participant.awaitingReason ?? t('usage limit'),
                    })
                  : t("{name}'s agent stopped ({reason}).", {
                      name: participant.name,
                      reason: participant.awaitingReason ?? t('usage limit'),
                    })
                : participant.snapshotAt
                  ? t('Nothing running · last checkpoint {when}', {
                      when: ago(participant.snapshotAt),
                    })
                  : mine
                    ? t('Nothing running · your desktop runs what you ask')
                    : t('Nothing running')}
        </T>
        {mine ? (
          <Button
            small
            kind="secondary"
            title={t('Hand off')}
            onPress={() => setHandingOff(true)}
          />
        ) : (
          canTakeOver &&
          !ai && (
            <Act
              small
              kind={participant.state === 'awaiting' ? 'primary' : 'secondary'}
              title={t('Take over')}
              onPress={async () =>
                (await confirm(
                  t("Take over {name}'s lane?", { name: participant.name }),
                  participant.state === 'awaiting'
                    ? t(
                        'Your desktop picks up their work from the last checkpoint, on your account.',
                      )
                    : t(
                        'Their agent stops at a safe checkpoint; then your desktop carries on, on your account.',
                      ),
                  t('Take over'),
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
