import { router } from 'expo-router';
import { CircleHelp, Hand } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { allowed, useActions } from '../lib/actions';
import { riskOf } from '@kovan/shared';
import { ago, nameOf, type Alert, type Board } from '../lib/board';
import { confirm } from '../lib/confirm';
import { desktopOffline, useDesktopOnline } from '../lib/desktop';
import { t, useLocale } from '../lib/i18n';
import { colors, fonts, radius, tint } from '../lib/theme';
import { Act, T } from './ui';

/** Why answering yes is hard to undo (a force push, deleting data), or null. Commands and tasks only. */
export function alertRisk(alert: Alert): string | null {
  const risk =
    alert.kind === 'approval'
      ? alert.approval.kind === 'command'
        ? riskOf(alert.approval.title, alert.approval.detail)
        : null
      : alert.kind === 'task'
        ? riskOf(alert.title, alert.reason)
        : null;
  // The reasons are @kovan/shared's English; the catalog has them.
  return risk && t(risk);
}

function lines(
  alert: Alert,
  userId: string | null,
): { danger: boolean; main: string; sub: string; risk: string | null } {
  const title = alert.session.title;
  const risk = alertRisk(alert);
  switch (alert.kind) {
    case 'approval': {
      const a = alert.approval;
      return {
        danger: risk !== null,
        main:
          a.laneUserId === userId
            ? t('Your agent asks: {title}', { title: a.title })
            : t("{name}'s agent asks: {title}", {
                name: nameOf(alert.session, a.laneUserId),
                title: a.title,
              }),
        sub: `${a.detail.split('\n')[0]} · ${title}`,
        risk,
      };
    }
    case 'task':
      return {
        danger: risk !== null,
        main: t('A swarm task needs a yes: {title}', { title: alert.title }),
        sub: `${alert.reason} · ${title}`,
        risk,
      };
    case 'swarm':
      return {
        danger: true,
        main: t('A swarm paused itself: {reason}', { reason: alert.reason }),
        sub: title,
        risk: null,
      };
    case 'awaiting':
      return {
        danger: true,
        main: t("{name}'s agent stopped: {reason}. Someone needs to take over.", {
          name: alert.name,
          reason: alert.reason,
        }),
        sub: `${title} · ${
          alert.snapshotAt
            ? t('last checkpoint {when}', { when: ago(alert.snapshotAt) })
            : t('no checkpoint yet')
        }`,
        risk: null,
      };
    case 'handoff':
      return {
        danger: false,
        main: t('{name} handed you their work.', {
          name: nameOf(alert.session, alert.handoff.fromUserId),
        }),
        sub: `${title}${alert.handoff.context?.reason ? ` · ${alert.handoff.context.reason}` : ''}`,
        risk: null,
      };
    case 'outcome':
      return {
        danger: true,
        main: t('Outcome unknown: {command}', { command: alert.outcome.command }),
        sub: `${t("{name}'s agent was cut off mid-flight", {
          name: nameOf(alert.session, alert.outcome.laneUserId),
        })} · ${title}`,
        risk: null,
      };
  }
}

/** A risky yes is asked twice: the step can't easily be undone. Anything else goes at once. */
async function sure(alert: Alert, what: string): Promise<boolean> {
  const risk = alertRisk(alert);
  if (!risk) return true;
  return confirm(t('{risk}. Approve it?', { risk }), what.slice(0, 600), t('Approve'), true);
}

