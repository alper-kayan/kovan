import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Keyboard, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MAX_FONT_SCALE, colors, fonts, radius, tint } from './theme';

type Tone = 'info' | 'error';

interface ToastState {
  show(text: string, tone?: Tone): void;
}

interface Hosts {
  toast: { text: string; tone: Tone } | null;
  /** Where toasts can show, newest last: a modal sheet covers the screens under it. */
  stack: number[];
  join(id: number, base: boolean): void;
  leave(id: number): void;
}

const Context = createContext<ToastState | null>(null);
const HostContext = createContext<Hosts | null>(null);
let nextHost = 1;

export function useToast(): ToastState {
  const value = useContext(Context);
  if (!value) throw new Error('useToast outside ToastProvider');
  return value;
}

/**
 * Where toasts appear. The app has one; every modal (a sheet or a modal screen) adds its own,
 * since anything drawn under it is hidden. Only the newest one shows the toast.
 */
export function ToastHost({ base = false }: { base?: boolean }) {
  const hosts = useContext(HostContext);
  const [id] = useState(() => nextHost++);
  const insets = useSafeAreaInsets();
  // Above the keyboard when it is open, or the answer to what was just typed is hidden.
  const [keyboard, setKeyboard] = useState(0);
  const join = hosts?.join;
  const leave = hosts?.leave;
  useEffect(() => {
    join?.(id, base);
    return () => leave?.(id);
  }, [id, base, join, leave]);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setKeyboard(e.endCoordinates.height),
    );
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setKeyboard(0),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const toast = hosts?.toast;
  if (!toast || hosts.stack.at(-1) !== id) return null;
  return (
    <View
      pointerEvents="none"
      style={[s.wrap, { bottom: Math.max(insets.bottom, keyboard) + 16 }]}
      accessibilityLiveRegion="polite"
    >
      <View style={[s.toast, toast.tone === 'error' && s.error]}>
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={s.text}>
          {toast.text}
        </Text>
      </View>
    </View>
  );
}

/** One short line over the bottom of the screen: what an action did, or why it didn't. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: Tone } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stack, setStack] = useState<number[]>([]);
  // The app's own host stays at the bottom, whenever it mounts.
  const join = useCallback(
    (id: number, base: boolean) =>
      setStack((s) =>
        base ? [id, ...s.filter((x) => x !== id)] : [...s.filter((x) => x !== id), id],
      ),
    [],
  );
  const leave = useCallback((id: number) => setStack((s) => s.filter((x) => x !== id)), []);

  const show = useCallback((text: string, tone: Tone = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, tone });
    // VoiceOver doesn't read live regions: it is told.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    // Long enough to read a sentence; errors stay a little longer.
    timer.current = setTimeout(() => setToast(null), tone === 'error' ? 6000 : 4000);
  }, []);

  const value = useMemo(() => ({ show }), [show]);
  const hosts = useMemo(() => ({ toast, stack, join, leave }), [toast, stack, join, leave]);
  return (
    <Context.Provider value={value}>
      <HostContext.Provider value={hosts}>
        {children}
        <ToastHost base />
      </HostContext.Provider>
    </Context.Provider>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg4,
  },
  error: { borderColor: tint.dangerLine, backgroundColor: tint.dangerBg },
  text: { color: colors.fg, fontFamily: fonts.ui, fontSize: 14, lineHeight: 19 },
});
