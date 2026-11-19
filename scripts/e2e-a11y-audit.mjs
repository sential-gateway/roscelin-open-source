// Milestone 1 slice 6: accessibility pass over every composition, in Chrome's REAL side panel, against the controlled
// reference app (no Vikunja, no AI, no network beyond loopback, no writes to the app).
//   node scripts/build.mjs --e2e && node scripts/e2e-a11y-audit.mjs
// For each state (default list, Focus, Guided, Compare, Compare two, proposal preview + Refine, review dialog,
// Profile, Activity, workload map) it runs the page audit in scripts/lib/a11y-audit-page.js (names, ARIA references,
// widget roles, text and field contrast, 24 px targets, live regions, headings, non-text alternatives), and checks:
// keyboard-only operation of each composition with real key events, a Tab walk (focus always visible, never hidden
// or trapped), light, dark, forced colours and the app's high-contrast setting, reduced motion, reflow at 320 px and
// at 200% zoom (a 360 px panel → 180 CSS px), and WCAG text spacing.
// It does NOT replace testing with Narrator/NVDA or by disabled people: see ACCESSIBILITY.md (not yet verified items).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep, checker } from './lib/cdp.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT = join(ROOT, 'dist', 'extension-e2e');
const OUT = process.env.A11Y_OUTPUT ? resolve(process.env.A11Y_OUTPUT) : join(ROOT, 'outputs', 'a11y-audit');
const AUDIT = await readFile(join(ROOT, 'scripts', 'lib', 'a11y-audit-page.js'), 'utf8');
await mkdir(OUT, { recursive: true });

// ---- reference app on 127.0.0.1:4317 (refuse if the port is taken) ----
const fixtureDir = join(ROOT, 'test-fixtures', 'reference-app');
const server = createServer(async (req, res) => {
  const f = (new URL(req.url, 'http://x').pathname.slice(1) || 'index.html');
  if (f.includes('..')) return res.writeHead(400).end();
  let body;
  try { body = await readFile(join(fixtureDir, f)); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
});
await new Promise((ok, no) => { server.once('error', () => no(new Error('Port 4317 is in use. Stop the other test or fixture server first.'))); server.listen(4317, '127.0.0.1', ok); });

const c = await launchChrome({ extraArgs: ['--window-size=1280,900'] });
const { check, assert, results } = checker();
const report = { scope: 'Automated checks in the real side panel against the reference app. Not a conformance claim; manual screen-reader and zoom checks are listed as not yet verified in ACCESSIBILITY.md.', states: {} };
let P;

const ev = (expr) => c.evaluate(P, expr);
const key = async (k, mods = 0) => {
  const named = { Tab: ['Tab', 9], Enter: ['Enter', 13], ' ': ['Space', 32], Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowLeft: ['ArrowLeft', 37], Home: ['Home', 36], End: ['End', 35] };
  const [code, kc] = named[k] ?? [k, 0];
  const base = { key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc, modifiers: mods };
  await c.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, P);
  if (k === 'Enter' || k === ' ') await c.cdp('Input.dispatchKeyEvent', { type: 'char', ...base, text: k === 'Enter' ? '\r' : ' ' }, P);
  await c.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, P);
  await sleep(60);
};
const typeText = async (s) => { await c.cdp('Input.insertText', { text: s }, P); await sleep(60); };
const focusInfo = () => ev('window.__a11y.focusInfo()');
const media = (features) => c.cdp('Emulation.setEmulatedMedia', { features }, P);
const width = (w) => (w ? c.cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, P) : c.cdp('Emulation.clearDeviceMetricsOverride', {}, P));
const shot = async (file) => { try { const { data } = await c.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, P); await writeFile(join(OUT, file), Buffer.from(data, 'base64')); } catch { /* optional */ } };

/** Run the page audit; fail the check on any WCAG failure and keep warnings in the report. */
async function audited(state, rootSel = 'body') {
  await ev(AUDIT);
  const r = await ev(`window.__a11y.audit(${JSON.stringify(rootSel)})`);
  report.states[state] = { ...(report.states[state] ?? {}), audit: r };
  assert(r.fails.length === 0, `${r.fails.length} failure(s): ${r.fails.slice(0, 6).map((f) => `${f.rule}: ${f.el}${f.detail ? ` (${f.detail})` : ''}`).join(' | ')}`);
  return `${r.checked.elements} elements, ${r.checked.interactive} interactive, 0 failures${r.warns.length ? `, ${r.warns.length} warning(s)` : ''}`;
}

