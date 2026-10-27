import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans/600SemiBold';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono/400Regular';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { PushBridge } from '../components/PushBridge';
import { LiveProvider } from '../lib/live';
import { SessionProvider, useSession } from '../lib/session';
import { ToastProvider } from '../lib/toast';
import { useUpdateWatcher } from '../lib/updates';
import { colors, fonts } from '../lib/theme';

void SplashScreen.preventAutoHideAsync();

function Screens() {
  const { status } = useSession();
  const [loaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    GeistMono_400Regular,
  });
  const ready = loaded && status !== 'loading';
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
        <Stack.Screen name="index" options={{ title: 'Workspaces' }} />
        <Stack.Screen name="workspace/[id]" options={{ title: '' }} />
        <Stack.Screen name="session/[id]" options={{ title: '' }} />
        <Stack.Screen name="account" options={{ title: 'Account', presentation: 'modal' }} />
        <Stack.Screen name="spend" options={{ title: 'Spend and limits', presentation: 'modal' }} />
        <Stack.Screen
          name="delete-account"
          options={{ title: 'Delete account', presentation: 'modal' }}
        />
      </Stack.Protected>
      {/* Last: signed out, the first open screen is where the app lands, and that is sign-in. */}
      <Stack.Screen name="signed-in" options={{ headerShown: false }} />
    </Stack>
  );
}

function App() {
  useUpdateWatcher();
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
