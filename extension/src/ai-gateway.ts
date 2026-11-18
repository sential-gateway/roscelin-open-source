// Client for the local model gateway (127.0.0.1:4318). The panel uses it only when the person has switched on
// AI layouts AND paired this browser session with the gateway's secret. The gateway decides nothing for the
// extension: whatever it returns is validated again by the planner (field-aware validator), and any failure
// falls back to the rule-based layout. Nothing here can approve or run an action.
import type { ModelGateway, PlannerContext } from '../../packages/planner/src/planner.ts';

export const GATEWAY_ORIGIN = 'http://127.0.0.1:4318';
const SECRET_KEY = 'gatewaySecret'; // chrome.storage.session only (trusted extension contexts), never local/sync
const ENABLED_KEY = 'aiLayoutsEnabled'; // a preference, not a secret
const SECRET_RE = /^[0-9a-f]{64}$/; // the gateway's per-install secret is 32 random bytes in hex

export async function getAiConfig(): Promise<{ enabled: boolean; paired: boolean }> {
  const enabled = (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] === true;
  const paired = typeof (await chrome.storage.session.get(SECRET_KEY))[SECRET_KEY] === 'string';
  return { enabled, paired };
}

export async function setAiEnabled(on: boolean) {
  await chrome.storage.local.set({ [ENABLED_KEY]: on });
}

const CODE_RE = /^\d{3}\s?\d{3}$/; // one-time code shown on the gateway's console

/**
 * Pair this browser session with the gateway, using either the 6-digit one-time code shown by the gateway or the
 * full secret. The secret is kept in chrome.storage.session only. Returns an error message, or null when paired.
 */
export async function pair(input: string): Promise<string | null> {
  const s = input.trim();
  if (CODE_RE.test(s)) {
    let r: Response;
    try {
      r = await fetch(`${GATEWAY_ORIGIN}/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: s.replace(/\s+/g, '') }), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    } catch {
      return 'Gateway not reachable. Is it running? Nothing was saved.';
    }
    const body = await r.json().catch(() => null);
    if (r.status === 401) return `${typeof body?.error === 'string' ? body.error : 'Wrong code'}. Check the code on the gateway's screen.`;
    if (r.status === 410) return 'This gateway has no pairing code available (already used, expired or locked). Restart the gateway for a new one.';
    if (!r.ok || typeof body?.secret !== 'string' || !SECRET_RE.test(body.secret)) return `Pairing failed (gateway ${r.status}). Nothing was saved.`;
    await chrome.storage.session.set({ [SECRET_KEY]: body.secret });
    return null;
  }
  if (!SECRET_RE.test(s)) return 'Enter the 6-digit code shown by the gateway (or its 64-character secret). Nothing was saved.';
  await chrome.storage.session.set({ [SECRET_KEY]: s });
  return null;
}

export async function forgetPairing() {
  await chrome.storage.session.remove(SECRET_KEY);
}

/** Human-readable reason for a gateway response that did not produce a layout. Never includes the secret. */
function reason(status: number, body: { error?: unknown; upstreamError?: { type?: unknown } } | null): string {
  const e = typeof body?.error === 'string' ? body.error.slice(0, 120) : '';
  if (status === 401) return 'gateway refused the pairing secret';
  if (status === 403) return 'gateway is not set up for this extension';
  if (status === 402) return `spending or call limit reached (${e})`;
  if (status === 429) return `gateway busy or rate-limited (${e})`;
  if (status === 400) return `gateway refused the request (${e})`;
  if (status === 422) return `model declined or output was cut short (${e})`;
  return `gateway error ${status}${e ? ` (${e})` : ''}`;
}

/**
 * Build a ModelGateway for planSurface when AI layouts are on and paired; otherwise null (rule-based only).
 * `onSent` receives the exact planner context sent, so the panel can show it.
 */
export async function gatewayClient(onSent: (ctx: PlannerContext) => void): Promise<ModelGateway | null> {
  const { enabled } = await getAiConfig();
  if (!enabled) return null;
  const secret = (await chrome.storage.session.get(SECRET_KEY))[SECRET_KEY] as string | undefined;
  if (!secret) return null;
  return {
    name: 'local-gateway',
    async generate(ctx: PlannerContext, signal: AbortSignal): Promise<string> {
      onSent(ctx);
      let r: Response;
      try {
        r = await fetch(`${GATEWAY_ORIGIN}/v1/plan`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify(ctx),
          signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        throw new Error(signal.aborted ? 'AI layout took too long' : 'gateway not reachable');
      }
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(reason(r.status, body));
      if (typeof body?.surfaceText !== 'string') throw new Error('gateway returned no layout');
      return body.surfaceText; // raw text; the planner's validator parses and checks it
    },
  };
}
