import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const types = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['woff2', 'font/woff2'],
]);

const root = new URL('../', import.meta.url);
const host = '127.0.0.1';
const port = 5174;

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const path = request.url.split('?')[0];
  const file = path === '/' ? '/index.html' : path;
  const type = types.get(file.split('.').at(-1));
  const isAsset = /^\/assets\/(?:[\w-]+\/)*[\w-]+\.[\w]+$/.test(file);
  if (!type || (!isAsset && file !== '/index.html' && file !== '/config.js')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const content = await readFile(new URL('.' + file, root));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});

server.listen(port, host, () => console.log(`Expense Tracker is running at http://${host}:${port}/`));
