// Minimal static server for the controlled reference fixture. Binds to loopback only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../test-fixtures/reference-app/', import.meta.url));
const port = Number(process.env.FIXTURE_PORT ?? 4317);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([\\/])+/, '');
  if (rel.includes('..')) return res.writeHead(400).end();
  try {
    const body = await readFile(join(root, rel));
    res.writeHead(200, { 'content-type': types[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`reference fixture on http://localhost:${port}`));
