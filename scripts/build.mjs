// Zero-dependency build: strips TypeScript types with Node's built-in stripper, rewrites import
// specifiers to .js in an output tree, and bundles the content script as a classic IIFE
// (content scripts injected via chrome.scripting cannot be ES modules).
import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// --e2e: test-only build that pre-declares the fixture host permission, because automated
// headless runs cannot click Chrome's permission prompt. Never distribute this variant.
const E2E = process.argv.includes('--e2e');
const OUT = join(ROOT, 'dist', E2E ? 'extension-e2e' : 'extension');

const strip = (code) => stripTypeScriptTypes(code, { mode: 'strip' });

/** Map a source .ts path to its output .js path. */
function outPath(src) {
  const rel = relative(ROOT, src);
  if (rel.startsWith(`extension${sep}src${sep}`)) return join(OUT, rel.slice(`extension${sep}src${sep}`.length)).replace(/\.ts$/, '.js');
  if (rel.startsWith(`packages${sep}`)) return join(OUT, rel).replace(/\.ts$/, '.js');
  throw new Error(`unexpected source ${rel}`);
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

async function emitModule(src, seen = new Set()) {
  if (seen.has(src)) return;
  seen.add(src);
  const code = strip(await readFile(src, 'utf8'));
  const deps = [];
  const out = code.replace(IMPORT_RE, (_m, kw, q, spec) => {
    const depSrc = resolve(dirname(src), `${spec}.ts`);
    deps.push(depSrc);
    let r = relative(dirname(outPath(src)), outPath(depSrc)).split(sep).join('/');
    if (!r.startsWith('.')) r = `./${r}`;
    return `${kw}${q}${r}${q}`;
  });
  await mkdir(dirname(outPath(src)), { recursive: true });
  await writeFile(outPath(src), out);
  for (const d of deps) await emitModule(d, seen);
}

/** Naive bundler for the content script: dependency-ordered concatenation inside an IIFE. */
async function bundleClassic(entry, outFile) {
  const order = [];
  const visit = async (src) => {
    if (order.includes(src)) return;
    const code = strip(await readFile(src, 'utf8'));
    for (const m of code.matchAll(/^\s*import\s+[^;]*?from\s*['"](\.{1,2}\/[^'"]+)\.ts['"];?\s*$/gm)) await visit(resolve(dirname(src), `${m[1]}.ts`));
    order.push(src);
  };
  await visit(entry);
  const parts = [];
  for (const src of order) {
    let code = strip(await readFile(src, 'utf8'));
    code = code.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"];?\s*$/gm, '');
    code = code.replace(/^export\s+(const|function|async function|class|let)\b/gm, '$1');
    if (/^\s*(import|export)\b/m.test(code)) throw new Error(`unbundleable module syntax left in ${src}`);
    parts.push(`// ${relative(ROOT, src)}\n${code}`);
  }
  await writeFile(outFile, `(() => {\n'use strict';\n${parts.join('\n')}\n})();\n`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const f of ['manifest.json', 'sidepanel.html', 'sidepanel.css']) await copyFile(join(ROOT, 'extension', f), join(OUT, f));
// Bundled font (Hanken Grotesk, OFL-1.1) and its licence: no network font loading.
await mkdir(join(OUT, 'fonts'), { recursive: true });
for (const f of await readdir(join(ROOT, 'extension', 'fonts'))) await copyFile(join(ROOT, 'extension', 'fonts', f), join(OUT, 'fonts', f));
if (E2E) {
  const m = JSON.parse(await readFile(join(OUT, 'manifest.json'), 'utf8'));
  m.name += ' [E2E TEST BUILD]';
  m.host_permissions = ['http://localhost:4317/*', 'http://localhost:3456/*'];
  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(m, null, 2));
}
await mkdir(join(OUT,'vendor'),{recursive:true});
for(const f of ['three.module.js','three.core.js'])await copyFile(join(ROOT,'node_modules','three','build',f),join(OUT,'vendor',f));
await copyFile(join(ROOT,'node_modules','three','LICENSE'),join(OUT,'vendor','THREE-LICENSE.txt'));
await emitModule(join(ROOT, 'extension', 'src', 'sw.ts'));
await emitModule(join(ROOT, 'extension', 'src', 'sidepanel.ts'));
await bundleClassic(join(ROOT, 'extension', 'src', 'content.ts'), join(OUT, 'content.js'));

// Guard: shipped code must not contain dynamic code execution or remote script loading.
const bad = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bimport\s*\(/, /\.innerHTML\s*=/, /<script[^>]+src=["']https?:/i];
async function scan(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await scan(p);
    else if (/\.(js|html)$/.test(e.name)) {
      const c = await readFile(p, 'utf8');
      for (const b of bad) if (b.test(c)) throw new Error(`forbidden pattern ${b} in ${relative(OUT, p)}`);
    }
  }
}
await scan(OUT);
console.log(`built ${relative(ROOT, OUT)}`);
