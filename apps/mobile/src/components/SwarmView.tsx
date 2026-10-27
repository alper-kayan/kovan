import type { Session, Swarm, SwarmMessage } from '@kovan/shared';
import { Bot, Square } from 'lucide-react-native';
import { useRef, useState, type ReactNode } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useActions } from '../lib/actions';
import { ago, usd } from '../lib/board';
import { confirm } from '../lib/confirm';
import { colors, fonts, radius } from '../lib/theme';
import { swarmColor } from './SessionCard';
import { SwarmSetup } from './SwarmSetup';
import { Act, Bar, Button, T } from './ui';

export interface SwarmRights {
  /** Set up and launch one (it runs on this person's desktop). */
  canStart: boolean;
  /** Pause, stop, stop an agent. */
  canSteer: boolean;
  /** Resume: only who launched it (it runs on their machine), with the role to start one. */
  canResume: boolean;
  /** The session is still going. */
  live: boolean;
}

function Controls({ swarm, rights, onNew }: { swarm: Swarm; rights: SwarmRights; onNew(): void }) {
  const act = useActions();
  if (!rights.live) return null;
  const stop = async () =>
    (await confirm(
      'Stop the swarm?',
      'Its agents stop at their next step. Finished tasks stay.',
      'Stop',
      true,
    )) && act.setSwarmStatus(swarm.id, 'stopped');
  const buttons: ReactNode[] = [];
  if (swarm.status === 'running' && rights.canSteer)
    buttons.push(
      <Act
        key="pause"
        small
        kind="secondary"
        title="Pause"
        onPress={() => act.setSwarmStatus(swarm.id, 'paused')}
      />,
      <Act key="stop" small kind="secondary" title="Stop" onPress={stop} />,
    );
  if (swarm.status === 'paused') {
    if (rights.canResume)
      buttons.push(
        <Act
          key="resume"
          small
          title="Resume"
          onPress={() =>
            act.desk({ kind: 'resume', swarmId: swarm.id, sessionId: swarm.sessionId })
          }
        />,
      );
    if (rights.canSteer)
      buttons.push(<Act key="stop" small kind="secondary" title="Stop" onPress={stop} />);
  }
  if ((swarm.status === 'done' || swarm.status === 'stopped') && rights.canStart)
    buttons.push(<Button key="new" small kind="secondary" title="New swarm" onPress={onNew} />);
  return buttons.length ? <View style={s.row}>{buttons}</View> : null;
}

