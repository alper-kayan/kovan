import { t } from '../i18n';
import type { Effort, ModelInfo } from '@kovan/model-gateway';
import {
  JEV_MODEL_ID,
  type Attachment,
  type ConversationConfig,
  type Harness,
  type PermissionMode,
  HARNESS_NAMES,
  type AgentAccount,
  type ExternalHarness,
} from '../../../shared/agent';
import { getState, notify, reportError, setState, writeLocal, secretStore } from '../store';
import { api } from './api';
import { newTerminal } from './terminal';

export function initAgent(): void {
  api.on('agents:limits', (agentLimits) => setState({ agentLimits }));
  // A chat written from the terminal: list again, and show the new turns of the open one when it sits idle here.
  api.on('agent:changed', (ids) => {
    void loadConversations(false);
    const open = getState().conversation;
    if (open && !open.running && ids.includes(open.id)) void openConversation(open.id);
  });
  void api
    .invoke('agents:limits')
    .then((agentLimits) => setState({ agentLimits }))
    .catch(reportError);
  api.on('agent:event', (id, event) => {
    // A finished turn starts the next queued prompt for that conversation (lane).
    if (event.type === 'turn_end' && event.reason === 'done') void runQueued(id);
    // Edits being typed show in the editor, not in the transcript.
    if (event.type === 'tool_progress') return;
    const current = getState().conversation;
    if (event.type === 'idle') {
      if (current?.id === id && current.running)
        setState({ conversation: { ...current, running: false } });
      return;
    }
    if (current?.id !== id) {
      if (event.type === 'turn_end') void loadConversations(false);
      return;
    }
    const running =
      event.type === 'turn_start' ? true : event.type === 'turn_end' ? false : current.running;
    setState({
      conversation: {
        ...current,
        events: [...current.events, event],
        running,
        // Another agent took the conversation over: the pickers follow.
        ...(event.type === 'switch' || event.type === 'auto'
          ? {
              harness: event.to,
              model: event.model,
              ...(event.to !== 'kovan' ? { effort: null } : {}),
            }
          : {}),
        ...(event.type === 'turn_end'
          ? { cost: current.cost + event.cost, updatedAt: Date.now() }
          : {}),
      },
    });
    if (event.type === 'turn_end') void loadConversations(false);
  });
}

/** Loads this workspace's conversations; opens the newest when asked. */
export async function loadConversations(openNewest: boolean): Promise<void> {
  if (!getState().workspace) {
    setState({ conversations: [], conversation: null });
    return;
  }
  try {
    const conversations = await api.invoke('agent:list');
    setState({ conversations });
    // The title is set from the first prompt in the main process; mirror it here.
    const open = getState().conversation;
    const saved = conversations.find((c) => c.id === open?.id);
    if (open && saved && saved.title !== open.title)
      setState({ conversation: { ...open, title: saved.title } });
    const current = getState().conversation;
    if (openNewest && conversations[0] && current?.root !== getState().workspace?.root) {
      await openConversation(conversations[0].id);
    } else if (openNewest && current?.root !== getState().workspace?.root) {
      setState({ conversation: null });
    }
  } catch (error) {
    reportError(error);
  }
}

export async function newConversation(): Promise<void> {
  try {
    setState({ conversation: await api.invoke('agent:create') });
  } catch (error) {
    reportError(error);
  }
}

