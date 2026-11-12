import type { ChatMessage, StreamEvent, Usage } from '@kovan/model-gateway';
import { digest, lastUserIndex } from './digest.js';
import type { TaskType } from './policy.js';

export interface Classification {
  task: TaskType;
  /** 1 (trivial) to 5 (hardest). */
  difficulty: number;
  /** False when the new message continues the previous task ("yes", "now also run the tests"). */
  newTask: boolean;
  source: 'rules' | 'model';
}

const FOLLOW_UP =
  /^(y(es|ep)?|ok(ay)?|sure|go( ahead)?|do it|continue|proceed|thanks?|thank you|evet|tamam|olur|devam( et)?|yap|şimdi|bir de|ayrıca|sonra|tekrar|teşekkür|now|also|and|then|try again|again|retry)(?![\p{L}])/iu;

const PATTERNS: [TaskType, RegExp][] = [
  [
    'plan',
    /\b(plan|design|architect(ure)?|approach|strategy|roadmap|how should (we|i)|propose)\b/i,
  ],
  [
    'debug',
    /\b(bug|error|exception|crash(es|ing)?|fail(s|ing|ed)?|broken|doesn'?t work|not working|stack ?trace|regression|fix)\b/i,
  ],
  [
    'refactor',
    /\b(refactor|restructure|rename across|migrate|extract|split (up|into)|clean ?up|reorgani[sz]e)\b/i,
  ],
  ['review', /\b(review|audit|check (my|this|the) (code|pr|diff)|look over)\b/i],
  [
    'feature',
    /\b(add|implement|build|create|support|introduce|write (a|an|the)? ?(function|feature|endpoint|component|test))\b/i,
  ],
  ['question', /^(what|why|how|where|when|which|who|is|are|does|do|can|explain|tell me)\b|\?$/i],
];

/**
 * The same task types in Turkish. Turkish adds endings to a stem ("hatayı", "düzeltir"), so these
 * match the start of a word, letters of any script counting as word characters.
 */
const W = '(?<![\\p{L}\\p{N}])';
const TR_PATTERNS: [TaskType, RegExp][] = [
  [
    'plan',
    new RegExp(
      `${W}(plan|tasarla|tasarım|mimari|yaklaşım|strateji|yol haritası|nasıl yapmalı)`,
      'iu',
    ),
  ],
  [
    'debug',
    new RegExp(
      `${W}(hata|düzelt|bozu|çalışmıyor|çalışmaz|çök|kırıl|patlı|sorun|yanlış|başarısız)`,
      'iu',
    ),
  ],
  ['refactor', new RegExp(`${W}(yeniden düzenle|refactor|taşı|ayır|böl|sadeleştir|temizle)`, 'iu')],
  ['review', new RegExp(`${W}(incele|gözden geçir|kontrol et|denetle)`, 'iu')],
  ['feature', new RegExp(`${W}(ekle|uygula|oluştur|geliştir|yaz|kur|destek)`, 'iu')],
  [
    'question',
    new RegExp(`(^(ne|neden|niye|nasıl|nerede|hangi|kim|açıkla)${'(?![\\p{L}])'})|\\?$`, 'iu'),
  ],
];

/** Wider work in Turkish ("tüm servislerde", "kod tabanı", "performans"). */
const TR_BIGGER = new RegExp(
  `${W}(tüm|bütün|kod taban|servisler|modüller|eş ?zaman|performans|güvenlik|geçiş)`,
  'iu',
);
const TR_SMALLER = new RegExp(
  `${W}(yazım hatası|küçük|basit|tek satır|yeniden adlandır|ufak)`,
  'iu',
);

const textOf = (m: ChatMessage | undefined): string =>
  !m
    ? ''
    : typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ')
        : '';

/** Free, instant classification from the text alone. */
export function classifyByRules(messages: ChatMessage[]): Classification {
  const last = lastUserIndex(messages);
  const text = textOf(messages[last]).trim();
  const hadEarlierTask = messages.slice(0, last).some((m) => m.role === 'user');
  const followUp = hadEarlierTask && text.length < 80 && FOLLOW_UP.test(text);

  let task: TaskType = 'small_edit';
  // Type by type, English and Turkish together: the same request routes the same way in either.
  for (const [type, pattern] of PATTERNS) {
    const tr = TR_PATTERNS.find(([t]) => t === type)?.[1];
    if (pattern.test(text) || tr?.test(text)) {
      task = type;
      break;
    }
  }
  const files = new Set(
    text.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|css|md|json|sql|yml|yaml)\b/g) ?? [],
  ).size;
  let difficulty = 2;
  if (text.length > 400) difficulty++;
  if (text.length > 1200) difficulty++;
  if (files >= 3) difficulty++;
  if (
    /\b(across|entire|whole|all (the )?(files|modules|services)|codebase|concurren|race|deadlock|performance|security|migration)\b/i.test(
      text,
    )
  )
    difficulty++;
  else if (TR_BIGGER.test(text)) difficulty++;
  if (/\b(typo|rename|comment|small|tiny|quick|one-?line|simple)\b/i.test(text)) difficulty--;
  else if (TR_SMALLER.test(text)) difficulty--;
  if (/^\s*at .+:\d+:\d+/m.test(text) || /Traceback|Exception:/.test(text)) difficulty++;
  return {
    task,
    difficulty: Math.min(5, Math.max(1, difficulty)),
    newTask: !followUp,
    source: 'rules',
  };
}

