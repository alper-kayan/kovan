import { swarmBadge, type Session } from '@kovan/shared';
import { router } from 'expo-router';
import { Eye, FileCode2, Radio } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { ago, harnessLine, nameOf, sessionState, stateLabel, swarmLabel, usd } from '../lib/board';
import { t, useLocale } from '../lib/i18n';
import { colors, fonts, radius, STATE_COLOR } from '../lib/theme';
import { Avatar, Bar, T } from './ui';

/** The swarm's line on a card: its state, its tasks by state, and spend against the budget. */
function SwarmLine({ session }: { session: Session }) {
  const swarm = session.swarm!;
  const tasks = session.tasks;
  const parts = [
    tasks.running && t('{n} running', { n: tasks.running }),
    tasks.waiting && t('{n} waiting', { n: tasks.waiting }),
    session.taskApprovals.length && t('{n} need approval', { n: session.taskApprovals.length }),
    tasks.done && t('{n} done', { n: tasks.done }),
    tasks.failed && t('{n} failed', { n: tasks.failed }),
    tasks.blocked && t('{n} blocked', { n: tasks.blocked }),
  ].filter(Boolean);
  return (
    <View style={s.block}>
      <T style={s.small}>
        <T style={[s.swarmStatus, { color: swarmColor(swarmBadge(swarm).tone) }]}>
          {swarmLabel(swarm)}
        </T>{' '}
        <T style={[s.small, { color: tasks.failed || tasks.blocked ? colors.danger : colors.fg3 }]}>
          {parts.join(' · ') || t('no tasks yet')}
        </T>
      </T>
      <View style={s.barRow}>
        <Bar share={swarm.budget ? swarm.spent / swarm.budget : 0} budget />
        <T muted mono style={s.tiny}>
          {usd(swarm.spent)}
          {swarm.budget !== null ? ` / ${usd(swarm.budget)}` : ''}
        </T>
      </View>
    </View>
  );
}

export function swarmColor(status: string): string {
  if (status === 'failed') return colors.danger;
  if (status === 'partial') return colors.warn;
  if (status === 'running') return colors.okSoft;
  if (status === 'paused') return colors.warn;
  if (status === 'done') return colors.purple;
  return colors.fg3;
}

export function SessionCard({ session }: { session: Session }) {
  useLocale();
  const state = sessionState(session);
  const sponsors = session.running.map((r) => nameOf(session, r.userId));
  const joined = session.participants.filter((p) => p.mode === 'join');
  const watching = session.participants.filter((p) => p.mode === 'watch');
  const when =
    session.status === 'ended' ? (session.endedAt ?? session.updatedAt) : session.updatedAt;
  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { backgroundColor: colors.bg4 }]}
      onPress={() => router.push({ pathname: '/session/[id]', params: { id: session.id } })}
      accessibilityRole="button"
      accessibilityLabel={[
        session.title,
        stateLabel(state),
        sponsors.length ? t('running: {names}', { names: sponsors.join(', ') }) : null,
        joined.length
          ? t('working: {names}', {
              names: joined
                .map((p) =>
                  p.kind === 'agent' ? t('{name} (AI teammate)', { name: p.name }) : p.name,
                )
                .join(', '),
            })
          : null,
        watching.length ? t('{n} watching', { n: watching.length }) : null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <T style={s.title} numberOfLines={2}>
        {session.title}
      </T>
      <View style={s.status}>
        <Radio size={12} color={STATE_COLOR[state]} />
        <T style={[s.small, { color: STATE_COLOR[state] }]} numberOfLines={1}>
          {stateLabel(state)}
          {sponsors.length > 0 && (
            <T muted style={s.small}>
              {' · '}
              {sponsors.length > 1
                ? t('on {names} accounts', {
                    names: sponsors.map((name) => t("{name}'s", { name })).join(', '),
                  })
                : t("on {name}'s account", { name: sponsors[0]! })}
            </T>
          )}
        </T>
      </View>
      <T muted mono numberOfLines={1} style={s.tiny}>
        {harnessLine(session) || t('no agents yet')}
        {session.branch ? ` · ${session.branch}` : ''}
      </T>
      {session.plan.total > 0 && (
        <View style={s.barRow}>
          <Bar share={session.plan.done / session.plan.total} />
          <T muted mono style={s.tiny}>
            {session.plan.done}/{session.plan.total}
          </T>
        </View>
      )}
      {session.swarm && <SwarmLine session={session} />}
      {session.touchedFiles.length > 0 && (
        <View style={s.status}>
          <FileCode2 size={12} color={colors.fg3} />
          <T muted mono numberOfLines={1} style={[s.tiny, { flex: 1 }]}>
            {session.touchedFiles.slice(0, 2).join(', ')}
            {session.touchedFiles.length > 2 ? ` +${session.touchedFiles.length - 2}` : ''}
          </T>
        </View>
      )}
      <View style={s.foot}>
        <View style={s.avatars}>
          {joined.slice(0, 5).map((p, i) => (
            <View key={p.userId} style={i > 0 && { marginLeft: -6 }}>
              <Avatar name={p.name} size={22} ring ai={p.kind === 'agent'} />
            </View>
          ))}
        </View>
        {watching.length > 0 && (
          <View style={s.status}>
            <Eye size={12} color={colors.fg3} />
            <T muted style={s.small}>
              {watching.length}
            </T>
          </View>
        )}
        <View style={{ flex: 1 }} />
        <T muted mono style={s.tiny}>
          {session.cost > 0 ? `${usd(session.cost)} · ` : ''}
          {ago(when)}
        </T>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    gap: 9,
    padding: 16,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  title: { fontFamily: fonts.uiMedium, fontSize: 16, lineHeight: 21 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { fontSize: 13 },
  tiny: { fontSize: 11.5 },
  block: { gap: 6 },
  swarmStatus: { fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: 0.6 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  avatars: { flexDirection: 'row' },
});