function Header({
  swarm,
  machine,
  rights,
  onNew,
}: {
  swarm: Swarm;
  /** The registered machine it runs on (agentd), named instead of whoever launched it. */
  machine: string | null;
  rights: SwarmRights;
  onNew(): void;
}) {
  const act = useActions();
  return (
    <View style={s.head}>
      <View style={s.row}>
        <T style={[s.status, { color: swarmColor(swarm.status) }]}>{swarm.status.toUpperCase()}</T>
        <T muted style={s.small}>
          {machine
            ? `on ${machine}`
            : swarm.launchedByName
              ? `on ${swarm.launchedByName}'s machine`
              : ''}
        </T>
      </View>
      <T selectable style={s.goal}>
        {swarm.goal}
      </T>
      <View style={s.row}>
        <T mono style={s.tiny}>
          {usd(swarm.spent)} / {swarm.budget === null ? 'unlimited' : usd(swarm.budget)}
        </T>
        {swarm.budget !== null && <Bar share={swarm.spent / swarm.budget} budget />}
      </View>
      {swarm.pausedReason && <T style={s.reason}>{swarm.pausedReason}</T>}
      <Controls swarm={swarm} rights={rights} onNew={onNew} />
      <View style={s.agents}>
        {swarm.agents.map((a) => (
          <View key={a.agentId} style={s.agent}>
            <View style={s.bot}>
              <Bot size={13} color={colors.fg2} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T style={s.small}>
                {a.name}
                {a.role === 'lead' && <T style={s.lead}> LEAD</T>}
                <T
                  style={[s.small, { color: a.status === 'working' ? colors.okSoft : colors.fg3 }]}
                >
                  {' '}
                  {a.status}
                </T>
              </T>
              {a.task && (
                <T muted numberOfLines={2} style={s.tiny}>
                  {a.task}
                </T>
              )}
            </View>
            <T muted mono style={s.tiny}>
              {usd(a.spent)}
            </T>
            {rights.live &&
              rights.canSteer &&
              swarm.status === 'running' &&
              a.status === 'working' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Stop ${a.name}`}
                  hitSlop={8}
                  onPress={async () =>
                    (await confirm(
                      `Stop ${a.name}?`,
                      'It stops at its next step; the lead plans again around its task.',
                      'Stop',
                      true,
                    )) && act.stopAgent(swarm.id, a.agentId, a.name)
                  }
                >
                  <Square size={13} color={colors.fg3} />
                </Pressable>
              )}
          </View>
        ))}
      </View>
      <T style={s.section}>SWARM CHAT</T>
    </View>
  );
}

/**
 * The swarm in the session: its state, budget and agents, then its chat, where agents talk to
 * each other and the closing report lands, newest at the bottom.
 */
export function SwarmView({
  session,
  swarm,
  messages,
  rights,
}: {
  session: Session;
  swarm: Swarm | null;
  messages: SwarmMessage[];
  rights: SwarmRights;
}) {
  // A finished swarm's "New swarm": set up the next one in the same session.
  const [again, setAgain] = useState<string | null>(null);
  const list = useRef<FlatList<SwarmMessage>>(null);
  // Opens at the top (state and controls). New messages are followed while the reader is at the
  // bottom, or while a running swarm's chat still fits on screen; never after they scroll up.
  const atEnd = useRef(false);
  const viewH = useRef(0);
  const contentH = useRef(0);
  const setup = !swarm || swarm.status === 'draft' || again === swarm.id;
  if (setup && rights.live && rights.canStart)
    return (
      <ScrollView
        style={s.list}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <SwarmSetup
          session={session}
          draft={swarm?.status === 'draft' ? swarm : null}
          onCancel={again ? () => setAgain(null) : undefined}
        />
      </ScrollView>
    );
  if (!swarm || swarm.status === 'draft')
    return (
      <T muted style={s.empty}>
        {swarm ? 'A swarm is set up here but not launched yet.' : 'No swarm in this session.'}
      </T>
    );
  return (
    <FlatList
      style={s.list}
      contentContainerStyle={s.content}
      ref={list}
      data={messages}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
      }}
      scrollEventThrottle={100}
      onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
      onContentSizeChange={(_w, h) => {
        const fitted = contentH.current <= viewH.current;
        contentH.current = h;
        if (h > viewH.current && (atEnd.current || (fitted && swarm?.status === 'running')))
          list.current?.scrollToEnd({ animated: true });
      }}
      keyExtractor={(m) => m.id}
      ListHeaderComponent={
        <Header
          swarm={swarm}
          machine={session.machine?.name ?? null}
          rights={rights}
          onNew={() => setAgain(swarm.id)}
        />
      }
      ListEmptyComponent={
        <T muted style={s.small}>
          Agents talk to each other here.
        </T>
      }
      renderItem={({ item: m }) => (
        <View style={s.message}>
          <T style={s.small}>
            <T style={[s.small, { fontFamily: fonts.uiBold }]}>{m.fromName}</T>
            <T muted style={s.small}>
              {' '}
              → {m.toName ?? 'everyone'} · {ago(m.createdAt)}
            </T>
          </T>
          <T selectable style={s.text}>
            {m.text}
          </T>
        </View>
      )}
    />
  );
}

const s = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: 16, gap: 12 },
  empty: { padding: 24, textAlign: 'center' },
  head: { gap: 10, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  status: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.6 },
  goal: { fontSize: 15, lineHeight: 21 },
  reason: { color: colors.warn, fontSize: 13 },
  agents: {
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg4,
  },
  lead: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.fg3 },
  section: {
    color: colors.fg3,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 6,
  },
  message: { gap: 3 },
  text: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13 },
  tiny: { fontSize: 11.5 },
});
