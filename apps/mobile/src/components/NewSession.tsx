import type { Session } from '@kovan/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActions } from '../lib/actions';
import { useDesktopOnline } from '../lib/desktop';
import { t, useLocale } from '../lib/i18n';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';
import { ToastHost, useToast } from '../lib/toast';
import { Button, T } from './ui';
import { branchFor } from '../lib/board';

/**
 * Starts a session from the phone: its own branch (a worktree on the desktop, so nobody's
 * checkout changes), and optionally a first prompt for your agent, which your desktop runs.
 */
export function NewSession({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  useLocale();
  const { api } = useSession();
  const { show } = useToast();
  const act = useActions();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  // Your agent runs on your computer: without Kovan open there, only the session is made.
  const desktop = useDesktopOnline();
  const offline = desktop === false;
  const [busy, setBusy] = useState(false);
  const { board } = useLive();
  const branch = branchFor(
    title,
    (board.sessions[workspaceId] ?? []).map((x) => x.branch),
  );
  const start = async () => {
    if (!title.trim() || !branch) return;
    setBusy(true);
    try {
      const { session } = await api<{ session: Session }>(
        'POST',
        `/api/workspaces/${workspaceId}/sessions`,
        { title: title.trim(), branch },
      );
      onClose();
      router.push({ pathname: '/session/[id]', params: { id: session.id } });
      if (prompt.trim() && !offline) await act.prompt(session.id, prompt.trim());
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
          <T style={s.title}>{t('New session')}</T>
          <TextInput
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            value={title}
            onChangeText={setTitle}
            placeholder={t("What it's about, e.g. Stats helpers")}
            placeholderTextColor={colors.fg4}
            style={s.input}
            autoFocus
            accessibilityLabel={t('Session title')}
          />
          <T muted mono style={s.small}>
            {branch ? t('New branch {branch}', { branch }) : t('It gets its own branch')}
          </T>
          {offline ? (
            <T style={[s.small, s.warn]}>
              {t(
                "Kovan isn't open on your computer, so your agent can't start from here. You can still make the session for your team; open Kovan on your computer to put your agent to work in it.",
              )}
            </T>
          ) : (
            <>
              <TextInput
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                value={prompt}
                onChangeText={setPrompt}
                multiline
                placeholder={t('First prompt for your agent (optional)')}
                placeholderTextColor={colors.fg4}
                style={[s.input, s.prompt]}
                accessibilityLabel={t('First prompt for your agent')}
              />
              <T muted style={s.small}>
                {t('Your computer opens the branch in its own copy and runs your agent there.')}
              </T>
            </>
          )}
          <Button
            title={offline ? t('Make the session') : t('Start')}
            busy={busy}
            disabled={!branch}
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
  warn: { color: colors.warn },
  input: {
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  prompt: { minHeight: 80, textAlignVertical: 'top' },
  small: { fontSize: 12.5, lineHeight: 17 },
});
