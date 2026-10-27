import { useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, View } from 'react-native';

/**
 * Keeps a screen's bottom (a composer) above the keyboard. The offset is where the screen
 * starts in the window, measured, so it is right under any header on both platforms.
 */
export function KeyboardScreen({ children }: { children: ReactNode }) {
  const box = useRef<View>(null);
  const [top, setTop] = useState(0);
  return (
    <View
      ref={box}
      style={{ flex: 1 }}
      onLayout={() => box.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={top}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
