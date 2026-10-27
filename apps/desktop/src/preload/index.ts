import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type KovanApi,
} from '../shared/api.js';

const invokeChannels = new Set<string>(INVOKE_CHANNELS);
const eventChannels = new Set<string>(EVENT_CHANNELS);

/** Strips Electron's "Error invoking remote method 'x': Error: " prefix so the UI shows the real message. */
function cleanError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''));
}

const api: KovanApi = {
  invoke: ((channel: InvokeChannel, ...args: unknown[]) => {
    if (!invokeChannels.has(channel))
      return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
      throw cleanError(error);
    });
  }) as KovanApi['invoke'],

  on: ((channel: EventChannel, listener: (...args: unknown[]) => void) => {
    if (!eventChannels.has(channel)) throw new Error(`Unknown event ${channel}`);
    const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  }) as KovanApi['on'],
};

contextBridge.exposeInMainWorld('kovan', api);
