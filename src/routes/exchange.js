'use strict';
// Exchange (back-office) portal: QHP certification workflow (Test Manager ACA:151-160 / requirement ACA:42),
// reconsideration (ACA:16/43), agents & brokers (ACA:9/10/36/37), FTR notices (ACA:12/38),
// data inaccuracy (ACA:13/39), QIS report (ACA:18), rule tools, parameters and test-data admin.
const D = require('../db');
const R = require('../rules');
const BCA = require('../bca');
const { getR, postR, h, raw, field, select, textarea, button, linkBtn, alertBox, errors, table, dl, badge, slug, redirect } = require('../web');
const { breadcrumb } = require('../layout');

const CRITERIA_LABELS = {
  network: 'Network Adequacy', ehb: 'Essential Health Benefits', av: 'Actuarial Value', cost_sharing: 'Cost-Sharing Limits',
  discrimination: 'Non-Discrimination in Benefit Design', qis: 'Quality Improvement Strategy', transparency: 'Transparency in Coverage',
  accreditation: 'Accreditation', ecp: 'Essential Community Providers',
};
const DENIAL_REASONS = [
  'Failure to meet 45 CFR 155.1000(c) - General Certification Criteria',
  'Failure to meet 45 CFR 155.1000(c)(2) - Essential Health Benefits',
  'Network Adequacy Non-Compliance per 45 CFR 155.1000(c)',
  'Exceeds Maximum Out-of-Pocket Limits - 45 CFR 155.1000(c)',
  'Benefit Design Discrimination - 45 CFR 155.1000(c)',
  'Failure to Submit Quality Improvement Strategy - 45 CFR 155.1000(c)',
  'Transparency in Coverage Violation - 45 CFR 155.1000(c)',
  'Lack of Required Accreditation - 45 CFR 155.1000(c)',
  'Multiple General Certification Criteria Failures - 45 CFR 155.1000(c)',
];
const AV_VIOLATIONS = ['Actuarial Value Below Required Threshold', 'Actuarial Value Above Permitted Range', 'Unapproved AV Calculator Version'];

