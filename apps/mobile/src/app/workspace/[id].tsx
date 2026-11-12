import type { Session } from '@kovan/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { Alerts } from '../../components/Alerts';
import { NewSession } from '../../components/NewSession';
import { SessionCard } from '../../components/SessionCard';
import { Button, ConnectionBar, LogoMark, Segmented, T } from '../../components/ui';
import { allowed } from '../../lib/actions';
import { alertsOf } from '../../lib/board';
import { t, useLocale } from '../../lib/i18n';
import { useLive } from '../../lib/live';
import { useSession } from '../../lib/session';
import { colors } from '../../lib/theme';

/** One workspace's board: its live sessions with what needs someone on top, or its history. */
export default function WorkspaceBoard() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, api } = useSession();
  const { board, connection, reload } = useLive();
  const [tab, setTab] = useState<'live' | 'history'>('live');
  const [history, setHistory] = useState<Session[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  // The sessions come first: past two waiting things, the rest fold away.
  const [allAlerts, setAllAlerts] = useState(false);
  const workspace = board.workspaces.find((w) => w.id === id);
  const live = board.sessions[id] ?? [];
  const alerts = useMemo(() => alertsOf(board, user?.id ?? null, id), [board, user?.id, id]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api<{ sessions: Session[] }>(
        'GET',
        `/api/workspaces/${id}/sessions?status=ended`,
      );
      setHistory(
        res.sessions.sort((a, b) =>
          (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt),
        ),
      );
      setHistoryError(null);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
    }
  }, [api, id]);

  useEffect(() => {
    if (tab === 'history') void loadHistory();
  }, [tab, loadHistory]);

  const shown = tab === 'live' ? live : (history ?? []);

  return (
    <>
      <Stack.Screen options={{ title: workspace?.name ?? t('Workspace') }} />
      <ConnectionBar state={connection} />
      <FlatList
        style={s.list}
        contentContainerStyle={s.content}
        data={shown}
        keyExtractor={(x) => x.id}
        refreshControl={
          <RefreshControl
            tintColor={colors.fg3}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void (tab === 'live' ? reload() : loadHistory()).finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <View style={s.head}>
            <Segmented
              value={tab}
              options={[
                { value: 'live', label: t('Live'), badge: alerts.length },
                { value: 'history', label: t('History') },
              ]}
              onChange={setTab}
            />
            {tab === 'live' && (
              <Alerts
                alerts={allAlerts ? alerts : alerts.slice(0, 2)}
                board={board}
                userId={user?.id ?? null}
              />
            )}
            {tab === 'live' && alerts.length > 2 && (
              <Button
                small
                kind="secondary"
                title={
                  allAlerts
                    ? t('Show fewer')
                    : t('{n} more need you: show', { n: alerts.length - 2 })
                }
                onPress={() => setAllAlerts(!allAlerts)}
              />
            )}
            {tab === 'live' && allowed(board, id, 'session.start') && (
              <Button
                small
                kind="secondary"
                title={t('New session')}
                onPress={() => setStarting(true)}
              />
            )}
            {tab === 'history' && historyError && (
              <T style={{ color: colors.danger }}>{historyError}</T>
            )}
          </View>
        }
        ListEmptyComponent={
          tab === 'history' && history === null ? null : (
            <View style={s.empty}>
              <LogoMark size={40} color={colors.fg4} />
              <T style={s.emptyTitle}>
                {tab === 'live' ? t('No live sessions') : t('No finished sessions yet')}
              </T>
              <T muted style={s.emptyText}>
                {tab === 'live'
                  ? t(
                      'Sessions show up here as they run, with every lane live. Start one here or on a desktop.',
                    )
                  : t('Ended sessions land here with their transcript.')}
              </T>
            </View>
          )
        }
        renderItem={({ item }) => <SessionCard session={item} />}
      />
      {starting && <NewSession workspaceId={id} onClose={() => setStarting(false)} />}
    </>
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12 },
  head: { gap: 12 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16 },
  emptyText: { textAlign: 'center', lineHeight: 21 },
});
