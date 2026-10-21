const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
require('./build.cjs');
const root = path.resolve(__dirname, '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const port = Number(process.env.PORT || 8767);
http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5);
    if (!['push-config', 'subscription', 'test-notification', 'pengingat-doa'].includes(name)) { res.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 6000) { res.writeHead(413).end(); return; } }
    try { req.body = body ? JSON.parse(body) : undefined; } catch { res.writeHead(400).end(); return; }
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    return require('../api/' + name + '.js')(req, res);
  }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { const data = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data); }
  catch { res.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port));
