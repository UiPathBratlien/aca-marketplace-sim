'use strict';
// Minimal zero-dependency web framework: routing, body parsing, sessions, HTML helpers.
const crypto = require('crypto');

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}
const getR = (p, h) => route('GET', p, h);
const postR = (p, h) => route('POST', p, h);

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) { const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); return { handler: r.handler, params }; }
  }
  return null;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => {
      const type = (req.headers['content-type'] || '').split(';')[0].trim();
      if (!data) return resolve({});
      if (type === 'application/json') { try { return resolve(JSON.parse(data)); } catch { return reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })); } }
      const out = {};
      for (const [k, v] of new URLSearchParams(data)) {
        if (k.endsWith('[]')) (out[k.slice(0, -2)] ||= []).push(v);
        else if (k in out) out[k] = [].concat(out[k], v);
        else out[k] = v;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

// ---- Sessions (in memory) ----
const sessions = new Map();
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function getSession(req, res) {
  let sid = parseCookies(req).sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(18).toString('hex');
    sessions.set(sid, { flash: [] });
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return sessions.get(sid);
}

// ---- Response helpers ----
function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const html = (res, body, status = 200) => send(res, status, body, 'text/html; charset=utf-8');
const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj, null, 2), 'application/json; charset=utf-8');
function redirect(res, location) { res.writeHead(303, { Location: location }); res.end(); }

// ---- HTML helpers ----
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Tagged template: interpolations are escaped unless wrapped with raw()
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Raw(s);
function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map(x => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v === null || v === undefined || v === false) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Form controls with stable id/name/data-testid for UiPath selectors
function field({ name, label, type = 'text', value = '', required = false, placeholder = '', hint = '', step, min, max, autocomplete, id }) {
  const fid = id || name;
  return h`<div class="field"><label for="${fid}">${label}${required ? raw(' <span class="req" aria-hidden="true">*</span>') : ''}</label>
    ${hint ? h`<span class="hint" id="${fid}-hint">${hint}</span>` : ''}
    <input id="${fid}" name="${name}" data-testid="${fid}" type="${type}" value="${value}" ${required ? raw('required') : ''} ${placeholder ? h`placeholder="${placeholder}"` : ''} ${step ? h`step="${step}"` : ''} ${min !== undefined ? h`min="${min}"` : ''} ${max !== undefined ? h`max="${max}"` : ''} ${autocomplete ? h`autocomplete="${autocomplete}"` : ''} ${hint ? h`aria-describedby="${fid}-hint"` : ''}></div>`;
}
function select({ name, label, options, value = '', required = false, placeholder, id, hint }) {
  const fid = id || name;
  const opts = options.map(o => (Array.isArray(o) ? o : [o, o]));
  return h`<div class="field"><label for="${fid}">${label}${required ? raw(' <span class="req" aria-hidden="true">*</span>') : ''}</label>
    ${hint ? h`<span class="hint">${hint}</span>` : ''}
    <select id="${fid}" name="${name}" data-testid="${fid}" ${required ? raw('required') : ''}>
      ${placeholder ? h`<option value="">${placeholder}</option>` : ''}
      ${opts.map(([v, l]) => h`<option value="${v}" ${String(v) === String(value) ? raw('selected') : ''}>${l}</option>`)}
    </select></div>`;
}
function textarea({ name, label, value = '', required = false, rows = 4, id, hint }) {
  const fid = id || name;
  return h`<div class="field"><label for="${fid}">${label}${required ? raw(' <span class="req" aria-hidden="true">*</span>') : ''}</label>
    ${hint ? h`<span class="hint">${hint}</span>` : ''}
    <textarea id="${fid}" name="${name}" data-testid="${fid}" rows="${rows}" ${required ? raw('required') : ''}>${value}</textarea></div>`;
}
function button(label, { id, type = 'submit', cls = 'btn', name, value, attrs = '' } = {}) {
  const bid = id || 'btn-' + slug(label);
  return h`<button type="${type}" id="${bid}" data-testid="${bid}" class="${cls}" ${name ? h`name="${name}"` : ''} ${value !== undefined ? h`value="${value}"` : ''} ${raw(attrs)}>${label}</button>`;
}
function linkBtn(label, href, { id, cls = 'btn' } = {}) {
  const bid = id || 'link-' + slug(label);
  return h`<a href="${href}" id="${bid}" data-testid="${bid}" class="${cls}">${label}</a>`;
}
function alertBox(kind, title, body, id) {
  return h`<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}" id="${id || 'alert-' + kind}" data-testid="${id || 'alert-' + kind}">
    ${title ? h`<h3 class="alert-title">${title}</h3>` : ''}${body ? h`<div class="alert-body">${body}</div>` : ''}</div>`;
}
function errors(list) {
  if (!list || !list.length) return '';
  return alertBox('error', 'Please correct the following', h`<ul>${list.map(e => h`<li>${e}</li>`)}</ul>`, 'form-errors');
}
function table(headers, rows, { id, empty = 'No records found.' } = {}) {
  if (!rows.length) return h`<p class="muted" id="${id ? id + '-empty' : 'table-empty'}">${empty}</p>`;
  return h`<div class="table-wrap"><table class="data" ${id ? h`id="${id}" data-testid="${id}"` : ''}><thead><tr>${headers.map(x => h`<th scope="col">${x}</th>`)}</tr></thead>
    <tbody>${rows.map(r => h`<tr>${r.map(c => h`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}
function dl(pairs, id) {
  return h`<dl class="kv" ${id ? h`id="${id}" data-testid="${id}"` : ''}>${pairs.map(([k, v]) => h`<div class="kv-row" data-testid="${'kv-' + slug(k)}"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}
function badge(text) {
  const t = String(text || '');
  const kind = /denied|failed|missing|non-compliant|suspend|rejected|untimely|not covered|not submitted|expired|flagged|insufficient|upheld/i.test(t) ? 'bad'
    : /certified|passed|compliant|active|accepted|granted|submitted|enrolled|resolved|covered|eligible|paid/i.test(t) ? 'good' : 'neutral';
  return h`<span class="badge badge-${kind}" data-testid="status-badge">${t}</span>`;
}

module.exports = { route, getR, postR, match, parseBody, getSession, html, json, redirect, esc, h, raw, Raw, slug, field, select, textarea, button, linkBtn, alertBox, errors, table, dl, badge, sessions };
