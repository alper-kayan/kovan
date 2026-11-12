import { mayActOnLane, openQuestions, type Action, type Participant } from '@kovan/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { GitBranch, Plus, Radio } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActivityList } from '../../components/ActivityList';
import { AddTeammate } from '../../components/AddTeammate';
import { ChangesView } from '../../components/ChangesView';
import { Composer } from '../../components/Composer';
import { KeyboardScreen } from '../../components/KeyboardScreen';
import { LaneControls } from '../../components/LaneControls';
import { LaneView } from '../../components/LaneView';
import { SwarmView } from '../../components/SwarmView';
import { TaskList } from '../../components/TaskList';
import { Avatar, ConnectionBar, Segmented, T } from '../../components/ui';
import { allowed, useActions } from '../../lib/actions';
import { sessionState, stateLabel, usd } from '../../lib/board';
import { t, useLocale } from '../../lib/i18n';
import { useLive } from '../../lib/live';
import { useRoom } from '../../lib/room';
import { useSession } from '../../lib/session';
import { colors, fonts, STATE_COLOR } from '../../lib/theme';

type Tab = 'lanes' | 'tasks' | 'swarm' | 'changes' | 'activity';

/** One session, live: every lane's agent at work, the task graph, the swarm and its chat. */
export default function SessionScreen() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { board, connection } = useLive();
  const room = useRoom(id);
  const act = useActions();
  const session = room.session;
  const [tab, setTab] = useState<Tab>('lanes');
  const [adding, setAdding] = useState(false);
  const lanes = useMemo(
    () => session?.participants.filter((p) => p.mode === 'join') ?? [],
    [session?.participants],
  );
  const [laneId, setLaneId] = useState<string | null>(null);
  // Until a lane is picked, show the one that most needs eyes: waiting, running, then the one
  // with the most work (the transcripts arrive after the screen opens).
  const [picked, setPicked] = useState(false);
  const auto = useMemo(() => {
    const work = (userId: string) => room.lanes[userId]?.length ?? 0;
    return (
      lanes.find((p) => p.state === 'waiting' || p.state === 'awaiting') ??
      lanes.find((p) => p.state === 'running') ??
      [...lanes].sort((a, b) => work(b.userId) - work(a.userId))[0] ??
      null
    );
  }, [lanes, room.lanes]);
  // Chosen again once the transcripts are in; after that only a lane that starts asking moves it.
  const settled = useRef(false);
  const loaded = Object.keys(room.lanes).length > 0;
  useEffect(() => {
    const current = lanes.find((p) => p.userId === laneId);
    const asking = auto && (auto.state === 'waiting' || auto.state === 'awaiting');
    // Picking "You" before your lane exists holds too; the lane takes its place once it does.
    if (picked && (current || laneId === user?.id)) return;
    if (!current || !settled.current || asking) setLaneId(auto?.userId ?? null);
    if (loaded) settled.current = true;
  }, [auto, picked, lanes, laneId, loaded, user?.id]);

  if (!session)
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: t('Session') }} />
        {room.error ? (
          <T style={{ color: colors.danger }}>{room.error}</T>
        ) : (
          <ActivityIndicator color={colors.fg3} />
        )}
      </View>
    );

  const state = sessionState(session);
  const may = (action: Action) => allowed(board, session.workspaceId, action);
  // Someone else's agent: its person and the owners (and editors, when allowed) only.
  const ws = board.workspaces.find((w) => w.id === session.workspaceId);
  const mayLane = (lane: Participant, action: 'approval.answer' | 'agent.steer') =>
    mayActOnLane({
      role: ws?.role,
      userId: user?.id,
      lane: { userId: lane.userId, hostId: lane.hostId ?? null },
      othersAgents: ws?.othersAgents,
      action,
    });
  const lane = lanes.find((p) => p.userId === laneId) ?? null;
  const approvals = board.approvals.filter((a) => a.sessionId === session.id);
  const taskAsks = session.taskApprovals.length;
  const live = session.status === 'active';
  const canJoin = live && may('session.join');
  const mine = lanes.some((p) => p.userId === user?.id);
  const questions = room.swarm
    ? openQuestions(
        room.messages,
        room.swarm.agents.map((a) => a.agentId),
      )
    : [];
  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: 'lanes', label: t('Lanes'), badge: approvals.length },
    ...(room.plan?.steps.length || session.swarm
      ? [{ value: 'tasks' as const, label: t('Tasks'), badge: taskAsks }]
      : []),
    ...(room.swarm || (session.status === 'active' && may('session.start'))
      ? [{ value: 'swarm' as const, label: 'Swarm', badge: questions.length }]
      : []),
    { value: 'changes', label: t('Changes') },
    { value: 'activity', label: t('Activity') },
  ];

  return (
    <View style={s.screen}>
      <KeyboardScreen>
        <Stack.Screen options={{ title: session.title }} />
        <ConnectionBar state={connection} />
        <View style={s.summary}>
          <View style={s.line}>
            <Radio size={12} color={STATE_COLOR[state]} />
            <T style={[s.small, { color: STATE_COLOR[state] }]}>{stateLabel(state)}</T>
            {session.branch && (
              <>
                <GitBranch size={12} color={colors.fg3} />
                <T muted mono numberOfLines={1} style={[s.tiny, { flexShrink: 1 }]}>
                  {session.branch}
                </T>
              </>
            )}
            <View style={{ flex: 1 }} />
            {session.cost > 0 && (
              <T muted mono style={s.tiny}>
                {usd(session.cost)}
              </T>
            )}
          </View>
          <Segmented value={tab} options={tabs} onChange={setTab} />
        </View>
        {/* A swarm agent waiting on a person says so wherever you are in the session. */}
        {questions.length > 0 && tab !== 'swarm' && (
          <Pressable
            style={s.swarmAsk}
            onPress={() => setTab('swarm')}
            accessibilityRole="button"
            accessibilityLabel={
              may('agent.steer')
                ? t('{name} asks: {text}. Open the swarm to answer.', {
                    name: questions[0]!.fromName,
                    text: questions[0]!.text,
                  })
                : t('{name} asks: {text}. Open the swarm.', {
                    name: questions[0]!.fromName,
                    text: questions[0]!.text,
                  })
            }
          >
            <T style={[s.small, { color: colors.warn }]} numberOfLines={2}>
              {t('{name} asks: {text}', { name: questions[0]!.fromName, text: questions[0]!.text })}
            </T>
            <T muted style={s.tiny}>
              {questions.length > 1 ? `${t('{n} questions', { n: questions.length })} · ` : ''}
              {may('agent.steer') ? t('Answer in Swarm') : t('An editor or owner answers it')}
            </T>
          </Pressable>
        )}

        {tab === 'lanes' && (
          <>
            {(lanes.length > 1 || canJoin) && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                // A tap on a lane works with the keyboard up (after sending, it still is).
                keyboardShouldPersistTaps="handled"
                style={s.pickerScroll}
                contentContainerStyle={s.picker}
              >
                {canJoin && !mine && user && (
                  <Pressable
                    onPress={() => {
                      setPicked(true);
                      setLaneId(user.id);
                    }}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: !lane }}
                    accessibilityLabel={t('Your lane, not started')}
                    style={[s.pick, !lane && s.pickOn]}
                  >
                    <Avatar name={user.name} size={20} />
                    <T style={[s.small, !lane && { color: colors.fg }]}>{t('You')}</T>
                  </Pressable>
                )}
                {lanes.map((p) => {
                  const on = p.userId === laneId;
                  const waits = approvals.some((a) => a.laneUserId === p.userId);
                  return (
                    <Pressable
                      key={p.userId}
                      onPress={() => {
                        setPicked(true);
                        setLaneId(p.userId);
                      }}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={t("{name}'s lane, {state}", {
                        name: p.name,
                        state: stateLabel(p.state),
                      })}
                      style={[s.pick, on && s.pickOn]}
                    >
                      <Avatar name={p.name} size={20} ai={p.kind === 'agent'} />
                      <T style={[s.small, on && { color: colors.fg }]}>
                        {p.userId === user?.id ? t('You') : p.name}
                      </T>
                      <View
                        style={[
                          s.dot,
                          { backgroundColor: waits ? colors.warn : STATE_COLOR[p.state] },
                        ]}
                      />
                    </Pressable>
                  );
                })}
                {canJoin && (
                  <Pressable
                    onPress={() => setAdding(true)}
                    accessibilityRole="button"
                    accessibilityLabel={t('Add an AI teammate')}
                    style={s.pick}
                  >
                    <Plus size={14} color={colors.fg3} style={{ marginLeft: 4 }} />
                    <T style={s.small}>{t('AI teammate')}</T>
                  </Pressable>
                )}
              </ScrollView>
            )}
            {lane ? (
              <>
                <LaneView
                  machine={session.machine?.name ?? null}
                  participant={lane}
                  events={room.lanes[lane.userId] ?? []}
                  approvals={approvals.filter((a) => a.laneUserId === lane.userId)}
                  canAnswer={mayLane(lane, 'approval.answer') && session.status === 'active'}
                />
                <LaneControls
                  session={session}
                  participant={lane}
                  events={room.lanes[lane.userId] ?? []}
                  canSteer={mayLane(lane, 'agent.steer')}
                  canTakeOver={may('agent.takeover')}
                />
              </>
            ) : canJoin && !mine ? (
              <>
                <T muted style={[s.empty, { flex: 1 }]}>
                  {t(
                    "Your agent isn't in this session yet. Ask it something: your desktop joins the session with it and runs it.",
                  )}
                </T>
                <View style={s.ask}>
                  <Composer
                    placeholder={t('Ask your agent to work here…')}
                    label={t('Prompt for your agent')}
                    onSend={(text) => act.prompt(session.id, text)}
                  />
                </View>
              </>
            ) : (
              <T muted style={s.empty}>
                {t(
                  'No one is working in this session yet. Lanes appear when someone joins with an agent.',
                )}
              </T>
            )}
          </>
        )}
        {tab === 'tasks' && (
          <TaskList
            plan={room.plan}
            session={session}
            swarm={room.swarm}
            canApprove={may('approval.answer')}
            canSteer={may('agent.steer')}
          />
        )}
        {tab === 'swarm' && (
          <SwarmView
            swarm={room.swarm}
            messages={room.messages}
            session={session}
            rights={{
              canStart: may('session.start'),
              canSteer: may('agent.steer'),
              canResume:
                may('session.start') &&
                (!room.swarm?.launchedBy || room.swarm.launchedBy === user?.id),
              live: session.status === 'active',
            }}
          />
        )}
        {tab === 'changes' && (
          <ChangesView session={session} lanes={room.lanes} canComment={may('comment.create')} />
        )}
        {tab === 'activity' && <ActivityList activity={room.activity} />}
      </KeyboardScreen>
      {adding && <AddTeammate session={session} onClose={() => setAdding(false)} />}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  summary: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg2,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { fontSize: 13, color: colors.fg3 },
  tiny: { fontSize: 11.5 },
  swarmAsk: {
    gap: 3,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.bg3,
  },
  pickerScroll: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
  picker: { paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  pick: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingLeft: 5,
    paddingRight: 10,
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  pickOn: { backgroundColor: colors.bg4, borderColor: colors.bg4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  ask: {
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg2,
  },
  empty: { padding: 24, textAlign: 'center', lineHeight: 21, fontFamily: fonts.ui },
});
