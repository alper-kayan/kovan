import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  Effort,
  ModelInfo,
  RouteDecision,
  StreamEvent,
  Usage,
} from '@kovan/model-gateway';
import {
  classifyByModel,
  classifyByRules,
  type Classification,
  type ClassifierModel,
} from './classifier.js';
import { parseDirectives, type Directive } from './directives.js';
import { estimateTokens, lastUserIndex, turnSignals } from './digest.js';
import {
  capTier,
  effortFor,
  findPinned,
  pickModel,
  stepUp,
  tierFor,
  tierOf,
  type Tier,
} from './policy.js';

/** The virtual model id people pick to let JevRouter choose. */
export const JEV_MODEL_ID = 'kovan/jevrouter';

export interface RouterOptions {
  /** Streams model calls (OpenRouter). */
  client: ClassifierModel & {
    stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  };
  catalog: ModelInfo[];
  /** Small, fast model for classification; null uses the rules only. */
  classifierModel?: string | null;
  /** Escalate after this many failed tool calls in one turn (or two in a row). */
  escalateAfter?: number;
}

interface State {
  model: ModelInfo;
  effort: Effort | null;
  tier: Tier;
  /** Index of the user message the current decision was made for. */
  userIndex: number;
  escalatedAtIndex: number;
  directive: Directive | null;
  classification: Classification | null;
}

const OUTPUT_ALLOWANCE = 16_000;

/**
 * JevRouter: picks a model per task, keeps it while the task lasts (so the provider's prompt
 * cache stays warm), escalates when the agent keeps failing, and obeys [jev: …] directives.
 */
export class JevRouter {
  private state: State | null = null;
  private stickyDirective: Directive | null = null;

  constructor(private readonly options: RouterOptions) {}

