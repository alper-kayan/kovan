import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { DEFAULT_KEYBINDINGS } from '../shared/keybindings.js';

/**
 * The native menu. Shortcuts are shown for discoverability, but the renderer owns the actual
 * key handling (so user keybinding overrides work), hence registerAccelerator: false.
 */
export function buildMenu(run: (commandId: string) => void, isDev: boolean): Menu {
  const isMac = process.platform === 'darwin';
  const item = (label: string, commandId: string): MenuItemConstructorOptions => {
    const accelerator = DEFAULT_KEYBINDINGS[commandId]?.replace('Mod', 'CmdOrCtrl');
    return {
      label,
      click: () => run(commandId),
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    };
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Settings…', 'settings.open'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('Open Repository…', 'workspace.open'),
        item('Getting Started', 'gettingStarted.open'),
        item('Go to File…', 'palette.files'),
        { type: 'separator' },
        item('Save', 'file.save'),
        item('Close Tab', 'tab.close'),
        ...(isMac
          ? []
          : [
              { type: 'separator' } as const,
              item('Settings', 'settings.open'),
              { role: 'quit' } as const,
            ]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        item('Command Palette…', 'palette.commands'),
        { type: 'separator' },
        item('Sessions', 'go.sessions'),
        item('People', 'go.people'),
        item('Agents', 'go.agents'),
        item('Editor', 'go.workspace'),
        { type: 'separator' },
        item('Files', 'view.explorer'),
        item('Changes', 'view.git'),
        item('Toggle Sidebar', 'view.toggleSidebar'),
        item('Toggle Terminal', 'view.toggleTerminal'),
        item('New Terminal', 'terminal.new'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? [
              { type: 'separator' } as const,
              { role: 'reload' } as const,
              { role: 'toggleDevTools' } as const,
            ]
          : []),
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
