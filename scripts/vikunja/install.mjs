// Download and verify a PINNED Vikunja release into .local/vikunja/<version>/ (gitignored, disposable).
// Verification: SHA-256 must equal the digest GitHub publishes for the release asset (pinned below).
// Nothing is installed system-wide; no services, PATH or registry changes.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const VIKUNJA_VERSION = 'v2.8.0';
const ASSET = `vikunja-${VIKUNJA_VERSION}-windows-4.0-amd64.exe-full.zip`;
const URL_ = `https://github.com/go-vikunja/vikunja/releases/download/${VIKUNJA_VERSION}/${ASSET}`;
// From `gh api repos/go-vikunja/vikunja/releases/tags/v2.8.0` → assets[].digest (checked 2026-11-17).
const SHA256 = 'a65637c960b5c88fc3be3fa26a1a96626285e32a0d6abdefb869c8e3c26096db';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const VDIR = join(ROOT, '.local', 'vikunja', VIKUNJA_VERSION);
const DL = join(VDIR, 'download');
const BIN = join(VDIR, 'bin');

export function exePath() {
  return join(BIN, `vikunja-${VIKUNJA_VERSION}-windows-4.0-amd64.exe`);
}

async function main() {
  if (existsSync(exePath())) {
    console.log(`already installed: ${exePath()}`);
    return;
  }
  await mkdir(DL, { recursive: true });
  const zip = join(DL, ASSET);
  if (!existsSync(zip)) {
    console.log(`downloading ${URL_}`);
    const res = await fetch(URL_, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  }
  const got = createHash('sha256').update(await readFile(zip)).digest('hex');
  if (got !== SHA256) {
    await rm(zip, { force: true });
    throw new Error(`SHA-256 mismatch: expected ${SHA256}, got ${got}. Deleted download.`);
  }
  console.log(`sha256 ok ${got}`);
  await rm(BIN, { recursive: true, force: true });
  await mkdir(BIN, { recursive: true });
  // Windows 10+ bsdtar extracts zip archives; avoids running anything from the archive.
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', BIN], { stdio: 'inherit' });
  console.log('extracted:', (await readdir(BIN)).join(', '));
  if (!existsSync(exePath())) throw new Error(`expected ${exePath()} after extraction`);
  // The archive also ships a .sha256 for the exe; check it matches as a second consistency check.
  const inner = (await readFile(`${exePath()}.sha256`, 'utf8')).trim().split(/\s+/)[0];
  const exeHash = createHash('sha256').update(await readFile(exePath())).digest('hex');
  if (inner !== exeHash) throw new Error(`exe hash ${exeHash} != shipped ${inner}`);
  console.log(`exe sha256 ok ${exeHash}`);
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) main().catch((e) => { console.error(e.message); process.exit(1); });
