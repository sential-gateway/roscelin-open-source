// WCAG 2.2 contrast checks for the side-panel design tokens, read from the real stylesheet.
// Text pairs need 4.5:1 (1.4.3); focus rings, control borders and the source thread need 3:1 (1.4.11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

/** Custom properties declared inside the first block whose selector text matches `selector`. */
function block(selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  assert.ok(m, `block not found: ${selector}`);
  let i = css.indexOf('{', m.index) + 1, depth = 1;
  const start = i;
  while (depth && i < css.length) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
  const body = css.slice(start, i - 1);
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1], x[2].toLowerCase()]));
}
const light = block(/^:root \{/m);
const dark = { ...light, ...block(/:root:not\(\[data-theme="light"\]\) \{/) };
const highLight = { ...light, ...block(/^:root\[data-contrast="high"\] \{/m) };
const highDark = { ...dark, ...block(/^:root\[data-contrast="high"\] \{/m), ...block(/:root\[data-contrast="high"\]:not\(\[data-theme="light"\]\) \{/) };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT: [string, string][] = [
  ['fg', 'bg'], ['fg', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent-fg', 'accent'],
  ['accent', 'accent-tint'], ['accent', 'surface'], ['fg', 'accent-tint'], ['warn-fg', 'warn-bg'], ['danger', 'surface'], ['ok', 'surface'],
  ['on-night', 'night'], ['on-night-2', 'night'], ['muted', 'accent-tint'],
];
const NON_TEXT: [string, string][] = [
  ['focus', 'bg'], ['focus', 'surface'], ['focus-on-night', 'night'], ['line-strong', 'surface'], ['line-strong', 'bg'],
  ['thread', 'bg'], ['thread', 'surface'], ['accent', 'bg'],
];

for (const [name, t] of [['light', light], ['dark', dark], ['high contrast (light)', highLight], ['high contrast (dark)', highDark]] as const) {
  test(`design tokens meet WCAG contrast: ${name}`, () => {
    const fails: string[] = [];
    for (const [a, b] of TEXT) { assert.ok(t[a] && t[b], `${name}: missing --${a} or --${b}`); const r = ratio(t[a], t[b]); if (r < 4.5) fails.push(`text --${a} on --${b}: ${r.toFixed(2)}`); }
    for (const [a, b] of NON_TEXT) { assert.ok(t[a] && t[b], `${name}: missing --${a} or --${b}`); const r = ratio(t[a], t[b]); if (r < 3) fails.push(`non-text --${a} on --${b}: ${r.toFixed(2)}`); }
    assert.deepEqual(fails, []);
  });
}

test('teal and mint brand colours are marks only, never text on light grounds', () => {
  // Only the `color` property (text); borders and backgrounds (border-*-color, background) may use them.
  assert.ok(!/(?<![-\w])color:\s*var\(--(teal|mint)\)/.test(css), 'teal/mint used as a text colour');
});

test('font is bundled locally (no remote font or stylesheet loading)', () => {
  assert.match(css, /src: url\('fonts\/hanken-grotesk-variable\.woff2'\)/);
  assert.ok(!/@import|https?:\/\//.test(css), 'remote resource referenced from the stylesheet');
});
