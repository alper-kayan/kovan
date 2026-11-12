import type { Activity } from '@kovan/shared';
import { FlatList, StyleSheet, View } from 'react-native';
import { ago } from '../lib/board';
import { t, useLocale } from '../lib/i18n';
import { colors } from '../lib/theme';
import { T } from './ui';

const WARN = new Set([
  'limit_hit',
  'outcome_unknown',
  'conflict',
  'sync_paused',
  'swarm_paused',
  'task_failed',
  'task_blocked',
  'subagent_failed',
  'turn_interrupted',
]);

/** The session's activity feed, newest first, as the server keeps it. */
export function ActivityList({ activity }: { activity: Activity[] }) {
  useLocale();
  return (
    <FlatList
      style={s.list}
      contentContainerStyle={s.content}
      data={activity}
      keyExtractor={(a) => a.id}
      ListEmptyComponent={
        <T muted style={s.empty}>
          {t('Nothing has happened here yet.')}
        </T>
      }
      renderItem={({ item: a }) => (
        <View style={s.row}>
          <View style={[s.dot, WARN.has(a.kind) && { backgroundColor: colors.warn }]} />
          <View style={{ flex: 1, gap: 2 }}>
            <T style={s.text}>{a.text}</T>
            <T muted style={s.detail}>
              {[a.detail, ago(a.createdAt)].filter(Boolean).join(' · ')}
            </T>
          </View>
        </View>
      )}
    />
  );
}

const s = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: 16, gap: 14 },
  empty: { padding: 24, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7, backgroundColor: colors.fg4 },
  text: { fontSize: 14, lineHeight: 19 },
  detail: { fontSize: 12, lineHeight: 16 },
});
