import { insertMention, mentionMatches, mentionQuery, type Mentionable } from '@kovan/shared';
import { ArrowUp } from 'lucide-react-native';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { t } from '../lib/i18n';
import { colors, fonts, radius, MAX_FONT_SCALE } from '../lib/theme';
import { T } from './ui';

/**
 * A text box with a send button, as under a lane on the desktop. `onSend` resolves to whether
 * it went; the text is kept when it didn't.
 */
export function Composer({
  placeholder,
  label,
  onSend,
  teammates = [],
}: {
  placeholder: string;
  /** What the box is for, for screen readers. */
  label: string;
  onSend(text: string): Promise<boolean>;
  /** AI teammates "@" suggests, to call one in. */
  teammates?: Mentionable[];
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const off = !text.trim() || sending;
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    if (await onSend(body)) setText('');
    setSending(false);
  };
  return (
    <View style={{ gap: 6 }}>
      <MentionChips
        text={text}
        caret={caret}
        teammates={teammates}
        onPick={(next) => {
          setText(next.text);
          setCaret(next.caret);
        }}
      />
      <View style={s.composer}>
        <TextInput
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          value={text}
          onChangeText={(value) => {
            setText(value);
            // The caret follows typing at the end; a tap elsewhere reports through onSelectionChange.
            setCaret(value.length);
          }}
          onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
          multiline
          placeholder={placeholder}
          placeholderTextColor={colors.fg4}
          style={s.input}
          accessibilityLabel={label}
        />
        <Pressable
          onPress={() => void send()}
          disabled={off}
          accessibilityRole="button"
          accessibilityLabel={t('Send')}
          style={[s.send, off && { opacity: 0.4 }]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.popfg} />
          ) : (
            <ArrowUp size={16} color={colors.popfg} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

/** While "@name" is being typed: the AI teammates it may mean, a tap puts the name in. */
export function MentionChips({
  text,
  caret,
  teammates,
  onPick,
}: {
  text: string;
  caret: number;
  teammates: Mentionable[];
  onPick(next: { text: string; caret: number }): void;
}) {
  const query = teammates.length ? mentionQuery(text, caret) : null;
  const matches = query === null ? [] : mentionMatches(query, teammates).slice(0, 6);
  if (!matches.length) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      contentContainerStyle={s.mentions}
      accessibilityLabel={t('Teammates to call in')}
    >
      {matches.map((m) => (
        <Pressable
          key={m.id}
          onPress={() => onPick(insertMention(text, caret, m.name))}
          accessibilityRole="button"
          accessibilityLabel={t('Call {name} in', { name: m.name })}
          style={s.mention}
        >
          <T style={s.mentionText}>@{m.name}</T>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  mentions: { gap: 6, paddingHorizontal: 2 },
  mention: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  mentionText: { fontSize: 13.5, fontFamily: fonts.uiBold },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 6,
    paddingLeft: 12,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line2,
    backgroundColor: colors.bg3,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 34,
    paddingTop: 8,
    paddingBottom: 8,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pop,
  },
});
