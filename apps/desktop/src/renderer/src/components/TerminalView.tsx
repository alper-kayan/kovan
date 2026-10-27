import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { api } from '../services/api';
import { attachTerminal } from '../services/terminal';
import { useStore } from '../store';

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  return {
    background: cssVar('--bg2'),
    foreground: cssVar('--fg'),
    cursor: cssVar('--fg'),
    cursorAccent: cssVar('--bg2'),
    selectionBackground: cssVar('--sel'),
  };
}

/**
 * An xterm bound to one PTY. Every byte goes straight through in both directions, so the
 * shell and any CLI running in it (Claude Code, Codex) behave exactly as outside the app.
 */
export function TerminalView({ id, visible }: { id: number; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const settings = useStore((s) => s.settings);

  useEffect(() => {
    if (!host.current) return;
    const s = useStore.getState().settings;
    const terminal = new Terminal({
      fontFamily: s.editorFontFamily,
      fontSize: s.terminalFontSize,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 10_000,
      theme: theme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host.current);
    term.current = terminal;
    fit.current = fitAddon;

    const detach = attachTerminal(id, (data) => terminal.write(data));
    const input = terminal.onData((data) => void api.invoke('terminal:write', id, data));
    const resize = terminal.onResize(
      ({ cols, rows }) => void api.invoke('terminal:resize', id, cols, rows),
    );

    const observer = new ResizeObserver(() => {
      if (host.current && host.current.offsetParent !== null) fitAddon.fit();
    });
    observer.observe(host.current);

    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => {
      terminal.options.theme = theme();
    };
    darkQuery.addEventListener('change', onTheme);

    return () => {
      darkQuery.removeEventListener('change', onTheme);
      observer.disconnect();
      input.dispose();
      resize.dispose();
      detach();
      terminal.dispose();
      term.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!term.current) return;
    term.current.options.fontSize = settings.terminalFontSize;
    term.current.options.fontFamily = settings.editorFontFamily;
    fit.current?.fit();
  }, [settings]);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        fit.current?.fit();
        term.current?.focus();
      });
    }
  }, [visible]);

  return (
    <div className="terminal-host" ref={host} style={{ display: visible ? 'block' : 'none' }} />
  );
}
