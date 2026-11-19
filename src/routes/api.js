'use strict';
// JSON API for data-driven / API tests. Read-mostly; POST /api/admin/reset restores the seeded baseline.
const D = require('../db');
const R = require('../rules');
const M = require('../marketplace');
const { getR, postR, json } = require('../web');
const { qisReport, plan } = require('./exchange');

const HIDDEN_COLUMNS = { users: ['password_hash'] };

// Requirement -> where it is implemented (UI path, API path). Keys match Test Manager project ACA.
const TRACE = {
  'ACA:42': { ui: ['/exchange (certification workflow)', '/exchange/review/:planId'], api: ['/api/qhp-certifications', '/api/denials'], tests: ['ACA:151', 'ACA:152', 'ACA:153', 'ACA:154', 'ACA:155', 'ACA:156', 'ACA:157', 'ACA:158', 'ACA:159', 'ACA:160'] },
  'ACA:16': { ui: ['/exchange/denials/:num', '/exchange/reconsiderations'], api: ['/api/rules/reconsideration-check'] },
  'ACA:43': { ui: ['/exchange/reconsiderations/new?denial=:num'], api: ['/api/rules/reconsideration-check'] },
  'ACA:9': { ui: ['/exchange/agencies/:id'], api: ['/api/db/compliance_actions'] },
  'ACA:36': { ui: ['/exchange/agencies/:id'], api: ['/api/db/compliance_actions'] },
  'ACA:10': { ui: ['/exchange/agents/:npn', '/help/local', '/apply/:num/review'], api: ['/api/rules/agent-suspension'] },
  'ACA:37': { ui: ['/exchange/agents/:npn'], api: ['/api/rules/agent-suspension'] },
  'ACA:11': { ui: ['/apply/:num/review (consent & review section)'], api: ['/api/applications/:num'] },
  'ACA:12': { ui: ['/exchange/notices', '/dashboard'], api: ['/api/rules/ftr-notice', '/api/db/notices'] },
  'ACA:38': { ui: ['/exchange/notices'], api: ['/api/rules/ftr-notice'] },
  'ACA:13': { ui: ['/exchange/data-inaccuracy'], api: ['/api/rules/data-inaccuracy-deadline'] },
  'ACA:39': { ui: ['/exchange/data-inaccuracy'], api: ['/api/rules/data-inaccuracy-deadline'] },
  'ACA:14': { ui: ['/enrollments/:num (payments)'], api: ['/api/rules/premium-threshold'] },
  'ACA:40': { ui: ['/enrollments/:num (payments)'], api: ['/api/rules/premium-threshold'] },
  'ACA:15': { ui: ['/appeals/new'], api: ['/api/rules/appeal-standing'] },
  'ACA:41': { ui: ['/appeals/new'], api: ['/api/rules/appeal-standing'] },
  'ACA:17': { ui: ['/exchange/review/:planId?section=ecp'], api: ['/api/rules/ecp-review'] },
  'ACA:44': { ui: ['/exchange/review/:planId?section=ecp'], api: ['/api/rules/ecp-review'] },
  'ACA:18': { ui: ['/exchange/qis-report'], api: ['/api/qis-report'] },
  // ---- Project BCA (2025 CFR changes) ----
  'BCA:2': { ui: ['/apply/:num/household (immigration status)', '/apply/:num/results'], api: [] },
  'BCA:3': { ui: ['/exchange/agents/:npn (suspend / reinstate with remediation)'], api: [] },
  'BCA:4': { ui: ['/apply/:num/results (FTR check)', '/exchange/notices'], api: [] },
  'BCA:5': { ui: ['/exchange/notices'], api: [] }, 'BCA:6': { ui: ['/exchange/notices', '/apply/:num/results'], api: [] },
  'BCA:7': { ui: ['/exchange/inconsistencies'], api: ['/api/inconsistencies/deadline-check'] },
  'BCA:8': { ui: ['/apply/:num/income (data hub)', '/exchange/inconsistencies'], api: [] }, 'BCA:9': { ui: ['/apply/:num/income (alternate data)'], api: [] },
  'BCA:10': { ui: ['/apply/:num/income (blank tax data)'], api: [] },
  'BCA:11': { ui: ['/exchange/redetermination/:id'], api: ['/api/redetermination/enrollees/:id/reenroll'] },
  'BCA:12': { ui: ['/exchange/redetermination', '/exchange/redetermination/:id', '/exchange/redetermination/:id/premium-record', '/exchange/834', '/exchange/clock'],
    api: ['/api/clock', '/api/redetermination/enrollees', '/api/redetermination/enrollees/:id/reenroll', '/api/redetermination/enrollees/:id/premium-record', '/api/834'],
    tests: ['BCA:40', 'BCA:41', 'BCA:42', 'BCA:43', 'BCA:44', 'BCA:45', 'BCA:46', 'BCA:47', 'BCA:48', 'BCA:49'] },
  'BCA:13': { ui: ['/enrollments/:num (payments)'], api: [] },
  'BCA:14': { ui: ['/apply/:num/plans', '/exchange/parameters'], api: [] }, 'BCA:15': { ui: ['/apply/:num/plans', '/exchange/parameters'], api: [] },
  'BCA:16': { ui: ['/apply/:num/enroll'], api: [] }, 'BCA:17': { ui: ['/apply/:num/enroll'], api: [] },
  'BCA:18': { ui: ['/sep/new'], api: [] }, 'BCA:19': { ui: ['/sep/new'], api: [] }, 'BCA:20': { ui: ['/sep/new'], api: [] }, 'BCA:21': { ui: ['/sep/new'], api: [] },
  'BCA:22': { ui: ['/sep/new', '/exchange/sep'], api: [] },
  'BCA:24': { ui: ['/exchange/plan-validation'], api: ['/api/plan-validation/:id'] }, 'BCA:25': { ui: ['/exchange/plan-validation'], api: ['/api/plan-validation/:id'] },
  'BCA:28': { ui: ['/exchange/plan-validation'], api: ['/api/plan-validation/:id'] }, 'BCA:38': { ui: ['/exchange/plan-validation'], api: ['/api/plan-validation/:id'] },
  'BCA:32': { ui: ['/exchange/reconsiderations/new?denial=:num'], api: [] },
  'BCA:33': { ui: ['/exchange/inconsistencies/:num (resolve)'], api: [] }, 'BCA:34': { ui: ['/exchange/agents/:npn (terminate for cause)'], api: [] },
  'BCA:35': { ui: ['/exchange/data-inaccuracy'], api: [] }, 'BCA:36': { ui: ['/appeals/new'], api: [] },
};
for (const t of R.TOOLS) for (const r of t.reqs) {
  TRACE[r] ||= { ui: [], api: [] };
  if (!TRACE[r].ui.includes(`/exchange/tools/${t.id}`)) TRACE[r].ui.push(`/exchange/tools/${t.id}`);
  if (!TRACE[r].api.includes(`/api/rules/${t.id}`)) TRACE[r].api.push(`/api/rules/${t.id}`);
}

