import type { AgentSpendStats, BillingState, UsageSummary, Workspace } from '@kovan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { Bar, Button, Chip, T } from '../components/ui';
import { lastDays, usd } from '../lib/board';
import { useLive } from '../lib/live';
import { useSession } from '../lib/session';
import { ToastHost, useToast } from '../lib/toast';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';

const DAYS = 30;

/**
 * What agents cost: everything your apps reported over the last 30 days, Kovan's managed
 * usage against your allowance, and each workspace's monthly agent limit (its owner sets it).
 */
export default function Spend() {
  const { api } = useSession();
  const { board } = useLive();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [limits, setLimits] = useState<Record<string, AgentSpendStats>>({});
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const scroll = useRef<ScrollView>(null);
  // The limit editor is at the bottom: once the keyboard is up, it scrolls into view.
  const reveal = () => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      sub.remove();
      scroll.current?.scrollToEnd({ animated: true });
    });
  };

  const load = useCallback(async () => {
    try {
      const [u, b, ...stats] = await Promise.all([
        api<UsageSummary>('GET', `/api/usage?days=${DAYS}`),
        api<{ billing: BillingState }>('GET', '/api/billing').catch(() => null),
        ...board.workspaces.map((w) =>
          api<{ stats: AgentSpendStats }>('GET', `/api/workspaces/${w.id}/agent-spend`)
            .then((r) => [w.id, r.stats] as const)
            .catch(() => null),
        ),
      ]);
      setUsage(u);
      setBilling(b?.billing ?? null);
      setLimits(Object.fromEntries(stats.filter((x) => x !== null)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, board.workspaces]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!usage && !error)
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.fg3} />
      </View>
    );

  return (
    <View style={s.screen}>
      <KeyboardScreen>
        <ScrollView
          ref={scroll}
          style={s.screen}
          contentContainerStyle={s.content}
          // A tap on Save works with the keyboard up.
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.fg3}
              onRefresh={() => {
                setRefreshing(true);
                void load().finally(() => setRefreshing(false));
              }}
            />
          }
        >
          {error && <T style={{ color: colors.danger }}>{error}</T>}
          {usage && <Usage usage={usage} />}
          {billing?.available && <Managed billing={billing} />}
          {board.workspaces.length > 0 && (
            <View style={s.card}>
              <T style={s.title}>Agent limits this month</T>
              <T muted style={s.note}>
                A workspace&apos;s swarms pause when its agents reach the monthly limit.
              </T>
              {board.workspaces.map((w) => (
                <Limit
                  key={w.id}
                  workspace={w}
                  stats={limits[w.id] ?? null}
                  onSaved={(stats) => setLimits((l) => ({ ...l, [w.id]: stats }))}
                  onEdit={reveal}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardScreen>
      <ToastHost />
    </View>
  );
}

function Usage({ usage }: { usage: UsageSummary }) {
  const days = lastDays(usage.byDay, DAYS);
  const top = Math.max(...days.map((d) => d.cost), 0);
  return (
    <View style={s.card}>
      <T muted style={s.label}>
        LAST {DAYS} DAYS
      </T>
      <View style={s.totalRow}>
        <T style={s.total}>{usd(usage.total)}</T>
        <T muted style={s.note}>
          {usage.calls} model {usage.calls === 1 ? 'call' : 'calls'}
        </T>
      </View>
      <View style={s.chart} accessibilityLabel={`Spend per day over the last ${DAYS} days`}>
        {days.map((d) => (
          <View key={d.day} style={s.barSlot}>
            <View
              style={[
                s.bar,
                { height: top > 0 ? Math.max(2, (d.cost / top) * 56) : 2 },
                d.cost === 0 && { backgroundColor: colors.bg4 },
              ]}
            />
          </View>
        ))}
      </View>
      <T muted style={s.note}>
        What your agents cost on any key, as your apps reported it.
      </T>
      {usage.byModel.length > 0 && (
        <>
          <T muted style={[s.label, { marginTop: 6 }]}>
            BY MODEL
          </T>
          {usage.byModel.slice(0, 8).map((m) => (
            <Line key={m.model} label={m.model.split('/').pop() ?? m.model} cost={m.cost} />
          ))}
        </>
      )}
      {usage.byWorkspace.length > 0 && (
        <>
          <T muted style={[s.label, { marginTop: 6 }]}>
            BY WORKSPACE
          </T>
          {usage.byWorkspace.map((w) => (
            <Line
              key={w.workspaceId ?? 'none'}
              label={w.name ?? 'Outside workspaces'}
              cost={w.cost}
            />
          ))}
        </>
      )}
    </View>
  );
}

function Managed({ billing }: { billing: BillingState }) {
  const share = billing.allowance ? billing.spent / billing.allowance : 0;
  return (
    <View style={s.card}>
      <View style={s.head}>
        <T style={[s.title, { flex: 1 }]}>Managed usage</T>
        {billing.status === 'past_due' ? (
          <Chip color={colors.danger}>payment failed</Chip>
        ) : billing.ready ? (
          <Chip color={colors.okSoft}>on</Chip>
        ) : (
          <Chip>off</Chip>
        )}
      </View>
      {billing.reason && !billing.ready && (
        <T muted style={s.note}>
          {billing.reason}
        </T>
      )}
      {billing.consentAt && (
        <>
          <View style={s.head}>
            <T style={{ flex: 1 }}>
              {usd(billing.spent)}
              <T muted>
                {billing.uncapped ? ' spent, no limit' : ` of ${usd(billing.allowance ?? 0)}`}
              </T>
            </T>
          </View>
          {!billing.uncapped && <Bar share={share} budget />}
          <Line label="Not charged yet" cost={billing.unbilled} />
          {billing.card && (
            <View style={s.line}>
              <T muted style={{ flex: 1 }}>
                Card
              </T>
              <T mono style={s.small}>
                {billing.card.brand} ···· {billing.card.last4}
              </T>
            </View>
          )}
        </>
      )}
      <T muted style={s.note}>
        The allowance and the card are changed on the desktop: Settings, Billing & usage.
      </T>
    </View>
  );
}

function Limit({
  workspace,
  stats,
  onSaved,
  onEdit,
}: {
  workspace: Workspace & { role: string };
  stats: AgentSpendStats | null;
  onSaved(stats: AgentSpendStats): void;
  onEdit(): void;
}) {
  const { api } = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  // Said next to the limit, where the person is looking.
  const [problem, setProblem] = useState<string | null>(null);
  const owner = workspace.role === 'owner';
  const limit = stats?.monthLimit ?? null;
  const save = async (next: number | null) => {
    setBusy(true);
    try {
      await api('PATCH', `/api/workspaces/${workspace.id}`, { agentMonthlyLimit: next });
      if (stats) onSaved({ ...stats, monthLimit: next });
      setEditing(false);
      Keyboard.dismiss();
      setProblem(null);
      show(next === null ? 'No monthly limit now.' : `Monthly limit: ${usd(next)}.`);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const amount = Number(value.replace(',', '.'));
  return (
    <View style={s.limit}>
      <View style={s.head}>
        <T numberOfLines={1} style={{ flex: 1 }}>
          {workspace.name}
        </T>
        <T mono style={s.small}>
          {stats ? usd(stats.monthSpent) : '…'}
          <T muted mono style={s.small}>
            {limit !== null ? ` / ${usd(limit)}` : ''}
          </T>
        </T>
      </View>
      {limit !== null && stats && <Bar share={stats.monthSpent / limit} budget />}
      {problem && <T style={[s.note, { color: colors.danger }]}>{problem}</T>}
      {editing ? (
        <View style={s.edit}>
          <T muted>$</T>
          <TextInput
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            autoFocus
            selectTextOnFocus
            placeholder="50.00"
            placeholderTextColor={colors.fg4}
            style={s.input}
            accessibilityLabel={`Monthly agent limit for ${workspace.name}, in dollars`}
          />
          <Button
            small
            title="Save"
            busy={busy}
            disabled={!(amount >= 0.01)}
            onPress={() => void save(Math.round(amount * 100) / 100)}
          />
          {limit !== null && (
            <Button small kind="secondary" title="No limit" onPress={() => void save(null)} />
          )}
        </View>
      ) : owner ? (
        <Button
          small
          kind="secondary"
          title={limit === null ? 'Set a monthly limit' : 'Change the limit'}
          onPress={() => {
            setValue(limit !== null ? limit.toFixed(2) : '');
            onEdit();
            setEditing(true);
          }}
          style={{ alignSelf: 'flex-start' }}
        />
      ) : (
        <T muted style={s.note}>
          {limit === null ? 'No limit.' : 'The workspace owner sets the limit.'}
        </T>
      )}
    </View>
  );
}

function Line({ label, cost }: { label: string; cost: number }) {
  return (
    <View style={s.line}>
      <T numberOfLines={1} style={[s.small, { flex: 1, color: colors.fg2 }]}>
        {label}
      </T>
      <T mono style={s.small}>
        {usd(cost)}
      </T>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  card: { gap: 8, padding: 16, borderRadius: radius.lg, backgroundColor: colors.bg3 },
  title: { fontFamily: fonts.uiBold, fontSize: 16 },
  label: { fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.8 },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  total: { fontFamily: fonts.uiBold, fontSize: 28 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 60, gap: 2 },
  barSlot: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderRadius: 1.5, backgroundColor: colors.pop },
  note: { fontSize: 12.5, lineHeight: 18 },
  small: { fontSize: 12.5 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  limit: {
    gap: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line2,
  },
  edit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    width: 96,
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 15,
    textAlign: 'right',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