export async function openConversation(id: string): Promise<void> {
  try {
    setState({ conversation: await api.invoke('agent:open', id) });
  } catch (error) {
    reportError(error);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  await api.invoke('agent:remove', id).catch(reportError);
  if (getState().conversation?.id === id) setState({ conversation: null });
  await loadConversations(false);
}

/** Adds a prompt to run after the current turn of this conversation. */
export function queuePrompt(conversationId: string, text: string, attachments: Attachment[]): void {
  setState((s) => ({
    queues: {
      ...s.queues,
      [conversationId]: [...(s.queues[conversationId] ?? []), { text, attachments }],
    },
  }));
}

export function unqueuePrompt(conversationId: string, index: number): void {
  setState((s) => ({
    queues: {
      ...s.queues,
      [conversationId]: (s.queues[conversationId] ?? []).filter((_, i) => i !== index),
    },
  }));
}

async function runQueued(conversationId: string): Promise<void> {
  const [next, ...rest] = getState().queues[conversationId] ?? [];
  if (!next) return;
  setState((s) => ({ queues: { ...s.queues, [conversationId]: rest } }));
  try {
    await api.invoke('agent:send', conversationId, next.text, next.attachments);
  } catch (error) {
    // Put it back so nothing typed is lost.
    setState((s) => ({
      queues: { ...s.queues, [conversationId]: [next, ...(s.queues[conversationId] ?? [])] },
    }));
    reportError(error);
  }
}

export function setDraft(conversationKey: string, text: string): void {
  setState((s) => ({ drafts: { ...s.drafts, [conversationKey]: text } }));
}

export async function sendPrompt(text: string, attachments: Attachment[]): Promise<boolean> {
  if (!text.trim() && attachments.length === 0) return false;
  try {
    if (!getState().conversation) await newConversation();
    const conversation = getState().conversation;
    if (!conversation) return false;
    await api.invoke('agent:send', conversation.id, text, attachments);
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export function stopAgent(): void {
  const c = getState().conversation;
  if (c?.running) void api.invoke('agent:stop', c.id);
}

export function answerApproval(approvalId: string, approved: boolean): void {
  const c = getState().conversation;
  // A refused answer (a role that no longer allows it, say) says why instead of doing nothing.
  if (c) void api.invoke('agent:approve', c.id, approvalId, approved).catch(reportError);
}

export async function configureConversation(patch: Partial<ConversationConfig>): Promise<void> {
  try {
    if (!getState().conversation) await newConversation();
    const c = getState().conversation;
    if (!c) return;
    const updated = await api.invoke('agent:configure', c.id, patch);
    // In a session, teammates see which agent and model this lane runs.
    if (updated.session && (patch.harness || patch.model))
      void api
        .invoke('brain:request', 'POST', `/api/sessions/${updated.session.id}/join`, {
          mode: 'join',
          harness: updated.harness ?? 'kovan',
          model: updated.model,
        })
        .catch(() => undefined);
    // Keep the live event list; the main process may not have every streamed delta saved yet.
    setState({
      conversation: { ...updated, events: getState().conversation?.events ?? updated.events },
    });
  } catch (error) {
    reportError(error);
  }
}

export const setMode = (mode: PermissionMode) => configureConversation({ mode });
export const setEffort = (effort: Effort | null) => configureConversation({ effort });

/** Lets JevRouter pick the model (and effort) for each task. */
export function chooseJevRouter(): void {
  void configureConversation({ model: JEV_MODEL_ID, effort: null });
}

export function setModel(model: ModelInfo): void {
  // Keep the effort only when the new model supports it.
  const effort = getState().conversation?.effort ?? null;
  const keep = effort && model.reasoning?.efforts.includes(effort) ? effort : null;
  void configureConversation({ model: model.id, effort: keep });
}

export async function loadModels(refresh = false): Promise<void> {
  try {
    setState({ models: await api.invoke('models:list', refresh) });
  } catch (error) {
    if (refresh) reportError(error);
  }
}

export async function loadProviders(): Promise<void> {
  setState({ providers: await api.invoke('providers:status') });
}

export async function saveOpenRouterKey(key: string | null): Promise<boolean> {
  try {
    setState({ providers: await api.invoke('providers:setOpenRouterKey', key) });
    if (key) {
      notify({
        kind: 'info',
        title: 'OpenRouter connected',
        message: t('Your key is stored in {store}.', { store: secretStore() }),
      });
      await loadModels(true);
    }
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export function toggleAgentPanel(): void {
  const agentOpen = !getState().agentOpen;
  setState({ agentOpen });
  writeLocal('kovan.agentOpen', agentOpen);
}

export function modelInfo(id: string | undefined): ModelInfo | undefined {
  return getState().models.find((m) => m.id === id);
}

export async function loadExternalAgents(refresh = false): Promise<void> {
  try {
    const [externalAgents, agentAccounts] = await Promise.all([
      api.invoke('agents:external', refresh),
      api.invoke('accounts:list'),
    ]);
    setState({ externalAgents, agentAccounts });
  } catch (error) {
    reportError(error);
  }
}

/** Another Claude Code or Codex account: made here, then signed in in a terminal. */
export async function addAgentAccount(
  harness: ExternalHarness,
  name: string,
  home = false,
): Promise<boolean> {
  try {
    const account = await api.invoke('accounts:add', harness, name, home);
    setState({ agentAccounts: await api.invoke('accounts:list') });
    // This computer's sign-in is already there (or the person signs in in their own terminal).
    if (home) return true;
    await newTerminal(harness, {
      account: account.id,
      login: true,
      title: `${account.name}: sign in`,
    });
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}

export async function removeAgentAccount(account: AgentAccount): Promise<void> {
  if (
    !window.confirm(
      account.home
        ? `Stop using this computer's ${HARNESS_NAMES[account.harness]} sign-in in Kovan? Your sign-in and settings stay as they are.`
        : `Remove ${HARNESS_NAMES[account.harness]} (${account.name}) from Kovan? Its sign-in on this machine is deleted; the account itself stays as it is.`,
    )
  )
    return;
  try {
    await api.invoke('accounts:remove', account.id);
    const { settings } = getState();
    // Order steps of that account would be skipped from now on: they go too.
    const kept = settings.agentOrder.filter((o) => o.account !== account.id);
    if (kept.length !== settings.agentOrder.length && kept.length > 0)
      await api
        .invoke('settings:update', { agentOrder: kept })
        .then((s) => setState({ settings: s }));
    setState({ agentAccounts: await api.invoke('accounts:list') });
  } catch (error) {
    reportError(error);
  }
}

/** Lets JevRouter pick who runs the conversation, from the next prompt. */
export function setAutoAgent(): void {
  void configureConversation({ auto: true });
}

/** Switches who runs the conversation: Kovan's agent or the user's Claude Code or Codex. */
export function setHarness(harness: Harness, account?: string): void {
  const kovanModel = getState().settings.agentModel;
  void configureConversation(
    harness !== 'kovan'
      ? { harness, model: 'default', effort: null, account }
      : { harness, model: kovanModel, account: undefined },
  );
}