getR('/api', ctx => json(ctx.res, {
  name: 'CoverWell Marketplace test API', database: D.DB_PATH,
  endpoints: {
    'GET /api/health': 'Health check', 'POST /api/admin/reset': 'Reset database to seeded baseline',
    'GET /api/db': 'List tables', 'GET /api/db/:table?column=value&limit=n': 'Rows from a table (filter by equality on any column)',
    'GET /api/plans?zip=&metal=': 'Marketplace plans', 'GET /api/plans/:id': 'One plan',
    'GET /api/eligibility?zip=&income=&household=&ages=40,38': 'APTC / CSR / Medicaid estimate',
    'GET /api/qhp-certifications': 'QHP certification records', 'GET /api/qhp-certifications/:planId': 'Record with assessments, checklist, denials',
    'GET /api/denials': 'Certification denials', 'GET /api/applications/:appNumber': 'Application with household, income, enrollments',
    'GET /api/rules': 'Rule tool catalog', 'GET|POST /api/rules/:toolId': 'Run a rule tool (inputs as query string or JSON body)',
    'GET /api/qis-report': 'Aggregated QIS public report', 'GET /api/requirements': 'Requirement traceability map',
  },
}));
getR('/api/health', ctx => json(ctx.res, { status: 'ok', database: D.DB_PATH, plans: D.get('SELECT COUNT(*) n FROM plans').n, time: D.nowIso() }));
postR('/api/admin/reset', ctx => { D.reset(); json(ctx.res, { status: 'reset', database: D.DB_PATH }); });

getR('/api/db', ctx => json(ctx.res, D.TABLES.slice().sort().map(t => ({ table: t, rows: D.get(`SELECT COUNT(*) n FROM ${t}`).n }))));
getR('/api/db/:table', ctx => {
  const t = ctx.params.table;
  if (!D.TABLES.includes(t)) return json(ctx.res, { error: `Unknown table ${t}` }, 404);
  const cols = D.all(`PRAGMA table_info(${t})`).map(c => c.name);
  const hidden = HIDDEN_COLUMNS[t] || [];
  const where = []; const args = [];
  for (const [k, v] of Object.entries(ctx.query)) {
    if (k === 'limit' || k === 'offset') continue;
    if (!cols.includes(k)) return json(ctx.res, { error: `Unknown column ${k} on ${t}`, columns: cols }, 400);
    where.push(`${k} = ?`); args.push(v);
  }
  const limit = Math.min(1000, Number(ctx.query.limit) || 200); const offset = Number(ctx.query.offset) || 0;
  const rows = D.all(`SELECT ${cols.filter(c => !hidden.includes(c)).join(', ')} FROM ${t} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} LIMIT ${limit} OFFSET ${offset}`, ...args);
  return json(ctx.res, { table: t, count: rows.length, rows });
});

