import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { NotificationSettings } from '../components/NotificationSettings';
import { Avatar, Button, Segmented, T } from '../components/ui';
import { roleName, t, useLanguageChoice, useLocale, type LanguageChoice } from '../lib/i18n';
import { saveLanguage } from '../lib/i18n/saved';
import { useSession } from '../lib/session';
import { confirm } from '../lib/confirm';
import { ToastHost, useToast } from '../lib/toast';
import { runningUpdate } from '../lib/updates';
import { colors, fonts, MAX_FONT_SCALE, radius } from '../lib/theme';

export default function Account() {
  useLocale();
  const language = useLanguageChoice();
  const { user, orgs, server, signOut, rename } = useSession();
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const save = async () => {
    const next = name.trim();
    if (!next || next === user?.name) return setEditing(false);
    try {
      await rename(next);
      setEditing(false);
      show(t('Name saved. Teammates see it from now on.'));
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  return (
    <View style={s.screen}>
      <ScrollView
        style={s.screen}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.card}>
          <Avatar name={user?.name ?? ''} size={52} />
          <View style={{ flex: 1, gap: 2 }}>
            {editing ? (
              <TextInput
                autoFocus
                value={name}
                onChangeText={setName}
                onSubmitEditing={() => void save()}
                returnKeyType="done"
                maxLength={80}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                accessibilityLabel={t('Your name')}
                style={s.nameInput}
              />
            ) : (
              <T style={s.name}>{user?.name ?? t('Loading…')}</T>
            )}
            <T muted>{user?.email ?? user?.githubLogin ?? ''}</T>
          </View>
          {user &&
            (editing ? (
              <Button small title={t('Save')} onPress={() => void save()} />
            ) : (
              <Button
                small
                kind="secondary"
                title={t('Edit name')}
                onPress={() => {
                  setName(user.name);
                  setEditing(true);
                }}
              />
            ))}
        </View>
        {user && user.email && user.name === user.email.split('@')[0] && !editing && (
          <T muted style={{ fontSize: 12.5, marginTop: -8 }}>
            {t('Teammates see “{name}” on your work. Edit it to the name they know you by.', {
              name: user.name,
            })}
          </T>
        )}
        <View style={s.list}>
          <Row label={t('Server')} value={server.replace(/^https?:\/\//, '')} mono />
          {orgs.map((o) => (
            <Row key={o.id} label={t('Organization')} value={`${o.name} · ${roleName(o.role)}`} />
          ))}
          <Row
            label={t('App')}
            value={`Kovan ${Constants.expoConfig?.version ?? ''}${Application.nativeBuildVersion ? ` (${Application.nativeBuildVersion})` : ''}`}
          />
          <Row label={t('Update')} value={runningUpdate()} mono />
        </View>
        <Pressable
          onPress={() => router.push('/spend')}
          accessibilityRole="button"
          style={({ pressed }) => [s.link, pressed && { backgroundColor: colors.bg4 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <T>{t('Spend and limits')}</T>
            <T muted style={{ fontSize: 12.5 }}>
              {t('What agents cost, your allowance, workspace limits')}
            </T>
          </View>
          <ChevronRight size={16} color={colors.fg3} />
        </Pressable>
        <NotificationSettings />
        <View style={s.language}>
          <T muted>{t('Language')}</T>
          <Segmented<LanguageChoice>
            value={language}
            options={[
              { value: 'system', label: t('System') },
              { value: 'en', label: 'English' },
              { value: 'tr', label: 'Türkçe' },
            ]}
            onChange={(next) => void saveLanguage(next)}
          />
        </View>
        <View style={s.list}>
          <Page server={server} path="/privacy/" title={t('Privacy policy')} />
          <Page server={server} path="/terms/" title={t('Terms of service')} />
          <Page server={server} path="/contact/" title={t('Contact')} last />
        </View>
        <Button
          title={t('Sign out')}
          kind="danger"
          busy={busy}
          onPress={() =>
            void confirm(
              t('Sign out?'),
              t(
                "This phone stops getting your notifications until you sign in again. Your agents and sessions aren't affected.",
              ),
              t('Sign out'),
              true,
            ).then((yes) => {
              if (!yes) return;
              setBusy(true);
              // Signed out, the guarded screens go away and sign-in shows by itself.
              void signOut();
            })
          }
        />
        <Button
          title={t('Delete account…')}
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
  nameInput: {
    color: colors.fg,
    fontFamily: fonts.uiBold,
    fontSize: 17,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.fg3,
  },
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
  language: {
    gap: 10,
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
