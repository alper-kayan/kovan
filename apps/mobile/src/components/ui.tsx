import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { Bot } from 'lucide-react-native';
import { MAX_FONT_SCALE, colors, fonts, initials, personColor, radius } from '../lib/theme';

/** Kovan's mark: six cells around a filled one (the same paths as the desktop and site). */
export function LogoMark({ size = 28, color = colors.pop }: { size?: number; color?: string }) {
  return (
    <Svg viewBox="-1 -1 34 34" width={size} height={size}>
      <G fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round">
        <Path d="M25.27 16.85l3.9 2.25v4.5l-3.9 2.25-3.9-2.25v-4.5z" />
        <Path d="M16 22.2l3.9 2.25v4.5L16 31.2l-3.9-2.25v-4.5z" />
        <Path d="M6.73 16.85l3.9 2.25v4.5l-3.9 2.25-3.9-2.25v-4.5z" />
        <Path d="M6.73 6.15l3.9 2.25v4.5l-3.9 2.25-3.9-2.25V8.4z" />
        <Path d="M16 .8l3.9 2.25v4.5L16 9.8l-3.9-2.25v-4.5z" />
        <Path d="M25.27 6.15l3.9 2.25v4.5l-3.9 2.25-3.9-2.25V8.4z" />
      </G>
      <Path fill={color} d="M16 12.75l2.81 1.63v3.24L16 19.25l-2.81-1.63v-3.24z" />
    </Svg>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  busy = false,
  disabled = false,
  small = false,
  style,
}: {
  title: string;
  onPress(): void;
  kind?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  /** The desktop's btn-sm: for actions inside a card. */
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.primary,
        kind === 'secondary' && styles.secondary,
        kind === 'danger' && styles.dangerBtn,
        small && styles.small,
        pressed && { opacity: 0.8 },
        off && { opacity: 0.5 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={kind === 'primary' ? colors.popfg : colors.fg} />
      ) : (
        <Text
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={[
            styles.buttonText,
            kind === 'primary' && { color: colors.popfg },
            kind === 'danger' && { color: colors.danger },
            small && { fontSize: 13.5 },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

/** A button that runs an action and shows it's busy until the action settles. */
export function Act({
  onPress,
  ...props
}: Omit<Parameters<typeof Button>[0], 'onPress' | 'busy'> & { onPress(): Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      {...props}
      busy={busy}
      onPress={() => {
        setBusy(true);
        void onPress().finally(() => setBusy(false));
      }}
    />
  );
}

export function Avatar({
  name,
  size = 28,
  ring = false,
  ai = false,
}: {
  name: string;
  size?: number;
  /** A card-coloured edge, for avatars that overlap. */
  ring?: boolean;
  /** An AI teammate: its own amber robot, as on the desktop, whatever its name. */
  ai?: boolean;
}) {
  if (ai)
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: colors.warn,
          backgroundColor: 'rgba(229,160,0,0.12)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Bot size={size * 0.55} color={colors.warn} />
      </View>
    );
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(ring ? { borderWidth: 2, borderColor: colors.bg3 } : null),
        backgroundColor: personColor(name),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        allowFontScaling={false}
        style={{ color: '#fff', fontFamily: fonts.uiBold, fontSize: size * 0.38 }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}

export function Chip({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <View style={[styles.chip, color ? { borderColor: color } : null]}>
      <Text
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[styles.chipText, color ? { color } : null]}
      >
        {children}
      </Text>
    </View>
  );
}

export function T({
  children,
  style,
  muted,
  mono,
  numberOfLines,
  selectable,
  scales = true,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  muted?: boolean;
  mono?: boolean;
  numberOfLines?: number;
  /** Long-press to copy, for what an agent wrote. */
  selectable?: boolean;
  /** False for text in a fixed shape (initials in a tile) that must not grow. */
  scales?: boolean;
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      allowFontScaling={scales}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[styles.text, muted && { color: colors.fg3 }, mono && styles.mono, style]}
    >
      {children}
    </Text>
  );
}

/** The desktop's segmented control: a few options, one on. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: { value: NoInfer<V>; label: string; badge?: number }[];
  onChange(value: NoInfer<V>): void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, on && styles.segmentOn]}
          >
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={[styles.segmentText, on && { color: colors.fg }]}
            >
              {o.label}
              {o.badge ? <Text style={{ color: colors.warn }}> {o.badge}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A thin bar: share done (0..1), green, or red once full when it is a budget. */
export function Bar({ share, budget }: { share: number; budget?: boolean }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return (
    <View style={styles.bar}>
      <View
        style={{
          width: `${pct}%`,
          height: '100%',
          backgroundColor: budget && pct >= 100 ? colors.danger : colors.ok,
        }}
      />
    </View>
  );
}

/** "Offline" and "Reconnecting" over a screen, quiet while connected. */
export function ConnectionBar({ state }: { state: 'connecting' | 'online' | 'offline' }) {
  if (state === 'online') return null;
  return (
    <View style={styles.connection} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.fg3} />
      <Text style={styles.connectionText}>
        {state === 'offline' ? 'Offline. Trying again…' : 'Connecting…'}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  text: { color: colors.fg, fontFamily: fonts.ui, fontSize: 15 },
  mono: { fontFamily: fonts.mono, fontSize: 12.5 },
  button: {
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.pop },
  secondary: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line2 },
  dangerBtn: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.line2 },
  small: { minHeight: 34, paddingHorizontal: 12, borderRadius: radius.sm + 1 },
  buttonText: { color: colors.fg, fontFamily: fonts.uiMedium, fontSize: 15.5 },
  chip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.line2,
  },
  chipText: { color: colors.fg3, fontFamily: fonts.mono, fontSize: 10.5 },
  segmented: {
    flexDirection: 'row',
    padding: 3,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg2,
  },
  segment: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: colors.bg4 },
  segmentText: { color: colors.fg3, fontFamily: fonts.uiMedium, fontSize: 13.5 },
  bar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.bg4, overflow: 'hidden' },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 6,
    backgroundColor: colors.bg3,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  connectionText: { color: colors.fg3, fontFamily: fonts.ui, fontSize: 12.5 },
});
