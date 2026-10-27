import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { NotificationSettings } from '../components/NotificationSettings';
import { Avatar, Button, T } from '../components/ui';
import { useSession } from '../lib/session';
import { ToastHost } from '../lib/toast';
import { runningUpdate } from '../lib/updates';
import { colors, fonts, radius } from '../lib/theme';

export default function Account() {
  const { user, orgs, server, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <View style={s.screen}>
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <View style={s.card}>
          <Avatar name={user?.name ?? '?'} size={52} />
          <View style={{ flex: 1, gap: 2 }}>
            <T style={s.name}>{user?.name}</T>
            <T muted>{user?.email ?? user?.githubLogin ?? ''}</T>
          </View>
        </View>
        <View style={s.list}>
          <Row label="Server" value={server.replace(/^https?:\/\//, '')} mono />
          {orgs.map((o) => (
            <Row key={o.id} label="Organization" value={`${o.name} · ${o.role}`} />
          ))}
          <Row
            label="App"
            value={`Kovan ${Constants.expoConfig?.version ?? ''}${Application.nativeBuildVersion ? ` (${Application.nativeBuildVersion})` : ''}`}
          />
          <Row label="Update" value={runningUpdate()} mono />
        </View>
        <Pressable
          onPress={() => router.push('/spend')}
          accessibilityRole="button"
          style={({ pressed }) => [s.link, pressed && { backgroundColor: colors.bg4 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <T>Spend and limits</T>
            <T muted style={{ fontSize: 12.5 }}>
              What agents cost, your allowance, workspace limits
            </T>
          </View>
          <ChevronRight size={16} color={colors.fg3} />
        </Pressable>
        <NotificationSettings />
        <View style={s.list}>
          <Page server={server} path="/privacy/" title="Privacy policy" />
          <Page server={server} path="/terms/" title="Terms of service" />
          <Page server={server} path="/contact/" title="Contact" last />
        </View>
        <Button
          title="Sign out"
          kind="danger"
          busy={busy}
          onPress={() => {
            setBusy(true);
            // Signed out, the guarded screens go away and sign-in shows by itself.
            void signOut();
          }}
        />
        <Button
          title="Delete account…"
          kind="secondary"
          onPress={() => router.push('/delete-account')}
        />
      </ScrollView>
      <ToastHost />
    </View>
  );
}

/** A page of the website, opened in the browser. */
function Page({
  server,
  path,
  title,
  last,
}: {
  server: string;
  path: string;
  title: string;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={() => void Linking.openURL(`${server.replace(/\/$/, '')}${path}`)}
      accessibilityRole="link"
      style={({ pressed }) => [
        s.row,
        last && { borderBottomWidth: 0 },
        pressed && { opacity: 0.6 },
      ]}
    >
      <T>{title}</T>
      <ChevronRight size={16} color={colors.fg3} />
    </Pressable>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.row}>
      <T muted>{label}</T>
      <T mono={mono} numberOfLines={1} style={{ flexShrink: 1 }}>
        {value}
      </T>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.bg3,
  },
  name: { fontFamily: fonts.uiBold, fontSize: 18 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: radius.lg,
    backgroundColor: colors.bg3,
  },
  list: {
    borderRadius: radius.lg,
    backgroundColor: colors.bg3,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line2,
  },
});
