import { graphColumns, type Plan, type PlanStep, type Session, type Swarm } from '@kovan/shared';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useActions } from '../lib/actions';
import { usd } from '../lib/board';
import { confirm } from '../lib/confirm';
import { colors, fonts, radius } from '../lib/theme';
import { Act, T } from './ui';

const RUN_LABEL: Record<NonNullable<PlanStep['runState']>, string> = {
  waiting: 'waiting',
  waiting_for_approval: 'needs approval',
  running: 'running',
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  cancelled: 'stopped',
};

function runColor(state: PlanStep['runState'] | PlanStep['status']): string {
  switch (state) {
    case 'running':
    case 'done':
    case 'doing':
      return colors.okSoft;
    case 'failed':
      return colors.danger;
    case 'blocked':
    case 'waiting_for_approval':
      return colors.warn;
    default:
      return colors.fg3;
  }
}

/**
 * The session's tasks as the desktop's graph reads, top to bottom on a phone: one stage per
 * column of the graph, each task after what it depends on, with its state, owner, spend and why.
 */
export function TaskList({
  plan,
  session,
  swarm,
  canApprove,
  canSteer,
}: {
  plan: Plan | null;
  session: Session;
  swarm: Swarm | null;
  canApprove: boolean;
  canSteer: boolean;
}) {
  const act = useActions();
  const live = session.status === 'active';
  const steps = plan?.steps ?? [];
  const nameOf = (id: string | null) =>
    session.participants.find((p) => p.userId === id)?.name ??
    swarm?.agents.find((a) => a.agentId === id)?.name ??
    (id ? 'someone' : 'nobody yet');
  const titleOf = (id: string) => steps.find((x) => x.id === id)?.title ?? 'another task';
  const columns = graphColumns(steps.map((x) => ({ ...x, key: x.id })));
  const counts: Record<string, number> = {};
  for (const x of steps) {
    const k = x.runState ? RUN_LABEL[x.runState] : x.status;
    counts[k] = (counts[k] ?? 0) + 1;
  }

  if (!plan)
    return (
      <T muted style={s.empty}>
        Loading the plan…
      </T>
    );
  if (steps.length === 0)
    return (
      <T muted style={s.empty}>
        No tasks yet. A swarm&apos;s lead splits its goal into tasks here; people add plan steps on
        the desktop.
      </T>
    );
  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.content}>
      <T muted mono style={s.counts}>
        {Object.entries(counts)
          .map(([k, n]) => `${n} ${k}`)
          .join(' · ')}
      </T>
      {columns.map((column, i) => (
        <View key={i} style={s.stage}>
          {columns.length > 1 && (
            <T style={s.stageLabel}>{i === 0 ? 'FIRST' : `THEN · STAGE ${i + 1}`}</T>
          )}
          {column.map((x) => {
            const state = x.runState ?? x.status;
            const color = runColor(state);
            return (
              <View
                key={x.id}
                style={[
                  s.task,
                  x.runState && x.runState !== 'done' && x.runState !== 'waiting'
                    ? { borderColor: color }
                    : null,
                  x.runState === 'cancelled' && { opacity: 0.6 },
                ]}
                accessible
                accessibilityLabel={`${x.title}, ${x.runState ? RUN_LABEL[x.runState] : x.status}`}
              >
                <View style={s.taskHead}>
                  <View style={[s.chip, { borderColor: color }]}>
                    <T style={[s.chipText, { color }]}>
                      {x.runState ? RUN_LABEL[x.runState] : x.status}
                    </T>
                  </View>
                  <View style={{ flex: 1 }} />
                  {x.spent > 0 && (
                    <T muted mono style={s.tiny}>
                      {usd(x.spent)}
                    </T>
                  )}
                </View>
                <T style={s.title}>{x.title}</T>
                <T muted style={s.small}>
                  {nameOf(x.ownerId)}
                </T>
                {x.dependsOn.length > 0 && (
                  <T muted style={s.small}>
                    After {x.dependsOn.map(titleOf).join(', ')}
                  </T>
                )}
                {x.acceptance && (
                  <T muted style={s.small}>
                    Done means: {x.acceptance}
                  </T>
                )}
                {x.runDetail && (
                  <T style={[s.small, { color: colors.fg2 }]} numberOfLines={4}>
                    {x.runDetail}
                  </T>
                )}
                {x.approval === 'pending' && (
                  <>
                    <T style={[s.small, { color: colors.warn }]}>
                      Needs a yes{x.approvalReason ? `: ${x.approvalReason}` : ''}
                    </T>
                    {canApprove && live && (
                      <View style={s.actions}>
                        <Act small title="Approve" onPress={() => act.answerTask(x.id, true)} />
                        <Act
                          small
                          kind="secondary"
                          title="Reject"
                          onPress={() => act.answerTask(x.id, false)}
                        />
                      </View>
                    )}
                  </>
                )}
                {x.runState === 'running' &&
                  swarm?.status === 'running' &&
                  canSteer &&
                  live &&
                  x.ownerId &&
                  swarm.agents.some((a) => a.agentId === x.ownerId) && (
                    <View style={s.actions}>
                      <Act
                        small
                        kind="secondary"
                        title="Stop task"
                        onPress={async () =>
                          (await confirm(
                            'Stop this task?',
                            `${nameOf(x.ownerId)} stops at its next step; the lead plans again around it.`,
                            'Stop',
                            true,
                          )) && act.stopAgent(swarm.id, x.ownerId!, nameOf(x.ownerId))
                        }
                      />
                    </View>
                  )}
                {x.approval && x.approval !== 'pending' && (
                  <T muted style={s.small}>
                    {x.approval} by {nameOf(x.approvedBy)}
                  </T>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 16, gap: 16 },
  empty: { padding: 24, textAlign: 'center', lineHeight: 21 },
  counts: { fontSize: 11.5 },
  stage: { gap: 8 },
  stageLabel: { color: colors.fg4, fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.8 },
  task: {
    gap: 5,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  taskHead: { flexDirection: 'row', alignItems: 'center' },
  chip: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, borderWidth: 1 },
  chipText: { fontFamily: fonts.mono, fontSize: 10.5 },
  title: { fontFamily: fonts.uiMedium, fontSize: 14.5, lineHeight: 20 },
  small: { fontSize: 12.5, lineHeight: 17 },
  tiny: { fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
});