/** The small model JevRouter asks when its rules aren't enough (a fraction of a cent a call). */
export const JEV_CLASSIFIER_MODEL = 'openai/gpt-5.6-luna';

export interface ClassifierModel {
  stream(
    request: {
      model: string;
      messages: ChatMessage[];
      effort?: null | 'none' | 'low';
      maxTokens?: number;
    },
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

const SYSTEM = `You route coding-agent requests to the right model tier. Read the conversation and reply with JSON only:
{"task":"question|small_edit|feature|refactor|debug|plan|review","difficulty":1-5,"same_task":true|false}
difficulty: 1 trivial (typo, one-line), 2 small and local, 3 moderate (a feature in a few files), 4 hard (cross-cutting, subtle bugs, concurrency), 5 very hard (architecture, large migrations).
same_task: true when the latest message continues or adjusts the previous request rather than starting a new one.`;

/**
 * Asks a small, fast model to classify the whole conversation. Returns null (fall back to
 * rules) on any failure; never blocks the agent for long.
 */
export async function classifyByModel(
  client: ClassifierModel,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ classification: Classification; usage: Usage | null } | null> {
  const { previous, latest } = digest(messages);
  const timeout = AbortSignal.timeout(8000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let text = '';
  let usage: Usage | null = null;
  try {
    for await (const event of client.stream(
      {
        model,
        effort: 'none',
        maxTokens: 120,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `Earlier conversation:\n${previous || '(none)'}\n\nLatest message:\n${latest}`,
          },
        ],
      },
      combined,
    )) {
      if (event.type === 'text') text += event.text;
      if (event.type === 'done') usage = event.usage;
    }
    const json = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '') as {
      task?: string;
      difficulty?: number;
      same_task?: boolean;
    };
    const tasks: TaskType[] = [
      'question',
      'small_edit',
      'feature',
      'refactor',
      'debug',
      'plan',
      'review',
    ];
    if (!tasks.includes(json.task as TaskType) || typeof json.difficulty !== 'number') return null;
    const hadEarlierTask = messages
      .slice(0, lastUserIndex(messages))
      .some((m) => m.role === 'user');
    return {
      classification: {
        task: json.task as TaskType,
        difficulty: Math.min(5, Math.max(1, Math.round(json.difficulty))),
        newTask: !hadEarlierTask || json.same_task !== true,
        source: 'model',
      },
      usage,
    };
  } catch {
    return null;
  }
}
