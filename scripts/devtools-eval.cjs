'use strict';
/* Ask a running Electron window what it is showing, over the DevTools protocol.
 *
 *   node scripts/devtools-eval.cjs "document.body.innerText" [port]
 *
 * Why this exists: the app windows cannot be driven by the browser preview —
 * the preview is a plain browser with no Electron bridge, so it sees the
 * default (machine-app) profile and none of the panels a shop's app has. This
 * is the other way in: Electron is Chromium, so with --remote-debugging-port it
 * will describe its own DOM, and Node's built-in WebSocket (22+) is enough to
 * ask. Handy for checking which first screen an app opens on, and what a panel
 * actually rendered, without a screenshot.
 */

const port = process.argv[3] || '9222';
const expression = process.argv[2] || 'document.body.innerText';

async function main() {
  const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  const page = list.find(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1/.test(t.url));
  if (!page) throw new Error(`No app window on port ${port} — is it running with --remote-debugging-port=${port}?`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the window did not answer in 20s')), 20000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      if (message.result && message.result.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'the expression threw'));
        return;
      }
      resolve(message.result && message.result.result ? message.result.result.value : null);
    });
    ws.addEventListener('error', () => reject(new Error('could not attach to the window')));
  });

  const value = await done;
  ws.close();
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

main().catch((e) => {
  console.error(`devtools-eval: ${e.message}`);
  process.exit(1);
});
