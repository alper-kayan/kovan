import { suggestTeam } from '@kovan/jevrouter';
import { effectiveMode, type Member, type Session, type Swarm } from '@kovan/shared';
import { Check, Minus, Plus } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useActions } from '../lib/actions';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';
import { useToast } from '../lib/toast';
import { useTeammates } from './AddTeammate';
import { Button, T } from './ui';

/**
 * Setting up a swarm from the phone, as on the desktop: the goal, who leads, who works, the
 * budget. It is saved here and then runs on the person's own desktop, on their key, or on a
 * machine of the workspace (agentd) when none of their desktops is online.
 */
export function SwarmSetup({
  session,
  draft,
  onCancel,
}: {
  session: Session;
  /** A swarm set up earlier and not launched: its settings are the starting point. */
  draft: Swarm | null;
  onCancel?: () => void;
}) {
  const { api } = useSession();
  const { board } = useLive();
  const act = useActions();
  const { show } = useToast();
  const { agents, error } = useTeammates(session.workspaceId);
  const [people, setPeople] = useState<number | null>(null);
  const [goal, setGoal] = useState(draft?.goal ?? '');
  const [picked, setPicked] = useState<string[]>(draft?.agents.map((a) => a.agentId) ?? []);
  const [lead, setLead] = useState<string | null>(draft?.leadAgentId ?? null);
  const [budget, setBudget] = useState(draft?.budget?.toFixed(2) ?? '1.00');
  const [parallel, setParallel] = useState(draft?.maxParallel ?? 2);
  const [review, setReview] = useState(draft?.review ?? true);
  const [why, setWhy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workspace = board.workspaces.find((w) => w.id === session.workspaceId);
  useEffect(() => {
    void api<{ members: Member[] }>('GET', `/api/workspaces/${session.workspaceId}/members`)
      .then((r) => setPeople(r.members.filter((m) => m.kind === 'human').length))
      .catch(() => setPeople(null));
  }, [api, session.workspaceId]);
  const solo = workspace ? effectiveMode(workspace.mode, people ?? 2) === 'solo' : false;

  if (error) return <T style={{ color: colors.danger }}>{error}</T>;
  if (!agents) return <ActivityIndicator color={colors.fg3} />;
  if (agents.length === 0)
    return (
      <T muted style={s.note}>
        A swarm puts several AI teammates on one goal: a lead splits it, the others work in
        parallel. Add AI teammates on the People page of the desktop app first.
      </T>
    );

  const leadId = lead && picked.includes(lead) ? lead : (picked[0] ?? null);
  const amount = Number(budget.replace(',', '.'));
  const valid = goal.trim().length > 0 && picked.length > 0 && amount >= 0.01;
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  // JevRouter's free rules size the goal; the teammates whose instructions fit it are picked.
  const suggest = () => {
    const t = suggestTeam(goal, agents, solo ? { maxWorkers: 2 } : {});
    if (!t) return;
    setPicked([t.leadId, ...t.workerIds]);
    setLead(t.leadId);
    setParallel(Math.min(4, t.maxParallel));
    setWhy(
      t.small
        ? `${t.reason}. One agent is enough here: you can also just ask your own agent in the Lanes tab.`
        : `${t.reason}${solo ? ' · Solo workspace: at most two workers' : ''}`,
    );
  };
  const launch = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const { swarm } = await api<{ swarm: Swarm }>('PUT', `/api/sessions/${session.id}/swarm`, {
        goal: goal.trim(),
        leadAgentId: leadId,
        agentIds: picked,
        budget: Math.round(amount * 100) / 100,
        review,
        maxParallel: parallel,
        mode: draft?.mode ?? 'allow',
      });
      await act.desk({ kind: 'launch', swarmId: swarm.id, sessionId: session.id });
    } catch (e) {
      show(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.box}>
      <T style={s.title}>Start a swarm</T>
      <TextInput
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        value={goal}
        onChangeText={setGoal}
        multiline
        placeholder="The shared goal, e.g. Add median and mode helpers with tests"
        placeholderTextColor={colors.fg4}
        // One paragraph: Return puts the keyboard away instead of starting a new line.
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        style={[s.input, s.goal]}
        accessibilityLabel="The swarm's goal"
      />
      <Button
        small
        kind="secondary"
        title="Suggest a team"
        disabled={!goal.trim()}
        onPress={suggest}
      />
      {why && (
        <T muted style={s.note}>
          {why}
        </T>
      )}

      <T style={s.section}>TEAM</T>
      <View style={s.list}>
        {agents.map((a) => {
          const on = picked.includes(a.id);
          const isLead = on && a.id === leadId;
          return (
            <View key={a.id} style={s.agent}>
              <Pressable
                onPress={() => toggle(a.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={a.name}
                style={s.agentMain}
              >
                <View style={[s.check, on && s.checkOn]}>
                  {on && <Check size={12} color={colors.popfg} />}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T>{a.name}</T>
                  {a.instructions ? (
                    <T muted numberOfLines={1} style={s.small}>
                      {a.instructions}
                    </T>
                  ) : null}
                </View>
              </Pressable>
              {on && (
                <Pressable
                  onPress={() => setLead(a.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isLead }}
                  accessibilityLabel={`${a.name} leads`}
                  hitSlop={6}
                  style={[s.lead, isLead && s.leadOn]}
                >
                  <T style={[s.leadText, isLead && { color: colors.fg }]}>LEAD</T>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>

      <View style={s.row}>
        <T style={{ flex: 1 }}>Budget</T>
        <T muted>$</T>
        <TextInput
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
          // Typing replaces the amount rather than adding to it.
          selectTextOnFocus
          style={[s.input, s.amount]}
          accessibilityLabel="Budget in dollars"
        />
      </View>
      <View style={s.row}>
        <T style={{ flex: 1 }}>At once</T>
        <Pressable
          onPress={() => setParallel((n) => Math.max(1, n - 1))}
          accessibilityRole="button"
          accessibilityLabel="Fewer at once"
          hitSlop={6}
          style={s.step}
        >
          <Minus size={14} color={colors.fg2} />
        </Pressable>
        <T mono style={s.count}>
          {parallel}
        </T>
        <Pressable
          onPress={() => setParallel((n) => Math.min(6, n + 1))}
          accessibilityRole="button"
          accessibilityLabel="More at once"
          hitSlop={6}
          style={s.step}
        >
          <Plus size={14} color={colors.fg2} />
        </Pressable>
      </View>
      <View style={s.row}>
        <T style={{ flex: 1 }}>Review each task before it joins</T>
        <Switch
          value={review}
          onValueChange={setReview}
          trackColor={{ true: colors.pop, false: colors.bg4 }}
        />
      </View>

      <T muted style={s.note}>
        It runs on your desktop, on your key; with your desktop off, on a machine of this workspace.
        Its agents act without asking.
      </T>
      <Button title="Launch" busy={busy} disabled={!valid} onPress={launch} />
      {onCancel && <Button title="Cancel" kind="secondary" onPress={onCancel} />}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 12 },
  title: { fontFamily: fonts.uiBold, fontSize: 17 },
  section: {
    color: colors.fg3,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.8,
    marginTop: 4,
  },
  input: {
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goal: { minHeight: 84, textAlignVertical: 'top' },
  amount: { width: 90, textAlign: 'right', fontFamily: fonts.mono },
  list: {
    gap: 4,
    padding: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 6 },
  agentMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8 },
  check: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.pop, borderColor: colors.pop },
  lead: {
    paddingHorizontal: 8,
    minHeight: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line2,
    justifyContent: 'center',
  },
  leadOn: { backgroundColor: colors.bg4, borderColor: colors.bg4 },
  leadText: { fontFamily: fonts.mono, fontSize: 10, color: colors.fg3, letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 },
  step: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { width: 20, textAlign: 'center' },
  small: { fontSize: 12.5, lineHeight: 17 },
  note: { fontSize: 12.5, lineHeight: 18 },
});
