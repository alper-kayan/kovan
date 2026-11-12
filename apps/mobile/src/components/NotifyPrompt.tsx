import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { t, useLocale } from '../lib/i18n';
import { registerForPush } from '../lib/push';
import { useSession } from '../lib/session';
import { colors, fonts, radius } from '../lib/theme';
import { Button, T } from './ui';

/**
 * Asks for notifications with a reason first, instead of the system's question popping up over
 * the very first screen. Shows only while the phone hasn't been asked yet.
 */
export function NotifyPrompt() {
  useLocale();
  const { api } = useSession();
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    void registerForPush(api, false)
      .then((s) => setAsk(s.state === 'off'))
      .catch(() => setAsk(false));
  }, [api]);
  if (!ask) return null;
  return (
    <View style={s.box}>
      <T style={s.title}>{t('Know when an agent needs you')}</T>
      <T muted style={s.text}>
        {t(
          'Kovan tells this phone when an agent waits for your yes, finishes, or gets stuck, but only while you are away from your desktop. You choose which kinds in Account.',
        )}
      </T>
      <View style={s.row}>
        <Button
          small
          title={t('Turn on notifications')}
          onPress={() => void registerForPush(api, true).finally(() => setAsk(false))}
        />
        <Button small kind="secondary" title={t('Not now')} onPress={() => setAsk(false)} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 8, padding: 14, borderRadius: radius.lg, backgroundColor: colors.bg3 },
  title: { fontFamily: fonts.uiBold, fontSize: 15 },
  text: { fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
});
