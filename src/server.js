'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const D = require('./db');
const W = require('./web');
const { page } = require('./layout');

D.init();
require('./routes/consumer');
require('./routes/exchange');
require('./routes/api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname.replace(/^\/static\//, '')));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  try {
    if (pathname.startsWith('/static/') && req.method === 'GET') { if (serveStatic(res, pathname)) return; }
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const session = W.getSession(req, res);
    const user = session.userId ? D.get('SELECT id, email, first_name, last_name, role FROM users WHERE id = ?', session.userId) : null;
    const query = {};
    for (const [k, v] of u.searchParams) { if (k in query) query[k] = [].concat(query[k], v); else query[k] = v; }
    const isApi = pathname.startsWith('/api');
    const area = pathname.startsWith('/exchange') ? 'exchange' : 'consumer';
    const ctx = {
      req, res, session, user, query, path: pathname, url: pathname + u.search, params: {}, body: {},
      render: (title, body, opts = {}) => W.html(res, page({ title, body, session, user, area, ...opts })),
      flash: (kind, text) => session.flash.push({ kind, text }),
      notFound: msg => (isApi ? W.json(res, { error: msg || 'Not found' }, 404)
        : W.html(res, page({ title: 'Not found', session, user, area, body: W.h`<h1 id="page-title">Page not found</h1>${W.alertBox('error', null, msg || 'The page you requested does not exist.', 'not-found')}<p><a href="${area === 'exchange' ? '/exchange' : '/'}">Return home</a></p>` }), 404)),
    };
    const m = W.match(req.method, pathname);
    if (!m) return ctx.notFound();
    ctx.params = m.params;
    if (req.method === 'POST') ctx.body = await W.parseBody(req);
    await m.handler(ctx);
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.end();
    if (pathname.startsWith('/api')) return W.json(res, { error: err.message }, err.status || 500);
    W.html(res, `<!doctype html><title>Error</title><h1 id="page-title">Something went wrong</h1><pre id="error-detail">${W.esc(err.message)}</pre><a href="/">Home</a>`, err.status || 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`CoverWell Marketplace test app running at http://localhost:${PORT}`);
  console.log(`  Consumer site:   http://localhost:${PORT}/`);
  console.log(`  Exchange portal: http://localhost:${PORT}/exchange`);
  console.log(`  API:             http://localhost:${PORT}/api`);
  console.log(`  Database:        ${D.DB_PATH}`);
});
