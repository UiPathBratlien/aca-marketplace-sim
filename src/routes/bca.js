'use strict';
// 2025 CFR changes wired into the flows (Test Manager project BCA):
//  - application eligibility: lawful presence (BCA:2), FTR (BCA:4-6), income verification (BCA:7-10), evidence standard (BCA:33)
//  - Exchange: inconsistencies, special enrollment (BCA:18-22), plan data validation (BCA:23-31, 38-39), agent termination (BCA:34)
//  - consumer: special enrollment period requests with 2026 pre-enrollment verification (BCA:18-22)
const D = require('../db');
const R = require('../rules');
const B = require('../bca');
const M = require('../marketplace');
const { getR, postR, h, raw, field, select, textarea, button, linkBtn, alertBox, errors, table, dl, badge, redirect, json } = require('../web');
const { breadcrumb } = require('../layout');

const money = R.money;
const actor = u => (u ? u.email : 'anonymous');
const BA = B.rules;

// ================= Application eligibility (called by the consumer application on submit) =================
function evaluateApplication(a, members) {
  const y = a.coverage_year;
  const notes = [];
  // BCA:2 lawful presence for each person who needs coverage
  const lp = members.map(m => ({ m, r: BA.lawfulPresence(m.immigration_status || 'citizen') }));
  lp.forEach(({ m, r }) => D.run('UPDATE household_members SET lawfully_present = ? WHERE id = ?', r.lawfullyPresent === null ? 1 : (r.lawfullyPresent ? 1 : 0), m.id));
  const ineligible = lp.filter(x => x.m.applying && !x.r.eligible);
  ineligible.forEach(x => notes.push(`${x.m.first_name} ${x.m.last_name}: ${x.r.reason}`));
  const eligibleApplying = lp.filter(x => x.m.applying && x.r.eligible).map(x => x.m);
  // BCA:4-6 failure to file and reconcile
  const ftr = D.get('SELECT * FROM ftr_cases WHERE user_id = ? ORDER BY id DESC', a.user_id);
  let ftrResult = null;
  if (ftr) {
    ftrResult = BA.ftrEligibility({ planYear: y, failedYears: ftr.consecutive_ftr_years, channel: ftr.notice_channel, name: ftr.tax_filer_name });
    if (ftrResult.notice) notes.push(`FTR: ${ftrResult.reason}`);
  }
  // BCA:7-10 income verification against the simulated data hub
  const size = members.length; const attested = a.annual_income || 0;
  let verification = 'Verified'; let path = 'Tax return data'; let inc = null;
  const lpMedicaidIneligible = members.some(m => m.relationship === 'Self' && m.medicaid_ineligible_immigration);
  if (a.tax_data_income === null || a.tax_data_income === undefined) {
    const nt = BA.noTaxData(y);
    path = nt.path;
    if (nt.acceptAttestation) { verification = 'Attestation accepted (no tax data)'; notes.push(nt.reason); }
    else if (a.alternate_data_income !== null && a.alternate_data_income !== undefined) {
      const c = BA.incomeIncreaseCheck({ planYear: y, path: 'alternate', dataIncome: a.alternate_data_income, attestedIncome: attested, householdSize: size });
      if (c.triggered) inc = { type: 'Household income (alternate data)', detail: c.reason }; else verification = 'Verified with alternate data';
    } else inc = { type: 'Household income (no tax data)', detail: nt.reason };
  } else {
    const c = BA.incomeIncreaseCheck({ planYear: y, path: 'basic', dataIncome: a.tax_data_income, attestedIncome: attested, householdSize: size, lpMedicaidIneligible });
    if (c.triggered) inc = { type: 'Household income', detail: c.reason }; else if (c.reason.startsWith('Exception')) notes.push(c.reason);
  }
  let incRow = null;
  if (inc) {
    const d = BA.inconsistencyDeadline(D.today(), 'income', 0);
    const num = D.nextNumber('INC', 'inconsistencies', 'inc_number');
    D.insert('inconsistencies', { inc_number: num, application_id: a.id, inc_type: inc.type, detail: inc.detail, notice_date: d.noticeDate, deadline: d.deadline, status: 'Open' });
    verification = `Inconsistency ${num} — resolve by ${d.deadline}`;
    notes.push(`${inc.detail} You have until ${d.deadline} (90 days) to send documents.`);
    incRow = num;
  }
  return { eligibleApplying, ineligible, ftrResult, verification, path, inconsistency: incRow, notes };
}

