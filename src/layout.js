'use strict';
const { h, raw, esc } = require('./web');
const D = require('./db');

const SITE = 'CoverWell Marketplace';

function flashes(session) {
  const f = session.flash || [];
  session.flash = [];
  return f.map(m => h`<div class="alert alert-${m.kind}" role="status" id="flash-${m.kind}" data-testid="flash-${m.kind}"><div class="alert-body">${m.text}</div></div>`);
}

function page({ title, body, session, user, area = 'consumer', active = '', wide = false }) {
  const nav = area === 'exchange' ? exchangeHeader(user) : consumerHeader(user, active);
  const main = area === 'exchange'
    ? h`<div class="ex-shell">${exchangeNav(active)}<main id="main-content" class="ex-main" tabindex="-1">${flashes(session)}${body}</main></div>`
    : h`<main id="main-content" class="container ${wide ? 'wide' : ''}" tabindex="-1">${flashes(session)}${body}</main>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${area === 'exchange' ? 'Exchange QHP Certification Portal' : SITE}</title>
<link rel="stylesheet" href="/static/styles.css"></head>
<body class="area-${area}">
<a class="skip" href="#main-content">Skip to main content</a>
<div class="sandbox-banner" id="sandbox-banner">Test environment — fictional data for automated testing. Not a government website. · System date <span id="banner-system-date">${esc(D.today())}</span></div>
${nav}
${main}
<footer class="site-footer"><div class="container">
  <div>${SITE} test sandbox · Coverage year 2026 · <a href="/api" id="footer-api">API</a> · <a href="/exchange" id="footer-exchange">Exchange portal</a> · <a href="/exchange/admin" id="footer-admin">Test data admin</a></div>
</div></footer>
<script src="/static/app.js"></script>
</body></html>`;
}

function consumerHeader(user, active) {
  const item = (href, label, key) => h`<li><a href="${href}" id="nav-${key}" data-testid="nav-${key}" class="${active === key ? 'active' : ''}">${label}</a></li>`;
  return h`<header class="site-header"><div class="container header-row">
    <a href="/" class="logo" id="logo"><span class="logo-mark">CW</span> ${SITE}</a>
    <nav aria-label="Primary"><ul class="nav">
      ${item('/screener', 'See if you can save', 'screener')}
      ${item('/plans', 'See plans & prices', 'plans')}
      ${item('/apply', 'Apply for coverage', 'apply')}
      ${item('/help/local', 'Find local help', 'local-help')}
      ${item('/appeals/new', 'Appeals', 'appeals')}
    </ul></nav>
    <div class="account">${user
      ? h`<span class="who" id="signed-in-user">Hi, ${user.first_name}</span> <a href="/dashboard" id="nav-dashboard" class="btn btn-small btn-outline-light">My account</a>
         <form method="post" action="/logout" class="inline"><button id="btn-logout" class="btn btn-small btn-link-light" type="submit">Log out</button></form>`
      : h`<a href="/login" id="nav-login" class="btn btn-small btn-outline-light">Log in</a> <a href="/account/create" id="nav-create-account" class="btn btn-small btn-accent">Create account</a>`}
    </div></div></header>`;
}

function exchangeHeader(user) {
  return h`<header class="ex-header"><div class="ex-header-row">
    <a href="/exchange" class="ex-logo" id="ex-logo">Exchange QHP Certification Portal</a>
    <span class="ex-sub">Plan Management · Plan Year 2026 · <a href="/exchange/clock" id="ex-system-date" class="ex-clock">System date ${D.today()}</a></span>
    <div class="account">${user
      ? h`<span class="who" id="ex-signed-in-user">${user.first_name} ${user.last_name} (${user.role})</span>
         <form method="post" action="/logout?next=/exchange" class="inline"><button id="btn-ex-logout" class="btn btn-small btn-link-light" type="submit">Sign out</button></form>`
      : h`<a href="/exchange/login" id="ex-nav-login" class="btn btn-small btn-outline-light">Sign in</a>`}
      <a href="/" class="btn btn-small btn-link-light" id="ex-consumer-site">Consumer site</a>
    </div></div></header>`;
}

const EX_NAV = [
  ['Certification', [
    ['/exchange', 'Dashboard', 'dashboard'],
    ['/exchange/queue', 'Certification Queue', 'queue'],
    ['/exchange/pending', 'Pending Certifications', 'pending'],
    ['/exchange/active', 'Active Certifications', 'active'],
    ['/exchange/submissions', 'New Plan Submissions', 'submissions'],
    ['/exchange/reviews', 'Certification Reviews', 'reviews'],
    ['/exchange/workflow', 'Certification Workflow', 'workflow'],
    ['/exchange/comprehensive', 'Comprehensive Reviews', 'comprehensive'],
    ['/exchange/transparency', 'Transparency Compliance', 'transparency'],
    ['/exchange/accreditation', 'Accreditation Verification', 'accreditation'],
    ['/exchange/plans', 'All QHP Records', 'plans'],
    ['/exchange/denials', 'Denials', 'denials'],
    ['/exchange/reconsiderations', 'Reconsiderations', 'reconsiderations'],
  ]],
  ['Operations', [
    ['/exchange/agents', 'Agents & Brokers', 'agents'],
    ['/exchange/appeals', 'Eligibility Appeals', 'appeals'],
    ['/exchange/notices', 'FTR Notices', 'notices'],
    ['/exchange/data-inaccuracy', 'Data Inaccuracy Reports', 'data-inaccuracy'],
    ['/exchange/qis-report', 'QIS Public Report', 'qis-report'],
    ['/exchange/enrollments', 'Enrollments & Payments', 'enrollments'],
  ]],
  ['Enrollment & Eligibility (2025 CFR)', [
    ['/exchange/redetermination', 'Annual Redetermination', 'redetermination'],
    ['/exchange/834', '834 Transactions', '834'],
    ['/exchange/inconsistencies', 'Inconsistencies', 'inconsistencies'],
    ['/exchange/sep', 'Special Enrollment', 'sep'],
    ['/exchange/plan-validation', 'Plan Data Validation', 'plan-validation'],
    ['/exchange/clock', 'System Clock', 'clock'],
  ]],
  ['Rules & Tools', [
    ['/exchange/tools', 'Regulatory Rule Tools', 'tools'],
    ['/exchange/parameters', 'Regulatory Parameters', 'parameters'],
    ['/exchange/admin', 'Test Data Admin', 'admin'],
  ]],
];
function exchangeNav(active) {
  return h`<nav class="ex-nav" aria-label="Exchange menu" id="exchange-menu">
    ${EX_NAV.map(([group, items]) => h`<div class="ex-nav-group"><div class="ex-nav-title">${group}</div><ul>
      ${items.map(([href, label, key]) => h`<li><a href="${href}" id="menu-${key}" data-testid="menu-${key}" class="${active === key ? 'active' : ''}">${label}</a></li>`)}
    </ul></div>`)}
  </nav>`;
}

function breadcrumb(items) {
  return h`<nav class="breadcrumb" aria-label="Breadcrumb"><ol>${items.map(([label, href]) => (href ? h`<li><a href="${href}">${label}</a></li>` : h`<li aria-current="page">${label}</li>`))}</ol></nav>`;
}

module.exports = { page, breadcrumb, SITE };
