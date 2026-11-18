// Minimal Chrome DevTools Protocol client over --remote-debugging-pipe, plus helpers shared by e2e scripts.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ headless = true, extraArgs = [] } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), 'ai-e2e-'));
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--window-size=1400,900', ...extraArgs, 'about:blank',
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const toChrome = proc.stdio[3];
  const fromChrome = proc.stdio[4];
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  let buf = '';
  fromChrome.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)) : res(msg.result);
      } else if (msg.method) for (const l of listeners) l(msg);
    }
  });
  const cdp = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });

  async function evaluate(session, expression, { gesture = true } = {}) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture }, session);
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 160)}`);
    return r.result.value;
  }
  async function waitFor(session, expression, label, timeout = 8000) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        const v = await evaluate(session, expression);
        if (v) return v;
      } catch (e) { last = e; }
      await sleep(100);
    }
    throw new Error(`timeout waiting for: ${label}${last ? ` (${last.message.split('\n')[0]})` : ''}`);
  }
  async function attach(targetId) {
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId).catch(() => {});
    return sessionId;
  }
  async function open(url, newWindow = false) {
    const { targetId } = await cdp('Target.createTarget', { url, newWindow });
    const sessionId = await attach(targetId);
    await cdp('Page.enable', {}, sessionId).catch(() => {});
    return { targetId, sessionId };
  }
  async function targets() {
    return (await cdp('Target.getTargets')).targetInfos;
  }
  async function close() {
    proc.kill();
    await sleep(600);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  return { cdp, evaluate, waitFor, attach, open, targets, close, onEvent: (f) => listeners.add(f), proc };
}

/** Results collector used by e2e scripts. */
export function checker() {
  const results = [];
  return {
    results,
    async check(name, fn) {
      try {
        const detail = await fn();
        results.push({ name, pass: true, detail: detail ?? '' });
        console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
      } catch (e) {
        results.push({ name, pass: false, detail: String(e.message ?? e) });
        console.log(`  ✗ ${name} — ${e.message ?? e}`);
      }
    },
    assert(c, m) {
      if (!c) throw new Error(m);
    },
  };
}
