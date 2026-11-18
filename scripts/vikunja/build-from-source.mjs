// Build Vikunja v2.8.0 from its official signed tag with pinned, verified toolchains. No UPX.
//   node scripts/vikunja/build-from-source.mjs [step...]   steps: toolchains source frontend backend (default: all)
// Everything lands under .local/ (gitignored). No system-wide installs, PATH, registry or AV changes.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const L = join(ROOT, '.local');
const TOOLS = join(L, 'toolchains');
const SRC = join(L, 'vikunja-src', 'v2.8.0');
export const OUT_DIR = join(L, 'vikunja', 'v2.8.0-src', 'bin');
export const OUT_EXE = join(OUT_DIR, 'vikunja-v2.8.0-src.exe');
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

// ---- pins (all checked 2026-11-17) ----
export const PINS = {
  go: {
    version: 'go1.27.3', // version the official v2.8.0 release was built with (`vikunja version`); go.mod requires >= 1.27.0
    url: 'https://go.dev/dl/go1.27.3.windows-amd64.zip',
    sha256: 'f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff', // go.dev/dl/?mode=json&include=all
  },
  mingw: {
    version: 'llvm-mingw-20261020-ucrt-x86_64', // needed: mattn/go-sqlite3 requires cgo; no MinGW on this machine
    url: 'https://github.com/mstorsjo/llvm-mingw/releases/download/20261020/llvm-mingw-20261020-ucrt-x86_64.zip',
    sha256: 'fd5462b7f5d93b2ff981fcd3f9c7e427e47f3203c64ea91c27bcc444eebd74cd', // GitHub release asset digest
  },
  pnpm: {
    version: '12.16.1', // frontend/package.json "packageManager"
    url: 'https://registry.npmjs.org/pnpm/-/pnpm-12.16.1.tgz',
    integrity: 'sha512-CR0d7nknV1Zhsl2rPCrjHK/BxU1rce1qZgDPDByxBDSkR+rhQBXxsj4ua+3u1535SpMuIWTSgyKA3OP7MvZW0Q==', // npm registry dist.integrity
    // pnpm 12 is a native executable shipped in a per-platform package; the wrapper above only locates it.
    exeUrl: 'https://registry.npmjs.org/@pnpm/exe.win32-x64/-/exe.win32-x64-12.16.1.tgz',
    exeIntegrity: 'sha512-k+FhRJ0ttphFoFIVB1Sk4v76YJAulafmA/Ly57cysesUhhIzVlApeOShUz0jXubKx317TThlEfpQrukldnqORA==',
  },
  source: {
    repo: 'https://github.com/go-vikunja/vikunja.git',
    tag: 'v2.8.0',
    tagObject: '5dff8b9e09426ce5d4b955d7dd66eb81dff29d5d', // annotated tag; GitHub: verified=true, reason=valid, tagger kolaente
    commit: '6e788bf87cebe50e2b8d034b213fcf94ae5449ee',
  },
};

const log = (...a) => console.log('[build]', ...a);
const sha256File = (p) => new Promise((res, rej) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });

async function fetchVerified(url, dest, check) {
  if (!existsSync(dest)) {
    log('download', url);
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  }
  await check(dest);
}

