import { ROLE_WORDS, type Role } from '@kovan/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { Button, T } from '../components/ui';
import { t, useLocale } from '../lib/i18n';
import { useSession } from '../lib/session';
import { colors, fonts } from '../lib/theme';

type Joined = { workspaceId: string; workspaceName: string; role: Role };

/**
 * kovan://join?t=…, from an invite link: joins the workspace with whatever account is signed
 * in here (an Apple private address too), and signs in first when nobody is.
 */
export default function Join() {
  useLocale();
  const { t: token } = useLocalSearchParams<{ t?: string }>();
  const { status, user, api, signIn } = useSession();
  const [joined, setJoined] = useState<Joined | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status !== 'signedIn' || !token || joined || error || busy) return;
    setBusy(true);
    api<Joined>('POST', '/api/invites/accept', { token })
      .then(setJoined, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [status, token, joined, error, busy, api]);

  if (!token)
    return (
      <Screen>
        <T style={s.title}>{t('This link has no invite in it')}</T>
        <T muted style={s.text}>
          {t('Open the link from your invite email again, or ask for a new one.')}
        </T>
        <Button title={t('Go to Kovan')} kind="secondary" onPress={() => router.replace('/')} />
      </Screen>
    );

  if (status === 'signedOut')
    return (
      <Screen>
        <T style={s.title}>{t('Sign in to join')}</T>
        <T muted style={s.text}>
          {t(
            'You opened an invite. Sign in with any account; the invite joins it to the workspace right after, even if the invite went to another address.',
          )}
        </T>
        <Button title={t('Sign in')} onPress={() => void signIn()} />
      </Screen>
    );

  if (joined)
    return (
      <Screen>
        <T style={s.title}>{t("You're in {workspace}", { workspace: joined.workspaceName })}</T>
        <T muted style={s.text}>
          {t('You joined as {role}.', { role: t(ROLE_WORDS[joined.role]) })}
        </T>
        <Button
          title={t('Open {workspace}', { workspace: joined.workspaceName })}
          onPress={() =>
            router.replace({ pathname: '/workspace/[id]', params: { id: joined.workspaceId } })
          }
        />
      </Screen>
    );

  if (error)
    return (
      <Screen>
        <T style={s.title}>{t("This invite didn't work")}</T>
        <T style={[s.text, { color: colors.danger }]}>{error}</T>
        <Button title={t('Go to Kovan')} kind="secondary" onPress={() => router.replace('/')} />
      </Screen>
    );

  return (
    <Screen>
      <ActivityIndicator color={colors.fg3} />
      <T muted style={s.text}>
        {user?.email ? t('Joining as {email}…', { email: user.email }) : t('Joining…')}
      </T>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={s.screen}>
      <View style={s.box}>{children}</View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  box: { gap: 14 },
  title: { fontFamily: fonts.uiBold, fontSize: 20, textAlign: 'center' },
  text: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
});
