import { PUSH_KINDS, type PushKind } from '@kovan/shared';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Switch, View } from 'react-native';
import { registerForPush, setMuted, type PushStatus } from '../lib/push';
import { useSession } from '../lib/session';
import { useToast } from '../lib/toast';
import { colors, fonts, radius } from '../lib/theme';
import { Button, T } from './ui';

/** Which notifications this phone gets; off for a kind on this phone only. */
export function NotificationSettings() {
  const { api } = useSession();
  const { show } = useToast();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [muted, setMutedState] = useState<PushKind[]>([]);

  useEffect(() => {
    void registerForPush(api, false)
      .then((s) => {
        setStatus(s);
        setMutedState((s.device?.muted ?? []) as PushKind[]);
      })
      .catch(() => setStatus({ state: 'unavailable', device: null, serverReady: false }));
  }, [api]);

  const toggle = async (kind: PushKind, on: boolean) => {
    const next = on ? muted.filter((k) => k !== kind) : [...muted, kind];
    setMutedState(next);
    try {
      await setMuted(api, next);
    } catch (e) {
      setMutedState(muted);
      show(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <View style={s.box}>
      <T style={s.title}>Notifications</T>
      {status === null ? null : status.state === 'denied' ? (
        <>
          <T muted style={s.note}>
            Notifications are off for Kovan. Turn them on in Settings to hear about approvals and
            your agents while you are away.
          </T>
          <Button
            small
            kind="secondary"
            title="Open Settings"
            onPress={() => void Linking.openSettings()}
          />
        </>
      ) : status.state === 'unavailable' ? (
        <T muted style={s.note}>
          This device can&apos;t receive push notifications.
        </T>
      ) : status.state === 'off' ? (
        <Button
          small
          title="Turn on notifications"
          onPress={() =>
            void registerForPush(api, true).then((s) => {
              setStatus(s);
              setMutedState((s.device?.muted ?? []) as PushKind[]);
            })
          }
        />
      ) : (
        <>
          {!status.serverReady && (
            <T style={[s.note, { color: colors.warn }]}>
              This server can&apos;t send notifications yet.
            </T>
          )}
          <T muted style={s.note}>
            Sent only while you are away from your desktop.
          </T>
          {PUSH_KINDS.map((k) => (
            <View key={k.kind} style={s.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <T>{k.label}</T>
                <T muted style={s.detail}>
                  {k.detail}
                </T>
              </View>
              <Switch
                value={!muted.includes(k.kind)}
                onValueChange={(on) => void toggle(k.kind, on)}
                trackColor={{ true: colors.ok, false: colors.bg4 }}
                accessibilityLabel={k.label}
              />
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 10, padding: 16, borderRadius: radius.lg, backgroundColor: colors.bg3 },
  title: { fontFamily: fonts.uiBold, fontSize: 15.5 },
  note: { fontSize: 13, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line2,
  },
  detail: { fontSize: 12.5, lineHeight: 17 },
});
