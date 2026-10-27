import { router } from 'expo-router';
import { CircleHelp, Hand } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { allowed, useActions } from '../lib/actions';
import { ago, nameOf, type Alert, type Board } from '../lib/board';
import { confirm } from '../lib/confirm';
import { colors, fonts, radius, tint } from '../lib/theme';
import { Act, T } from './ui';

function lines(
  alert: Alert,
  userId: string | null,
): { danger: boolean; main: string; sub: string } {
  const title = alert.session.title;
  switch (alert.kind) {
    case 'approval': {
      const a = alert.approval;
      const who = a.laneUserId === userId ? 'Your' : `${nameOf(alert.session, a.laneUserId)}'s`;
      return {
        danger: false,
        main: `${who} agent asks: ${a.title}`,
        sub: `${a.detail.split('\n')[0]} · ${title}`,
      };
    }
    case 'task':
      return {
        danger: false,
        main: `A swarm task needs a yes: ${alert.title}`,
        sub: `${alert.reason} · ${title}`,
      };
    case 'swarm':
      return { danger: true, main: `A swarm paused itself: ${alert.reason}`, sub: title };
    case 'awaiting':
      return {
        danger: true,
        main: `${alert.name}'s agent stopped: ${alert.reason}. Awaiting takeover.`,
        sub: `${title} · ${alert.snapshotAt ? `last checkpoint ${ago(alert.snapshotAt)}` : 'no checkpoint yet'}`,
      };
    case 'handoff':
      return {
        danger: false,
        main: `${nameOf(alert.session, alert.handoff.fromUserId)} handed you their work.`,
        sub: `${title}${alert.handoff.context?.reason ? ` · ${alert.handoff.context.reason}` : ''}`,
      };
    case 'outcome':
      return {
        danger: true,
        main: `Outcome unknown: ${alert.outcome.command}`,
        sub: `${nameOf(alert.session, alert.outcome.laneUserId)}'s agent was cut off mid-flight · ${title}`,
      };
  }
}

/** What can be done about an alert from here; nothing when the role doesn't allow it. */
function Actions({ alert, board, userId }: { alert: Alert; board: Board; userId: string | null }) {
  const act = useActions();
  const ws = alert.session.workspaceId;
  const may = (action: Parameters<typeof allowed>[2]) => allowed(board, ws, action);
  const buttons: { title: string; primary?: boolean; run(): Promise<unknown> }[] = [];
  switch (alert.kind) {
    case 'approval':
      if (may('approval.answer'))
        buttons.push(
          { title: 'Approve', primary: true, run: () => act.answerApproval(alert.approval, true) },
          { title: 'Deny', run: () => act.answerApproval(alert.approval, false) },
        );
      break;
    case 'task':
      if (may('approval.answer'))
        buttons.push(
          { title: 'Approve', primary: true, run: () => act.answerTask(alert.stepId, true) },
          { title: 'Reject', run: () => act.answerTask(alert.stepId, false) },
        );
      break;
    case 'swarm': {
      const swarm = alert.session.swarm!;
      if (may('session.start') && (!swarm.launchedBy || swarm.launchedBy === userId))
        buttons.push({
          title: 'Resume',
          primary: true,
          run: () => act.desk({ kind: 'resume', swarmId: swarm.id, sessionId: alert.session.id }),
        });
      if (may('agent.steer'))
        buttons.push({
          title: 'Stop',
          run: async () =>
            (await confirm(
              'Stop the swarm?',
              'Its agents stop at their next step. Finished tasks stay.',
              'Stop',
              true,
            )) && act.setSwarmStatus(swarm.id, 'stopped'),
        });
      break;
    }
    case 'awaiting':
      if (may('agent.takeover'))
        buttons.push({
          title: 'Take over',
          primary: true,
          run: async () =>
            (await confirm(
              `Take over ${alert.name}'s lane?`,
              'Your desktop picks up their work from the last checkpoint, on your account.',
              'Take over',
            )) &&
            act.desk({ kind: 'takeover', sessionId: alert.session.id, laneUserId: alert.userId }),
        });
      break;
    case 'handoff':
      buttons.push(
        {
          title: 'Pick it up',
          primary: true,
          run: () =>
            act.desk({
              kind: 'continue',
              handoffId: alert.handoff.id,
              sessionId: alert.session.id,
            }),
        },
        { title: 'Decline', run: () => act.declineHandoff(alert.handoff) },
      );
      break;
    case 'outcome':
      if (may('approval.answer'))
        buttons.push(
          { title: 'It went through', run: () => act.recordOutcome(alert.outcome, 'succeeded') },
          { title: 'It failed', run: () => act.recordOutcome(alert.outcome, 'failed') },
          { title: "Didn't run", run: () => act.recordOutcome(alert.outcome, 'not_run') },
        );
      break;
  }
  if (buttons.length === 0) return null;
  return (
    <View style={s.actions}>
      {buttons.map((b) => (
        <Act
          key={b.title}
          small
          title={b.title}
          kind={b.primary ? 'primary' : 'secondary'}
          onPress={b.run}
        />
      ))}
    </View>
  );
}

/** What waits for someone, one row each; a tap opens the session, the buttons answer it here. */
export function Alerts({
  alerts,
  board,
  userId,
}: {
  alerts: Alert[];
  board: Board;
  userId: string | null;
}) {
  if (alerts.length === 0) return null;
  return (
    <View style={s.list}>
      {alerts.map((alert) => {
        const { danger, main, sub } = lines(alert, userId);
        const Icon =
          alert.kind === 'approval' || alert.kind === 'task' || alert.kind === 'outcome'
            ? CircleHelp
            : Hand;
        return (
          <View key={alert.key} style={[s.alert, danger && s.danger]}>
            <Pressable
              onPress={() =>
                router.push({ pathname: '/session/[id]', params: { id: alert.session.id } })
              }
              accessibilityRole="button"
              accessibilityHint="Opens the session"
              style={({ pressed }) => [s.head, pressed && { opacity: 0.7 }]}
            >
              <Icon size={15} color={danger ? colors.danger : colors.warn} style={s.icon} />
              <View style={s.text}>
                <T style={s.main}>{main}</T>
                <T muted numberOfLines={2} style={s.sub}>
                  {sub}
                </T>
              </View>
            </Pressable>
            <Actions alert={alert} board={board} userId={userId} />
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  list: { gap: 8 },
  alert: {
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tint.warnLine,
    backgroundColor: tint.warnBg,
  },
  danger: { borderColor: tint.dangerLine, backgroundColor: tint.dangerBg },
  head: { flexDirection: 'row', gap: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 25 },
  icon: { marginTop: 2 },
  text: { flex: 1, gap: 3 },
  main: { fontSize: 14, lineHeight: 19, fontFamily: fonts.uiMedium },
  sub: { fontSize: 12.5, lineHeight: 17 },
});
