import { Stack, router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Alerts } from '../components/Alerts';
import { NotifyPrompt } from '../components/NotifyPrompt';
import { UpdateBanner } from '../components/UpdateBanner';
import { Avatar, Chip, ConnectionBar, T } from '../components/ui';
import { alertsOf, sessionState } from '../lib/board';
import { roleName, t, useLocale } from '../lib/i18n';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { colors, fonts, initials, radius, workspaceColor } from '../lib/theme';

const modeLabel = (mode: 'solo' | 'team' | 'adaptive') =>
  mode === 'solo' ? t('Solo') : mode === 'team' ? t('Team') : t('Adaptive');

export default function Workspaces() {
  useLocale();
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
              accessibilityLabel={t('Account')}
              hitSlop={10}
            >
              <Avatar name={user?.name ?? ''} size={28} />
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
            <NotifyPrompt />
            {error && (
              <View style={s.banner}>
                <T style={{ color: colors.danger }}>{error}</T>
              </View>
            )}
            {alerts.length > 0 && (
              <>
                <T style={s.section}>{t('NEEDS YOU · {n}', { n: alerts.length })}</T>
                <Alerts alerts={alerts} board={board} userId={user?.id ?? null} />
              </>
            )}
            {board.workspaces.length > 0 && <T style={s.section}>{t('WORKSPACES')}</T>}
          </View>
        }
        ListEmptyComponent={
          loaded ? (
            <View style={s.empty}>
              <T style={s.emptyTitle}>{t('Nothing to follow yet')}</T>
              <T muted style={s.emptyText}>
                {t(
                  "Here you follow your team's work: what each agent is doing, a yes when one asks for it, and work started on your computer from your phone.",
                )}
              </T>
              <T muted style={s.emptyText}>
                {t(
                  "It fills up once you're in a workspace: when a teammate invites you, or when you share a repository from Kovan on your computer.",
                )}
              </T>
              {user?.email && (
                <T muted style={s.emptyText}>
                  {t("Signed in as {email}. Invites to another address don't show here.", {
                    email: user.email,
                  })}
                </T>
              )}
              {user?.email?.endsWith('@privaterelay.appleid.com') && (
                <T style={[s.emptyText, { color: colors.warn }]}>
                  {t(
                    "That's the private address Apple made for you. Ask to be invited with it, or sign in another way with the address you were invited with.",
                  )}
                </T>
              )}
              <T muted style={s.emptyText}>
                {t('Pull down to check again.')}
              </T>
            </View>
          ) : null
        }
        renderItem={({ item: w }) => {
          const sessions = board.sessions[w.id] ?? [];
          const running = sessions.filter((x) => sessionState(x) === 'running').length;
          const waiting = alertsOf(board, user?.id ?? null, w.id).length;
          const summary = [
            sessions.length === 1
              ? t('{n} live session', { n: sessions.length })
              : t('{n} live sessions', { n: sessions.length }),
            running > 0 && t('{n} running', { n: running }),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <Pressable
              style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.bg4 }]}
              onPress={() => router.push({ pathname: '/workspace/[id]', params: { id: w.id } })}
              accessibilityRole="button"
              accessibilityLabel={`${w.name}, ${roleName(w.role)}, ${summary}${waiting ? `, ${t('{n} need you', { n: waiting })}` : ''}`}
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
                    <T style={[s.meta, { color: colors.warn }]}>
                      {' · '}
                      {t('{n} need you', { n: waiting })}
                    </T>
                  )}
                </T>
                <T muted mono numberOfLines={1} style={s.repo}>
                  {w.repoUrl ?? t('no remote')} · {w.defaultBranch}
                </T>
              </View>
              <View style={s.chips}>
                <Chip>{roleName(w.role)}</Chip>
                <Chip>{modeLabel(w.mode)}</Chip>
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
  empty: { paddingVertical: 48, paddingHorizontal: 20, gap: 10 },
  emptyTitle: { textAlign: 'center', fontFamily: fonts.uiMedium, fontSize: 16 },
  emptyText: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
});
