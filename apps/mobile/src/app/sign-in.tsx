import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, LogoMark, T } from '../components/ui';
import { normalizeServer } from '../lib/api';
import { useSession } from '../lib/session';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';

export default function SignIn() {
  const { status, server, error, signIn, signInWithApple, cancelSignIn, setServer } = useSession();
  // Sign in with Apple on iPhones (Apple asks for it next to other sign-ins); never on Android.
  const [apple, setApple] = useState(false);
  const [viaApple, setViaApple] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    void AppleAuthentication.isAvailableAsync()
      .then(setApple)
      .catch(() => setApple(false));
  }, []);
  const [editing, setEditing] = useState(false);
  // Starts empty, with the current server as the hint: type a new one, or leave it to keep it.
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const waiting = status === 'signingIn';

  const close = () => {
    setDraft('');
    setDraftError(null);
    setEditing(false);
  };

  const saveServer = async () => {
    if (!draft.trim()) return close();
    const next = normalizeServer(draft);
    if (!next) return setDraftError('That address does not look right.');
    setDraftError(null);
    await setServer(next);
    close();
  };

  return (
    <SafeAreaView style={s.screen}>
      {/* Android draws edge to edge, so it needs the padding as much as iOS. */}
      <KeyboardAvoidingView style={s.body} behavior="padding">
        <View style={s.brand}>
          <LogoMark size={44} />
          <T style={s.word}>kovan</T>
          <T muted style={s.tagline}>
            Your team&apos;s agents, in your pocket. Watch sessions, answer approvals and steer
            agents from your phone.
          </T>
        </View>

        <View style={s.actions}>
          {waiting && viaApple ? (
            <T style={s.waiting}>Signing in with Apple…</T>
          ) : waiting ? (
            <>
              <T style={s.waiting}>Finish signing in in the browser.</T>
              <T muted style={s.small}>
                An email link works too: open it on this phone and come back here.
              </T>
              <Button title="Cancel" kind="secondary" onPress={cancelSignIn} />
            </>
          ) : (
            <>
              {apple && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                  cornerRadius={radius.md}
                  style={s.apple}
                  onPress={() => {
                    setViaApple(true);
                    void signInWithApple().finally(() => setViaApple(false));
                  }}
                />
              )}
              <Button
                title={apple ? 'Other ways to sign in' : 'Sign in'}
                kind={apple ? 'secondary' : 'primary'}
                onPress={() => void signIn()}
              />
            </>
          )}
          {error && !waiting && <T style={s.error}>{error}</T>}
        </View>

        <View style={s.server}>
          {editing ? (
            <>
              <TextInput
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                value={draft}
                onChangeText={setDraft}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
                placeholder={server.replace(/^https?:\/\//, '')}
                placeholderTextColor={colors.fg4}
                style={s.input}
                onSubmitEditing={() => void saveServer()}
                accessibilityLabel="Server address"
                testID="server-input"
              />
              {draftError && <T style={s.error}>{draftError}</T>}
              <View style={s.row}>
                <Button title="Cancel" kind="secondary" style={s.flex} onPress={close} />
                <Button title="Save" style={s.flex} onPress={() => void saveServer()} />
              </View>
            </>
          ) : (
            <Pressable
              disabled={waiting}
              onPress={() => setEditing(true)}
              accessibilityRole="button"
              accessibilityHint="Change the Kovan server"
            >
              <T muted style={s.small}>
                Server <T mono>{server.replace(/^https?:\/\//, '')}</T> · Change
              </T>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, paddingHorizontal: 24, justifyContent: 'center', gap: 36 },
  brand: { alignItems: 'center', gap: 12 },
  word: { fontFamily: fonts.uiBold, fontSize: 30, color: colors.pop, letterSpacing: -0.6 },
  tagline: { textAlign: 'center', lineHeight: 22, maxWidth: 320 },
  actions: { gap: 12 },
  apple: { height: 46, width: '100%' },
  waiting: { textAlign: 'center', fontFamily: fonts.uiMedium },
  small: { fontSize: 13, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 13.5, textAlign: 'center' },
  server: { gap: 10 },
  input: {
    minHeight: 46,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  row: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
});
