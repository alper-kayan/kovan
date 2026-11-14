import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActions } from '../lib/actions';
import { useDesktopOnline } from '../lib/desktop';
import { t, useLocale } from '../lib/i18n';
import { QUICK_BUDGET, startWithLead } from '../lib/leadStart';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';
import { ToastHost, useToast } from '../lib/toast';
import { Button, T } from './ui';

/**
 * One box for a goal: it goes to a lead, which splits it and opens its own agents. A team is set
 * up if the workspace has none; the session opens on its lanes and the swarm starts on your
 * desktop, or on a machine of the workspace when no desktop is online.
 */
export function LeadStart({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  useLocale();
  const { api } = useSession();
  const { show } = useToast();
  const act = useActions();
  const insets = useSafeAreaInsets();
  const { board } = useLive();
  const desktop = useDesktopOnline();
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = board.workspaces.find((w) => w.id === workspaceId)?.role === 'owner';
  const start = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const made = await startWithLead(api, {
        workspaceId,
        goal,
        branches: (board.sessions[workspaceId] ?? []).map((x) => x.branch),
        owner,
      });
      onClose();
      router.push({ pathname: '/session/[id]', params: { id: made.session.id } });
      await act.desk({ kind: 'launch', swarmId: made.swarm.id, sessionId: made.session.id });
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <Pressable
          style={s.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('Close')}
        />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <T style={s.title}>{t('What would you like to do?')}</T>
          <TextInput
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            value={goal}
            onChangeText={setGoal}
            multiline
            autoFocus
            placeholder={t(
              'Tell the lead what to build, e.g. Add total, product and mean helpers with tests',
            )}
            placeholderTextColor={colors.fg4}
            style={s.input}
            accessibilityLabel={t('The goal for the lead')}
          />
          <T muted style={s.small}>
            {t(
              "The lead splits it up and opens its own agents. You'll see their lanes in the session, one after another. Budget ${budget}.",
              { budget: QUICK_BUDGET },
            )}
          </T>
          {desktop === false && (
            <T style={[s.small, s.warn]}>
              {t(
                "Kovan isn't open on your computer. The team is set up either way; it runs on a machine of the workspace if there is one, or when you open Kovan on your computer.",
              )}
            </T>
          )}
          <Button
            title={t('Start with a lead')}
            busy={busy}
            disabled={!goal.trim()}
            onPress={start}
          />
          <Button title={t('Cancel')} kind="secondary" onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
      <ToastHost />
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    gap: 10,
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  title: { fontFamily: fonts.uiBold, fontSize: 17 },
  small: { fontSize: 12.5, lineHeight: 17 },
  warn: { color: colors.warn },
  input: {
    minHeight: 96,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
    textAlignVertical: 'top',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
});
