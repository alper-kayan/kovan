import * as Updates from 'expo-updates';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { t, useLocale } from '../lib/i18n';
import { colors, radius } from '../lib/theme';
import { Button, T } from './ui';

/** A downloaded update, offered on the home screen: it starts by itself on the next launch. */
export function UpdateBanner() {
  useLocale();
  const { isUpdatePending } = Updates.useUpdates();
  const [busy, setBusy] = useState(false);
  if (!isUpdatePending) return null;
  return (
    <View style={s.banner} accessibilityLiveRegion="polite">
      <T style={{ flex: 1 }}>{t('A new version of Kovan is ready.')}</T>
      <Button
        title={t('Restart')}
        small
        busy={busy}
        onPress={() => {
          setBusy(true);
          void Updates.reloadAsync().catch(() => setBusy(false));
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
});
