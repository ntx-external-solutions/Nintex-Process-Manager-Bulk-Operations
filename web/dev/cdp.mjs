// A small driver for headless Chrome over the DevTools protocol, using Node's global
// WebSocket. Enough to sign in, click, wait and read text; no dependency to install.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELPERS = `
window.$set = (sel, v) => { const el = document.querySelector(sel); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
window.$btn = (text) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(text)); if (!b) throw new Error('no button ' + text); b.click(); return true; };
window.$check = (label) => { const el = document.querySelector('input[aria-label="' + label + '"]'); el.click(); return true; };
true`;

export async function connect({ chromePort = 9333, app = 'http://localhost:3919', mock = 'http://localhost:4999/tenant' } = {}) {
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!targets) throw new Error(`No Chrome on port ${chromePort}. Start it with --remote-debugging-port=${chromePort}.`);
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let n = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((r) => {
      const i = ++n;
      waiting.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const js = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const until = async (expr, what) => {
    for (let i = 0; i < 150; i++) {
      if (await js(expr)) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}\n${await js('document.body.innerText')}`);
  };
  const go = async (path, ready, what) => {
    await cdp('Page.navigate', { url: app + path });
    await until(ready, what);
    await js(HELPERS);
  };
  const signIn = async () => {
    const signedIn = `document.body.innerText.includes('Signed in as op')`;
    await go('/', `!!document.querySelector('#site') || ${signedIn}`, 'sign-in form');
    // A session left over from the previous scenario still works against a fresh mock.
    if (await js(signedIn)) return;
    await js(`$set('#site','${mock}'); $set('#username','op'); $set('#password','pw'); true`);
    await js(`$btn('Sign in')`);
    await until(`document.body.innerText.includes('Signed in as op')`, 'signed in');
  };
  const upload = async (selector, file) => {
    const { result: doc } = await cdp('DOM.getDocument', {});
    const { result: found } = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await cdp('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] });
  };
  const sent = async () => (await (await fetch(`${mock}/_log`)).json());
  const screenshot = async (file) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  };

  // The results file as the operator would download it: the screen lists only the rows
  // that need attention.
  const resultsCsv = async () => {
    await js(`(() => { window.__csv = null; const make = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__csv = t; }); return make(blob); }; return true; })()`);
    await js(`$btn('Download the results')`);
    await until(`window.__csv !== null`, 'the results file');
    return js(`window.__csv`);
  };

  return { cdp, js, until, go, signIn, upload, sent, screenshot, resultsCsv, close: () => ws.close() };
}
