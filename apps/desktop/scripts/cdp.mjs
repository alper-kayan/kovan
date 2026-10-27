// Drives the Kovan dev renderer over the DevTools protocol.
//   node cdp.mjs '<js body>'        evaluate (async function body) and print the result
//   node cdp.mjs type 'text'        insert text at the focused element
//   node cdp.mjs key 'Meta+s'       press a key chord
//   node cdp.mjs shot out.png       screenshot the renderer (no window focus needed)
const port = process.env.PORT ?? '9333';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// The dev renderer (vite) or a built one (file://), whichever this instance runs.
const page = targets.find(
  (t) => t.type === 'page' && (t.url.startsWith('http://localhost') || t.url.startsWith('file://')),
);
if (!page) throw new Error('No renderer page: ' + JSON.stringify(targets.map((t) => t.url)));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const [mode, arg] =
  process.argv.length > 3 ? [process.argv[2], process.argv[3]] : ['eval', process.argv[2]];

if (mode === 'shot') {
  const { writeFileSync } = await import('node:fs');
  const res = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(res.result.data, 'base64'));
  console.log(arg);
} else if (mode === 'type') {
  await send('Input.insertText', { text: arg });
} else if (mode === 'key') {
  const parts = arg.split('+');
  const key = parts.pop();
  const mods = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const modifiers = parts.reduce((m, p) => m | (mods[p] ?? 0), 0);
  const vk = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 };
  const isChar = key.length === 1;
  const base = {
    modifiers,
    key,
    code: isChar ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined) : key,
    windowsVirtualKeyCode: isChar ? key.toUpperCase().charCodeAt(0) : (vk[key] ?? 0),
  };
  const text = key === 'Enter' ? '\r' : isChar && !(modifiers & 6) ? key : undefined;
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(text ? { text } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
} else {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${arg} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.exceptionDetails) {
    console.error(
      'EXCEPTION',
      res.result.exceptionDetails.exception?.description ??
        JSON.stringify(res.result.exceptionDetails),
    );
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(res.result?.result?.value, null, 2));
  }
}
ws.close();
