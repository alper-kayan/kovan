import type { AiAgent, Session } from '@kovan/shared';
import { Bot } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActions } from '../lib/actions';
import { useSession } from '../lib/session';
import { ToastHost } from '../lib/toast';
import { colors, fonts, radius } from '../lib/theme';
import { Button, Chip, T } from './ui';

/** The workspace's AI teammates, for a session or a swarm (archived ones left out). */
export function useTeammates(workspaceId: string) {
  const { api } = useSession();
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ agents: AiAgent[] }>('GET', `/api/workspaces/${workspaceId}/agents`)
      .then((r) => setAgents(r.agents.filter((a) => !a.archived)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, workspaceId]);
  return { agents, error };
}

/**
 * Brings an AI teammate into the session with its own lane. Your desktop runs it, on your key;
 * anyone in the session can then message it.
 */
export function AddTeammate({ session, onClose }: { session: Session; onClose(): void }) {
  const act = useActions();
  const insets = useSafeAreaInsets();
  const { agents, error } = useTeammates(session.workspaceId);
  const here = new Set(session.participants.filter((p) => p.mode === 'join').map((p) => p.userId));
  const free = agents?.filter((a) => !here.has(a.id)) ?? null;
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <T style={s.title}>Add an AI teammate</T>
        <T muted style={s.small}>
          It gets its own lane. Your desktop runs it, on your key.
        </T>
        {error && <T style={{ color: colors.danger }}>{error}</T>}
        {!free && !error && <ActivityIndicator color={colors.fg3} />}
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 6 }}>
          {free?.map((a) => (
            <Pressable
              key={a.id}
              style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.bg4 }]}
              accessibilityRole="button"
              accessibilityLabel={`Add ${a.name}`}
              onPress={() => {
                onClose();
                void act.addTeammate(session.id, a.id, a.name);
              }}
            >
              <View style={s.bot}>
                <Bot size={14} color={colors.fg2} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T>{a.name}</T>
                {a.instructions ? (
                  <T muted numberOfLines={2} style={s.small}>
                    {a.instructions}
                  </T>
                ) : null}
              </View>
              <Chip>{a.model.split('/').pop() ?? a.model}</Chip>
            </Pressable>
          ))}
          {free?.length === 0 && (
            <T muted style={s.small}>
              {agents?.length
                ? 'Every AI teammate is in this session already.'
                : 'This workspace has no AI teammates yet. Add them on the People page of the desktop app.'}
            </T>
          )}
        </ScrollView>
        <Button title="Cancel" kind="secondary" onPress={onClose} />
      </View>
      <ToastHost />
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    gap: 12,
    padding: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  title: { fontFamily: fonts.uiBold, fontSize: 17 },
  small: { fontSize: 12.5, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: radius.md,
  },
  bot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg4,
  },
});
