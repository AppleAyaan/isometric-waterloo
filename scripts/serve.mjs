// Tiny static file server (no dependencies).
//   npm run serve     -> the project root, viewer at /viewer/ (reads ../out/ directly)
//   npm run preview   -> the built site/ folder, exactly as it will be deployed
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8',
  '.dzi': 'application/xml', '.xml': 'application/xml', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};

export function startServer(port = 8080, root = PROJECT) {
  const ROOT = path.resolve(root);
  const isSite = ROOT !== PROJECT;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' && !isSite) { res.writeHead(302, { Location: '/viewer/' }); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : PROJECT;
  if (!fs.existsSync(root)) { console.error(`${root} does not exist (run npm run site first)`); process.exit(1); }
  await startServer(port, root);
  console.log(`serving on http://localhost:${port}/${root === PROJECT ? 'viewer/' : ''}`);
}
