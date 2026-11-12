import { Alert } from 'react-native';
import { t } from './i18n';

/** The platform's own yes/no dialog, for actions that are hard to take back. */
export function confirm(
  title: string,
  message: string,
  action: string,
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      title,
      message,
      [
        { text: t('Cancel'), style: 'cancel', onPress: () => resolve(false) },
        {
          text: action,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}
