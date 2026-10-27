import type { AccountDeletionPlan } from '@kovan/shared';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { Button, T } from '../components/ui';
import { usd } from '../lib/board';
import { useSession } from '../lib/session';
import { colors, fonts, MAX_FONT_SCALE, radius } from '../lib/theme';
import { ToastHost, useToast } from '../lib/toast';

const WORD = 'delete';

/**
 * Deleting the account, from the phone: what goes and what stays is shown first (the server
 * works it out), and it takes typing a word to go ahead. It can't be undone.
 */
export default function DeleteAccount() {
  const { api, signOut, user } = useSession();
  const { show } = useToast();
  const [plan, setPlan] = useState<AccountDeletionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ScrollView>(null);
  // The box and the button are at the bottom of a sheet: once the keyboard is up, they scroll
  // into view (a sheet doesn't move out of the keyboard's way by itself). On Android the view
  // shrinks only after the keyboard is shown, so its next layout scrolls too.
  const pinEnd = useRef(false);
  const toEnd = () => scroll.current?.scrollToEnd({ animated: true });
  const reveal = () => {
    pinEnd.current = true;
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      sub.remove();
      toEnd();
      setTimeout(() => (pinEnd.current = false), 600);
    });
  };

  useEffect(() => {
    void api<{ plan: AccountDeletionPlan }>('GET', '/api/me/deletion')
      .then((r) => setPlan(r.plan))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const remove = async () => {
    setBusy(true);
    try {
      await api('POST', '/api/me/delete', { confirm: true });
      show('Your account was deleted.');
      await signOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <View style={s.screen}>
      <KeyboardScreen>
        <ScrollView
          ref={scroll}
          style={s.screen}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          onLayout={() => pinEnd.current && toEnd()}
        >
          <T style={s.lead}>
            This deletes the Kovan account of {user?.name ?? 'this person'} for good, on every
            device. It can&apos;t be undone.
          </T>
          {!plan && !error && <ActivityIndicator color={colors.fg3} />}
          {error && <T style={s.danger}>{error}</T>}
          {plan && (
            <>
              <View style={s.card}>
                <T style={s.title}>Deleted</T>
                <T style={s.line}>
                  Your account, its sign-ins and this phone&apos;s notifications.
                </T>
                {plan.deleted.length > 0 && (
                  <T style={s.line}>
                    Workspaces only you are in, with their sessions, transcripts and AI teammates:{' '}
                    <T style={s.strong}>{plan.deleted.map((w) => w.name).join(', ')}</T>.
                  </T>
                )}
                <T style={s.line}>
                  What you wrote in shared workspaces (your comments and your agent lanes).
                </T>
                <T style={s.line}>Your saved card and billing details.</T>
              </View>
              {(plan.kept.length > 0 || plan.orgsKept.length > 0) && (
                <View style={s.card}>
                  <T style={s.title}>Stays for the others</T>
                  {plan.kept.map((w) => (
                    <T key={w.id} style={s.line}>
                      <T style={s.strong}>{w.name}</T>
                      {w.owner ? `: ${w.owner.name} becomes its owner.` : ''}
                    </T>
                  ))}
                  {plan.orgsKept
                    .filter((o) => o.owner)
                    .map((o) => (
                      <T key={o.id} style={s.line}>
                        Organization <T style={s.strong}>{o.name}</T>: {o.owner!.name} becomes its
                        owner.
                      </T>
                    ))}
                </View>
              )}
              <T muted style={s.note}>
                Repositories on GitHub and code on people&apos;s computers aren&apos;t touched.
                {plan.unbilled > 0
                  ? ` Managed usage not charged yet (${usd(plan.unbilled)}) won't be charged.`
                  : ''}
              </T>
              {plan.blocker ? (
                <T style={s.danger}>{plan.blocker}</T>
              ) : (
                <>
                  <T style={s.line}>
                    Type <T style={s.strong}>{WORD}</T> to confirm.
                  </T>
                  <TextInput
                    value={typed}
                    onChangeText={setTyped}
                    onFocus={reveal}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxFontSizeMultiplier={MAX_FONT_SCALE}
                    placeholder={WORD}
                    placeholderTextColor={colors.fg4}
                    style={s.input}
                    accessibilityLabel={`Type ${WORD} to confirm`}
                    testID="delete-confirm"
                  />
                  <Button
                    title="Delete my account"
                    kind="danger"
                    busy={busy}
                    disabled={typed.trim().toLowerCase() !== WORD}
                    onPress={() => void remove()}
                  />
                </>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardScreen>
      <ToastHost />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  lead: { fontSize: 15.5, lineHeight: 22 },
  card: { gap: 8, padding: 14, borderRadius: radius.lg, backgroundColor: colors.bg3 },
  title: { fontFamily: fonts.uiBold, fontSize: 15 },
  line: { fontSize: 14, lineHeight: 20, color: colors.fg2 },
  strong: { fontFamily: fonts.uiMedium, color: colors.fg },
  note: { fontSize: 13, lineHeight: 19 },
  danger: { color: colors.danger, lineHeight: 20 },
  input: {
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 15,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
