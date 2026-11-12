import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans/600SemiBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { PushBridge } from '../components/PushBridge';
import { roleName, t, useLocale } from '../lib/i18n';
import { loadLanguage } from '../lib/i18n/saved';
import { LiveProvider, useLive } from '../lib/live';
import { SessionProvider, useSession } from '../lib/session';
import { ToastProvider, useToast } from '../lib/toast';
import { useUpdateWatcher } from '../lib/updates';
import { colors, fonts } from '../lib/theme';

void SplashScreen.preventAutoHideAsync();
// The language picked in Account, read while the splash screen shows.
const languageLoaded = loadLanguage();

function Screens() {
  const { status } = useSession();
  useLocale();
  const [language, setLanguage] = useState(false);
  useEffect(() => {
    void languageLoaded.finally(() => setLanguage(true));
  }, []);
  const [loaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    GeistMono_400Regular,
  });
  const ready = loaded && language && status !== 'loading';
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);
  if (!ready) return null;
  const signedIn = status === 'signedIn';
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg2 },
        headerTintColor: colors.fg,
        headerTitleStyle: { fontFamily: fonts.uiBold, fontSize: 16 },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: t('Workspaces') }} />
        <Stack.Screen name="workspace/[id]" options={{ title: '' }} />
        <Stack.Screen name="session/[id]" options={{ title: '' }} />
        <Stack.Screen name="account" options={{ title: t('Account'), presentation: 'modal' }} />
        <Stack.Screen
          name="spend"
          options={{ title: t('Spend and limits'), presentation: 'modal' }}
        />
        <Stack.Screen
          name="delete-account"
          options={{ title: t('Delete account'), presentation: 'modal' }}
        />
      </Stack.Protected>
      {/* An invite link: open signed in or out (it asks to sign in, then joins). */}
      <Stack.Screen name="join" options={{ title: t('Invite') }} />
      {/* Last: signed out, the first open screen is where the app lands, and that is sign-in. */}
      <Stack.Screen name="signed-in" options={{ headerShown: false }} />
    </Stack>
  );
}

/** A workspace that appears while the app is open (an invite accepted): say who's in where. */
function useJoinNotice() {
  const { board, loaded } = useLive();
  const { show } = useToast();
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(board.workspaces.map((w) => w.id));
    if (known.current)
      for (const w of board.workspaces)
        if (!known.current.has(w.id))
          show(
            t("You're in {workspace} now, as {role}.", {
              workspace: w.name,
              role: roleName(w.role),
            }),
          );
    known.current = ids;
  }, [board.workspaces, loaded, show]);
}

function App() {
  useUpdateWatcher();
  useJoinNotice();
  return (
    <>
      <Screens />
      <PushBridge />
    </>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <ToastProvider>
        <LiveProvider>
          <StatusBar style="light" />
          <App />
        </LiveProvider>
      </ToastProvider>
    </SessionProvider>
  );
}