getR('/api/plans', ctx => {
  let rows;
  if (ctx.query.zip) { const loc = M.lookupZip(ctx.query.zip); if (!loc) return json(ctx.res, { error: 'ZIP not served' }, 404); rows = M.plansInCounty(loc.fips); }
  else rows = D.all('SELECT p.*, i.name issuer_name FROM plans p JOIN issuers i ON i.id = p.issuer_id ORDER BY p.id');
  if (ctx.query.metal) rows = rows.filter(p => p.metal.toLowerCase() === String(ctx.query.metal).toLowerCase());
  return json(ctx.res, { count: rows.length, plans: rows });
});
getR('/api/plans/:id', ctx => {
  const p = D.get('SELECT p.*, i.name issuer_name FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', ctx.params.id);
  if (!p) return json(ctx.res, { error: 'Not found' }, 404);
  p.service_area = D.all('SELECT county_fips FROM plan_service_areas WHERE plan_id = ?', p.id).map(r => r.county_fips);
  return json(ctx.res, p);
});
getR('/api/eligibility', ctx => {
  const ages = String(ctx.query.ages || '40').split(',').map(Number).filter(n => !Number.isNaN(n));
  const r = M.eligibility({ zip: ctx.query.zip, householdSize: ctx.query.household || ages.length, income: ctx.query.income || 0, members: ages.map(age => ({ age })) });
  return json(ctx.res, r, r.error ? 400 : 200);
});

getR('/api/qhp-certifications', ctx => json(ctx.res, D.all('SELECT * FROM qhp_certifications ORDER BY plan_id')));
getR('/api/qhp-certifications/:id', ctx => {
  const p = plan(ctx.params.id);
  if (!p) return json(ctx.res, { error: 'Not found' }, 404);
  return json(ctx.res, { ...p, assessments: D.all('SELECT criterion, status, detail FROM qhp_assessments WHERE plan_id = ?', p.plan_id),
    checklist: D.all('SELECT section, item, value, detail FROM qhp_checklist_items WHERE plan_id = ? ORDER BY id', p.plan_id),
    denials: D.all('SELECT * FROM qhp_denials WHERE plan_id = ? ORDER BY id DESC', p.plan_id).map(d => ({ ...d, violations: JSON.parse(d.violations) })),
    reconsiderations: D.all('SELECT * FROM qhp_reconsiderations WHERE plan_id = ? ORDER BY id DESC', p.plan_id) });
});
getR('/api/denials', ctx => json(ctx.res, D.all('SELECT * FROM qhp_denials ORDER BY id DESC').map(d => ({ ...d, violations: JSON.parse(d.violations) }))));
getR('/api/applications/:num', ctx => {
  const a = D.get('SELECT * FROM applications WHERE app_number = ?', ctx.params.num);
  if (!a) return json(ctx.res, { error: 'Not found' }, 404);
  return json(ctx.res, { ...a, members: D.all('SELECT * FROM household_members WHERE application_id = ?', a.id), income: D.all('SELECT * FROM income_sources WHERE application_id = ?', a.id),
    enrollments: D.all('SELECT * FROM enrollments WHERE application_id = ?', a.id) });
});

getR('/api/rules', ctx => json(ctx.res, R.TOOLS.map(t => ({ id: t.id, title: t.title, group: t.group, requirements: t.reqs, citation: t.cite,
  inputs: t.inputs.map(i => ({ name: i.name, label: i.label, type: i.type, ...(i.type === 'select' ? { options: R.resolveOptions(i).map(o => o[0]) } : {}), default: i.value })) }))));
function runRule(ctx, inputs) {
  try { const r = R.runTool(ctx.params.id, inputs); return json(ctx.res, { tool: ctx.params.id, inputs, outcome: r.outcome, result: r.data, details: Object.fromEntries(r.rows.map(([k, v], i) => [r.rows.findIndex(x => x[0] === k) === i ? k : `${k} ${i}`, v])) }); }
  catch (e) { if (e instanceof R.RuleError) return json(ctx.res, { tool: ctx.params.id, error: e.message }, 400); throw e; }
}
getR('/api/rules/:id', ctx => runRule(ctx, ctx.query));
postR('/api/rules/:id', ctx => runRule(ctx, { ...ctx.query, ...ctx.body }));

getR('/api/qis-report', ctx => json(ctx.res, qisReport()));
getR('/api/requirements', ctx => json(ctx.res, TRACE));

module.exports = { TRACE };