/** Propose for a request, optionally accept it. Uses the panel's own form (rule-based planner; AI is off). */
async function propose(text, accept = true) {
  await ev(`(() => { document.getElementById('tab-workspace').click(); const i = document.getElementById('intent'); i.value = ${JSON.stringify(text)}; document.getElementById('intent-form').requestSubmit(); })()`);
  await c.waitFor(P, `!document.getElementById('proposal').hidden && document.getElementById('proposal-title').textContent`, `proposal for "${text}"`);
  if (accept) {
    await ev(`document.getElementById('accept').click()`);
    await c.waitFor(P, `document.getElementById('proposal').hidden`, 'accepted');
    await sleep(150);
  }
  return ev(`document.getElementById('surface-name').textContent`);
}

/** Tab through the whole panel with real key events. */
async function tabWalk(label, max = 140) {
  await ev(`document.activeElement?.blur(); window.scrollTo(0, 0)`);
  const steps = [];
  const problems = [];
  let first = null;
  for (let i = 0; i < max; i++) {
    await key('Tab');
    const f = await focusInfo();
    if (f.body) continue;
    if (first === null) first = f.desc;
    else if (f.desc === first && steps.length > 2) break;
    steps.push(f.desc);
    if (!f.visible) problems.push(`focus on a hidden element: ${f.desc}`);
    if (!f.indicator) problems.push(`no visible focus indicator: ${f.desc}`);
    else if (!f.hasShadow && f.outlineContrast < 3) problems.push(`focus outline contrast ${f.outlineContrast}:1: ${f.desc}`);
    if (f.obscured) problems.push(`focused element entirely hidden by other content: ${f.desc}`);
    else if (f.partlyObscured) (report.partlyObscured ??= []).push(`${label}: ${f.desc}`);
    const last3 = steps.slice(-3);
    if (last3.length === 3 && new Set(last3).size === 1) { problems.push(`focus stuck on ${f.desc}`); break; }
  }
  report.states[label] = { ...(report.states[label] ?? {}), tabWalk: { stops: steps.length, order: steps, problems } };
  return { steps, problems };
}