// Section definitions drive the review workspace. Labels match Test Manager test steps exactly.
const SECTIONS = {
  general: { tab: 'General Certification Criteria', checklist: 'general', checklistOptions: ['Not Reviewed', 'Compliant', 'Non-Compliant'], failValue: 'Non-Compliant',
    reasonMode: 'text', reasonLabel: 'Denial reason', button: 'Deny Certification', confirm: true, status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Certification denied' },
  ehb: { tab: 'Essential Health Benefits', criterion: 'ehb', checklist: 'ehb', checklistOptions: ['Covered', 'Not Covered'], failValue: 'Not Covered',
    reasonLabel: 'Denial reason', notesLabel: 'Additional comments', button: 'Issue Denial', status: 'Certification Denied', basis: '45 CFR 155.1000(c)(2)', headline: 'Denial notification issued' },
  av: { tab: 'Actuarial Value', criterion: 'av', reveal: 'Flag Non-Compliance', reasonLabel: 'Violation type', reasonOptions: AV_VIOLATIONS, notesLabel: 'Justification',
    button: 'Deny Certification', status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Certification denial confirmed' },
  network: { tab: 'Provider Network', criterion: 'network', reveal: 'Analyze Network Adequacy', assess: { label: 'Network adequacy assessment', options: ['Passed', 'Failed'], fail: ['Failed'] },
    reasonLabel: 'Denial basis', notesLabel: 'Denial notes', button: 'Execute Denial', status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Denial executed — denial letter generated' },
  cost: { tab: 'Cost-Sharing Limits', criterion: 'cost_sharing', assess: { label: 'Cost-sharing evaluation', options: ['Compliant', 'Non-Compliant'], fail: ['Non-Compliant'] },
    reasonLabel: 'Denial reason', notesLabel: 'Explanation', button: 'Deny Certification', status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Certification denial recorded' },
  benefit: { tab: 'Benefit Design Review', criterion: 'discrimination', reveal: 'Discrimination Analysis', assess: { label: 'Discrimination assessment', options: ['No Discrimination Found', 'Discriminatory Design Detected'], fail: ['Discriminatory Design Detected'] },
    reasonLabel: 'Denial category', notesLabel: 'Denial justification', button: 'Initiate Denial Process', status: 'Denied - Discrimination Violation', basis: '45 CFR 155.1000(c)', headline: 'Denial workflow activated' },
  qis: { tab: 'Quality Improvement Strategy', criterion: 'qis', assess: { label: 'Quality improvement strategy status', options: ['Submitted', 'Incomplete', 'Missing'], fail: ['Missing', 'Incomplete'] },
    reasonLabel: 'Denial basis', notesLabel: 'Comments', button: 'Process Denial', status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Denial confirmed' },
  transparency: { tab: 'Machine-Readable Files', criterion: 'transparency', assess: { label: 'Transparency compliance', options: ['Compliant', 'Non-Compliant'], fail: ['Non-Compliant'] },
    reasonLabel: 'Denial reason', notesLabel: 'Denial explanation', button: 'Deny Certification', status: 'Denied', basis: '45 CFR 155.1000(c)', headline: 'Certification denial processed' },
  accreditation: { tab: 'Accreditation Status', criterion: 'accreditation', assess: { label: 'Accreditation status', options: ['Compliant', 'Non-Compliant'], fail: ['Non-Compliant'] },
    reasonLabel: 'Denial basis', notesLabel: 'Denial rationale', button: 'Execute Certification Denial', status: 'Certification Denied - Accreditation Failure', basis: '45 CFR 155.1000(c)', headline: 'Denial notification generated' },
  ecp: { tab: 'Essential Community Providers', criterion: 'ecp', infoOnly: true },
  summary: { tab: 'Compliance Summary', reveal: 'Aggregate Violations', reasonLabel: 'Denial type', notesLabel: 'Comprehensive denial notes', button: 'Issue Comprehensive Denial',
    status: 'Denied - Multiple Criteria Failures', basis: '45 CFR 155.1000(c)', headline: 'Comprehensive denial issued' },
};
const SECTION_VIOLATION = { ehb: 'Essential Health Benefits', av: 'Actuarial Value', network: 'Network Adequacy', cost: 'Cost-Sharing Limits', benefit: 'Non-Discrimination in Benefit Design', qis: 'Quality Improvement Strategy', transparency: 'Transparency in Coverage', accreditation: 'Accreditation' };
const FAILED = /failed|missing|flagged|non-compliant|not reviewed/i;

const plan = id => D.get(`SELECT q.*, i.name AS issuer_name, i.hios_id, s.name AS state_name, s.exchange_type
  FROM qhp_certifications q JOIN issuers i ON i.id = q.issuer_id JOIN states s ON s.code = q.state WHERE UPPER(q.plan_id) = UPPER(?)`, String(id || '').trim());
const actor = u => (u ? `${u.first_name} ${u.last_name}` : 'Exchange Reviewer');

function planTable(rows, { radio = true, id = 'plans-table' } = {}) {
  return table(
    [radio ? 'Select' : '', 'Plan ID', 'Plan name', 'Issuer', 'State', 'Metal', 'Submitted', 'Status'],
    rows.map(p => [
      radio ? h`<input type="radio" name="planId" value="${p.plan_id}" id="select-${p.plan_id}" data-testid="select-${p.plan_id}" aria-label="Select ${p.plan_id}">` : '',
      radio ? h`<label for="select-${p.plan_id}" class="plan-id">${p.plan_id}</label>` : h`<a href="/exchange/plans/${p.plan_id}" class="plan-id">${p.plan_id}</a>`,
      p.plan_name, p.issuer_name, p.state, p.metal, p.submitted_on, badge(p.status)]),
    { id, empty: 'No plans match.' });
}
const plansWhere = (where, ...args) => D.all(`SELECT q.*, i.name AS issuer_name FROM qhp_certifications q JOIN issuers i ON i.id = q.issuer_id ${where} ORDER BY q.plan_id`, ...args);
const searchPlans = term => plansWhere("WHERE UPPER(q.plan_id) LIKE UPPER(?) OR UPPER(q.plan_name) LIKE UPPER(?)", `%${term}%`, `%${term}%`);

// A "select a plan from list, click action" page
function listPage(ctx, { active, title, intro, rows, action, section, listTitle, extraTop = '' }) {
  const err = ctx.query.error ? errors([ctx.query.error]) : '';
  return ctx.render(title, h`${breadcrumb([['Dashboard', '/exchange'], [title]])}
    <h1 id="page-title">${title}</h1><p class="lead">${intro}</p>${err}${extraTop}
    <form method="post" action="/exchange/open" id="plan-select-form" class="card">
      <input type="hidden" name="section" value="${section}"><input type="hidden" name="back" value="${ctx.path}">
      <h2>${listTitle}</h2>${planTable(rows)}
      <div class="actions">${button(action)}</div>
    </form>`, { active });
}
// A "type a plan identifier, click load" page
function idEntryPage(ctx, { active, title, intro, label = 'Plan identifier', fieldId = 'plan-identifier', action, section, crumbs }) {
  const err = ctx.query.error ? errors([ctx.query.error]) : '';
  return ctx.render(title, h`${breadcrumb(crumbs || [['Dashboard', '/exchange'], [title]])}
    <h1 id="page-title">${title}</h1><p class="lead">${intro}</p>${err}
    <form method="post" action="/exchange/open" class="card narrow" id="plan-id-form">
      <input type="hidden" name="section" value="${section}"><input type="hidden" name="back" value="${ctx.path}">
      ${field({ name: 'planIdentifier', id: fieldId, label, required: true, placeholder: 'QHP-2026-001', value: ctx.query.planIdentifier || '' })}
      <div class="actions">${button(action)}</div>
    </form>`, { active });
}

// ---------------- Menus / entry points ----------------
getR('/exchange', ctx => {
  const counts = D.all('SELECT queue, COUNT(*) n FROM qhp_certifications GROUP BY queue');
  const c = k => (counts.find(x => x.queue === k) || { n: 0 }).n;
  const denied = D.get("SELECT COUNT(*) n FROM qhp_certifications WHERE status LIKE '%Denied%'").n;
  const tile = (href, label, n, key) => h`<a class="tile" href="${href}" id="tile-${key}" data-testid="tile-${key}"><span class="tile-n">${n}</span><span class="tile-l">${label}</span></a>`;
  return ctx.render('Dashboard', h`<h1 id="page-title">Certification workflow dashboard</h1>
    <p class="lead">QHP certification for plan year 2026. Exchange denial authority: 45 CFR 155.1000(e) for plans that do not meet the general certification criteria in 45 CFR 155.1000(c).</p>
    <div class="tiles">${tile('/exchange/queue', 'Certification Queue', c('pending'), 'queue')}${tile('/exchange/active', 'Active Certifications', c('active'), 'active')}
      ${tile('/exchange/submissions', 'New Plan Submissions', c('submission'), 'submissions')}${tile('/exchange/reviews?filter=in_progress', 'In-Progress Reviews', c('in_progress'), 'in-progress')}
      ${tile('/exchange/comprehensive', 'Comprehensive Reviews', c('comprehensive'), 'comprehensive')}${tile('/exchange/denials', 'Denied plans', denied, 'denied')}</div>
    <div class="card"><h2>Start work</h2><div class="option-list" id="dashboard-options">
      ${linkBtn('New Certification Review', '/exchange/workflow/new', { id: 'option-new-certification-review' })}
      ${linkBtn('Quality Standards Review', '/exchange/workflow/quality', { id: 'option-quality-standards-review', cls: 'btn btn-outline' })}
      ${linkBtn('New Accreditation Review', '/exchange/accreditation/new', { id: 'option-new-accreditation-review', cls: 'btn btn-outline' })}
      ${linkBtn('Regulatory Rule Tools', '/exchange/tools', { id: 'option-tools', cls: 'btn btn-outline' })}</div></div>
    <div class="card"><h2>All QHP certification records</h2>${planTable(plansWhere(''), { radio: false, id: 'dashboard-plans' })}</div>`, { active: 'dashboard' });
});

getR('/exchange/queue', ctx => listPage(ctx, { active: 'queue', title: 'Certification Queue', intro: 'Plans awaiting certification review.', listTitle: 'Pending certifications',
  rows: plansWhere("WHERE q.queue = 'pending'"), action: 'Begin Certification Review', section: 'general' }));

getR('/exchange/pending', ctx => {
  const err = ctx.query.error ? errors([ctx.query.error]) : '';
  return ctx.render('Pending Certifications', h`${breadcrumb([['Dashboard', '/exchange'], ['Pending Certifications']])}
    <h1 id="page-title">Pending Certifications</h1><p class="lead">Retrieve a pending plan by plan ID.</p>${err}
    <form method="post" action="/exchange/open" class="card narrow" id="retrieve-plan-form">
      <input type="hidden" name="section" value="general"><input type="hidden" name="back" value="/exchange/pending">
      ${field({ name: 'planIdentifier', id: 'plan-id-search', label: 'Plan ID', required: true, placeholder: 'QHP-2026-006' })}
      <div class="actions">${button('Retrieve Plan')}</div></form>
    <div class="card"><h2>Pending plans</h2>${planTable(plansWhere("WHERE q.queue = 'pending'"), { radio: false, id: 'pending-plans' })}</div>`, { active: 'pending' });
});

getR('/exchange/active', ctx => {
  const term = (ctx.query.q || '').trim();
  const rows = term ? searchPlans(term) : plansWhere("WHERE q.queue = 'active'");
  return listPage(ctx, { active: 'active', title: 'Active Certifications', intro: 'Search certified and in-force plans.', section: 'general',
    listTitle: term ? `Search results for "${term}"` : 'Active certifications', rows, action: 'Review Certification Status',
    extraTop: h`<form method="get" action="/exchange/active" class="card narrow search-form" id="active-search-form">
      ${field({ name: 'q', id: 'search-field', label: 'Search plans (plan ID or name)', value: term, placeholder: 'QHP-2026-003' })}
      <div class="actions">${button('Search', { id: 'btn-search' })}</div></form>` });
});

getR('/exchange/submissions', ctx => listPage(ctx, { active: 'submissions', title: 'New Plan Submissions', intro: 'Newly submitted QHP applications for plan year 2026.',
  listTitle: 'Submissions', rows: plansWhere("WHERE q.queue = 'submission'"), action: 'Start Certification Process', section: 'general' }));

getR('/exchange/reviews', ctx => {
  const f = ctx.query.filter || 'all';
  const where = { all: '', in_progress: "WHERE q.queue = 'in_progress'", completed: "WHERE q.status LIKE '%Denied%' OR q.status = 'Certified'" }[f] ?? '';
  const filt = (key, label) => h`<a href="/exchange/reviews?filter=${key}" id="filter-${slug(label)}" data-testid="filter-${slug(label)}" class="chip ${f === key ? 'chip-on' : ''}">${label}</a>`;
  return listPage(ctx, { active: 'reviews', title: 'Certification Reviews', intro: 'All certification reviews. Use the filters to narrow the list.', section: 'general',
    listTitle: { all: 'All reviews', in_progress: 'In-progress reviews', completed: 'Completed reviews' }[f] || 'All reviews',
    rows: plansWhere(where), action: 'Continue Review',
    extraTop: h`<div class="chips" role="group" aria-label="Review filters">${filt('all', 'All Reviews')}${filt('in_progress', 'In-Progress Reviews')}${filt('completed', 'Completed Reviews')}</div>` });
});

getR('/exchange/workflow', ctx => ctx.render('Certification Workflow', h`${breadcrumb([['Dashboard', '/exchange'], ['Certification Workflow']])}
  <h1 id="page-title">Certification Workflow</h1><p class="lead">Choose a workflow.</p>
  <div class="card option-list" id="workflow-options">
    ${linkBtn('New Certification Review', '/exchange/workflow/new', { id: 'option-new-certification-review' })}
    ${linkBtn('Quality Standards Review', '/exchange/workflow/quality', { id: 'option-quality-standards-review' })}
    ${linkBtn('Comprehensive Reviews', '/exchange/comprehensive', { id: 'option-comprehensive-reviews', cls: 'btn btn-outline' })}
    ${linkBtn('Accreditation Verification', '/exchange/accreditation', { id: 'option-accreditation-verification', cls: 'btn btn-outline' })}
  </div>`, { active: 'workflow' }));

getR('/exchange/workflow/new', ctx => idEntryPage(ctx, { active: 'workflow', title: 'New Certification Review', intro: 'Enter the plan identifier to load plan details.',
  action: 'Load Plan Details', section: 'general', crumbs: [['Dashboard', '/exchange'], ['Certification Workflow', '/exchange/workflow'], ['New Certification Review']] }));
getR('/exchange/workflow/quality', ctx => idEntryPage(ctx, { active: 'workflow', title: 'Quality Standards Review', intro: 'Load a plan to review quality standards and the quality improvement strategy.',
  action: 'Load Plan for Review', section: 'qis', crumbs: [['Dashboard', '/exchange'], ['Certification Workflow', '/exchange/workflow'], ['Quality Standards Review']] }));

getR('/exchange/comprehensive', ctx => listPage(ctx, { active: 'comprehensive', title: 'Comprehensive Reviews', intro: 'Plans requiring a full certification assessment.',
  listTitle: 'Review queue', rows: plansWhere("WHERE q.queue = 'comprehensive'"), action: 'Begin Full Certification Assessment', section: 'summary' }));

getR('/exchange/transparency', ctx => {
  const term = (ctx.query.q || '').trim();
  const rows = term ? searchPlans(term) : [];
  return listPage(ctx, { active: 'transparency', title: 'Transparency Compliance', intro: 'Review transparency in coverage and machine-readable file submissions.', section: 'transparency',
    listTitle: term ? `Search results for "${term}"` : 'Search results', rows, action: 'Review Transparency Requirements',
    extraTop: h`<form method="get" action="/exchange/transparency" class="card narrow search-form" id="transparency-search-form">
      ${field({ name: 'q', id: 'plan-search-field', label: 'Plan search', value: term, placeholder: 'QHP-2026-009' })}
      <div class="actions">${button('Search Plans')}</div></form>` });
});

getR('/exchange/accreditation', ctx => ctx.render('Accreditation Verification', h`${breadcrumb([['Dashboard', '/exchange'], ['Accreditation Verification']])}
  <h1 id="page-title">Accreditation Verification</h1><p class="lead">Verify issuer accreditation by a recognized accrediting entity.</p>
  <div class="card">${linkBtn('New Accreditation Review', '/exchange/accreditation/new', { id: 'btn-new-accreditation-review' })}</div>
  <div class="card"><h2>Plans</h2>${table(['Plan ID', 'Plan', 'Accreditation'], D.all("SELECT a.plan_id, q.plan_name, a.detail FROM qhp_assessments a JOIN qhp_certifications q ON q.plan_id = a.plan_id WHERE a.criterion = 'accreditation' ORDER BY a.plan_id").map(r => [r.plan_id, r.plan_name, r.detail]), { id: 'accreditation-table' })}</div>`, { active: 'accreditation' }));
getR('/exchange/accreditation/new', ctx => idEntryPage(ctx, { active: 'accreditation', title: 'New Accreditation Review', intro: 'Enter the plan identifier to retrieve accreditation data.',
  action: 'Retrieve Plan Data', section: 'accreditation', crumbs: [['Dashboard', '/exchange'], ['Accreditation Verification', '/exchange/accreditation'], ['New Accreditation Review']] }));

postR('/exchange/open', ctx => {
  const b = ctx.body;
  const id = (b.planId || b.planIdentifier || '').trim();
  const back = (b.back && b.back.startsWith('/exchange')) ? b.back : '/exchange';
  const sep = back.includes('?') ? '&' : '?';
  if (!id) return redirect(ctx.res, `${back}${sep}error=${encodeURIComponent(b.planId === undefined && b.planIdentifier === undefined ? 'Select a plan from the list.' : 'Enter a plan identifier.')}`);
  const p = plan(id);
  if (!p) return redirect(ctx.res, `${back}${sep}error=${encodeURIComponent(`No plan found with identifier ${id}.`)}&planIdentifier=${encodeURIComponent(id)}`);
  const section = SECTIONS[b.section] ? b.section : 'general';
  D.audit('qhp_certification', p.plan_id, 'Review opened', SECTIONS[section].tab, actor(ctx.user));
  return redirect(ctx.res, `/exchange/review/${encodeURIComponent(p.plan_id)}?section=${section}`);
});

// ---------------- Review workspace ----------------
function sectionBody(p, key, values, errs) {
  const s = SECTIONS[key];
  const assess = Object.fromEntries(D.all('SELECT criterion, status, detail FROM qhp_assessments WHERE plan_id = ?', p.plan_id).map(a => [a.criterion, a]));
  const items = sec => D.all('SELECT * FROM qhp_checklist_items WHERE plan_id = ? AND section = ? ORDER BY id', p.plan_id, sec);
  const reveal = (label, inner) => {
    const open = !!errs.length;
    const tid = 'reveal-' + slug(label);
    return h`<div class="actions">${button(label, { type: 'button', cls: 'btn btn-outline', attrs: `data-reveal="#${tid}" aria-controls="${tid}" aria-expanded="${open}"` })}</div>
      <div id="${tid}" class="reveal ${open ? '' : 'hidden'}" data-testid="${tid}">${inner}</div>`;
  };
  let info = '';
  switch (key) {
    case 'general':
      info = h`<p>Review the criteria checklist for 45 CFR 155.1000(c) compliance. Mark each criterion and record a denial reason for any non-compliance.</p>`; break;
    case 'ehb':
      info = h`<p>Review the essential health benefits coverage checklist (45 CFR 155.1000(c)(2); 45 CFR 156.110).</p>`; break;
    case 'av':
      info = dl([['Metal tier', `${p.metal}`], ['Actuarial value', `${Math.round(p.actuarial_value)}%`], ['Required minimum (test configuration)', `${Math.round(p.av_minimum)}%`],
        ['AV calculator', 'Final 2026 AV Calculator'], ['Assessment', badge(assess.av.status)]], 'av-details'); break;
    case 'network':
      info = h`<p>Provider network evaluation module. Run the network adequacy analysis to view the report.</p>`; break;
    case 'cost':
      info = dl([['Maximum out-of-pocket (individual)', `$${p.moop_individual.toLocaleString('en-US')}`], ['Regulatory limit for 2026', `$${p.moop_limit.toLocaleString('en-US')}`],
        ['Comparison', p.moop_individual > p.moop_limit ? `Exceeds limit by $${(p.moop_individual - p.moop_limit).toLocaleString('en-US')}` : 'Within limit']], 'cost-details'); break;
    case 'benefit':
      info = h`<p>Benefit design review for non-discrimination (45 CFR 156.125).</p>`; break;
    case 'qis':
      info = dl(items('qis').map(i => [i.item, i.value]).concat([['Assessment', badge(assess.qis.status)]]), 'qis-details'); break;
    case 'transparency':
      info = h`<h3>Machine-readable file status</h3><ul class="status-list" id="mrf-status">${items('transparency').map(i => h`<li data-testid="mrf-${slug(i.item)}">${i.item}: ${i.value}</li>`)}</ul>`; break;
    case 'accreditation':
      info = h`<h3>Accreditation record</h3><ul class="status-list" id="accreditation-record">${items('accreditation').map(i => h`<li data-testid="accreditation-${slug(i.item)}">${i.value}</li>`)}</ul>`; break;
    case 'ecp': {
      const r = R.rules.ecpReviewer(p.state, p.plan_year, 'medical');
      info = dl([['ECP review responsibility', r.reviewer], ['Basis', r.reason], ['Assessment', badge(assess.ecp.status)], ['Detail', assess.ecp.detail]], 'ecp-details'); break;
    }
    case 'summary':
      info = h`<h3>Compliance report</h3><ul class="status-list" id="compliance-report">${Object.keys(CRITERIA_LABELS).map(c => h`<li data-testid="compliance-${c}">${CRITERIA_LABELS[c].replace(' in Benefit Design', '')}: ${assess[c].status}</li>`)}</ul>`; break;
  }
  if (s.infoOnly) return info;

  // Denial form
  const cl = s.checklist ? items(s.checklist) : [];
  const checklistHtml = cl.length ? h`<fieldset class="checklist"><legend>${key === 'ehb' ? 'Essential health benefits coverage checklist' : 'General certification criteria checklist — 45 CFR 155.1000(c)'}</legend>
      ${table(['Criterion', 'Status'], cl.map(i => [h`<label for="status-${slug(i.item)}">${i.item}</label>`,
        h`<select name="item_${i.id}" id="status-${slug(i.item)}" data-testid="status-${slug(i.item)}">${s.checklistOptions.map(o => h`<option ${(values['item_' + i.id] || i.value) === o ? raw('selected') : ''}>${o}</option>`)}</select>`]), { id: `${key}-checklist` })}</fieldset>` : '';
  const assessHtml = s.assess ? select({ name: 'assessment', id: 'assessment', label: s.assess.label, options: s.assess.options, placeholder: '-- Select --', value: values.assessment || '' }) : '';
  const reasonHtml = s.reasonMode === 'text'
    ? textarea({ name: 'reason', id: 'denial-reason', label: s.reasonLabel, value: values.reason || '', rows: 3 })
    : select({ name: 'reason', id: slug(s.reasonLabel), label: s.reasonLabel, options: s.reasonOptions || DENIAL_REASONS, placeholder: `-- Select ${s.reasonLabel.toLowerCase()} --`, value: values.reason || '' });
  const notesHtml = s.notesLabel ? textarea({ name: 'notes', id: slug(s.notesLabel), label: s.notesLabel, value: values.notes || '', rows: 3 }) : '';
  const confirmAttrs = s.confirm ? `data-confirm="#confirm-dialog"` : '';
  const formInner = h`${errors(errs)}
    <input type="hidden" name="section" value="${key}">
    ${checklistHtml}${assessHtml}${reasonHtml}${notesHtml}
    <div class="actions">${button(s.button, { type: s.confirm ? 'button' : 'submit', cls: 'btn btn-danger', attrs: confirmAttrs })}
      ${key === 'general' ? button('Certify Plan', { cls: 'btn btn-outline', name: 'action', value: 'certify', attrs: 'formnovalidate' }) : ''}</div>
    ${s.confirm ? h`<div class="modal hidden" id="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" data-testid="confirm-dialog">
      <div class="modal-box"><h2 id="confirm-dialog-title">Confirm certification denial</h2>
      <p id="confirm-dialog-message" data-testid="confirm-dialog-message">Are you sure you want to deny certification for ${p.plan_id}?</p>
      <div class="actions">${button('Confirm Denial', { cls: 'btn btn-danger', name: 'action', value: 'deny' })}${button('Cancel', { type: 'button', cls: 'btn btn-outline', attrs: 'data-close="#confirm-dialog"' })}</div></div></div>` : ''}`;

  let pre = '';
  if (key === 'network') {
    const rows = items('network').map(i => { const [county, type] = i.item.split('|'); const [actual, std] = (i.detail || '|').split('|'); return [county, type, actual, std, badge(i.value)]; });
    pre = h`<h3>Network adequacy report</h3><p class="finding" id="network-finding" data-testid="network-finding">${assess.network.detail}</p>
      ${table(['County', 'Provider type', 'Max travel distance', 'Standard', 'Result'], rows, { id: 'network-report' })}`;
  }
  if (key === 'benefit') {
    pre = h`<h3>Discrimination Analysis</h3><p class="finding" id="flagged-benefit-design" data-testid="flagged-benefit-design">${items('benefit')[0].value}</p>`;
  }
  const form = h`<form method="post" action="/exchange/review/${p.plan_id}/deny" id="denial-form" class="denial-form" novalidate>${pre}${formInner}</form>`;
  if (s.reveal) {
    const label = key === 'benefit' ? 'Discrimination Analysis' : s.reveal;
    return h`${info}${reveal(label, form)}`;
  }
  return h`${info}${form}`;
}

function renderWorkspace(ctx, p, key, values = {}, errs = []) {
  const s = SECTIONS[key];
  const tabs = h`<nav class="tabs" aria-label="Certification review sections" id="review-tabs">${Object.entries(SECTIONS).map(([k, v]) =>
    h`<a href="/exchange/review/${p.plan_id}?section=${k}" id="tab-${k}" data-testid="tab-${slug(v.tab)}" class="tab ${k === key ? 'tab-on' : ''}" ${k === key ? raw('aria-current="page"') : ''}>${v.tab}</a>`)}</nav>`;
  return ctx.render(`${p.plan_id} — ${s.tab}`, h`${breadcrumb([['Dashboard', '/exchange'], [p.plan_id, `/exchange/plans/${p.plan_id}`], [s.tab]])}
    <div class="plan-head" id="plan-header">
      <div><h1 id="page-title">${p.plan_id}: ${p.plan_name}</h1>
      <p class="muted">${p.issuer_name} (HIOS ${p.hios_id}) · ${p.state_name} (${p.exchange_type}) · ${p.metal} ${p.plan_type} · PY ${p.plan_year}</p></div>
      <div class="plan-status">Certification status: <span id="certification-status" data-testid="certification-status">${badge(p.status)}</span></div>
    </div>
    ${tabs}
    <section class="card section" id="section-${key}" data-testid="section-${slug(s.tab)}" aria-labelledby="section-title"><h2 id="section-title">${s.tab}</h2>
      ${sectionBody(p, key, values, errs)}</section>`, { active: '' });
}

getR('/exchange/review/:id', ctx => {
  const p = plan(ctx.params.id);
  if (!p) return ctx.notFound(`No plan found with identifier ${ctx.params.id}.`);
  const key = SECTIONS[ctx.query.section] ? ctx.query.section : 'general';
  return renderWorkspace(ctx, p, key);
});

postR('/exchange/review/:id/deny', ctx => {
  const p = plan(ctx.params.id);
  if (!p) return ctx.notFound(`No plan found with identifier ${ctx.params.id}.`);
  const b = ctx.body; const key = SECTIONS[b.section] ? b.section : 'general'; const s = SECTIONS[key];
  if (s.infoOnly) return redirect(ctx.res, `/exchange/review/${p.plan_id}?section=${key}`);
  const errs = [];
  const cl = s.checklist ? D.all('SELECT * FROM qhp_checklist_items WHERE plan_id = ? AND section = ? ORDER BY id', p.plan_id, s.checklist) : [];
  const marked = cl.map(i => ({ ...i, value: s.checklistOptions.includes(b['item_' + i.id]) ? b['item_' + i.id] : i.value }));

  // Certify (general section only)
  if (key === 'general' && b.action === 'certify') {
    for (const i of marked) D.run('UPDATE qhp_checklist_items SET value = ? WHERE id = ?', i.value, i.id);
    if (marked.some(i => i.value !== 'Compliant')) {
      return renderWorkspace(ctx, plan(p.plan_id), key, b, ['All general certification criteria must be marked Compliant before the plan can be certified.']);
    }
    D.run("UPDATE qhp_certifications SET status = 'Certified', queue = 'active', updated_at = ? WHERE plan_id = ?", D.nowIso(), p.plan_id);
    D.audit('qhp_certification', p.plan_id, 'Certified', 'All general certification criteria compliant', actor(ctx.user));
    ctx.flash('success', `${p.plan_id} certified.`);
    return redirect(ctx.res, `/exchange/plans/${p.plan_id}`);
  }

  let violations = [];
  if (s.checklist) {
    const failed = marked.filter(i => i.value === s.failValue);
    if (!failed.length) errs.push(key === 'ehb' ? 'Mark at least one essential health benefit as Not Covered to deny certification.' : 'Mark at least one criterion as Non-Compliant to deny certification.');
    violations = failed.map(i => (key === 'ehb' ? `Essential Health Benefits: ${i.item} not covered` : `${i.item}: Non-Compliant`));
  }
  if (s.assess) {
    if (!b.assessment) errs.push(`Select a value for ${s.assess.label}.`);
    else if (!s.assess.fail.includes(b.assessment)) errs.push(`${s.assess.label} is "${b.assessment}". Certification can only be denied when the assessment indicates non-compliance.`);
  }
  if (key === 'summary') {
    const failedCrit = D.all('SELECT criterion, status FROM qhp_assessments WHERE plan_id = ?', p.plan_id).filter(a => /failed|missing|flagged/i.test(a.status));
    if (!failedCrit.length) errs.push('No failed criteria to aggregate.');
    if (/^Multiple/.test(b.reason || '') && failedCrit.length < 2) errs.push('Multiple-criteria denial requires at least two failed criteria.');
    violations = failedCrit.map(a => `${CRITERIA_LABELS[a.criterion].replace(' in Benefit Design', '')}: ${a.status}`);
  } else if (!s.checklist) {
    violations = [`${SECTION_VIOLATION[key]}: ${b.assessment || b.reason || 'Non-Compliant'}`];
  }
  const reason = (b.reason || '').trim();
  const notes = (b.notes || '').trim();
  if (!reason) errs.push(`${s.reasonLabel} is required.`);
  if (s.notesLabel && !notes) errs.push(`${s.notesLabel} is required.`);
  if (errs.length) return renderWorkspace(ctx, p, key, b, errs);

  // Persist
  for (const i of marked) D.run('UPDATE qhp_checklist_items SET value = ? WHERE id = ?', i.value, i.id);
  if (s.criterion && s.assess) D.run('UPDATE qhp_assessments SET status = ? WHERE plan_id = ? AND criterion = ?', b.assessment, p.plan_id, s.criterion);
  if (key === 'av') D.run("UPDATE qhp_assessments SET status = 'Failed' WHERE plan_id = ? AND criterion = 'av'", p.plan_id);
  if (key === 'ehb') D.run("UPDATE qhp_assessments SET status = 'Failed' WHERE plan_id = ? AND criterion = 'ehb'", p.plan_id);

  const deniedOn = R.today();
  const deadline = R.addDays(deniedOn, Number(D.param('reconsideration_days', 7)));
  const basis = s.basis;
  const authority = '45 CFR 155.1000(e)';
  const fullReason = reason.includes('155.1000') ? reason : `${reason} (${basis})`;
  const denialNumber = D.nextNumber('DEN', 'qhp_denials', 'denial_number');
  const letter = [
    `DENIAL OF QHP CERTIFICATION — ${denialNumber}`,
    `Date: ${deniedOn}`,
    `To: ${p.issuer_name} (HIOS ${p.hios_id})`,
    `Plan: ${p.plan_id} — ${p.plan_name} (${p.metal} ${p.plan_type}, plan year ${p.plan_year})`,
    '',
    `Pursuant to the Exchange's authority under ${authority}, certification of the above plan as a qualified health plan is DENIED because the plan does not meet the general certification criteria at ${basis}.`,
    '',
    `Basis for denial: ${fullReason}`,
    'Violations:',
    ...violations.map(v => `  - ${v}`),
    notes ? `Reviewer notes: ${notes}` : (key === 'general' ? `Reviewer notes: ${reason}` : ''),
    '',
    `Reconsideration: The issuer may request reconsideration within 7 calendar days (by ${deadline}) and must provide clear and convincing evidence that HHS erred in determining noncompliance with 45 CFR 155.1000(c) (45 CFR 155.1090(a)).`,
  ].filter(x => x !== null).join('\n');

  D.insert('qhp_denials', { denial_number: denialNumber, plan_id: p.plan_id, section: key, denial_reason: fullReason, notes: notes || null,
    regulatory_basis: basis, authority, violations: JSON.stringify(violations), status_after: s.status, denial_letter: letter,
    denied_by: actor(ctx.user), denied_on: deniedOn, reconsideration_deadline: deadline, created_at: D.nowIso() });
  D.run('UPDATE qhp_certifications SET status = ?, updated_at = ? WHERE plan_id = ?', s.status, D.nowIso(), p.plan_id);
  D.audit('qhp_certification', p.plan_id, s.status, `${denialNumber}: ${fullReason}`, actor(ctx.user));
  return redirect(ctx.res, `/exchange/denials/${denialNumber}?new=1`);
});

// ---------------- Denials / records ----------------
getR('/exchange/denials', ctx => ctx.render('Denials', h`<h1 id="page-title">Certification denials</h1>
  ${table(['Denial #', 'Plan', 'Date', 'Status', 'Reason', 'Reconsideration deadline'], D.all('SELECT * FROM qhp_denials ORDER BY id DESC').map(d =>
    [h`<a href="/exchange/denials/${d.denial_number}">${d.denial_number}</a>`, d.plan_id, d.denied_on, badge(d.status_after), d.denial_reason, d.reconsideration_deadline]), { id: 'denials-table', empty: 'No denials have been issued.' })}`, { active: 'denials' }));

getR('/exchange/denials/:num', ctx => {
  const d = D.get('SELECT * FROM qhp_denials WHERE denial_number = ?', ctx.params.num);
  if (!d) return ctx.notFound('Denial not found.');
  const p = plan(d.plan_id); const s = SECTIONS[d.section];
  const v = JSON.parse(d.violations);
  const isNew = ctx.query.new === '1';
  const headline = s.headline;
  const message = d.section === 'benefit'
    ? `Denial workflow activated for ${d.plan_id}. Discrimination violation cited under ${d.regulatory_basis} general certification criteria.`
    : d.section === 'summary'
      ? `Comprehensive denial issued for ${d.plan_id}. ${v.length} violation categories documented under ${d.regulatory_basis}; Exchange authority ${d.authority}.`
      : `Certification for ${d.plan_id} has been denied under ${d.regulatory_basis} general certification criteria. Exchange denial authority: ${d.authority}.`;
  return ctx.render(`Denial ${d.denial_number}`, h`${breadcrumb([['Dashboard', '/exchange'], ['Denials', '/exchange/denials'], [d.denial_number]])}
    ${alertBox('success', headline, h`<p id="denial-confirmation-message" data-testid="denial-confirmation-message">${message}</p>
      <ul id="denial-violations" data-testid="denial-violations">${v.map(x => h`<li>${x}</li>`)}</ul>`, isNew ? 'denial-notification' : 'denial-summary-alert')}
    <h1 id="page-title">Denial ${d.denial_number}</h1>
    <div class="card"><h2>Denial summary</h2>${dl([
      ['Plan', `${d.plan_id} — ${p.plan_name}`], ['Certification status', h`<span id="certification-status" data-testid="certification-status">${badge(p.status)}</span>`],
      ['Status set by this denial', d.status_after], ['Review section', s.tab], ['Denial reason', d.denial_reason], ['Notes', d.notes || '—'],
      ['Regulatory basis', h`<span id="regulatory-basis" data-testid="regulatory-basis">${d.regulatory_basis}</span>`],
      ['Denial authority', h`<span id="denial-authority" data-testid="denial-authority">${d.authority}</span>`],
      ['Violation categories', h`<span id="violation-count">${v.length}</span>`],
      ['Denied by', d.denied_by], ['Denied on', d.denied_on], ['Reconsideration deadline', h`<span id="reconsideration-deadline">${d.reconsideration_deadline}</span>`]], 'denial-details')}
    <div class="actions">${linkBtn('View Certification Record', `/exchange/plans/${d.plan_id}`)}${linkBtn('Request Reconsideration', `/exchange/reconsiderations/new?denial=${d.denial_number}`, { cls: 'btn btn-outline' })}</div></div>
    <div class="card"><h2>Denial letter</h2><pre class="letter" id="denial-letter" data-testid="denial-letter">${d.denial_letter}</pre></div>`, { active: 'denials' });
});

getR('/exchange/plans', ctx => ctx.render('All QHP Records', h`<h1 id="page-title">All QHP certification records</h1>${planTable(plansWhere(''), { radio: false, id: 'all-plans' })}`, { active: 'plans' }));

getR('/exchange/plans/:id', ctx => {
  const p = plan(ctx.params.id);
  if (!p) return ctx.notFound(`No plan found with identifier ${ctx.params.id}.`);
  const assess = D.all('SELECT * FROM qhp_assessments WHERE plan_id = ?', p.plan_id);
  const denials = D.all('SELECT * FROM qhp_denials WHERE plan_id = ? ORDER BY id DESC', p.plan_id);
  const recons = D.all('SELECT * FROM qhp_reconsiderations WHERE plan_id = ? ORDER BY id DESC', p.plan_id);
  const log = D.all("SELECT * FROM audit_log WHERE entity = 'qhp_certification' AND entity_id = ? ORDER BY id DESC LIMIT 25", p.plan_id);
  return ctx.render(`${p.plan_id} record`, h`${breadcrumb([['Dashboard', '/exchange'], ['All QHP Records', '/exchange/plans'], [p.plan_id]])}
    <h1 id="page-title">Certification record: ${p.plan_id}</h1>
    <div class="card">${dl([['Plan name', p.plan_name], ['Issuer', `${p.issuer_name} (HIOS ${p.hios_id})`], ['State / Exchange', `${p.state_name} (${p.exchange_type})`],
      ['Metal / type', `${p.metal} ${p.plan_type}`], ['Plan year', p.plan_year], ['Certification status', h`<span id="certification-status" data-testid="certification-status">${badge(p.status)}</span>`],
      ['Current denial reason', h`<span id="record-denial-reason" data-testid="record-denial-reason">${denials[0] ? denials[0].denial_reason : '—'}</span>`],
      ['Regulatory basis', h`<span id="record-regulatory-basis" data-testid="record-regulatory-basis">${denials[0] ? `${denials[0].regulatory_basis}; authority ${denials[0].authority}` : '—'}</span>`]], 'record-details')}
      <div class="actions">${linkBtn('Open Certification Review', `/exchange/review/${p.plan_id}?section=general`)}</div></div>
    <div class="card"><h2>Criteria assessments</h2>${table(['Criterion', 'Status', 'Detail'], assess.map(a => [CRITERIA_LABELS[a.criterion], badge(a.status), a.detail]), { id: 'assessments-table' })}</div>
    <div class="card"><h2>Denial history</h2>${table(['Denial #', 'Date', 'Status', 'Denial reason', 'Regulatory basis'], denials.map(d => [h`<a href="/exchange/denials/${d.denial_number}">${d.denial_number}</a>`, d.denied_on, d.status_after, d.denial_reason, `${d.regulatory_basis}; ${d.authority}`]), { id: 'denial-history', empty: 'No denials.' })}</div>
    <div class="card"><h2>Reconsiderations</h2>${table(['Request #', 'Received', 'Outcome', 'Reason'], recons.map(r => [r.request_number, r.received_on, badge(r.outcome), r.outcome_reason]), { id: 'reconsideration-history', empty: 'No reconsideration requests.' })}</div>
    <div class="card"><h2>Audit trail</h2>${table(['When', 'Action', 'Detail', 'By'], log.map(l => [l.at.replace('T', ' ').slice(0, 19), l.action, l.detail || '', l.actor]), { id: 'audit-trail' })}</div>`, { active: 'plans' });
});

// ---------------- Reconsideration (ACA:16 / ACA:43) ----------------
getR('/exchange/reconsiderations', ctx => ctx.render('Reconsiderations', h`<h1 id="page-title">Certification reconsiderations</h1>
  <p class="lead">Issuers denied FFE certification may request reconsideration within 7 calendar days with clear and convincing evidence of HHS error (45 CFR 155.1090(a)).</p>
  ${table(['Request #', 'Denial', 'Plan', 'Received', 'Evidence', 'Outcome'], D.all('SELECT r.*, d.denial_number FROM qhp_reconsiderations r JOIN qhp_denials d ON d.id = r.denial_id ORDER BY r.id DESC').map(r =>
    [r.request_number, r.denial_number, r.plan_id, r.received_on, r.evidence_standard, badge(r.outcome)]), { id: 'reconsiderations-table', empty: 'No reconsideration requests.' })}`, { active: 'reconsiderations' }));

function reconForm(ctx, d, values = {}, errs = []) {
  return ctx.render('Request Reconsideration', h`${breadcrumb([['Dashboard', '/exchange'], ['Denials', '/exchange/denials'], [d.denial_number, `/exchange/denials/${d.denial_number}`], ['Request Reconsideration']])}
    <h1 id="page-title">Request reconsideration — ${d.plan_id}</h1>
    <p class="lead">Denied ${d.denied_on}. Requests must be received by <strong id="deadline">${d.reconsideration_deadline}</strong> (7 calendar days).</p>
    <p id="reconsideration-instructions">Your request must include a statement or documents that give <strong>clear and convincing evidence</strong> that HHS was wrong to find the plan does not meet the general certification criteria in 45 CFR 155.1000(c) (45 CFR 155.1090(a)(2)). Requests without that evidence are incomplete.</p>${errors(errs)}
    <form method="post" action="/exchange/reconsiderations" class="card narrow" id="reconsideration-form">
      <input type="hidden" name="denial" value="${d.denial_number}">
      ${field({ name: 'receivedOn', id: 'received-on', type: 'date', label: 'Request received date', value: values.receivedOn || R.today(), required: true })}
      ${select({ name: 'evidenceStandard', id: 'evidence-standard', label: 'Evidence standard met', options: R.EVIDENCE_OPTIONS(), placeholder: '-- Select --', value: values.evidenceStandard, required: true })}
      ${textarea({ name: 'evidenceSummary', id: 'evidence-summary', label: 'Evidence summary', value: values.evidenceSummary || '', required: true })}
      <div class="actions">${button('Submit Reconsideration Request')}</div></form>`, { active: 'reconsiderations' });
}
getR('/exchange/reconsiderations/new', ctx => {
  const d = D.get('SELECT * FROM qhp_denials WHERE denial_number = ?', ctx.query.denial || '');
  if (!d) return ctx.notFound('Denial not found.');
  return reconForm(ctx, d);
});
postR('/exchange/reconsiderations', ctx => {
  const b = ctx.body;
  const d = D.get('SELECT * FROM qhp_denials WHERE denial_number = ?', b.denial || '');
  if (!d) return ctx.notFound('Denial not found.');
  const errs = [];
  if (!b.evidenceStandard) errs.push('Select the evidence standard.');
  if (!(b.evidenceSummary || '').trim()) errs.push('Incomplete request: provide a statement or documents addressing the 45 CFR 155.1000(c) criteria (clear and convincing evidence, 45 CFR 155.1090(a)(2)).');
  let r;
  try { if (!errs.length) r = R.rules.reconsideration(d.denied_on, b.receivedOn, b.evidenceStandard); } catch (e) { errs.push(e.message); }
  if (errs.length) return reconForm(ctx, d, b, errs);
  const num = D.nextNumber('REC', 'qhp_reconsiderations', 'request_number');
  D.insert('qhp_reconsiderations', { request_number: num, denial_id: d.id, plan_id: d.plan_id, received_on: b.receivedOn, evidence_standard: b.evidenceStandard,
    evidence_summary: b.evidenceSummary.trim(), outcome: r.outcome, outcome_reason: r.reason, created_at: D.nowIso() });
  if (r.outcome === 'Reconsideration Granted') D.run("UPDATE qhp_certifications SET status = 'Pending Review - Reconsideration Granted', updated_at = ? WHERE plan_id = ?", D.nowIso(), d.plan_id);
  D.audit('qhp_certification', d.plan_id, `Reconsideration: ${r.outcome}`, `${num}: ${r.reason}`, actor(ctx.user));
  ctx.flash(r.outcome === 'Reconsideration Granted' ? 'success' : 'warning', `${num}: ${r.outcome}. ${r.reason}`);
  return redirect(ctx.res, `/exchange/plans/${d.plan_id}`);
});

// ---------------- Agents & brokers (ACA:9/10/36/37) ----------------
getR('/exchange/agents', ctx => {
  const agents = D.all('SELECT a.*, g.name AS agency FROM agents a LEFT JOIN agencies g ON g.id = a.agency_id ORDER BY a.npn');
  const agencies = D.all('SELECT * FROM agencies ORDER BY name');
  const actions = D.all('SELECT c.*, g.name agency, a.first_name || \' \' || a.last_name agent FROM compliance_actions c LEFT JOIN agencies g ON g.id = c.agency_id LEFT JOIN agents a ON a.id = c.agent_id ORDER BY c.id DESC');
  return ctx.render('Agents & Brokers', h`<h1 id="page-title">Agents & brokers</h1>
    <div class="card"><h2>Agents and brokers</h2>${table(['NPN', 'Name', 'Agency', 'Lead agent', 'State', 'Status'], agents.map(a => [h`<a href="/exchange/agents/${a.npn}" id="agent-${a.npn}">${a.npn}</a>`, `${a.first_name} ${a.last_name}`, a.agency || '—', a.is_lead_agent ? 'Yes' : 'No', a.state, badge(a.status)]), { id: 'agents-table' })}</div>
    <div class="card"><h2>Agencies</h2>${table(['Agency NPN', 'Agency', 'State', ''], agencies.map(g => [g.agency_npn, g.name, g.state, h`<a href="/exchange/agencies/${g.id}" id="agency-${g.id}">Open agency</a>`]), { id: 'agencies-table' })}</div>
    <div class="card"><h2>Compliance actions</h2>${table(['Action #', 'Type', 'Agency', 'Agent', 'Basis', 'Outcome', 'Date'], actions.map(c => [c.action_number, c.action_type, c.agency || '—', c.agent || '—', c.basis, badge(c.outcome), c.created_at.slice(0, 10)]), { id: 'compliance-actions', empty: 'No compliance actions.' })}</div>`, { active: 'agents' });
});
getR('/exchange/agents/:npn', ctx => {
  const a = D.get('SELECT a.*, g.name AS agency FROM agents a LEFT JOIN agencies g ON g.id = a.agency_id WHERE npn = ?', ctx.params.npn);
  if (!a) return ctx.notFound('Agent not found.');
  const suspended = a.status.startsWith('Suspended');
  return ctx.render(`Agent ${a.npn}`, h`${breadcrumb([['Agents & Brokers', '/exchange/agents'], [a.npn]])}
    <h1 id="page-title">${a.first_name} ${a.last_name} (NPN ${a.npn})</h1>
    <div class="card">${dl([['Agency', a.agency || 'Independent'], ['Lead agent', a.is_lead_agent ? 'Yes' : 'No'], ['State', a.state], ['Status', h`<span id="agent-status">${badge(a.status)}</span>`],
      ['Suspension ground', a.suspension_ground || '—'], ['Suspended on', a.suspended_on || '—']], 'agent-details')}</div>
    ${a.status === 'Terminated for Cause' ? alertBox('error', 'Agreement terminated for cause', 'Noncompliance under 45 CFR 155.220(g)(1), supported by a preponderance of the evidence (45 CFR 155.220(g)(2)).', 'termination-notice')
      : suspended ? h`<form method="post" action="/exchange/agents/${a.npn}/reinstate" class="card narrow">${alertBox('warning', 'Exchange system access suspended', 'The agent cannot submit Exchange transactions or be selected as assisting agent. Consumers can still enroll through the Marketplace Call Center or consumer website.', 'suspension-notice')}
        ${textarea({ name: 'resolution', id: 'suspension-resolution', label: 'How the incident, breach or noncompliance was remedied or mitigated (required to lift a (k)(3) suspension)', rows: 3 })}
        <div class="actions">${button('Reinstate Access')}</div></form>`
      : h`<form method="post" action="/exchange/agents/${a.npn}/suspend" class="card narrow" id="suspend-form"><h2>Immediate suspension — 45 CFR 155.220(k)(3)</h2>
        ${select({ name: 'ground', id: 'suspension-ground', label: 'Ground for suspension', options: R.SUSPENSION_GROUNDS, placeholder: '-- Select ground --', required: true })}
        ${textarea({ name: 'notes', id: 'suspension-notes', label: 'Notes', rows: 3 })}
        <div class="actions">${button('Suspend Immediately', { cls: 'btn btn-danger' })}</div></form>
      <form method="post" action="/exchange/agents/${a.npn}/terminate" class="card narrow" id="terminate-form"><h2>Termination for cause — 45 CFR 155.220(g)</h2>
        ${textarea({ name: 'evidentiaryBasis', id: 'evidentiary-basis', label: 'Evidentiary basis for the noncompliance finding', rows: 3 })}
        <div class="field check"><input type="checkbox" name="preponderance" value="1" id="preponderance-confirmed"><label for="preponderance-confirmed">The noncompliance finding under § 155.220(g)(1) is supported by a preponderance of the evidence</label></div>
        <div class="actions">${button('Terminate for Cause', { cls: 'btn btn-danger', id: 'btn-terminate-for-cause' })}</div></form>`}
    <div class="card"><h2>Enforcement history</h2>${table(['Action #', 'Type', 'Authority', 'Basis', 'Evidence', 'Outcome', 'Date', 'Lifted'], D.all('SELECT * FROM compliance_actions WHERE agent_id = ? ORDER BY id DESC', a.id).map(c => [c.action_number, c.action_type, c.authority || '—', c.basis, c.evidentiary_basis ? `${c.evidence_standard}: ${c.evidentiary_basis}` : '—', badge(c.outcome), c.created_at.slice(0, 10), c.resolved_on ? `${c.resolved_on} — ${c.resolution_basis}` : '—']), { id: 'agent-actions', empty: 'No enforcement actions.' })}</div>`, { active: 'agents' });
});
postR('/exchange/agents/:npn/suspend', ctx => {
  const a = D.get('SELECT * FROM agents WHERE npn = ?', ctx.params.npn);
  if (!a) return ctx.notFound('Agent not found.');
  const g = R.rules.agentSuspensionGround(ctx.body.ground);
  if (!g.immediate) { ctx.flash('error', g.reason); return redirect(ctx.res, `/exchange/agents/${a.npn}`); }
  const label = R.SUSPENSION_GROUNDS.find(x => x[0] === ctx.body.ground)[1];
  D.run("UPDATE agents SET status = 'Suspended - Exchange Systems', suspension_ground = ?, suspended_on = ? WHERE id = ?", label, R.today(), a.id);
  D.insert('compliance_actions', { action_number: D.nextNumber('CA', 'compliance_actions', 'action_number'), action_type: 'Immediate system suspension', agent_id: a.id, agency_id: a.agency_id,
    basis: label, notes: ctx.body.notes || null, outcome: 'Suspended', created_by: actor(ctx.user), created_at: D.nowIso(), authority: '45 CFR 155.220(k)(3)' });
  D.audit('agent', a.npn, 'Suspended', label, actor(ctx.user));
  ctx.flash('success', `Agent ${a.npn} suspended from Exchange systems effective immediately.`);
  return redirect(ctx.res, `/exchange/agents/${a.npn}`);
});
postR('/exchange/agents/:npn/reinstate', ctx => {
  const a = D.get('SELECT * FROM agents WHERE npn = ?', ctx.params.npn);
  if (!a) return ctx.notFound('Agent not found.');
  const resolution = String(ctx.body.resolution || '').trim();
  if (!resolution) { ctx.flash('error', 'Describe how the circumstances were remedied or sufficiently mitigated before lifting the suspension (45 CFR 155.220(k)(3)).'); return redirect(ctx.res, `/exchange/agents/${a.npn}`); }
  D.run("UPDATE compliance_actions SET resolved_on = ?, resolution_basis = ?, outcome = 'Suspension Lifted' WHERE agent_id = ? AND action_type = 'Immediate system suspension' AND resolved_on IS NULL", R.today(), resolution, a.id);
  D.run("UPDATE agents SET status = 'Active', suspension_ground = NULL, suspended_on = NULL WHERE id = ?", a.id);
  D.audit('agent', a.npn, 'Reinstated', resolution, actor(ctx.user));
  ctx.flash('success', `Agent ${a.npn} reinstated.`);
  return redirect(ctx.res, `/exchange/agents/${a.npn}`);
});
const AGENCY_BASES = ['Leadership direction of misconduct', 'Oversight or supervision failure', 'Endorsement of noncompliant practices', 'Involvement in misconduct', 'Agency NPN used for noncompliant enrollments'];
getR('/exchange/agencies/:id', ctx => {
  const g = D.get('SELECT * FROM agencies WHERE id = ?', Number(ctx.params.id));
  if (!g) return ctx.notFound('Agency not found.');
  const agents = D.all('SELECT * FROM agents WHERE agency_id = ? ORDER BY is_lead_agent DESC, npn', g.id);
  return ctx.render(g.name, h`${breadcrumb([['Agents & Brokers', '/exchange/agents'], [g.name]])}<h1 id="page-title">${g.name}</h1>
    <div class="card">${table(['NPN', 'Agent', 'Lead agent', 'Status'], agents.map(a => [a.npn, `${a.first_name} ${a.last_name}`, a.is_lead_agent ? 'Yes' : 'No', badge(a.status)]), { id: 'agency-agents' })}</div>
    <form method="post" action="/exchange/agencies/${g.id}/review" class="card narrow" id="agency-review-form"><h2>Agency-level compliance review (through lead agent)</h2>
      <p class="muted">HHS may review and take enforcement action against an agency through its responsible lead agent(s) when misconduct is at the agency level.</p>
      ${select({ name: 'basis', id: 'agency-review-basis', label: 'Basis for agency-level review', options: AGENCY_BASES, placeholder: '-- Select basis --', required: true })}
      ${select({ name: 'leadAgent', id: 'lead-agent', label: 'Responsible lead agent', options: agents.filter(a => a.is_lead_agent).map(a => [a.npn, `${a.first_name} ${a.last_name} (${a.npn})`]), placeholder: '-- Select lead agent --', required: true })}
      ${textarea({ name: 'notes', id: 'agency-review-notes', label: 'Notes', rows: 3 })}
      <div class="actions">${button('Open Agency Compliance Review')}</div></form>`, { active: 'agents' });
});
postR('/exchange/agencies/:id/review', ctx => {
  const g = D.get('SELECT * FROM agencies WHERE id = ?', Number(ctx.params.id));
  if (!g) return ctx.notFound('Agency not found.');
  const lead = D.get('SELECT * FROM agents WHERE npn = ? AND agency_id = ? AND is_lead_agent = 1', ctx.body.leadAgent || '', g.id);
  if (!AGENCY_BASES.includes(ctx.body.basis) || !lead) { ctx.flash('error', 'Select a basis and a responsible lead agent of this agency.'); return redirect(ctx.res, `/exchange/agencies/${g.id}`); }
  const num = D.nextNumber('CA', 'compliance_actions', 'action_number');
  D.insert('compliance_actions', { action_number: num, action_type: 'Agency-level compliance review via lead agent', agency_id: g.id, agent_id: lead.id, basis: ctx.body.basis,
    notes: ctx.body.notes || null, outcome: 'Under Review', created_by: actor(ctx.user), created_at: D.nowIso() });
  D.audit('agency', g.agency_npn, 'Agency compliance review opened', `${num} via lead agent ${lead.npn}`, actor(ctx.user));
  ctx.flash('success', `${num}: agency-level compliance review opened for ${g.name} through lead agent ${lead.first_name} ${lead.last_name}.`);
  return redirect(ctx.res, '/exchange/agents');
});

// ---------------- Appeals (exchange view) ----------------
getR('/exchange/appeals', ctx => ctx.render('Eligibility Appeals', h`<h1 id="page-title">Eligibility appeals</h1>
  ${table(['Appeal #', 'Filed', 'Filer role', 'Filer', 'Appellant', 'Entity', 'Status'], D.all('SELECT * FROM appeals ORDER BY id DESC').map(a => [a.appeal_number, a.created_at.slice(0, 10), a.filer_role, a.filer_name, a.appellant_name, a.appeals_entity, badge(a.status)]), { id: 'appeals-table', empty: 'No appeals filed.' })}`, { active: 'appeals' }));

// ---------------- FTR notices (ACA:12/38) ----------------
getR('/exchange/notices', ctx => {
  const cases = D.all('SELECT * FROM ftr_cases ORDER BY id');
  const notices = D.all('SELECT * FROM notices ORDER BY id DESC');
  return ctx.render('FTR Notices', h`<h1 id="page-title">Failure to file and reconcile (FTR)</h1>
    <div class="card"><h2>FTR cases</h2>${table(['Tax filer', 'Application', 'Consecutive FTR years', 'Last FTR tax year', 'Channel', 'APTC status'], cases.map(c => [c.tax_filer_name, c.application_number || '—', c.consecutive_ftr_years, c.last_ftr_tax_year, c.notice_channel, badge(c.aptc_status)]), { id: 'ftr-cases' })}
      <form method="post" action="/exchange/notices/generate">${select({ name: 'planYear', id: 'ftr-plan-year', label: 'Plan year', options: ['2025', '2026', '2027'], value: D.param('coverage_year', '2026') })}<div class="actions">${button('Generate FTR Notices')}</div></form></div>
    <div class="card"><h2>Issued notices</h2>${table(['Notice #', 'Recipient', 'Type', 'Channel', 'Contains FTI', 'Text'], notices.map(n => [n.notice_number, n.recipient, n.notice_type, n.channel, n.contains_fti ? 'Yes' : 'No', n.body]), { id: 'notices-table', empty: 'No notices issued.' })}</div>`, { active: 'notices' });
});
postR('/exchange/notices/generate', ctx => {
  let n = 0;
  const planYear = Number(ctx.body.planYear || D.param('coverage_year', 2026));
  for (const c of D.all('SELECT * FROM ftr_cases')) {
    const r = BCA.rules.ftrEligibility({ planYear, failedYears: c.consecutive_ftr_years, channel: c.notice_channel, name: c.tax_filer_name });   // 45 CFR 155.305(f)(4) as amended
    if (!r.notice) continue;
    if (D.get('SELECT 1 x FROM notices WHERE ftr_case_id = ? AND notice_type = ?', c.id, r.notice)) continue;
    D.insert('notices', { notice_number: D.nextNumber('NTC', 'notices', 'notice_number'), user_id: c.user_id, ftr_case_id: c.id, recipient: c.tax_filer_name,
      notice_type: r.notice, channel: c.notice_channel, contains_fti: r.fti ? 1 : 0, body: r.body, created_at: D.nowIso() });
    D.run('UPDATE ftr_cases SET aptc_status = ? WHERE id = ?', r.aptcEligible ? 'Eligible - First-Year Notice Issued' : `APTC Denied - PY${planYear} (${r.rule})`, c.id);
    n++;
  }
  ctx.flash('success', `${n} FTR notice(s) generated.`);
  return redirect(ctx.res, '/exchange/notices');
});

// ---------------- Data inaccuracy (ACA:13/39) ----------------
getR('/exchange/data-inaccuracy', ctx => {
  const rows = D.all('SELECT d.*, i.name issuer FROM data_inaccuracy_reports d JOIN issuers i ON i.id = d.issuer_id ORDER BY d.id DESC');
  return ctx.render('Data Inaccuracy Reports', h`<h1 id="page-title">Issuer data inaccuracy reports</h1>
    <p class="lead">State Exchanges must review, resolve, and report the resolution to HHS within 60 calendar days of receiving a complete report (45 CFR 155.400(d)(1)).</p>
    <div class="card">${table(['Report #', 'Issuer', 'State', 'Received', 'Complete on', 'Deadline', 'Status', ''], rows.map(r => [r.report_number, r.issuer, r.state, r.received_on, r.completed_on || '—', r.resolution_deadline || '—', badge(BCA.rules.dataInaccuracyOverdue(r.resolution_deadline, R.today(), r.submitted_to_hhs_on).overdue ? 'Overdue - Flagged for HHS Review' : r.status), h`<a href="/exchange/data-inaccuracy/${r.report_number}" id="open-${r.report_number}">Open</a>`]), { id: 'dir-table' })}
      <div class="actions">${linkBtn('New Report', '/exchange/data-inaccuracy/new', { cls: 'btn btn-outline' })}</div></div>`, { active: 'data-inaccuracy' });
});
getR('/exchange/data-inaccuracy/new', ctx => ctx.render('New Data Inaccuracy Report', h`<h1 id="page-title">New data inaccuracy report</h1>
  <form method="post" action="/exchange/data-inaccuracy" class="card narrow" id="dir-new-form">
    ${select({ name: 'issuer', id: 'dir-issuer', label: 'Issuer', options: D.all('SELECT id, name, state FROM issuers ORDER BY name').map(i => [String(i.id), `${i.name} (${i.state})`]), required: true })}
    ${field({ name: 'receivedOn', id: 'dir-received-on', type: 'date', label: 'Received date', value: R.today(), required: true })}
    ${select({ name: 'complete', id: 'dir-complete', label: 'Report complete?', options: [['0', 'No — awaiting complete submission'], ['1', 'Yes — complete on receipt']] })}
    ${textarea({ name: 'description', id: 'dir-description', label: 'Description of inaccuracy', required: true })}
    <div class="actions">${button('Create Report')}</div></form>`, { active: 'data-inaccuracy' }));
postR('/exchange/data-inaccuracy', ctx => {
  const b = ctx.body; const iss = D.get('SELECT * FROM issuers WHERE id = ?', Number(b.issuer));
  if (!iss || !(b.description || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(b.receivedOn || '')) { ctx.flash('error', 'Issuer, received date and description are required.'); return redirect(ctx.res, '/exchange/data-inaccuracy/new'); }
  const complete = b.complete === '1';
  const num = D.nextNumber('DIR', 'data_inaccuracy_reports', 'report_number');
  D.insert('data_inaccuracy_reports', { report_number: num, issuer_id: iss.id, state: iss.state, description: b.description.trim(), received_on: b.receivedOn, complete: complete ? 1 : 0,
    completed_on: complete ? b.receivedOn : null, resolution_deadline: complete ? R.rules.dataInaccuracyDeadline(b.receivedOn).deadline : null, status: complete ? 'Open' : 'Awaiting Complete Submission' });
  return redirect(ctx.res, `/exchange/data-inaccuracy/${num}`);
});
getR('/exchange/data-inaccuracy/:num', ctx => {
  const r = D.get('SELECT d.*, i.name issuer FROM data_inaccuracy_reports d JOIN issuers i ON i.id = d.issuer_id WHERE report_number = ?', ctx.params.num);
  if (!r) return ctx.notFound('Report not found.');
  return ctx.render(r.report_number, h`${breadcrumb([['Data Inaccuracy Reports', '/exchange/data-inaccuracy'], [r.report_number]])}<h1 id="page-title">${r.report_number}</h1>
    <div class="card">${dl([['Issuer', r.issuer], ['State', r.state], ['Description', r.description], ['Received', r.received_on], ['Complete', r.complete ? `Yes (${r.completed_on})` : 'No'],
      ['Resolution deadline', h`<span id="resolution-deadline">${r.resolution_deadline || 'Starts when a complete report is received'}</span>`], ['Status', h`<span id="dir-status">${badge(BCA.rules.dataInaccuracyOverdue(r.resolution_deadline, R.today(), r.submitted_to_hhs_on).overdue ? 'Overdue - Flagged for HHS Review' : r.status)}</span>`],
      ['Resolution', r.resolution || '—'], ['Submitted to HHS', r.submitted_to_hhs_on || '—']], 'dir-details')}</div>
    ${!r.complete ? h`<form method="post" action="/exchange/data-inaccuracy/${r.report_number}/complete" class="card narrow" id="dir-complete-form">
        ${field({ name: 'completedOn', id: 'completed-on', type: 'date', label: 'Complete report received date', value: R.today(), required: true })}
        <div class="actions">${button('Mark Report Complete')}</div></form>` : ''}
    ${r.complete && !r.submitted_to_hhs_on ? h`<form method="post" action="/exchange/data-inaccuracy/${r.report_number}/resolve" class="card narrow" id="dir-resolve-form">
        ${field({ name: 'resolvedOn', id: 'resolved-on', type: 'date', label: 'Resolution date', value: R.today(), required: true })}
        ${textarea({ name: 'resolution', id: 'resolution-description', label: 'Resolution description (HHS required format)', required: true })}
        <div class="actions">${button('Submit Resolution to HHS')}</div></form>` : ''}`, { active: 'data-inaccuracy' });
});
postR('/exchange/data-inaccuracy/:num/complete', ctx => {
  const r = D.get('SELECT * FROM data_inaccuracy_reports WHERE report_number = ?', ctx.params.num);
  if (!r) return ctx.notFound('Report not found.');
  try {
    const { deadline } = R.rules.dataInaccuracyDeadline(ctx.body.completedOn);
    D.run("UPDATE data_inaccuracy_reports SET complete = 1, completed_on = ?, resolution_deadline = ?, status = 'Open' WHERE id = ?", ctx.body.completedOn, deadline, r.id);
  } catch (e) { ctx.flash('error', e.message); }
  return redirect(ctx.res, `/exchange/data-inaccuracy/${r.report_number}`);
});
postR('/exchange/data-inaccuracy/:num/resolve', ctx => {
  const r = D.get('SELECT * FROM data_inaccuracy_reports WHERE report_number = ?', ctx.params.num);
  if (!r) return ctx.notFound('Report not found.');
  const on = ctx.body.resolvedOn;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on || '') || !(ctx.body.resolution || '').trim()) { ctx.flash('error', 'Resolution date and description are required.'); return redirect(ctx.res, `/exchange/data-inaccuracy/${r.report_number}`); }
  const late = on > r.resolution_deadline;
  D.run('UPDATE data_inaccuracy_reports SET resolution = ?, resolved_on = ?, submitted_to_hhs_on = ?, status = ? WHERE id = ?', ctx.body.resolution.trim(), on, on,
    late ? 'Resolved - Reported to HHS (Late)' : 'Resolved - Reported to HHS', r.id);
  ctx.flash(late ? 'warning' : 'success', late ? `Resolution submitted after the ${r.resolution_deadline} deadline.` : 'Resolution submitted to HHS within 60 calendar days.');
  return redirect(ctx.res, `/exchange/data-inaccuracy/${r.report_number}`);
});

// ---------------- QIS public report (ACA:18) ----------------
function qisReport() {
  const rows = D.all("SELECT focus_area, COUNT(*) submissions, SUM(target_met) met FROM qis_submissions WHERE plan_year = 2025 AND exchange_type = 'FFE' GROUP BY focus_area ORDER BY focus_area");
  const excluded = D.get("SELECT COUNT(*) n FROM qis_submissions WHERE plan_year = 2025 AND exchange_type <> 'FFE'").n;
  return { planYear: 2025, publishedFrom: '2026-01-01', rows: rows.map(r => ({ focusArea: r.focus_area, submissions: r.submissions, targetMetPercent: Math.round((r.met / r.submissions) * 100) })), excludedNonFfeSubmissions: excluded };
}
getR('/exchange/qis-report', ctx => {
  const r = qisReport();
  return ctx.render('QIS Public Report', h`<h1 id="page-title">Quality Improvement Strategy — public summary (PY ${r.planYear})</h1>
    <p class="lead">Aggregated, de-identified summary of FFE issuer QIS submissions. State Exchange and SBE-FP data are excluded. Published annually beginning ${r.publishedFrom}.</p>
    <div class="card">${table(['QIS focus area', 'FFE submissions', 'Targets met'], r.rows.map(x => [x.focusArea, x.submissions, `${x.targetMetPercent}%`]), { id: 'qis-report' })}
    <p class="muted" id="qis-excluded">${r.excludedNonFfeSubmissions} SBE / SBE-FP submission(s) excluded. No issuer names are published.</p></div>`, { active: 'qis-report' });
});

// ---------------- Enrollments & payments ----------------
getR('/exchange/enrollments', ctx => ctx.render('Enrollments & Payments', h`<h1 id="page-title">Enrollments & premium payments</h1>
  <div class="card"><h2>Enrollments</h2>${table(['Enrollment #', 'Application', 'Plan', 'Gross', 'APTC', 'Net', 'Status', 'Effective'], D.all('SELECT e.*, a.app_number FROM enrollments e JOIN applications a ON a.id = e.application_id ORDER BY e.id DESC').map(e => [e.enrollment_number, e.app_number, e.plan_id, R.money(e.gross_premium), R.money(e.aptc_applied), R.money(e.net_premium), badge(e.status), e.effective_date]), { id: 'enrollments-table', empty: 'No enrollments yet.' })}</div>
  <div class="card"><h2>Premium payments</h2>${table(['Payment #', 'Enrollment', 'Type', 'Due', 'Paid', 'Policy', 'Result'], D.all('SELECT p.*, e.enrollment_number FROM premium_payments p JOIN enrollments e ON e.id = p.enrollment_id ORDER BY p.id DESC').map(p => [p.payment_number, p.enrollment_number, p.payment_type, R.money(p.amount_due), R.money(p.amount_paid), p.policy_applied || '—', p.result]), { id: 'payments-table', empty: 'No payments yet.' })}</div>`, { active: 'enrollments' }));

// ---------------- Rule tools ----------------
getR('/exchange/tools', ctx => {
  const groups = {};
  R.TOOLS.forEach(t => (groups[t.group] ||= []).push(t));
  return ctx.render('Regulatory Rule Tools', h`<h1 id="page-title">Regulatory rule tools</h1>
    <p class="lead">Each tool implements one or more Test Manager requirements. The same logic is available at <code>/api/rules/&lt;tool-id&gt;</code>.</p>
    ${Object.entries(groups).map(([g, ts]) => h`<div class="card"><h2>${g}</h2>${table(['Tool', 'Requirements', 'Citation'], ts.map(t => [h`<a href="/exchange/tools/${t.id}" id="tool-${t.id}" data-testid="tool-${t.id}">${t.title}</a>`, t.reqs.join(', '), t.cite]))}</div>`)}`, { active: 'tools' });
});
function toolPage(ctx, t, values, result, error) {
  return ctx.render(t.title, h`${breadcrumb([['Rule Tools', '/exchange/tools'], [t.title]])}
    <h1 id="page-title">${t.title}</h1><p class="muted">Requirements: <span id="tool-reqs">${t.reqs.join(', ')}</span> · ${t.cite}</p>
    <form method="post" action="/exchange/tools/${t.id}" class="card narrow" id="tool-form">
      ${t.inputs.map(i => (i.type === 'select'
        ? select({ name: i.name, id: i.name, label: i.label, options: R.resolveOptions(i), value: values[i.name] ?? '' })
        : field({ name: i.name, id: i.name, label: i.label, type: i.type === 'number' ? 'text' : i.type, value: values[i.name] ?? i.value ?? '', placeholder: i.placeholder || '' })))}
      <div class="actions">${button('Calculate', { id: 'btn-calculate' })}</div></form>
    ${error ? alertBox('error', 'Unable to calculate', error, 'tool-error') : ''}
    ${result ? h`<div class="card" id="tool-result" data-testid="tool-result"><h2>Result</h2><p class="outcome" id="tool-outcome" data-testid="tool-outcome">${result.outcome}</p>${dl(result.rows, 'tool-result-details')}</div>` : ''}`, { active: 'tools' });
}
getR('/exchange/tools/:id', ctx => {
  const t = R.TOOLS.find(x => x.id === ctx.params.id);
  if (!t) return ctx.notFound('Tool not found.');
  return toolPage(ctx, t, {}, null, null);
});
postR('/exchange/tools/:id', ctx => {
  const t = R.TOOLS.find(x => x.id === ctx.params.id);
  if (!t) return ctx.notFound('Tool not found.');
  try { return toolPage(ctx, t, ctx.body, t.run(ctx.body), null); } catch (e) { if (!(e instanceof R.RuleError)) throw e; return toolPage(ctx, t, ctx.body, null, e.message); }
});

// ---------------- Parameters & admin ----------------
getR('/exchange/parameters', ctx => ctx.render('Regulatory Parameters', h`<h1 id="page-title">Regulatory parameters</h1>
  <p class="lead">Values used by the rules engine. Edit to drive data-dependent tests; Reset Test Data restores defaults.</p>
  <div class="card">${table(['Key', 'Value', 'Description', 'Citation'], D.all('SELECT * FROM reg_parameters ORDER BY key').map(p => [h`<code>${p.key}</code>`,
    h`<form method="post" action="/exchange/parameters" class="inline-form"><input type="hidden" name="key" value="${p.key}"><input name="value" id="param-${p.key}" data-testid="param-${p.key}" value="${p.value}" aria-label="${p.key}"> <button class="btn btn-small" id="save-${p.key}" type="submit">Save</button></form>`,
    p.description, p.citation || '']), { id: 'parameters-table' })}</div>`, { active: 'parameters' }));
postR('/exchange/parameters', ctx => {
  const p = D.get('SELECT * FROM reg_parameters WHERE key = ?', ctx.body.key || '');
  const v = String(ctx.body.value ?? '').trim();
  const m = p && /^oep_(start|end)_(\d{4})$/.exec(p.key);
  if (m) {
    const y = Number(m[2]); const start = m[1] === 'start' ? v : D.param(`oep_start_${y}`, ''); const end = m[1] === 'end' ? v : D.param(`oep_end_${y}`, '');
    let check; try { check = BCA.rules.validateOep(y, start, end); } catch (e) { check = { valid: false, issues: [e.message] }; }
    if (!check.valid) { ctx.flash('error', `${p.key} not saved: ${check.issues.join(' ')}`); return redirect(ctx.res, '/exchange/parameters'); }
  }
  if (p && p.key === 'income_increase_threshold_pct' && !(Number(v) >= 10)) { ctx.flash('error', 'The reasonable threshold may not be less than 10% (45 CFR 155.320(c)(3)(iii)(D)).'); return redirect(ctx.res, '/exchange/parameters'); }
  if (p) { D.run('UPDATE reg_parameters SET value = ? WHERE key = ?', String(ctx.body.value ?? '').trim(), p.key); D.audit('reg_parameter', p.key, 'Updated', `${p.value} -> ${ctx.body.value}`, actor(ctx.user)); ctx.flash('success', `${p.key} updated.`); }
  return redirect(ctx.res, '/exchange/parameters');
});

getR('/exchange/admin', ctx => ctx.render('Test Data Admin', h`<h1 id="page-title">Test data admin</h1>
  <div class="card">${dl([['Database file', D.DB_PATH], ['Engine', 'SQLite (node:sqlite)']], 'db-info')}
    <form method="post" action="/exchange/admin/reset"><div class="actions">${button('Reset Test Data', { cls: 'btn btn-danger' })}</div></form>
    <p class="muted">API equivalent: <code>POST /api/admin/reset</code></p></div>
  <div class="card"><h2>Table row counts</h2>${table(['Table', 'Rows', ''], D.TABLES.slice().sort().map(t => [t, D.get(`SELECT COUNT(*) n FROM ${t}`).n, h`<a href="/api/db/${t}">JSON</a>`]), { id: 'table-counts' })}</div>
  <div class="card"><h2>Seeded accounts</h2>${table(['Email', 'Password', 'Role'], [['jane.consumer@example.com', 'Password123!', 'consumer'], ['sam.filer@example.com', 'Password123!', 'consumer'], ['reviewer@exchange.test', 'Password123!', 'reviewer']])}</div>`, { active: 'admin' }));
postR('/exchange/admin/reset', ctx => { D.reset(); ctx.flash('success', 'Test data reset to the seeded baseline.'); return redirect(ctx.res, '/exchange/admin'); });

getR('/exchange/login', ctx => ctx.render('Sign in', h`<h1 id="page-title">Sign in to the Exchange certification system</h1>
  <form method="post" action="/login" class="card narrow" id="exchange-login-form"><input type="hidden" name="next" value="${ctx.query.next || '/exchange'}">
    ${field({ name: 'email', id: 'username', label: 'Username (email)', value: 'reviewer@exchange.test', required: true, autocomplete: 'username' })}
    ${field({ name: 'password', id: 'password', type: 'password', label: 'Password', required: true, autocomplete: 'current-password' })}
    <div class="actions">${button('Sign In', { id: 'btn-sign-in' })}</div></form>`, { active: '' }));

module.exports = { SECTIONS, DENIAL_REASONS, qisReport, plan };