  /** The current choice, for display ("JevRouter → Claude Sonnet 5"). */
  get current(): { model: string; tier: Tier } | null {
    return this.state ? { model: this.state.model.id, tier: this.state.tier } : null;
  }

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const { messages, directive } = this.stripDirectives(request.messages);
    if (directive) this.stickyDirective = directive.kind === 'auto' ? null : directive;
    const decision = await this.decide(messages, signal);
    yield { type: 'route', decision };
    yield* this.options.client.stream(
      { ...request, messages, model: decision.model, effort: decision.effort },
      signal,
    );
  }

  /** Removes directive text from user messages so the model never sees it; returns the newest directive. */
  private stripDirectives(messages: ChatMessage[]): {
    messages: ChatMessage[];
    directive: Directive | null;
  } {
    const last = lastUserIndex(messages);
    let directive: Directive | null = null;
    const cleaned = messages.map((m, i) => {
      if (m.role !== 'user') return m;
      const strip = (text: string) => {
        const parsed = parseDirectives(text);
        if (i === last && parsed.directive) directive = parsed.directive;
        return parsed.cleaned;
      };
      if (typeof m.content === 'string') return { ...m, content: strip(m.content) };
      return {
        ...m,
        content: m.content.map((p): ContentPart =>
          p.type === 'text' ? { ...p, text: strip(p.text) } : p,
        ),
      };
    });
    // A directive only counts on the turn it was written.
    return { messages: cleaned, directive: this.state?.userIndex === last ? null : directive };
  }

  private async decide(messages: ChatMessage[], signal?: AbortSignal): Promise<RouteDecision> {
    const { catalog } = this.options;
    const userIndex = lastUserIndex(messages);
    const contextNeeded = estimateTokens(messages) + OUTPUT_ALLOWANCE;
    const previous = this.state;
    const sameTurn = previous?.userIndex === userIndex;
    const fits = (m: ModelInfo) => m.contextLength >= contextNeeded;

    // 1. A pinned model wins outright.
    if (this.stickyDirective?.kind === 'pin') {
      const pinned = findPinned(this.stickyDirective.query, catalog);
      if (pinned && fits(pinned)) {
        const tier = tierOf(pinned.id) ?? previous?.tier ?? 'balanced';
        return this.commit(
          {
            model: pinned,
            tier,
            userIndex,
            reason: `pinned by [jev: ${this.stickyDirective.query}]`,
            classification: null,
          },
          null,
          null,
        );
      }
    }

    // 2. Inside a turn: keep the model unless the agent keeps failing or the context outgrew it.
    if (sameTurn && previous) {
      const signals = turnSignals(messages);
      const limit = this.options.escalateAfter ?? 3;
      const failing = signals.failures >= limit || signals.consecutiveFailures >= 2;
      const cap = this.stickyDirective?.kind === 'cap' ? this.stickyDirective.tier : null;
      if (
        failing &&
        previous.escalatedAtIndex !== userIndex &&
        capTier(stepUp(previous.tier), cap) !== previous.tier
      ) {
        const tier = capTier(stepUp(previous.tier), cap);
        const model = pickModel(tier, catalog, contextNeeded) ?? previous.model;
        return this.commit(
          {
            model,
            tier,
            userIndex,
            reason: `escalated to ${tier}: ${signals.failures} failed tool call${signals.failures === 1 ? '' : 's'} this turn`,
            classification: previous.classification,
          },
          null,
          null,
          true,
        );
      }
      if (fits(previous.model)) return this.keep(previous, 'same task, keeping the model warm');
      const bigger = pickModel(previous.tier, catalog, contextNeeded) ?? previous.model;
      return this.commit(
        {
          model: bigger,
          tier: previous.tier,
          userIndex,
          reason: `context grew to ~${Math.round(contextNeeded / 1000)}K tokens`,
          classification: previous.classification,
        },
        null,
        null,
      );
    }

    // 3. A new user message: classify the whole conversation.
    let usage: Usage | null = null;
    let classification: Classification = classifyByRules(messages);
    const classifierModel = this.options.classifierModel ?? null;
    if (classifierModel) {
      const byModel = await classifyByModel(this.options.client, classifierModel, messages, signal);
      if (byModel) {
        classification = byModel.classification;
        usage = byModel.usage;
      }
    }

    // Follow-ups stay on the current model: switching would throw away the prompt cache.
    if (
      previous &&
      !classification.newTask &&
      fits(previous.model) &&
      this.stickyDirective?.kind !== 'tier'
    ) {
      return this.keep(
        { ...previous, userIndex },
        `continues the previous task (${classification.source})`,
        usage,
        classifierModel,
      );
    }

    let tier = tierFor(classification.task, classification.difficulty);
    let why = `${classification.task.replace('_', ' ')}, difficulty ${classification.difficulty}/5 → ${tier}`;
    if (this.stickyDirective?.kind === 'tier') {
      tier = this.stickyDirective.tier;
      why = `tier ${tier} by directive`;
    } else if (this.stickyDirective?.kind === 'cap') {
      const capped = capTier(tier, this.stickyDirective.tier);
      if (capped !== tier) why += ` (capped at ${capped})`;
      tier = capped;
    }
    const model = pickModel(tier, catalog, contextNeeded);
    if (!model)
      throw new Error('JevRouter found no model in the catalog that fits this conversation');
    return this.commit(
      { model, tier, userIndex, reason: why, classification },
      usage,
      classifierModel,
    );
  }

  private keep(
    state: State,
    reason: string,
    usage: Usage | null = null,
    classifierModel: string | null = null,
  ): RouteDecision {
    this.state = state;
    return {
      model: state.model.id,
      effort: state.effort,
      tier: state.tier,
      reason,
      switched: false,
      usage,
      classifierModel,
    };
  }

  private commit(
    next: {
      model: ModelInfo;
      tier: Tier;
      userIndex: number;
      reason: string;
      classification: Classification | null;
    },
    usage: Usage | null,
    classifierModel: string | null,
    escalated = false,
  ): RouteDecision {
    const switched = this.state?.model.id !== next.model.id;
    const effort = effortFor(next.tier, next.model);
    this.state = {
      model: next.model,
      effort,
      tier: next.tier,
      userIndex: next.userIndex,
      escalatedAtIndex: escalated ? next.userIndex : (this.state?.escalatedAtIndex ?? -1),
      directive: this.stickyDirective,
      classification: next.classification,
    };
    return {
      model: next.model.id,
      effort,
      tier: next.tier,
      reason: next.reason,
      switched,
      usage,
      classifierModel,
    };
  }
}
