// Content script for the reference fixture. Injected on demand via chrome.scripting after the user grants host access.
// Accepts commands ONLY from this extension's service worker (chrome.runtime messages). Never listens to window.postMessage,
// so page scripts cannot drive it. Bundled as a classic script (IIFE) by scripts/build.mjs.

import { readState, execute } from '../../packages/adapters/src/reference-tasks/dom.ts';

declare const chrome: any;

const FLAG = '__adaptiveInterfaceContentV1';
if (!(globalThis as any)[FLAG]) {
  (globalThis as any)[FLAG] = true;
  chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
    // Only the extension itself (service worker) may message us; tabs.sendMessage sets sender.id to our id and no sender.tab.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (msg?.type === 'ai.read') {
      try {
        sendResponse({ ok: true, state: readState(document) });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error).message) });
      }
      return false;
    }
    if (msg?.type === 'ai.exec') {
      execute(document, msg.request)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, dispatched: false, detail: String(e?.message ?? e) }));
      return true;
    }
    return false;
  });
}
