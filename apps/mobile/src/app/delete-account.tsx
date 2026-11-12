import type { AccountDeletionPlan } from '@kovan/shared';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { Button, T } from '../components/ui';
import { usd } from '../lib/board';
import { t, useLocale } from '../lib/i18n';
import { useSession } from '../lib/session';
import { colors, fonts, MAX_FONT_SCALE, radius } from '../lib/theme';
import { ToastHost } from '../lib/toast';

/**
 * Deleting the account, from the phone: what goes and what stays is shown first (the server
 * works it out), and it takes typing a word to go ahead. It can't be undone.
 */
export default function DeleteAccount() {
  useLocale();
  // The word to type, in the app's language.
  const WORD = t('delete');
  const { api, signOut, user } = useSession();
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
      // Said on the sign-in screen that comes next, not on this one as it closes.
      await signOut(t('Your account was deleted, with everything listed here.'));
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
            {t(
              "This deletes the Kovan account of {name} for good, on every device. It can't be undone.",
              { name: user?.name ?? t('this person') },
            )}
          </T>
          {!plan && !error && <ActivityIndicator color={colors.fg3} />}
          {error && <T style={s.danger}>{error}</T>}
          {plan && (
            <>
              <View style={s.card}>
                <T style={s.title}>{t('Deleted for good')}</T>
                <T style={s.line}>
                  {t("Your account, its sign-ins and this phone's notifications.")}
                </T>
                {plan.deleted.length > 0 && (
                  <T style={s.line}>
                    {t(
                      'Workspaces only you are in, with their sessions, transcripts and AI teammates:',
                    )}{' '}
                    <T style={s.strong}>{plan.deleted.map((w) => w.name).join(', ')}</T>.
                  </T>
                )}
                <T style={s.line}>
                  {t('What you wrote in shared workspaces (your comments and your agent lanes).')}
                </T>
                <T style={s.line}>{t('Your saved card and billing details.')}</T>
              </View>
              {(plan.kept.length > 0 || plan.orgsKept.length > 0) && (
                <View style={s.card}>
                  <T style={s.title}>{t('Stays for the others')}</T>
                  {plan.kept.map((w) => (
                    <T key={w.id} style={s.line}>
                      <T style={s.strong}>{w.name}</T>
                      {w.owner ? t(': {name} becomes its owner.', { name: w.owner.name }) : ''}
                    </T>
                  ))}
                  {plan.orgsKept
                    .filter((o) => o.owner)
                    .map((o) => {
                      const [before, after] = t('Organization {name}: {owner} becomes its owner.', {
                        owner: o.owner!.name,
                      }).split('{name}');
                      return (
                        <T key={o.id} style={s.line}>
                          {before}
                          <T style={s.strong}>{o.name}</T>
                          {after}
                        </T>
                      );
                    })}
                </View>
              )}
              <T muted style={s.note}>
                {t("Repositories on GitHub and code on people's computers aren't touched.")}
                {plan.unbilled > 0
                  ? ` ${t(
                      "Kovan billing usage not charged yet ({amount}) is charged to your card as the account is deleted (under $0.50, it's waived).",
                      { amount: usd(plan.unbilled) },
                    )}`
                  : ''}
              </T>
              {plan.blocker ? (
                <T style={s.danger}>{plan.blocker}</T>
              ) : (
                <>
                  <T style={s.line}>
                    {t('Type {word} to confirm.').split('{word}')[0]}
                    <T style={s.strong}>{WORD}</T>
                    {t('Type {word} to confirm.').split('{word}')[1]}
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
                    accessibilityLabel={t('Type {word} to confirm.', { word: WORD })}
                    testID="delete-confirm"
                  />
                  <Button
                    title={t('Delete my account')}
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