/** What can be done about an alert from here; nothing when the role doesn't allow it. */
function Actions({ alert, board, userId }: { alert: Alert; board: Board; userId: string | null }) {
  useLocale();
  const act = useActions();
  const ws = alert.session.workspaceId;
  const may = (action: Parameters<typeof allowed>[2]) => allowed(board, ws, action);
  const desktop = useDesktopOnline();
  const buttons: {
    title: string;
    primary?: boolean;
    /** Done by the person's desktop: off while Kovan isn't open there. */
    desk?: boolean;
    run(): Promise<unknown>;
  }[] = [];
  switch (alert.kind) {
    case 'approval':
      if (may('approval.answer'))
        buttons.push(
          {
            title: t('Approve'),
            primary: true,
            run: async () =>
              (await sure(alert, alert.approval.detail)) &&
              act.answerApproval(alert.approval, true),
          },
          { title: t('Deny'), run: () => act.answerApproval(alert.approval, false) },
        );
      break;
    case 'task':
      if (may('approval.answer'))
        buttons.push(
          {
            title: t('Approve'),
            primary: true,
            run: async () =>
              (await sure(alert, `${alert.title}\n${alert.reason}`)) &&
              act.answerTask(alert.stepId, true),
          },
          { title: t('Reject'), run: () => act.answerTask(alert.stepId, false) },
        );
      break;
    case 'swarm': {
      const swarm = alert.session.swarm!;
      if (may('session.start') && (!swarm.launchedBy || swarm.launchedBy === userId))
        buttons.push({
          title: t('Resume'),
          primary: true,
          run: () => act.desk({ kind: 'resume', swarmId: swarm.id, sessionId: alert.session.id }),
        });
      if (may('agent.steer'))
        buttons.push({
          title: t('Stop'),
          run: async () =>
            (await confirm(
              t('Stop the swarm?'),
              t('Its agents stop at their next step. Finished tasks stay.'),
              t('Stop'),
              true,
            )) && act.setSwarmStatus(swarm.id, 'stopped'),
        });
      break;
    }
    case 'awaiting':
      if (may('agent.takeover'))
        buttons.push({
          title: t('Take over'),
          primary: true,
          desk: true,
          run: async () =>
            (await confirm(
              t("Take over {name}'s lane?", { name: alert.name }),
              t('Your desktop picks up their work from the last checkpoint, on your account.'),
              t('Take over'),
            )) &&
            act.desk({ kind: 'takeover', sessionId: alert.session.id, laneUserId: alert.userId }),
        });
      break;
    case 'handoff':
      buttons.push(
        {
          title: t('Pick it up'),
          primary: true,
          desk: true,
          run: () =>
            act.desk({
              kind: 'continue',
              handoffId: alert.handoff.id,
              sessionId: alert.session.id,
            }),
        },
        { title: t('Decline'), run: () => act.declineHandoff(alert.handoff) },
      );
      break;
    case 'outcome':
      if (may('approval.answer'))
        buttons.push(
          { title: t('It went through'), run: () => act.recordOutcome(alert.outcome, 'succeeded') },
          { title: t('It failed'), run: () => act.recordOutcome(alert.outcome, 'failed') },
          { title: t("Didn't run"), run: () => act.recordOutcome(alert.outcome, 'not_run') },
        );
      break;
  }
  if (buttons.length === 0) return null;
  const blocked = desktop === false && buttons.some((b) => b.desk);
  return (
    <>
      <View style={s.actions}>
        {buttons.map((b) => (
          <Act
            key={b.title}
            small
            title={b.title}
            kind={b.primary ? 'primary' : 'secondary'}
            disabled={b.desk === true && desktop === false}
            onPress={b.run}
          />
        ))}
      </View>
      {blocked && <T style={s.deskNote}>{desktopOffline()}</T>}
    </>
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
  useLocale();
  if (alerts.length === 0) return null;
  return (
    <View style={s.list}>
      {alerts.map((alert) => {
        const { danger, main, sub, risk } = lines(alert, userId);
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
              accessibilityHint={t('Opens the session')}
              style={({ pressed }) => [s.head, pressed && { opacity: 0.7 }]}
            >
              <Icon size={15} color={danger ? colors.danger : colors.warn} style={s.icon} />
              <View style={s.text}>
                <T style={s.main}>{main}</T>
                {risk && <T style={s.risk}>{t('Hard to undo: {risk}.', { risk })}</T>}
                {/* The command is what's being approved: all of it, in a readable grey. */}
                <T style={[s.sub, { color: colors.fg2 }]} selectable>
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
  deskNote: { fontSize: 12.5, lineHeight: 17, color: colors.warn, paddingLeft: 25 },
  risk: { fontSize: 12.5, lineHeight: 17, color: colors.danger, fontFamily: fonts.uiMedium },
});
