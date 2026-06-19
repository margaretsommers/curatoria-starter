import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');
const port = Number(process.env.PORT ?? 3000);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function resolveFilePath(urlPath) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const directPath = path.join(publicDir, safePath);

  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  if (fs.existsSync(directPath) && fs.statSync(directPath).isDirectory()) {
    const indexPath = path.join(directPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  if (!path.extname(safePath)) {
    const indexInDir = path.join(publicDir, safePath, 'index.html');
    if (fs.existsSync(indexInDir)) {
      return indexInDir;
    }
  }

  return null;
}

const server = http.createServer((req, res) => {
  const filePath = resolveFilePath(req.url ?? '/');

  if (!filePath || !filePath.startsWith(publicDir)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath)] ?? 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Serving ${publicDir} at http://localhost:${port}`);
});