function run(cmd, args, opts = {}) {
  log('$', [cmd, ...args].join(' ').slice(0, 220));
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

export function goEnv() {
  const goroot = join(TOOLS, PINS.go.version, 'go');
  const mingw = join(TOOLS, PINS.mingw.version);
  return {
    ...process.env,
    GOROOT: goroot,
    GOTOOLCHAIN: 'local', // never auto-download another toolchain
    GOPATH: join(L, 'gopath'),
    GOMODCACHE: join(L, 'gopath', 'pkg', 'mod'),
    GOCACHE: join(L, 'gocache'),
    GOFLAGS: '-mod=readonly',
    GOPROXY: 'https://proxy.golang.org,direct',
    GOSUMDB: 'sum.golang.org', // every module checked against the Go checksum database
    GONOSUMDB: '', GONOSUMCHECK: '', GOPRIVATE: '', GOINSECURE: '',
    CGO_ENABLED: '1',
    CC: 'x86_64-w64-mingw32-clang',
    PATH: `${join(goroot, 'bin')};${join(mingw, 'bin')};${process.env.PATH}`,
  };
}

async function toolchains() {
  const dl = join(TOOLS, 'downloads');
  await mkdir(dl, { recursive: true });
  // Go
  const goZip = join(dl, `${PINS.go.version}.windows-amd64.zip`);
  await fetchVerified(PINS.go.url, goZip, async (p) => {
    const h = await sha256File(p);
    if (h !== PINS.go.sha256) throw new Error(`Go sha256 mismatch ${h}`);
    log('go zip sha256 ok', h);
  });
  const goDir = join(TOOLS, PINS.go.version);
  if (!existsSync(join(goDir, 'go', 'bin', 'go.exe'))) {
    await mkdir(goDir, { recursive: true });
    run(TAR, ['-xf', goZip, '-C', goDir]);
  }
  // mingw
  const mZip = join(dl, `${PINS.mingw.version}.zip`);
  await fetchVerified(PINS.mingw.url, mZip, async (p) => {
    const h = await sha256File(p);
    if (h !== PINS.mingw.sha256) throw new Error(`llvm-mingw sha256 mismatch ${h}`);
    log('llvm-mingw zip sha256 ok', h);
  });
  if (!existsSync(join(TOOLS, PINS.mingw.version, 'bin'))) run(TAR, ['-xf', mZip, '-C', TOOLS]);
  // pnpm (npm tarball, sha512 integrity)
  const pTgz = join(dl, `pnpm-${PINS.pnpm.version}.tgz`);
  await fetchVerified(PINS.pnpm.url, pTgz, async (p) => {
    const got = 'sha512-' + createHash('sha512').update(await readFile(p)).digest('base64');
    if (got !== PINS.pnpm.integrity) throw new Error(`pnpm integrity mismatch ${got}`);
    log('pnpm tarball sha512 integrity ok');
  });
  const pDir = join(TOOLS, `pnpm-${PINS.pnpm.version}`);
  if (!existsSync(join(pDir, 'package', 'bin', 'pnpm.cjs'))) {
    await mkdir(pDir, { recursive: true });
    run(TAR, ['-xzf', pTgz, '-C', pDir]);
  }
  const xTgz = join(dl, `pnpm-exe-win32-x64-${PINS.pnpm.version}.tgz`);
  await fetchVerified(PINS.pnpm.exeUrl, xTgz, async (p) => {
    const got = 'sha512-' + createHash('sha512').update(await readFile(p)).digest('base64');
    if (got !== PINS.pnpm.exeIntegrity) throw new Error(`pnpm exe integrity mismatch ${got}`);
    log('pnpm native exe tarball sha512 integrity ok');
  });
  const xDir = join(TOOLS, `pnpm-exe-${PINS.pnpm.version}`);
  if (!existsSync(join(xDir, 'package', 'pnpm.exe'))) {
    await mkdir(xDir, { recursive: true });
    run(TAR, ['-xzf', xTgz, '-C', xDir]);
  }
  run(join(xDir, 'package', 'pnpm.exe'), ['--version']);
  run(join(goDir, 'go', 'bin', 'go.exe'), ['version'], { env: goEnv() });
  run('x86_64-w64-mingw32-clang', ['--version'], { env: goEnv() });
}

async function source() {
  if (!existsSync(join(SRC, '.git'))) {
    await mkdir(join(L, 'vikunja-src'), { recursive: true });
    run('git', ['-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', PINS.source.tag, PINS.source.repo, SRC]);
  }
  const head = execFileSync('git', ['-C', SRC, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tagObj = execFileSync('git', ['-C', SRC, 'rev-parse', `refs/tags/${PINS.source.tag}`], { encoding: 'utf8' }).trim();
  if (head !== PINS.source.commit) throw new Error(`HEAD ${head} != pinned ${PINS.source.commit}`);
  if (tagObj !== PINS.source.tagObject) throw new Error(`tag object ${tagObj} != pinned ${PINS.source.tagObject}`);
  const dirty = execFileSync('git', ['-C', SRC, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`source tree not clean:\n${dirty}`);
  log('source ok: tag object', tagObj, 'commit', head, 'clean tree');
}

async function frontend() {
  const fe = join(SRC, 'frontend');
  const pnpm = join(TOOLS, `pnpm-exe-${PINS.pnpm.version}`, 'package', 'pnpm.exe');
  // PUPPETEER_SKIP_DOWNLOAD: Vikunja's pnpm-workspace.yaml allows puppeteer's postinstall, which otherwise
  // downloads ~261 MB of Chrome for Testing into %USERPROFILE%\.cache\puppeteer (only needed for its UI tests).
  const env = { ...process.env, CI: 'true', npm_config_store_dir: join(L, 'pnpm-store'), PNPM_HOME: join(L, 'pnpm-home'), PUPPETEER_SKIP_DOWNLOAD: 'true' };
  // --frozen-lockfile: install exactly what pnpm-lock.yaml pins; each tarball is checked against its lockfile integrity hash.
  run(pnpm, ['install', '--frozen-lockfile'], { cwd: fe, env });
  run(pnpm, ['run', 'build'], { cwd: fe, env });
  if (!existsSync(join(fe, 'dist', 'index.html'))) throw new Error('frontend build produced no dist/index.html');
  log('frontend dist files:', (await readdir(join(fe, 'dist'))).length);
}

async function backend() {
  const env = goEnv();
  const go = join(env.GOROOT, 'bin', 'go.exe');
  run(go, ['mod', 'download'], { cwd: SRC, env });
  run(go, ['mod', 'verify'], { cwd: SRC, env });
  await mkdir(OUT_DIR, { recursive: true });
  // Same flags as the official magefile Build target (-tags osusergo, -s -w, version ldflags). No UPX step.
  const ld = `-s -w -X "code.vikunja.io/api/pkg/version.Version=v2.8.0" -X "main.Tags=osusergo"`;
  run(go, ['build', '-trimpath', '-tags', 'osusergo', '-ldflags', ld, '-o', OUT_EXE, '.'], { cwd: SRC, env });
  const h = await sha256File(OUT_EXE);
  const raw = await readFile(OUT_EXE);
  const upx = raw.subarray(0, 8192).includes(Buffer.from('UPX!'));
  await writeFile(`${OUT_EXE}.build.json`, JSON.stringify({ builtAt: new Date().toISOString(), sha256: h, size: raw.length, upx, pins: PINS }, null, 2));
  log('built', OUT_EXE, 'sha256', h, 'size', raw.length, 'UPX', upx);
}

const steps = { toolchains, source, frontend, backend };
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);
for (const s of want) {
  if (!steps[s]) throw new Error(`unknown step ${s}`);
  log('=== step', s);
  await steps[s]();
}