// ================= Inconsistencies (BCA:7-10, 33) =================
getR('/exchange/inconsistencies', ctx => {
  const rows = D.all('SELECT i.*, a.app_number, a.coverage_year FROM inconsistencies i JOIN applications a ON a.id = i.application_id ORDER BY i.id DESC');
  return ctx.render('Inconsistencies', h`<h1 id="page-title">Data matching inconsistencies</h1>
    <p class="lead">Applicants have 90 days from the notice date to resolve an inconsistency, plus any good-faith extension. There is no automatic 60-day extension for household income (45 CFR 155.315(f)).</p>
    <p class="muted">System date: <strong id="inc-system-date">${D.today()}</strong></p>
    <div class="card">${table(['Inconsistency', 'Application', 'Plan year', 'Type', 'Notice date', 'Deadline', 'Status', ''], rows.map(r => [r.inc_number, r.app_number, r.coverage_year, r.inc_type, r.notice_date, h`<span id="deadline-${r.inc_number}">${r.deadline}</span>`, badge(r.status),
      h`<a href="/exchange/inconsistencies/${r.inc_number}" id="open-${r.inc_number}">Open</a>`]), { id: 'inconsistencies-table', empty: 'No inconsistencies.' })}
      <form method="post" action="/exchange/inconsistencies/deadline-check"><div class="actions">${button('Run Deadline Check', { id: 'btn-run-deadline-check' })}</div></form></div>`, { active: 'inconsistencies', wide: true });
});
getR('/exchange/inconsistencies/:num', ctx => {
  const r = D.get('SELECT i.*, a.app_number FROM inconsistencies i JOIN applications a ON a.id = i.application_id WHERE inc_number = ?', ctx.params.num);
  if (!r) return ctx.notFound('Inconsistency not found.');
  return ctx.render(r.inc_number, h`${breadcrumb([['Inconsistencies', '/exchange/inconsistencies'], [r.inc_number]])}<h1 id="page-title">${r.inc_number}</h1>
    <div class="card">${dl([['Application', r.app_number], ['Type', r.inc_type], ['Detail', r.detail], ['Notice date', r.notice_date], ['Deadline', h`<span id="inc-deadline">${r.deadline}</span>`],
      ['Good-faith extension', `${r.extension_days} days`], ['Status', h`<span id="inc-status">${badge(r.status)}</span>`], ['Outcome', r.outcome || '—']], 'inc-details')}</div>
    ${r.status === 'Open' ? h`<div class="grid2"><form method="post" action="/exchange/inconsistencies/${r.inc_number}/extend" class="card" id="extend-form"><h2>Good-faith extension — § 155.315(f)(3)</h2>
        ${field({ name: 'days', id: 'extension-days', label: 'Extension (days)', value: '30' })}<div class="actions">${button('Grant Extension', { id: 'btn-grant-extension' })}</div></form>
      <form method="post" action="/exchange/inconsistencies/${r.inc_number}/resolve" class="card" id="resolve-form"><h2>Resolve with documents</h2>
        ${field({ name: 'support', id: 'evidence-support', label: 'Weight of evidence supporting the attestation (%)', value: '60' })}
        <p class="muted">Resolved only when the evidence is more likely true than not (preponderance of the evidence, 45 CFR 155.20).</p>
        <div class="actions">${button('Resolve Inconsistency', { id: 'btn-resolve-inconsistency' })}</div></form></div>` : ''}`, { active: 'inconsistencies' });
});
postR('/exchange/inconsistencies/:num/extend', ctx => {
  const r = D.get('SELECT * FROM inconsistencies WHERE inc_number = ?', ctx.params.num); if (!r) return ctx.notFound();
  const days = Number(ctx.body.days); if (!Number.isInteger(days) || days <= 0) { ctx.flash('error', 'Enter the extension in whole days.'); return redirect(ctx.res, `/exchange/inconsistencies/${r.inc_number}`); }
  const d = BA.inconsistencyDeadline(r.notice_date, 'income', r.extension_days + days);
  D.run('UPDATE inconsistencies SET extension_days = ?, deadline = ? WHERE id = ?', r.extension_days + days, d.deadline, r.id);
  D.audit('inconsistency', r.inc_number, 'Good-faith extension', `${days} days -> ${d.deadline}`, actor(ctx.user));
  ctx.flash('success', `Extension granted. New deadline ${d.deadline}.`); return redirect(ctx.res, `/exchange/inconsistencies/${r.inc_number}`);
});
postR('/exchange/inconsistencies/:num/resolve', ctx => {
  const r = D.get('SELECT * FROM inconsistencies WHERE inc_number = ?', ctx.params.num); if (!r) return ctx.notFound();
  let p; try { p = BA.preponderance(ctx.body.support); } catch (e) { ctx.flash('error', e.message); return redirect(ctx.res, `/exchange/inconsistencies/${r.inc_number}`); }
  if (!p.established) { ctx.flash('warning', `Not resolved: ${p.reason}`); return redirect(ctx.res, `/exchange/inconsistencies/${r.inc_number}`); }
  D.run("UPDATE inconsistencies SET status = 'Resolved', resolved_on = ?, outcome = ? WHERE id = ?", D.today(), p.reason, r.id);
  D.audit('inconsistency', r.inc_number, 'Resolved', p.reason, actor(ctx.user));
  ctx.flash('success', 'Inconsistency resolved.'); return redirect(ctx.res, `/exchange/inconsistencies/${r.inc_number}`);
});
function runDeadlineCheck() {
  const t = D.today(); let n = 0;
  for (const r of D.all("SELECT * FROM inconsistencies WHERE status = 'Open' AND deadline < ?", t)) {
    D.run("UPDATE inconsistencies SET status = 'Expired - APTC/CSR Ended', outcome = ? WHERE id = ?", `Not resolved by ${r.deadline}; eligibility redetermined from available data.`, r.id);
    D.run('UPDATE applications SET aptc_eligible = 0, aptc_monthly = 0, csr_variant = NULL WHERE id = ?', r.application_id);
    D.run("UPDATE enrollments SET aptc_applied = 0, net_premium = gross_premium WHERE application_id = ? AND status NOT LIKE 'Cancelled%'", r.application_id);
    D.audit('inconsistency', r.inc_number, 'Expired', 'APTC/CSR ended', 'system'); n++;
  }
  return n;
}
postR('/exchange/inconsistencies/deadline-check', ctx => { const n = runDeadlineCheck(); ctx.flash('success', `${n} inconsistency(ies) expired; APTC/CSR ended.`); return redirect(ctx.res, '/exchange/inconsistencies'); });
postR('/api/inconsistencies/deadline-check', ctx => json(ctx.res, { expired: runDeadlineCheck(), systemDate: D.today() }));

