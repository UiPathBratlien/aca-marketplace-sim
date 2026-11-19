'use strict';
// Annual redetermination, passive re-enrollment and 834 files (Test Manager project BCA: BCA:11, BCA:12, test cases BCA:40-49),
// plus the simulated system clock used by every date rule.
const D = require('../db');
const R = require('../rules');
const B = require('../bca');
const { getR, postR, h, field, select, button, linkBtn, alertBox, errors, table, dl, badge, redirect, json } = require('../web');
const { breadcrumb } = require('../layout');

const money = R.money;
class InputError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---------- Date helpers: accept 2025-12-15, 12/15/2025 or "December 15, 2025" ----------
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = n => String(n).padStart(2, '0');
function parseDate(v, name = 'Date') {
  const s = String(v ?? '').trim().replace(/^'|'$/g, '');
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) { const i = MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase().slice(0, 3))); if (i >= 0) return `${m[3]}-${pad(i + 1)}-${pad(m[2])}`; }
  throw new InputError(`${name} must be a date such as 2025-12-15 or December 15, 2025.`);
}
function parseTimestamp(v, name = 'Timestamp') {
  const s = String(v ?? '').trim().replace(/^'|'$/g, '');
  if (!s) return D.nowIso().slice(0, 19).replace('T', ' ');
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return `${m[1]} ${pad(m[2])}:${m[3]}:${m[4] || '00'}`;
  return `${parseDate(s, name)} 00:00:00`;
}
const moneyIn = (v, name) => { const n = Number(String(v ?? '').replace(/[$,\s']/g, '')); if (String(v ?? '').trim() === '' || Number.isNaN(n) || n < 0) throw new InputError(`${name} must be a dollar amount.`); return Math.round(n * 100) / 100; };

// ---------- Clock ----------
function setClock(date) {
  if (date === '' || date === null || date === 'real') { D.setParam('system_date', ''); return { systemDate: D.today(), simulated: false }; }
  const d = parseDate(date, 'System date');
  D.setParam('system_date', d);
  D.audit('clock', 'system_date', 'Set', d, 'test');
  return { systemDate: d, simulated: true };
}
const clockInfo = () => ({ systemDate: D.today(), simulated: !!D.clockDate(), realDate: new Date().toISOString().slice(0, 10) });

// ---------- Enrollee model ----------
const deadlineFor = by => D.param(`plan_selection_deadline_${by}`, `${by - 1}-12-15`);
const getEnrollee = id => D.get('SELECT * FROM redetermination_enrollees WHERE enrollee_id = ?', id);
function mustGet(id) { const e = getEnrollee(id); if (!e) throw new InputError(`Enrollee ${id} not found.`, 404); return e; }
const apps = id => D.all('SELECT * FROM updated_applications WHERE enrollee_id = ? ORDER BY submitted_at', id);
const PLATFORMS = [['FFE', 'Federally-facilitated Exchange (Federal platform)'], ['SBE-FP', 'State Exchange on the Federal platform'], ['SBE', 'State-based Exchange']];
const COVERAGE_STATUSES = ['Active', 'Terminated', 'Cancelled'];

function createEnrollee(b) {
  const id = String(b.enrolleeId || '').trim().replace(/^'|'$/g, '');
  if (!/^[A-Za-z0-9-]{3,40}$/.test(id)) throw new InputError('Enrollee ID is required (letters, digits and dashes), for example ENR-2026-001.');
  if (getEnrollee(id)) throw new InputError(`Enrollee ${id} already exists.`, 409);
  const platform = b.platform || 'FFE';
  if (!PLATFORMS.some(p => p[0] === platform)) throw new InputError('Platform must be FFE, SBE-FP or SBE.');
  const by = Number(b.benefitYear || 2026);
  if (!Number.isInteger(by) || by < 2024 || by > 2030) throw new InputError('Benefit year must be between 2024 and 2030.');
  const row = { enrollee_id: id, first_name: (b.firstName || 'Test').trim(), last_name: (b.lastName || 'Enrollee').trim(), platform,
    state: (b.state || (platform === 'SBE' ? 'California' : 'TX')).trim(), benefit_year: by, prior_coverage_status: b.priorCoverageStatus || 'Active',
    plan_id: b.planId || null, metal: b.metal || 'Silver', csr_eligible: b.csrEligible === '1' || b.csrEligible === true || b.csrEligible === 'yes' ? 1 : 0,
    issuer_ref: (b.issuerRef || '').trim() || null, plan_premium: b.planPremium !== undefined && b.planPremium !== '' ? moneyIn(b.planPremium, 'Plan premium') : null,
    status: 'Awaiting Redetermination', created_at: D.nowIso() };
  D.insert('redetermination_enrollees', row);
  D.audit('enrollee', id, 'Created', `${platform} ${row.state} BY${by}`, 'test');
  return getEnrollee(id);
}
function recalcNet(e) {
  const gross = e.plan_premium;
  if (gross == null || e.calculated_aptc == null) return null;
  return Math.round((gross - Math.min(gross, e.calculated_aptc)) * 100) / 100;
}
function updateEnrollee(id, b) {
  const e = mustGet(id);
  const set = {};
  if (b.priorCoverageStatus !== undefined) { if (!COVERAGE_STATUSES.includes(b.priorCoverageStatus)) throw new InputError('Coverage status must be Active, Terminated or Cancelled.'); set.prior_coverage_status = b.priorCoverageStatus; }
  if (b.planPremium !== undefined && b.planPremium !== '') set.plan_premium = moneyIn(b.planPremium, 'Plan premium');
  if (b.issuerRef !== undefined && b.issuerRef !== '') set.issuer_ref = String(b.issuerRef).trim().replace(/^'|'$/g, '');
  if (b.metal) { if (!B.METALS.includes(b.metal)) throw new InputError('Unknown metal level.'); set.metal = b.metal; }
  if (b.csrEligible !== undefined) set.csr_eligible = ['1', 'yes', 'true', true].includes(b.csrEligible) ? 1 : 0;
  if (b.platform) { if (!PLATFORMS.some(p => p[0] === b.platform)) throw new InputError('Platform must be FFE, SBE-FP or SBE.'); set.platform = b.platform; }
  if (b.state) set.state = String(b.state).trim();
  if (b.benefitYear) set.benefit_year = Number(b.benefitYear);
  if (b.planId !== undefined) set.plan_id = b.planId || null;
  if (!Object.keys(set).length) return e;
  D.run(`UPDATE redetermination_enrollees SET ${Object.keys(set).map(k => `${k} = ?`).join(', ')} WHERE enrollee_id = ?`, ...Object.values(set), id);
  const n = mustGet(id);
  if (n.calculated_aptc != null) D.run('UPDATE redetermination_enrollees SET net_premium_before = ? WHERE enrollee_id = ?', recalcNet(n), id);
  D.audit('enrollee', id, 'Updated', JSON.stringify(set), 'test');
  return mustGet(id);
}
function redetermine(id, b = {}) {
  const e = mustGet(id);
  if (e.plan_premium == null) throw new InputError('Configure the plan premium before running annual redetermination.');
  D.run("UPDATE redetermination_enrollees SET redetermined_at = ?, status = 'Redetermined' WHERE enrollee_id = ?", D.nowIso(), id);
  D.audit('enrollee', id, 'Annual redetermination run', null, 'test');
  if (b.aptc !== undefined && b.aptc !== '') return setAptc(id, b.aptc);
  return mustGet(id);
}
function setAptc(id, aptc) {
  const e = mustGet(id);
  if (!e.redetermined_at) throw new InputError('Run annual redetermination before setting the calculated APTC.');
  const a = Math.min(moneyIn(aptc, 'APTC amount'), e.plan_premium);
  D.run('UPDATE redetermination_enrollees SET calculated_aptc = ?, net_premium_before = ? WHERE enrollee_id = ?', a, Math.round((e.plan_premium - a) * 100) / 100, id);
  D.audit('enrollee', id, 'APTC calculated', String(a), 'test');
  return mustGet(id);
}
function submitUpdatedApplication(id, submittedAt) {
  const e = mustGet(id);
  const ts = parseTimestamp(submittedAt, 'Submission timestamp');
  const before = ts.slice(0, 10) <= deadlineFor(e.benefit_year) ? 1 : 0;
  D.insert('updated_applications', { enrollee_id: id, submitted_at: ts, before_deadline: before, created_at: D.nowIso() });
  D.audit('enrollee', id, 'Updated application submitted', ts, 'test');
  return { enrollee: mustGet(id), submittedAt: ts, beforeDeadline: !!before, deadline: deadlineFor(e.benefit_year),
    note: e.reenrolled_at ? 'Submitted after passive re-enrollment: it does not reverse an APTC adjustment already applied.' : (before ? 'Submitted on or before the plan selection deadline.' : 'Submitted after the plan selection deadline.') };
}
function evaluate(e) {
  const firstApp = apps(e.enrollee_id)[0];
  return B.rules.minimumPremium({ benefitYear: e.benefit_year, platform: e.platform, grossPremium: e.plan_premium, aptc: e.calculated_aptc,
    updatedAppDate: firstApp ? firstApp.submitted_at.slice(0, 10) : '', deadline: deadlineFor(e.benefit_year) });
}
function passiveReenroll(id) {
  const e = mustGet(id);
  if (e.reenrolled_at) throw new InputError(`Enrollee ${id} was already re-enrolled on ${e.reenrolled_at.slice(0, 10)}.`, 409);
  if (e.prior_coverage_status !== 'Active') throw new InputError(`Only enrollees with active ${e.benefit_year - 1} coverage are passively re-enrolled (status: ${e.prior_coverage_status}).`);
  if (!e.redetermined_at || e.calculated_aptc == null) throw new InputError('Run annual redetermination and set the calculated APTC first.');
  const dl = deadlineFor(e.benefit_year);
  if (D.today() <= dl) throw new InputError(`Passive re-enrollment runs after the plan selection deadline (${dl}). System date is ${D.today()}.`);
  const cw = B.rules.crosswalk(e.metal, !!e.csr_eligible);
  const r = evaluate(e);
  D.run(`UPDATE redetermination_enrollees SET reenrolled_at = ?, reenrolled_metal = ?, final_aptc = ?, final_net_premium = ?, minimum_premium_applied = ?, rule_result = ?,
    status = ? WHERE enrollee_id = ?`, D.nowIso(), cw.targetMetal, r.aptc, r.netPremium, r.applies ? 1 : 0, r.reason,
    r.applies ? 'Re-enrolled - $5 Minimum Premium Applied' : 'Re-enrolled', id);
  D.audit('enrollee', id, 'Passive re-enrollment', r.reason, 'test');
  return { enrollee: mustGet(id), rule: r, crosswalk: cw };
}
function applyMinimumPremium(id) {
  const e = mustGet(id);
  if (!e.reenrolled_at) throw new InputError('Execute passive re-enrollment first.');
  const r = evaluate({ ...e });
  if (!r.applies) throw new InputError(r.reason, 422);
  if (e.minimum_premium_applied) return { enrollee: e, rule: r, alreadyApplied: true, message: `$5 minimum premium adjustment is already applied: APTC ${money(e.final_aptc)}, net premium ${money(e.final_net_premium)}.` };
  D.run("UPDATE redetermination_enrollees SET final_aptc = ?, final_net_premium = ?, minimum_premium_applied = 1, rule_result = ?, status = 'Re-enrolled - $5 Minimum Premium Applied' WHERE enrollee_id = ?", r.aptc, r.netPremium, r.reason, id);
  return { enrollee: mustGet(id), rule: r, alreadyApplied: false, message: r.reason };
}
function premiumRecord(e) {
  const aptc = e.reenrolled_at ? e.final_aptc : e.calculated_aptc;
  const net = e.reenrolled_at ? e.final_net_premium : e.net_premium_before;
  return { enrolleeId: e.enrollee_id, benefitYear: e.benefit_year, platform: e.platform, planPremium: e.plan_premium, aptc, netPremium: net,
    minimumPremiumApplied: !!e.minimum_premium_applied, coverageEffective: `${e.benefit_year}-01-01`, status: e.status, ruleResult: e.rule_result };
}

// ---------- 834 benefit enrollment file (simplified ASC X12 005010X220A1 with FFM 2750 reporting categories) ----------
function generate834(issuerRef) {
  const ref = String(issuerRef || '').trim().replace(/^'|'$/g, '');
  if (!ref) throw new InputError('Issuer ID is required.');
  const members = D.all('SELECT * FROM redetermination_enrollees WHERE issuer_ref = ? AND reenrolled_at IS NOT NULL ORDER BY enrollee_id', ref);
  if (!members.length) throw new InputError(`No re-enrolled enrollees for issuer ${ref}. Execute passive re-enrollment first.`, 404);
  const fileNumber = D.nextNumber('EDI834', 'edi_834_files', 'file_number');
  const stamp = D.nowIso(); const ymd = stamp.slice(0, 10).replace(/-/g, ''); const hm = stamp.slice(11, 16).replace(':', '');
  const amt = n => Number(n || 0).toFixed(2);
  const seg = [];
  seg.push(`ISA*00*          *00*          *ZZ*CMSFFM         *ZZ*${ref.padEnd(15).slice(0, 15)}*${ymd.slice(2)}*${hm}*^*00501*000000001*0*T*:~`);
  seg.push(`GS*BE*CMSFFM*${ref}*${ymd}*${hm}*1*X*005010X220A1~`);
  const body = [];
  body.push(`ST*834*0001*005010X220A1~`, `BGN*00*${fileNumber}*${ymd}*${hm}****2~`, `N1*P5*CoverWell Marketplace*FI*000000000~`, `N1*IN*${ref}*FI*${ref}~`);
  for (const m of members) {
    body.push(`INS*Y*18*021*28*A***AC~`, `REF*0F*${m.enrollee_id}~`, `REF*17*${m.enrollee_id}~`, `NM1*IL*1*${m.last_name}*${m.first_name}~`,
      `HD*021**HLT*${m.plan_id || 'PLAN'}*IND~`, `DTP*348*D8*${m.benefit_year}0101~`,
      `LS*2700~`, `LX*1~`, `N1*75*PRE AMT TOT~`, `REF*9X*${amt(m.plan_premium)}~`, `LX*2~`, `N1*75*APTC AMT~`, `REF*9X*${amt(m.final_aptc)}~`,
      `LX*3~`, `N1*75*TOT RES AMT~`, `REF*9X*${amt(m.final_net_premium)}~`, `LE*2700~`);
  }
  body.push(`SE*${body.length + 1}*0001~`);
  const content = [...seg, ...body, 'GE*1*1~', 'IEA*1*000000001~'].join('\n');
  const parsed = members.map(m => ({ enrolleeId: m.enrollee_id, name: `${m.first_name} ${m.last_name}`, planId: m.plan_id, coverageEffective: `${m.benefit_year}-01-01`,
    totalPremium: m.plan_premium, aptcAmount: m.final_aptc, enrolleeNetPremium: m.final_net_premium, minimumPremiumApplied: !!m.minimum_premium_applied }));
  D.insert('edi_834_files', { file_number: fileNumber, issuer_ref: ref, benefit_year: members[0].benefit_year, member_count: members.length, content, members_json: JSON.stringify(parsed), created_at: stamp });
  D.audit('edi_834', fileNumber, 'Generated', `${ref}: ${members.length} member(s)`, 'test');
  return getFile(fileNumber);
}
function getFile(num) {
  const f = D.get('SELECT * FROM edi_834_files WHERE file_number = ?', num);
  if (!f) throw new InputError('834 file not found.', 404);
  return { fileNumber: f.file_number, issuerId: f.issuer_ref, benefitYear: f.benefit_year, memberCount: f.member_count, createdAt: f.created_at, members: JSON.parse(f.members_json), content: f.content };
}

// ---------- UI ----------
const plain = n => (n == null ? '—' : money(n));
function guard(ctx, fn, back) {
  try { return fn(); } catch (e) {
    if (!(e instanceof InputError) && !(e instanceof R.RuleError)) throw e;
    ctx.flash('error', e.message); return redirect(ctx.res, back);
  }
}
function listPage(ctx, v = {}, errs = []) {
  const rows = D.all('SELECT * FROM redetermination_enrollees ORDER BY id DESC');
  const years = [2026, 2027];
  return ctx.render('Annual Redetermination', h`${breadcrumb([['Dashboard', '/exchange'], ['Annual Redetermination']])}
    <h1 id="page-title">Annual redetermination & passive re-enrollment</h1>
    <p class="lead">Benefit year 2026, Federal platform: enrollees whose net premium after APTC would be $0 and who did not submit an updated application by the plan selection deadline pay $5 per month (45 CFR 155.335(n)).</p>
    <p class="muted">System date: <strong id="redet-system-date">${D.today()}</strong> · ${linkBtn('System Clock', '/exchange/clock', { cls: 'btn btn-small btn-outline', id: 'link-system-clock' })}</p>
    ${errors(errs)}
    <div class="card"><h2>Enrollees</h2>${table(['Enrollee ID', 'Name', 'Platform', 'State', 'Benefit year', 'Prior coverage', 'Plan premium', 'APTC', 'Net premium', 'Status', ''], rows.map(e => {
      const pr = premiumRecord(e);
      return [h`<a href="/exchange/redetermination/${e.enrollee_id}" id="enrollee-${e.enrollee_id}">${e.enrollee_id}</a>`, `${e.first_name} ${e.last_name}`, e.platform, e.state, e.benefit_year, badge(e.prior_coverage_status),
        plain(e.plan_premium), plain(pr.aptc), plain(pr.netPremium), badge(e.status), h`<a href="/exchange/redetermination/${e.enrollee_id}" id="open-${e.enrollee_id}">Open</a>`];
    }), { id: 'enrollees-table', empty: 'No enrollees.' })}</div>
    <form method="post" action="/exchange/redetermination" class="card narrow" id="create-enrollee-form"><h2>Create enrollee record</h2>
      ${field({ name: 'enrolleeId', id: 'enrollee-id', label: 'Enrollee ID', value: v.enrolleeId || '', placeholder: 'ENR-2026-001', required: true })}
      <div class="grid2">${field({ name: 'firstName', id: 'enrollee-first-name', label: 'First name', value: v.firstName || 'Test' })}${field({ name: 'lastName', id: 'enrollee-last-name', label: 'Last name', value: v.lastName || 'Enrollee' })}</div>
      ${select({ name: 'platform', id: 'enrollee-platform', label: 'Exchange platform', options: PLATFORMS, value: v.platform || 'FFE' })}
      ${field({ name: 'state', id: 'enrollee-state', label: 'State (or State-based Exchange name)', value: v.state || '', placeholder: 'TX or California' })}
      ${select({ name: 'benefitYear', id: 'enrollee-benefit-year', label: 'Re-enrollment benefit year', options: years.map(String), value: v.benefitYear || '2026' })}
      ${select({ name: 'priorCoverageStatus', id: 'enrollee-prior-coverage', label: 'Prior benefit year coverage status', options: COVERAGE_STATUSES, value: v.priorCoverageStatus || 'Active' })}
      ${field({ name: 'planPremium', id: 'enrollee-plan-premium', label: 'Plan premium for the benefit year ($/month)', value: v.planPremium || '' })}
      ${field({ name: 'issuerRef', id: 'enrollee-issuer-id', label: 'Issuer ID', value: v.issuerRef || '', placeholder: 'ISS-12345' })}
      <div class="actions">${button('Create Enrollee', { id: 'btn-create-enrollee' })}</div></form>
    <form method="post" action="/exchange/redetermination/deadlines" class="card narrow" id="deadline-form"><h2>Plan selection deadlines — 45 CFR 155.410(f)</h2>
      ${years.map(y => field({ name: `deadline_${y}`, id: `deadline-${y}`, label: `Last day to select a plan for January 1, ${y} coverage`, value: deadlineFor(y) }))}
      <div class="actions">${button('Save Deadlines', { id: 'btn-save-deadlines' })}</div></form>`, { active: 'redetermination', wide: true });
}
function detailPage(ctx, e, result) {
  const pr = premiumRecord(e); const list = apps(e.enrollee_id); const deadline = deadlineFor(e.benefit_year);
  return ctx.render(`Enrollee ${e.enrollee_id}`, h`${breadcrumb([['Annual Redetermination', '/exchange/redetermination'], [e.enrollee_id]])}
    <h1 id="page-title">Enrollee ${e.enrollee_id}</h1>
    <p class="muted">System date: <strong id="redet-system-date">${D.today()}</strong> · Plan selection deadline for ${e.benefit_year}: <strong id="plan-selection-deadline">${deadline}</strong></p>
    ${result ? alertBox(result.kind, result.title, result.text, 'redetermination-result') : ''}
    <div class="card">${dlBlock(e, pr)}</div>
    <div class="grid2">
    <form method="post" action="/exchange/redetermination/${e.enrollee_id}/update" class="card" id="enrollee-update-form"><h2>Enrollee & plan</h2>
      ${select({ name: 'priorCoverageStatus', id: 'prior-coverage-status', label: `Benefit year ${e.benefit_year - 1} coverage status`, options: COVERAGE_STATUSES, value: e.prior_coverage_status })}
      ${field({ name: 'planPremium', id: 'plan-premium', label: `Benefit year ${e.benefit_year} plan premium ($/month)`, value: e.plan_premium ?? '' })}
      ${field({ name: 'issuerRef', id: 'issuer-id', label: 'Issuer ID', value: e.issuer_ref || '' })}
      ${select({ name: 'metal', id: 'current-metal', label: 'Current metal level', options: B.METALS, value: e.metal })}
      ${select({ name: 'csrEligible', id: 'csr-eligible', label: 'CSR-eligible', options: [['0', 'No'], ['1', 'Yes']], value: String(e.csr_eligible) })}
      <div class="actions">${button('Save Enrollee', { id: 'btn-save-enrollee' })}</div></form>
    <div class="card"><h2>Annual redetermination</h2>
      <form method="post" action="/exchange/redetermination/${e.enrollee_id}/redetermine">${button('Run Annual Redetermination', { id: 'btn-run-redetermination' })}</form>
      <form method="post" action="/exchange/redetermination/${e.enrollee_id}/aptc" id="aptc-form">
        ${field({ name: 'aptc', id: 'calculated-aptc', label: `Calculated APTC for benefit year ${e.benefit_year} ($/month)`, value: e.calculated_aptc ?? '' })}
        <div class="actions">${button('Save APTC', { id: 'btn-save-aptc' })}</div></form>
      <p>Net premium after APTC: <strong id="net-premium-after-aptc">${plain(e.net_premium_before)}</strong></p></div>
    <form method="post" action="/exchange/redetermination/${e.enrollee_id}/applications" class="card" id="updated-application-form"><h2>Updated eligibility application</h2>
      ${field({ name: 'submittedAt', id: 'application-timestamp', label: 'Submission timestamp (YYYY-MM-DD HH:MM:SS; blank = now)', value: '' })}
      <div class="actions">${button('Submit Updated Application', { id: 'btn-submit-updated-application' })}</div>
      ${table(['Submitted', 'On or before deadline'], list.map(a => [a.submitted_at, a.before_deadline ? 'Yes' : 'No']), { id: 'updated-applications', empty: 'No updated eligibility application on file.' })}
      <p class="muted" id="updated-application-status">${list.length ? `${list.length} updated application(s) on file.` : 'No updated eligibility application exists for this enrollee.'}</p></form>
    <div class="card"><h2>Passive re-enrollment</h2>
      <form method="post" action="/exchange/redetermination/${e.enrollee_id}/reenroll">${button('Execute Passive Re-enrollment', { id: 'btn-execute-reenrollment' })}</form>
      <form method="post" action="/exchange/redetermination/${e.enrollee_id}/minimum-premium">${button('Apply $5 Minimum Premium Adjustment', { id: 'btn-apply-minimum-premium', cls: 'btn btn-outline' })}</form>
      <div class="actions">${linkBtn('View Premium Record', `/exchange/redetermination/${e.enrollee_id}/premium-record`, { id: 'btn-view-premium-record', cls: 'btn btn-outline' })}
        ${e.issuer_ref ? linkBtn('Generate 834 Transaction', `/exchange/834?issuer=${encodeURIComponent(e.issuer_ref)}`, { id: 'btn-go-834', cls: 'btn btn-outline' }) : ''}</div></div>
    </div>`, { active: 'redetermination', wide: true });
}
function dlBlock(e, pr) {
  return dl([['Enrollee ID', h`<span id="enrollee-id-value">${e.enrollee_id}</span>`], ['Name', `${e.first_name} ${e.last_name}`], ['Platform', h`<span id="enrollee-platform-value">${e.platform}</span>`],
    ['State / Exchange', e.state], ['Benefit year', e.benefit_year], ['Prior coverage', h`<span id="prior-coverage-value">${e.prior_coverage_status}</span>`],
    ['Plan premium', h`<span id="plan-premium-value">${plain(e.plan_premium)}</span>`], ['Calculated APTC', h`<span id="calculated-aptc-value">${plain(e.calculated_aptc)}</span>`],
    ['Final APTC', h`<span id="final-aptc">${plain(e.final_aptc)}</span>`], ['Enrollee net monthly premium', h`<span id="enrollee-net-premium">${plain(pr.netPremium)}</span>`],
    ['$5 minimum premium applied', h`<span id="minimum-premium-applied">${e.minimum_premium_applied ? 'Yes' : 'No'}</span>`], ['Re-enrolled metal level', e.reenrolled_metal || '—'],
    ['Status', h`<span id="enrollee-status">${badge(e.status)}</span>`], ['Rule result', h`<span id="rule-result">${e.rule_result || '—'}</span>`]], 'enrollee-details');
}

getR('/exchange/redetermination', ctx => listPage(ctx));
postR('/exchange/redetermination', ctx => {
  try { const e = createEnrollee(ctx.body); ctx.flash('success', `Enrollee ${e.enrollee_id} created.`); return redirect(ctx.res, `/exchange/redetermination/${e.enrollee_id}`); }
  catch (e) { if (!(e instanceof InputError)) throw e; return listPage(ctx, ctx.body, [e.message]); }
});
postR('/exchange/redetermination/deadlines', ctx => guard(ctx, () => {
  for (const y of [2026, 2027]) if (ctx.body[`deadline_${y}`]) D.setParam(`plan_selection_deadline_${y}`, parseDate(ctx.body[`deadline_${y}`], `Deadline ${y}`));
  ctx.flash('success', 'Plan selection deadlines saved.'); return redirect(ctx.res, '/exchange/redetermination');
}, '/exchange/redetermination'));
getR('/exchange/redetermination/:id', ctx => { const e = getEnrollee(ctx.params.id); if (!e) return ctx.notFound('Enrollee not found.'); return detailPage(ctx, e, null); });
const back = ctx => `/exchange/redetermination/${ctx.params.id}`;
const step = (path, fn, msg) => postR(`/exchange/redetermination/:id/${path}`, ctx => {
  const e0 = getEnrollee(ctx.params.id); if (!e0) return ctx.notFound('Enrollee not found.');
  try { const r = fn(ctx); return detailPage(ctx, getEnrollee(ctx.params.id), msg(r, ctx)); }
  catch (e) { if (!(e instanceof InputError) && !(e instanceof R.RuleError)) throw e; return detailPage(ctx, getEnrollee(ctx.params.id), { kind: 'error', title: 'Action not completed', text: e.message }); }
});
step('update', ctx => updateEnrollee(ctx.params.id, ctx.body), () => ({ kind: 'success', title: 'Enrollee saved', text: 'Enrollee and plan details saved.' }));
step('redetermine', ctx => redetermine(ctx.params.id), r => ({ kind: 'success', title: 'Annual redetermination complete', text: `Annual redetermination run for ${r.enrollee_id}. Enter the calculated APTC.` }));
step('aptc', ctx => setAptc(ctx.params.id, ctx.body.aptc), r => ({ kind: 'success', title: 'APTC saved', text: `Calculated APTC ${money(r.calculated_aptc)}; net premium after APTC ${money(r.net_premium_before)}.` }));
step('applications', ctx => submitUpdatedApplication(ctx.params.id, ctx.body.submittedAt), r => ({ kind: 'success', title: 'Updated application submitted', text: `Submitted ${r.submittedAt}. ${r.note}` }));
step('reenroll', ctx => passiveReenroll(ctx.params.id), r => ({ kind: r.rule.applies ? 'warning' : 'success', title: 'Passive re-enrollment complete', text: `Re-enrolled in a ${r.crosswalk.targetMetal} plan. APTC ${money(r.rule.aptc)}, net premium ${money(r.rule.netPremium)}. ${r.rule.reason}` }));
step('minimum-premium', ctx => applyMinimumPremium(ctx.params.id), r => ({ kind: 'success', title: '$5 minimum premium adjustment', text: r.message }));
getR('/exchange/redetermination/:id/premium-record', ctx => {
  const e = getEnrollee(ctx.params.id); if (!e) return ctx.notFound('Enrollee not found.');
  const pr = premiumRecord(e);
  return ctx.render(`Premium record ${e.enrollee_id}`, h`${breadcrumb([['Annual Redetermination', '/exchange/redetermination'], [e.enrollee_id, back(ctx)], ['Premium record']])}
    <h1 id="page-title">Monthly premium record — ${e.enrollee_id}</h1>
    <div class="card">${dl([['Benefit year', e.benefit_year], ['Coverage effective', pr.coverageEffective], ['Plan premium', h`<span id="premium-record-plan-premium">${plain(pr.planPremium)}</span>`],
      ['APTC amount', h`<span id="premium-record-aptc" data-testid="premium-record-aptc">${plain(pr.aptc)}</span>`],
      ['Enrollee net premium', h`<span id="premium-record-net-premium" data-testid="premium-record-net-premium">${plain(pr.netPremium)}</span>`],
      ['$5 minimum premium applied', h`<span id="premium-record-minimum-applied">${pr.minimumPremiumApplied ? 'Yes' : 'No'}</span>`], ['Status', badge(pr.status)]], 'premium-record')}</div>`, { active: 'redetermination' });
});

getR('/exchange/834', ctx => {
  const files = D.all('SELECT * FROM edi_834_files ORDER BY id DESC');
  return ctx.render('834 Transactions', h`${breadcrumb([['Dashboard', '/exchange'], ['834 Transactions']])}<h1 id="page-title">834 enrollment transactions</h1>
    <form method="post" action="/exchange/834" class="card narrow" id="generate-834-form">
      ${field({ name: 'issuerRef', id: 'edi-issuer-id', label: 'Issuer ID', value: ctx.query.issuer || '', placeholder: 'ISS-12345', required: true })}
      <div class="actions">${button('Generate 834 Transaction', { id: 'btn-generate-834' })}</div></form>
    <div class="card"><h2>Generated files</h2>${table(['File', 'Issuer', 'Members', 'Created', ''], files.map(f => [f.file_number, f.issuer_ref, f.member_count, f.created_at.slice(0, 19).replace('T', ' '), h`<a href="/exchange/834/${f.file_number}" id="open-${f.file_number}">View</a>`]), { id: 'edi-files', empty: 'No 834 files generated.' })}</div>`, { active: '834' });
});
postR('/exchange/834', ctx => guard(ctx, () => { const f = generate834(ctx.body.issuerRef); ctx.flash('success', `${f.fileNumber} generated for issuer ${f.issuerId} (${f.memberCount} member(s)).`); return redirect(ctx.res, `/exchange/834/${f.fileNumber}`); }, `/exchange/834?issuer=${encodeURIComponent(ctx.body.issuerRef || '')}`));
getR('/exchange/834/:num', ctx => {
  let f; try { f = getFile(ctx.params.num); } catch { return ctx.notFound('834 file not found.'); }
  return ctx.render(f.fileNumber, h`${breadcrumb([['834 Transactions', '/exchange/834'], [f.fileNumber]])}<h1 id="page-title">834 transaction ${f.fileNumber}</h1>
    <div class="card">${dl([['Issuer ID', h`<span id="edi-issuer">${f.issuerId}</span>`], ['Members', f.memberCount], ['Created', f.createdAt.slice(0, 19).replace('T', ' ')]], 'edi-header')}</div>
    <div class="card"><h2>Members</h2>${table(['Enrollee ID', 'Name', 'Plan', 'Coverage effective', 'Total premium', 'APTC amount', 'Enrollee net premium'], f.members.map(m => [m.enrolleeId, m.name, m.planId || '—', m.coverageEffective, plain(m.totalPremium),
      h`<span id="edi-aptc-${m.enrolleeId}" data-testid="edi-aptc-${m.enrolleeId}">${plain(m.aptcAmount)}</span>`, h`<span id="edi-net-premium-${m.enrolleeId}" data-testid="edi-net-premium-${m.enrolleeId}">${plain(m.enrolleeNetPremium)}</span>`]), { id: 'edi-members' })}</div>
    <div class="card"><h2>File content</h2><pre id="edi-content" class="edi">${f.content}</pre></div>`, { active: '834' });
});

getR('/exchange/clock', ctx => {
  const c = clockInfo();
  return ctx.render('System Clock', h`<h1 id="page-title">System clock</h1>
    <p class="lead">Every date rule (open enrollment, plan selection deadlines, SEP verification, inconsistency deadlines) uses this date. Tests set it with "Set system date".</p>
    <div class="card">${dl([['System date', h`<span id="system-date-value" data-testid="system-date-value">${c.systemDate}</span>`], ['Mode', c.simulated ? 'Simulated' : 'Real date'], ['Real date', c.realDate]], 'clock-details')}
      <form method="post" action="/exchange/clock" class="narrow" id="clock-form">${field({ name: 'date', id: 'system-date', label: 'Set system date', value: c.systemDate })}
        <div class="actions">${button('Set System Date', { id: 'btn-set-system-date' })}</div></form>
      <form method="post" action="/exchange/clock/advance" class="inline">${field({ name: 'days', id: 'advance-days', label: 'Advance by (days)', value: '1' })}${button('Advance Date', { id: 'btn-advance-date', cls: 'btn btn-outline' })}</form>
      <form method="post" action="/exchange/clock" class="inline"><input type="hidden" name="date" value="real">${button('Use Real Date', { id: 'btn-use-real-date', cls: 'btn btn-link' })}</form></div>`, { active: 'clock' });
});
postR('/exchange/clock', ctx => guard(ctx, () => { const c = setClock(ctx.body.date); ctx.flash('success', `System date set to ${c.systemDate}${c.simulated ? '' : ' (real date)'}.`); return redirect(ctx.res, ctx.body.next || '/exchange/clock'); }, '/exchange/clock'));
postR('/exchange/clock/advance', ctx => guard(ctx, () => { const n = Number(ctx.body.days || 1); if (!Number.isInteger(n)) throw new InputError('Days must be a whole number.'); const c = setClock(R.addDays(D.today(), n)); ctx.flash('success', `System date advanced to ${c.systemDate}.`); return redirect(ctx.res, '/exchange/clock'); }, '/exchange/clock'));

// ---------- JSON API ----------
function api(ctx, fn, status = 200) {
  try { return json(ctx.res, fn(), status); }
  catch (e) { if (e instanceof InputError || e instanceof R.RuleError) return json(ctx.res, { error: e.message }, e.status || 400); throw e; }
}
const withRecord = e => ({ ...e, premiumRecord: premiumRecord(e), updatedApplications: apps(e.enrollee_id), planSelectionDeadline: deadlineFor(e.benefit_year) });
getR('/api/clock', ctx => json(ctx.res, clockInfo()));
postR('/api/clock', ctx => api(ctx, () => (ctx.body.advanceDays !== undefined ? setClock(R.addDays(D.today(), Number(ctx.body.advanceDays))) : setClock(ctx.body.date))));
getR('/api/redetermination/deadlines', ctx => json(ctx.res, { 2026: deadlineFor(2026), 2027: deadlineFor(2027) }));
postR('/api/redetermination/deadlines', ctx => api(ctx, () => { const y = Number(ctx.body.benefitYear || 2026); D.setParam(`plan_selection_deadline_${y}`, parseDate(ctx.body.deadline, 'Deadline')); return { benefitYear: y, deadline: deadlineFor(y) }; }));
getR('/api/redetermination/enrollees', ctx => json(ctx.res, D.all('SELECT * FROM redetermination_enrollees ORDER BY id').map(withRecord)));
postR('/api/redetermination/enrollees', ctx => api(ctx, () => withRecord(createEnrollee(ctx.body)), 201));
getR('/api/redetermination/enrollees/:id', ctx => api(ctx, () => withRecord(mustGet(ctx.params.id))));
postR('/api/redetermination/enrollees/:id', ctx => api(ctx, () => withRecord(updateEnrollee(ctx.params.id, ctx.body))));
postR('/api/redetermination/enrollees/:id/redetermine', ctx => api(ctx, () => withRecord(redetermine(ctx.params.id, ctx.body))));
postR('/api/redetermination/enrollees/:id/aptc', ctx => api(ctx, () => withRecord(setAptc(ctx.params.id, ctx.body.aptc))));
postR('/api/redetermination/enrollees/:id/applications', ctx => api(ctx, () => { const r = submitUpdatedApplication(ctx.params.id, ctx.body.submittedAt); return { ...r, enrollee: withRecord(r.enrollee) }; }));
postR('/api/redetermination/enrollees/:id/reenroll', ctx => api(ctx, () => { const r = passiveReenroll(ctx.params.id); return { ...r, enrollee: withRecord(r.enrollee) }; }));
postR('/api/redetermination/enrollees/:id/minimum-premium', ctx => api(ctx, () => { const r = applyMinimumPremium(ctx.params.id); return { ...r, enrollee: withRecord(r.enrollee) }; }));
getR('/api/redetermination/enrollees/:id/premium-record', ctx => api(ctx, () => premiumRecord(mustGet(ctx.params.id))));
postR('/api/834', ctx => api(ctx, () => generate834(ctx.body.issuerId || ctx.body.issuerRef), 201));
getR('/api/834/:num', ctx => api(ctx, () => getFile(ctx.params.num)));

module.exports = { parseDate, parseTimestamp, setClock, createEnrollee, updateEnrollee, redetermine, setAptc, submitUpdatedApplication, passiveReenroll, applyMinimumPremium, premiumRecord, generate834, InputError };