try {
  const { id: extId } = await c.cdp('Extensions.loadUnpacked', { path: EXT });
  const tab = await c.open('http://localhost:4317/');
  await c.waitFor(tab.sessionId, `!!document.querySelector('li[data-task-id="t1"]')`, 'reference app');
  const launcher = await c.open(`chrome-extension://${extId}/sidepanel.html`);
  await c.waitFor(launcher.sessionId, `!document.getElementById('to-sidepanel').hidden`, 'launcher button');
  const [bx, by] = await c.evaluate(launcher.sessionId, `(() => { const b = document.getElementById('to-sidepanel').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.cdp('Input.dispatchMouseEvent', { type, x: bx, y: by, button: 'left', clickCount: 1 }, launcher.sessionId);
  await sleep(800);
  await c.cdp('Target.closeTarget', { targetId: launcher.targetId });
  await c.cdp('Target.activateTarget', { targetId: tab.targetId });
  let sp;
  for (let i = 0; i < 50 && !sp; i++) { sp = (await c.targets()).find((t) => t.url === `chrome-extension://${extId}/sidepanel.html` && !t.attached); if (!sp) await sleep(100); }
  assert(sp, 'side panel target not found');
  P = await c.attach(sp.targetId);
  await c.cdp('Page.enable', {}, P);
  await c.waitFor(P, `document.querySelector('.ai-provenance')?.textContent.includes('localhost:4317')`, 'workspace loaded from the reference app', 15000);
  await ev(AUDIT);
  const writesBefore = (await ev(`chrome.runtime.sendMessage({ type: 'broker.journal' })`)).journal.length;

  await check('page basics: language, title, one main landmark, skip link to the workspace', async () => {
    const r = await ev(`({ lang: document.documentElement.lang, title: document.title, mains: document.querySelectorAll('main, [role=main]').length, skip: !!document.querySelector('a[href^="#"]') })`);
    assert(r.lang && r.title, JSON.stringify(r));
    assert(r.skip, 'no skip link');
    return `lang=${r.lang}, title "${r.title}", main landmarks ${r.mains}, skip link present`;
  });

  await check('default workspace (task list): audit', () => audited('default'));

  await check('Focus composition: audit, and keyboard-only "Work on this task"', async () => {
    const name = await propose('what needs my attention right now');
    const detail = await audited('focus');
    await ev(`document.querySelector('#surface .ai-attention button')?.focus()`);
    const before = await focusInfo();
    assert(/button/.test(before.desc), `no primary action to focus: ${before.desc}`);
    await key('Enter');
    await sleep(200);
    const edit = await ev(`!!document.querySelector('#surface .ai-edit select, #surface .ai-edit input')`);
    assert(edit, 'Enter on the primary action did not open the edit form');
    return `${name}: ${detail}; Enter on "${before.desc}" opened the edit form`;
  });

  await check('Guided composition: audit, keyboard choose moves focus into step 2', async () => {
    const name = await propose('guide me through changing a task one step at a time');
    const detail = await audited('guided');
    // A task chosen in an earlier layout carries over (step 2). "Choose a different task" by keyboard goes back to step 1.
    let restart = '';
    if (await ev(`!!document.querySelector('#surface .ai-guided button[data-key$=":back"]')`)) {
      await ev(`document.querySelector('#surface .ai-guided button[data-key$=":back"]').focus()`);
      await key('Enter');
      await sleep(250);
      const f0 = await focusInfo();
      assert(/Step 1/.test(f0.desc), `focus after "Choose a different task": ${f0.desc}`);
      restart = `"Choose a different task" by Enter → focus on ${f0.desc}; `;
    }
    await ev(`document.querySelector('#surface .ai-guided [role=option][tabindex="0"]').focus()`);
    await key('ArrowDown');
    const moved = await focusInfo();
    await key('Enter');
    await sleep(250);
    const f = await focusInfo();
    const step = await ev(`document.querySelector('#surface [aria-current=step]')?.textContent.replace(/\\s+/g,' ').slice(0, 60)`);
    assert(/Step 2|change/i.test(step ?? ''), `current step after Enter: ${step}`);
    assert(!f.body && (await ev(`!!document.activeElement.closest('#surface')`)), `focus left the workspace: ${f.desc}`);
    return `${name}: ${detail}; ${restart}ArrowDown → ${moved.desc}; Enter → current step "${step}", focus ${f.desc}`;
  });

  await check('Compare composition: audit, keyboard selection in groups', async () => {
    const name = await propose('compare tasks by status');
    const detail = await audited('compare');
    await ev(`document.querySelector('#surface [role=listbox] [role=option]').focus()`);
    await key('Enter');
    await sleep(150);
    const sel = await ev(`document.querySelectorAll('#surface [role=option][aria-selected=true]').length`);
    assert(sel >= 1, 'Enter did not select an item');
    return `${name}: ${detail}; Enter selected an item`;
  });

  await check('Compare two composition: audit, keyboard picks two items and the summary updates', async () => {
    const name = await propose('compare two tasks side by side');
    const detail = await audited('compare-two');
    const picks = await ev(`document.querySelectorAll('#surface .ai-pick-btn').length`);
    assert(picks >= 2, `only ${picks} items to pick`);
    await ev(`document.querySelectorAll('#surface .ai-pick-btn')[0].focus()`);
    await key(' ');
    await sleep(150);
    await ev(`document.querySelectorAll('#surface .ai-pick-btn')[1].focus()`);
    await key(' ');
    await sleep(200);
    const summary = await ev(`document.querySelector('#surface .ai-compare-summary')?.textContent`);
    const pressed = await ev(`document.querySelectorAll('#surface .ai-pick-btn[aria-pressed=true]').length`);
    assert(pressed === 2, `${pressed} pressed`);
    const f = await focusInfo();
    assert(/ai-pick-btn/.test(f.desc), `focus lost after picking: ${f.desc}`);
    const after = await audited('compare-two-picked');
    return `${name}: ${detail}; two picks by Space, focus kept on ${f.desc}; summary "${(summary ?? '').slice(0, 70)}"; picked state ${after}`;
  });

  await check('proposal preview, Refine and version history: audit and keyboard use', async () => {
    await propose('show tasks compact with keyboard shortcuts', false);
    const detail = await audited('proposal');
    const inert = await ev(`document.getElementById('proposal-preview').inert && ![...document.querySelectorAll('#proposal-preview *')].some(e => e.tabIndex >= 0 && !e.closest('[inert]'))`);
    assert(inert, 'preview content is focusable');
    await ev(`document.getElementById('refine').focus()`);
    await typeText('more space, hide status');
    await key('Enter');
    const changes = await c.waitFor(P, `document.getElementById('proposal-changes').textContent`, 'refine status');
    const f1 = await focusInfo();
    assert(/#refine/.test(f1.desc), `focus after Refine: ${f1.desc}`);
    await ev(`document.getElementById('proposal-back').focus()`);
    await key('Enter');
    const ver = await ev(`document.getElementById('proposal-version').textContent`);
    assert(ver === 'Version 1 of 2', ver);
    const f2 = await focusInfo();
    assert(/#proposal-forward/.test(f2.desc), `focus after Previous reached version 1: ${f2.desc}`);
    const afterBack = await audited('proposal-refined');
    await ev(`document.getElementById('discard').click()`);
    return `${detail}; Refine by keyboard → "${changes}", focus stays in ${f1.desc}; Previous by Enter → ${ver}, focus ${f2.desc}; ${afterBack}`;
  });

  await check('review dialog: named, focus moves in, Tab stays inside, Escape closes and returns focus', async () => {
    await propose('show my tasks as a compact list');
    await ev(`document.querySelector('#surface [role=option]').focus()`);
    await key('Enter');
    await c.waitFor(P, `!!document.querySelector('#surface .ai-edit select, #surface .ai-edit input')`, 'edit form');
    await ev(`(() => { const s = document.querySelector('#surface .ai-edit select[name=status]') || document.querySelector('#surface .ai-edit select'); s.value = [...s.options].map(o => o.value).find(v => v !== s.value); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ev(`document.querySelector('#surface .ai-edit button[type=submit]').focus()`);
    const trigger = (await focusInfo()).desc;
    await key('Enter');
    await c.waitFor(P, `document.getElementById('review').open`, 'review dialog');
    await sleep(150);
    const named = await ev(`document.getElementById('review-title').textContent`);
    const inside = await focusInfo();
    assert(named && inside.inDialog, `title "${named}", focus ${inside.desc}`);
    const detail = await audited('review-dialog', '#review');
    // A modal dialog makes the page behind it inert: Tab may go to the browser's own controls, never to page content.
    for (let i = 0; i < 6; i++) { await key('Tab'); const f = await focusInfo(); assert(f.inDialog || f.body, `Tab reached page content behind the open dialog: ${f.desc}`); }
    await key('Escape');
    await c.waitFor(P, `!document.getElementById('review').open`, 'dialog closed');
    await sleep(150);
    const back = await focusInfo();
    assert(back.desc === trigger, `focus after Escape: ${back.desc}, expected ${trigger}`);
    return `"${named}"; ${detail}; focus returned to ${back.desc}`;
  });

  await check('Profile and Activity tabs: audit each', async () => {
    await ev(`document.getElementById('tab-settings').click()`);
    const a = await audited('profile', '#panel-settings');
    await ev(`document.getElementById('tab-activity').click()`);
    await sleep(150);
    const b = await audited('activity', '#panel-activity');
    await ev(`document.getElementById('tab-workspace').click()`);
    return `Profile: ${a}; Activity: ${b}`;
  });

  await check('workload map (table and optional 3D view): audit', async () => {
    await propose('show my tasks as a compact list');
    await ev(`document.getElementById('map-details').open = true`);
    await sleep(300);
    const detail = await audited('workload-map', '#map-details');
    const table = await ev(`!!document.querySelector('#task-map table caption, #task-map table[aria-label], #task-map table')`);
    assert(table, 'no exact table');
    await ev(`document.getElementById('map-details').open = false`);
    return `${detail}; exact table present`;
  });

  await check('Tab walk over the whole panel: focus always visible, never hidden, covered or trapped', async () => {
    await propose('what needs my attention right now');
    const { steps, problems } = await tabWalk('tab-walk');
    assert(steps.length > 5, `only ${steps.length} stops`);
    assert(problems.length === 0, problems.slice(0, 6).join(' | '));
    return `${steps.length} tab stops, all with a visible indicator`;
  });

  for (const [label, feats, extra] of [
    ['dark colour scheme', [{ name: 'prefers-color-scheme', value: 'dark' }], null],
    ['forced colours (Windows high contrast)', [{ name: 'forced-colors', value: 'active' }], null],
    ["the app's own high-contrast setting", [], 'high'],
  ]) {
    await check(`${label}: every composition passes the audit`, async () => {
      await media(feats);
      if (extra) await ev(`(() => { document.getElementById('tab-settings').click(); const r = document.querySelector('input[name=contrast][value=high]'); r.click(); r.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('tab-workspace').click(); })()`);
      const out = [];
      for (const [req, st] of [['what needs my attention right now', 'focus'], ['guide me through changing a task one step at a time', 'guided'], ['compare tasks by status', 'compare'], ['compare two tasks side by side', 'compare-two']]) {
        await propose(req);
        out.push(`${st}: ${(await audited(`${label}/${st}`)).split(',').slice(-1)[0].trim()}`);
        if (st === 'focus') await shot(`${label.replace(/[^a-z]+/gi, '-').toLowerCase()}-focus.png`);
      }
      const walk = await tabWalk(`${label}/tab-walk`);
      assert(walk.problems.length === 0, walk.problems.slice(0, 4).join(' | '));
      if (extra) await ev(`(() => { const r = document.querySelector('input[name=contrast][value=standard]'); r.click(); r.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await media([]);
      return `${out.join('; ')}; Tab walk ${walk.steps.length} stops, indicators visible`;
    });
  }

  await check('reduced motion (system setting): nothing animates or transitions', async () => {
    await media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await propose('compare two tasks side by side');
    await ev(`document.getElementById('map-details').open = true`);
    await sleep(200);
    const moving = await ev('window.__a11y.motion()');
    await ev(`document.getElementById('map-details').open = false`);
    await media([]);
    report.states['reduced-motion'] = { moving };
    assert(moving.length === 0, moving.slice(0, 5).join(' | '));
    return 'no animations or transitions over 10 ms';
  });

  for (const [label, w] of [['320 px wide', 320], ['200% zoom (a 360 px panel is 180 CSS px)', 180]]) {
    await check(`reflow at ${label}: no horizontal scrolling in any composition`, async () => {
      await width(w);
      const out = [];
      for (const [req, st] of [['what needs my attention right now', 'focus'], ['guide me through changing a task one step at a time', 'guided'], ['compare tasks by status', 'compare'], ['compare two tasks side by side', 'compare-two']]) {
        await propose(req);
        await sleep(150);
        const r = await ev('window.__a11y.reflow()');
        report.states[`reflow-${w}/${st}`] = r;
        assert(!r.horizontalScroll, `${st}: page scrolls sideways (${r.scrollWidth} > ${r.clientWidth}); wide: ${r.wide.join(', ')}`);
        out.push(`${st} ${r.scrollWidth}/${r.clientWidth}${r.clipped.length ? ` (${r.clipped.length} clipped)` : ''}`);
        if (st === 'guided') await shot(`reflow-${w}-guided.png`);
      }
      await width(0);
      return out.join('; ');
    });
  }

  await check('text spacing (WCAG 1.4.12 overrides): no horizontal scrolling or clipped text', async () => {
    await width(320);
    await ev('window.__a11y.textSpacing(true)');
    const out = [];
    for (const [req, st] of [['what needs my attention right now', 'focus'], ['compare two tasks side by side', 'compare-two']]) {
      await propose(req);
      await sleep(150);
      const r = await ev('window.__a11y.reflow()');
      report.states[`text-spacing/${st}`] = r;
      assert(!r.horizontalScroll && r.clipped.length === 0, `${st}: scroll ${r.scrollWidth}/${r.clientWidth}; clipped ${r.clipped.join(', ')}`);
      out.push(`${st} ok`);
    }
    await ev('window.__a11y.textSpacing(false)');
    await width(0);
    return out.join('; ');
  });

  await check('the pass made no changes to the app (journal unchanged)', async () => {
    const after = (await ev(`chrome.runtime.sendMessage({ type: 'broker.journal' })`)).journal.length;
    assert(after === writesBefore, `${after - writesBefore} journal entries added`);
    return `${after} journal entries before and after`;
  });
} catch (e) {
  results.push({ name: 'harness', pass: false, detail: String(e.stack ?? e) });
  console.log(`  ✗ harness — ${e.message ?? e}`);
} finally {
  report.results = results;
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await c.close();
  server.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Report: ${join(OUT, 'report.json')}`);
process.exitCode = failed ? 1 : 0;