// ================= Special enrollment (Exchange view, BCA:22) =================
getR('/exchange/sep', ctx => {
  const rows = D.all('SELECT s.*, u.email FROM sep_requests s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC');
  const y2026 = rows.filter(r => r.plan_year === 2026 && ['Verified', 'Unverified'].includes(r.verification));   // SEP requests that needed verification
  const verified = y2026.filter(r => r.verification === 'Verified').length;
  const rate = y2026.length ? BA.sepVerificationRate(verified, y2026.length) : null;
  return ctx.render('Special Enrollment', h`<h1 id="page-title">Special enrollment periods</h1>
    <p class="lead">From January 1 to December 31, 2026 every SEP on the Federal platform needs pre-enrollment verification; at least 75% of new SEP enrollments must be verified (45 CFR 155.420(g)).</p>
    <div class="card">${dl([['2026 SEP requests', y2026.length], ['Verified', verified], ['Verification rate', h`<span id="sep-verification-rate">${rate ? `${rate.rate}% (${rate.meets ? 'meets' : 'below'} 75%)` : '—'}</span>`]], 'sep-stats')}</div>
    <div class="card">${table(['SEP #', 'Consumer', 'Plan year', 'Type', 'Event', 'Verification', 'New plan', 'Effective', 'Status'], rows.map(r => [r.sep_number, r.email || '—', r.plan_year, r.sep_type, r.event_date, r.verification, r.new_plan_id || '—', r.effective_date || '—', badge(r.status)]), { id: 'sep-table', empty: 'No SEP requests.' })}</div>`, { active: 'sep', wide: true });
});

