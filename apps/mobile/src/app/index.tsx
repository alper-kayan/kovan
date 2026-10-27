import { Stack, router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Alerts } from '../components/Alerts';
import { UpdateBanner } from '../components/UpdateBanner';
import { Avatar, Chip, ConnectionBar, T } from '../components/ui';
import { alertsOf, sessionState } from '../lib/board';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { colors, fonts, initials, radius, workspaceColor } from '../lib/theme';

const MODE_LABEL = { solo: 'Solo', team: 'Team', adaptive: 'Adaptive' } as const;

export default function Workspaces() {
  const { user } = useSession();
  const { board, loaded, connection, error, reload } = useLive();
  const [refreshing, setRefreshing] = useState(false);
  const alerts = useMemo(() => alertsOf(board, user?.id ?? null), [board, user?.id]);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/account')}
              accessibilityRole="button"
              accessibilityLabel="Account"
              hitSlop={10}
            >
              <Avatar name={user?.name ?? '?'} size={28} />
            </Pressable>
          ),
        }}
      />
      <ConnectionBar state={connection} />
      <FlatList
        style={s.list}
        contentContainerStyle={s.content}
        data={board.workspaces}
        keyExtractor={(w) => w.id}
        refreshControl={
          <RefreshControl
            tintColor={colors.fg3}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void reload().finally(() => setRefreshing(false));
            }}
          />
        }
        ListHeaderComponent={
          <View style={s.head}>
            <UpdateBanner />
            {error && (
              <View style={s.banner}>
                <T style={{ color: colors.danger }}>{error}</T>
              </View>
            )}
            {alerts.length > 0 && (
              <>
                <T style={s.section}>NEEDS YOU · {alerts.length}</T>
                <Alerts alerts={alerts} board={board} userId={user?.id ?? null} />
              </>
            )}
            {board.workspaces.length > 0 && <T style={s.section}>WORKSPACES</T>}
          </View>
        }
        ListEmptyComponent={
          loaded ? (
            <View style={s.empty}>
              <T muted style={{ textAlign: 'center' }}>
                You&apos;re not in a workspace yet. Create or join one in the desktop app; it shows
                up here.
              </T>
            </View>
          ) : null
        }
        renderItem={({ item: w }) => {
          const sessions = board.sessions[w.id] ?? [];
          const running = sessions.filter((x) => sessionState(x) === 'running').length;
          const waiting = alertsOf(board, user?.id ?? null, w.id).length;
          const summary = [
            `${sessions.length} live session${sessions.length === 1 ? '' : 's'}`,
            running > 0 && `${running} running`,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.bg4 }]}
              onPress={() => router.push({ pathname: '/workspace/[id]', params: { id: w.id } })}
              accessibilityRole="button"
              accessibilityLabel={`${w.name}, ${w.role}, ${summary}${waiting ? `, ${waiting} need you` : ''}`}
            >
              <View style={[s.tile, { backgroundColor: workspaceColor(w.name, w.color) }]}>
                <T scales={false} style={s.tileText}>
                  {initials(w.name)}
                </T>
              </View>
              <View style={s.info}>
                <T style={s.name} numberOfLines={1}>
                  {w.name}
                </T>
                <T muted numberOfLines={1} style={s.meta}>
                  {summary}
                  {waiting > 0 && (
                    <T style={[s.meta, { color: colors.warn }]}> · {waiting} need you</T>
                  )}
                </T>
                <T muted mono numberOfLines={1} style={s.repo}>
                  {w.repoUrl ?? 'no remote'} · {w.defaultBranch}
                </T>
              </View>
              <View style={s.chips}>
                <Chip>{w.role}</Chip>
                <Chip>{MODE_LABEL[w.mode]}</Chip>
              </View>
              <ChevronRight size={16} color={colors.fg4} />
            </Pressable>
          );
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 10 },
  head: { gap: 10 },
  section: {
    color: colors.fg3,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.bg3,
    borderWidth: 1,
    borderColor: colors.line,
  },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: { color: '#fff', fontFamily: fonts.uiBold, fontSize: 13 },
  info: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.uiMedium, fontSize: 16 },
  meta: { fontSize: 13 },
  repo: { fontSize: 11.5 },
  chips: { alignItems: 'flex-end', gap: 4 },
  banner: {
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  empty: { paddingVertical: 60, paddingHorizontal: 20 },
});
