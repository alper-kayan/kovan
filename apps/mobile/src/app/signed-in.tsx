import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { T } from '../components/ui';
import { t, useLocale } from '../lib/i18n';
import { useSession } from '../lib/session';
import { colors } from '../lib/theme';

/**
 * kovan://signed-in, where the server's last sign-in page sends the browser. The link usually
 * arrives before the phone has collected its token, so it waits for that, then goes on.
 */
export default function SignedIn() {
  useLocale();
  const { status } = useSession();
  if (status === 'loading' || status === 'signingIn')
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          backgroundColor: colors.bg,
        }}
      >
        <ActivityIndicator color={colors.fg3} />
        <T muted>{t('Finishing sign-in…')}</T>
      </View>
    );
  return <Redirect href={status === 'signedIn' ? '/' : '/sign-in'} />;
}