// ================= Consumer SEP flow (BCA:18-22) =================
const requireLogin = ctx => { if (!ctx.user) { redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url)}`); return false; } return true; };
function sepForm(ctx, a, v, errs) {
  const enr = D.get("SELECT e.*, p.metal FROM enrollments e JOIN plans p ON p.id = e.plan_id WHERE e.application_id = ? AND e.status NOT LIKE 'Cancelled%' ORDER BY e.id DESC", a.id);
  const plans = M.plansInCounty(a.county_fips, a.coverage_year);
  return ctx.render('Report a life change', h`<h1 id="page-title">Special enrollment period</h1><p class="muted">Application ${a.app_number} · Plan year ${a.coverage_year} · System date ${D.today()}</p>${errors(errs)}
    <form method="post" action="/sep" class="card narrow" id="sep-form"><input type="hidden" name="app" value="${a.app_number}">
      ${select({ name: 'sepType', id: 'sep-type', label: 'What happened?', options: B.SEP_TYPES, placeholder: '-- Select --', value: v.sepType, required: true })}
      ${field({ name: 'eventDate', id: 'sep-event-date', type: 'date', label: 'Date of the event', value: v.eventDate || D.today(), required: true })}
      ${enr ? h`<p>Current plan: <strong id="sep-current-plan">${enr.plan_id} (${enr.metal})</strong></p>` : h`<p class="muted">You are not enrolled in a plan yet.</p>`}
      ${select({ name: 'planId', id: 'sep-plan', label: 'Plan to enroll in', options: plans.map(p => [p.id, `${p.name} — ${p.metal}`]), placeholder: '-- Select plan --', value: v.planId, required: true })}
      ${select({ name: 'documents', id: 'sep-documents', label: 'Documents to verify your eligibility for this SEP', options: [['provided', 'I uploaded documents that confirm the event'], ['none', 'I don\'t have documents']], value: v.documents || 'provided' })}
      <div class="actions">${button('Submit SEP Request', { id: 'btn-submit-sep' })}</div></form>`, { active: 'dashboard' });
}
getR('/sep/new', ctx => {
  if (!requireLogin(ctx)) return;
  const a = D.get("SELECT * FROM applications WHERE app_number = ? AND user_id = ? AND status <> 'In Progress'", ctx.query.app || '', ctx.user.id)
    || D.get("SELECT * FROM applications WHERE user_id = ? AND status <> 'In Progress' ORDER BY id DESC", ctx.user.id);
  if (!a) { ctx.flash('warning', 'Submit an application before reporting a life change.'); return redirect(ctx.res, '/apply'); }
  return sepForm(ctx, a, {}, []);
});
postR('/sep', ctx => {
  if (!requireLogin(ctx)) return;
  const b = ctx.body;
  const a = D.get("SELECT * FROM applications WHERE app_number = ? AND user_id = ? AND status <> 'In Progress'", b.app || '', ctx.user.id);
  if (!a) return ctx.notFound('Application not found.');
  const errs = [];
  if (!B.SEP_TYPES.some(s => s[0] === b.sepType)) errs.push('Select what happened.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.eventDate || '')) errs.push('Enter the date of the event.');
  const plan = D.get('SELECT p.* FROM plans p JOIN plan_service_areas s ON s.plan_id = p.id WHERE p.id = ? AND s.county_fips = ?', b.planId || '', a.county_fips);
  if (!plan) errs.push('Select a plan available in your area.');
  if (errs.length) return sepForm(ctx, a, b, errs);
  const state = D.get('SELECT * FROM states WHERE code = ?', a.state);
  const platform = state ? state.exchange_type : 'FFE';
  const enr = D.get("SELECT e.*, p.metal FROM enrollments e JOIN plans p ON p.id = e.plan_id WHERE e.application_id = ? AND e.status NOT LIKE 'Cancelled%' ORDER BY e.id DESC", a.id);
  const today = D.today();
  let status = 'Approved'; let reason = ''; let verification = 'Not required'; let effective = null;
  // d(16) availability (BCA:21)
  if (b.sepType === 'd16') {
    const av = BA.d16Availability(a.coverage_year, a.fpl_percent || 0, !!a.aptc_eligible);
    if (!av.available) { status = 'Denied - SEP Not Available'; reason = av.reason; }
  }
  // plan change rules (BCA:18, 19)
  if (status === 'Approved') {
    const ch = BA.sepPlanChange(b.sepType, a.coverage_year, enr ? enr.metal : '', plan.metal);
    if (!ch.allowed) { status = 'Denied - Plan Change Not Allowed'; reason = `${ch.reason} (${ch.rule})`; }
  }
  // 2026 pre-enrollment verification (BCA:22)
  if (status === 'Approved') {
    const vr = BA.sepVerificationRequired(today, platform);
    if (vr.required) {
      verification = b.documents === 'provided' ? 'Verified' : 'Unverified';
      if (verification === 'Unverified') { status = 'Denied - Eligibility Not Verified'; reason = 'We could not verify your eligibility for this special enrollment period (45 CFR 155.420(g)). You have the right to appeal under 45 CFR 155.505(b)(1)(iii).'; }
    }
  }
  if (status === 'Approved') { const e = BA.sepEffectiveDate(b.sepType, a.coverage_year, today); effective = e.effectiveDate; reason = `${e.reason} (${e.rule})`; }
  const num = D.nextNumber('SEP', 'sep_requests', 'sep_number');
  D.insert('sep_requests', { sep_number: num, user_id: ctx.user.id, application_id: a.id, plan_year: a.coverage_year, sep_type: b.sepType, event_date: b.eventDate, fpl_percent: a.fpl_percent,
    aptc_eligible: a.aptc_eligible ? 1 : 0, verification, current_metal: enr ? enr.metal : null, new_plan_id: plan.id, new_metal: plan.metal, effective_date: effective, status, status_reason: reason, created_at: D.nowIso() });
  let enrNum = null;
  if (status === 'Approved') {
    const ages = D.all('SELECT dob FROM household_members WHERE application_id = ? AND applying = 1 AND COALESCE(lawfully_present, 1) = 1', a.id).map(m => M.ageOn(m.dob, `${a.coverage_year}-01-01`));
    const gross = M.householdPremium(plan, ages.length ? ages : [40]); const aptc = Math.min(gross, a.aptc_monthly || 0);
    if (enr) D.run("UPDATE enrollments SET status = 'Cancelled - Plan Change (SEP)' WHERE id = ?", enr.id);
    enrNum = D.nextNumber('ENR', 'enrollments', 'enrollment_number');
    D.insert('enrollments', { enrollment_number: enrNum, application_id: a.id, user_id: ctx.user.id, plan_id: plan.id, gross_premium: gross, aptc_applied: M.r2(aptc), net_premium: M.r2(gross - aptc),
      status: 'Pending Binder Payment', effective_date: effective, created_at: D.nowIso() });
    D.run("UPDATE applications SET status = 'Enrolled' WHERE id = ?", a.id);
  }
  D.audit('sep', num, status, reason, ctx.user.email);
  const ok = status === 'Approved';
  return ctx.render('SEP result', h`<h1 id="page-title">${ok ? 'Special enrollment approved' : 'Special enrollment not approved'}</h1>
    ${alertBox(ok ? 'success' : 'error', ok ? 'Your plan selection was accepted' : status, reason, 'sep-result')}
    <div class="card">${dl([['SEP request', h`<span id="sep-number">${num}</span>`], ['Status', h`<span id="sep-status">${badge(status)}</span>`], ['Verification', h`<span id="sep-verification">${verification}</span>`],
      ['New plan', `${plan.id} (${plan.metal})`], ['Coverage starts', h`<span id="sep-effective-date">${effective || '—'}</span>`]], 'sep-details')}
      <div class="actions">${ok ? linkBtn('View enrollment', `/enrollments/${enrNum}`, { id: 'btn-view-enrollment' }) : linkBtn('File an appeal', `/appeals/new?app=${a.app_number}`, { id: 'btn-sep-appeal', cls: 'btn btn-outline' })}</div></div>`, { active: 'dashboard' });
});

// ================= Plan data validation (BCA:23-31, 38-39) =================
function planChecks(p) {
  const qualBronze = p.metal === 'Expanded Bronze' || !!p.hsa_eligible;
  const av = BA.avDeMinimis(p.metal, Math.round(p.actuarial_value * 1000) / 10, qualBronze ? 'yes' : 'no');
  const ehb = BA.planEhbValidation(p);
  let md = null;
  if (p.standardized) { try { md = R.rules.standardizedPlanCompliance(p); } catch { md = null; } }
  const ns = !p.standardized ? R.rules.nonstandardLimit(p.issuer_id, p.plan_year) : null;
  const cell = ns ? ns.groups.find(g => g.plans.includes(p.id)) : null;
  const issues = [];
  if (!av.pass) issues.push(`AV ${av.av}% outside ${av.low}%–${av.high}% (45 CFR 156.140(c)(1))`);
  ehb.violations.forEach(v => issues.push(`${v} (45 CFR 156.115(d))`));
  if (md && md.duplicates && md.duplicates.length) issues.push(`Not meaningfully different from ${md.duplicates.join(', ')} (45 CFR 156.201(c))`);
  if (cell && !cell.withinLimit) issues.push(`${cell.count} non-standardized plans in one cell — limit is 2 (45 CFR 156.202(b))`);
  return { planId: p.id, planYear: p.plan_year, metal: p.metal, av, ehb, meaningfulDifference: md, nonstandardCell: cell || null, compliant: issues.length === 0, issues };
}
getR('/exchange/plan-validation', ctx => {
  const year = Number(ctx.query.year || 2026);
  const rows = D.all('SELECT p.*, i.name issuer FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.plan_year = ? ORDER BY p.id', year).map(p => ({ p, c: planChecks(p) }));
  return ctx.render('Plan Data Validation', h`<h1 id="page-title">Plan data validation — 2025 CFR rules</h1>
    <p class="lead">Checks issuer plan data against AV de minimis ranges, EHB prohibited benefits, standardized-plan meaningful difference and the non-standardized plan limit.</p>
    <form method="get" action="/exchange/plan-validation" class="inline">${select({ name: 'year', id: 'validation-year', label: 'Plan year', options: ['2025', '2026'], value: String(year) })}${button('Show', { id: 'btn-show-year', cls: 'btn btn-small' })}</form>
    <div class="card">${table(['Plan', 'Issuer', 'Metal', 'AV', 'Result', 'Issues', ''], rows.map(({ p, c }) => [p.id, p.issuer, p.metal, `${c.av.av}%`, badge(c.compliant ? 'Compliant' : 'Non-compliant'), c.issues.join('; ') || '—',
      h`<a href="/exchange/plan-validation/${p.id}" id="validate-${p.id}">Details</a>`]), { id: 'plan-validation-table' })}</div>`, { active: 'plan-validation', wide: true });
});
getR('/exchange/plan-validation/:id', ctx => {
  const p = D.get('SELECT p.*, i.name issuer FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', ctx.params.id);
  if (!p) return ctx.notFound('Plan not found.');
  const c = planChecks(p);
  return ctx.render(`Validate ${p.id}`, h`${breadcrumb([['Plan Data Validation', '/exchange/plan-validation'], [p.id]])}<h1 id="page-title">${p.name}</h1>
    <div class="card">${dl([['Plan ID', p.id], ['Plan year', p.plan_year], ['Metal', p.metal], ['Result', h`<span id="validation-result">${badge(c.compliant ? 'Compliant' : 'Non-compliant')}</span>`]], 'validation-summary')}</div>
    <div class="card"><h2>Actuarial value</h2><p id="av-check">${c.av.reason}</p></div>
    <div class="card"><h2>Essential health benefits</h2><p class="muted">${c.ehb.tier}</p>${table(['Benefit', 'Classified as EHB'], c.ehb.benefits.map(b => [(B.BENEFITS.find(x => x[0] === b.benefit_code) || [0, b.benefit_code])[1], b.classified_ehb ? 'Yes' : 'No']), { id: 'ehb-benefits', empty: 'No benefit classification on file.' })}
      ${c.ehb.violations.length ? alertBox('error', 'EHB classification errors', h`<ul>${c.ehb.violations.map(v => h`<li>${v}</li>`)}</ul>`, 'ehb-violations') : ''}</div>
    <div class="card"><h2>Plan options</h2>${dl([['Standardized', p.standardized ? 'Yes' : 'No'], ['Meaningful difference', c.meaningfulDifference ? (c.meaningfulDifference.duplicates.length ? `Fails — same as ${c.meaningfulDifference.duplicates.join(', ')}` : 'Passes') : 'Not applicable'],
      ['Non-standardized cell', c.nonstandardCell ? `${c.nonstandardCell.count} plan(s): ${c.nonstandardCell.withinLimit ? 'within limit' : 'exceeds limit of 2'}` : 'Not applicable']], 'plan-option-checks')}</div>
    ${c.issues.length ? alertBox('error', 'Issues', h`<ul>${c.issues.map(i => h`<li>${i}</li>`)}</ul>`, 'validation-issues') : ''}`, { active: 'plan-validation' });
});
getR('/api/plan-validation/:id', ctx => {
  const p = D.get('SELECT * FROM plans WHERE id = ?', ctx.params.id);
  if (!p) return json(ctx.res, { error: 'Not found' }, 404);
  return json(ctx.res, planChecks(p));
});

// ================= Agents & brokers: termination for cause (BCA:34) =================
postR('/exchange/agents/:npn/terminate', ctx => {
  const a = D.get('SELECT * FROM agents WHERE npn = ?', ctx.params.npn);
  if (!a) return ctx.notFound('Agent not found.');
  const t = BA.terminationForCause(ctx.body.evidentiaryBasis, ctx.body.preponderance === '1' ? 'yes' : 'no');
  if (!t.allowed) { ctx.flash('error', t.reason); return redirect(ctx.res, `/exchange/agents/${a.npn}`); }
  D.run("UPDATE agents SET status = 'Terminated for Cause' WHERE id = ?", a.id);
  D.insert('compliance_actions', { action_number: D.nextNumber('CA', 'compliance_actions', 'action_number'), action_type: 'Termination for cause', agent_id: a.id, agency_id: a.agency_id,
    basis: 'Noncompliance under 45 CFR 155.220(g)(1)', notes: ctx.body.notes || null, outcome: 'Terminated', created_by: actor(ctx.user), created_at: D.nowIso(),
    authority: '45 CFR 155.220(g)', evidentiary_basis: ctx.body.evidentiaryBasis.trim(), evidence_standard: 'Preponderance of the evidence' });
  D.audit('agent', a.npn, 'Terminated for cause', `Preponderance of the evidence: ${ctx.body.evidentiaryBasis.trim()}`, actor(ctx.user));
  ctx.flash('success', `Agent ${a.npn} terminated for cause. Finding recorded as supported by a preponderance of the evidence.`);
  return redirect(ctx.res, `/exchange/agents/${a.npn}`);
});

module.exports = { evaluateApplication, runDeadlineCheck, planChecks };
