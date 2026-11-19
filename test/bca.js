'use strict';
// End-to-end check of the 2025 CFR changes (Test Manager project BCA). Walks test cases BCA:40-49 step by step through the
// Exchange UI, then checks the other BCA requirements through the consumer flows, Exchange pages and rule API.
// Runs against a throwaway database:  npm run smoke:bca
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(os.tmpdir(), `aca-bca-${Date.now()}.db`);
let failures = 0; let passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.log('  FAIL:', msg); } };

let cookie = '';
async function req(method, url, form) {
  const opts = { method, redirect: 'manual', headers: { cookie } };
  if (form) { opts.body = new URLSearchParams(form).toString(); opts.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  let r = await fetch(BASE + url, opts);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let hops = 0;
  while (r.status === 303 && hops++ < 5) r = await fetch(BASE + r.headers.get('location'), { headers: { cookie } });
  return { status: r.status, url: r.url.replace(BASE, ''), text: await r.text() };
}
const api = async (method, url, body) => (await fetch(BASE + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const byId = (page, id) => { const m = new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`).exec(page.text); return m ? m[1].replace(/<[^>]+>/g, '').trim() : null; };
const has = (page, s) => page.text.includes(s) || page.text.includes(s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'));
const rule = async (id, q) => (await fetch(`${BASE}/api/rules/${id}?${new URLSearchParams(q)}`)).json();

// ---- Steps used by the Test Manager cases, as UI actions ----
const setDate = d => req('POST', '/exchange/clock', { date: d });
const create = (id, extra = {}) => req('POST', '/exchange/redetermination', { enrolleeId: id, platform: 'FFE', benefitYear: '2026', priorCoverageStatus: 'Active', ...extra });
const update = (id, f) => req('POST', `/exchange/redetermination/${id}/update`, f);
const redetermine = id => req('POST', `/exchange/redetermination/${id}/redetermine`, {});
const setAptc = (id, v) => req('POST', `/exchange/redetermination/${id}/aptc`, { aptc: v });
const submitApp = (id, ts) => req('POST', `/exchange/redetermination/${id}/applications`, { submittedAt: ts });
const deadline = (y, v) => req('POST', '/exchange/redetermination/deadlines', { [`deadline_${y}`]: v });
const reenroll = id => req('POST', `/exchange/redetermination/${id}/reenroll`, {});
const applyMin = id => req('POST', `/exchange/redetermination/${id}/minimum-premium`, {});
const detail = id => req('GET', `/exchange/redetermination/${id}`);
async function expectFinal(tc, id, aptc, net) {
  const p = await detail(id);
  ok(byId(p, 'final-aptc') === aptc, `${tc}: final APTC ${aptc} (got ${byId(p, 'final-aptc')})`);
  ok(byId(p, 'enrollee-net-premium') === net, `${tc}: net premium ${net} (got ${byId(p, 'enrollee-net-premium')})`);
  return p;
}

async function main() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...process.env, PORT: String(PORT), ACA_DB_PATH: dbFile, ACA_RESET_ON_START: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { child.stdout.on('data', d => { if (String(d).includes('running')) res(); }); child.on('exit', c => rej(new Error('server exited ' + c))); });
  try {
    // ================= BCA:40 =================
    let p = await setDate('November 15, 2025'); ok(byId(p, 'system-date-value') === '2025-11-15', 'BCA:40 set system date (long date format)');
    p = await create('ENR-2026-001'); ok(has(p, 'Enrollee ENR-2026-001 created'), 'BCA:40 create enrollee');
    await update('ENR-2026-001', { priorCoverageStatus: 'Active', planPremium: '$450.00' });
    p = await redetermine('ENR-2026-001'); ok(has(p, 'Annual redetermination complete'), 'BCA:40 run redetermination');
    p = await setAptc('ENR-2026-001', '$450.00'); ok(byId(p, 'net-premium-after-aptc') === '$0.00', 'BCA:40 net premium after APTC $0.00');
    ok(has(p, 'No updated eligibility application exists'), 'BCA:40 no updated application');
    p = await deadline(2026, 'December 15, 2025'); ok(has(p, 'Plan selection deadlines saved'), 'BCA:40 set deadline');
    await setDate('2025-12-16');
    p = await reenroll('ENR-2026-001'); ok(has(p, 'Passive re-enrollment complete'), 'BCA:40 passive re-enrollment');
    await expectFinal('BCA:40', 'ENR-2026-001', '$445.00', '$5.00');

    // ================= BCA:41 =================
    await setDate('2025-11-10'); await create('ENR-2026-002'); await update('ENR-2026-002', { planPremium: '380.00' });
    await deadline(2026, '2025-12-15'); await setDate('2025-12-10');
    p = await submitApp('ENR-2026-002', '2025-12-10 14:30:00'); ok(has(p, 'Submitted on or before the plan selection deadline'), 'BCA:41 app before deadline');
    await redetermine('ENR-2026-002'); await setAptc('ENR-2026-002', '380.00'); await setDate('2025-12-16');
    p = await reenroll('ENR-2026-002'); ok(has(p, 'not applied'), 'BCA:41 rule reports not applied');
    await expectFinal('BCA:41', 'ENR-2026-002', '$380.00', '$0.00');

    // ================= BCA:42 =================
    await setDate('2025-11-20'); await create('ENR-2026-003'); await update('ENR-2026-003', { planPremium: '520.00' });
    await redetermine('ENR-2026-003'); p = await setAptc('ENR-2026-003', '485.00'); ok(byId(p, 'net-premium-after-aptc') === '$35.00', 'BCA:42 net $35.00');
    await deadline(2026, 'December 15, 2025'); await setDate('2025-12-16'); await reenroll('ENR-2026-003');
    await expectFinal('BCA:42', 'ENR-2026-003', '$485.00', '$35.00');

    // ================= BCA:43 =================
    await setDate('2025-11-18'); await create('ENR-2026-004', { platform: 'SBE', state: 'California' }); await update('ENR-2026-004', { planPremium: '410.00' });
    await redetermine('ENR-2026-004'); await setAptc('ENR-2026-004', '410.00'); await deadline(2026, 'December 15, 2025'); await setDate('2025-12-16');
    await reenroll('ENR-2026-004'); await expectFinal('BCA:43', 'ENR-2026-004', '$410.00', '$0.00');

    // ================= BCA:44 =================
    await setDate('2025-11-12'); await create('ENR-2026-005'); await update('ENR-2026-005', { planPremium: '395.00', issuerRef: 'ISS-12345' });
    await redetermine('ENR-2026-005'); await setAptc('ENR-2026-005', '395.00'); await deadline(2026, 'December 15, 2025'); await setDate('2025-12-16');
    await reenroll('ENR-2026-005'); p = await applyMin('ENR-2026-005'); ok(has(p, 'already applied'), 'BCA:44 apply adjustment (already applied by re-enrollment)');
    p = await req('POST', '/exchange/834', { issuerRef: 'ISS-12345' }); ok(has(p, 'generated for issuer ISS-12345'), 'BCA:44 generate 834');
    ok(byId(p, 'edi-aptc-ENR-2026-005') === '$390.00', `BCA:44 834 APTC $390.00 (got ${byId(p, 'edi-aptc-ENR-2026-005')})`);
    ok(byId(p, 'edi-net-premium-ENR-2026-005') === '$5.00', 'BCA:44 834 net premium $5.00');
    ok(has(p, 'N1*75*APTC AMT~') && has(p, 'REF*9X*390.00~') && has(p, 'REF*9X*5.00~'), 'BCA:44 834 content segments');

    // ================= BCA:45 =================
    await setDate('2025-11-08'); await create('ENR-2026-006'); await update('ENR-2026-006', { planPremium: '425.00' });
    await redetermine('ENR-2026-006'); await setAptc('ENR-2026-006', '425.00'); await deadline(2026, 'December 15, 2025'); await setDate('2025-12-16');
    await reenroll('ENR-2026-006'); await applyMin('ENR-2026-006');
    p = await req('GET', '/exchange/redetermination/ENR-2026-006/premium-record');
    ok(byId(p, 'premium-record-aptc') === '$420.00', 'BCA:45 premium record APTC $420.00');
    ok(byId(p, 'premium-record-net-premium') === '$5.00', 'BCA:45 premium record net $5.00');

    // ================= BCA:46 =================
    await setDate('2025-11-05'); await create('ENR-2026-007'); await update('ENR-2026-007', { planPremium: '365.00' }); await deadline(2026, 'December 15, 2025');
    await redetermine('ENR-2026-007'); await setAptc('ENR-2026-007', '365.00'); await setDate('2025-12-15');
    p = await submitApp('ENR-2026-007', '2025-12-15 23:45:00'); ok(has(p, 'Submitted on or before the plan selection deadline'), 'BCA:46 app on deadline day');
    await setDate('2025-12-16'); await reenroll('ENR-2026-007'); await expectFinal('BCA:46', 'ENR-2026-007', '$365.00', '$0.00');

    // ================= BCA:47 =================
    await setDate('2025-11-03'); await create('ENR-2026-008'); await update('ENR-2026-008', { planPremium: '340.00' }); await deadline(2026, 'December 15, 2025');
    await redetermine('ENR-2026-008'); await setAptc('ENR-2026-008', '340.00'); await setDate('2025-12-16');
    await reenroll('ENR-2026-008'); await applyMin('ENR-2026-008'); await setDate('2025-12-17');
    p = await submitApp('ENR-2026-008', '2025-12-17 10:00:00'); ok(has(p, 'does not reverse'), 'BCA:47 late app does not reverse');
    await expectFinal('BCA:47', 'ENR-2026-008', '$335.00', '$5.00');

    // ================= BCA:48 =================
    await setDate('2026-11-10'); await create('ENR-2027-001', { benefitYear: '2027' }); await update('ENR-2027-001', { priorCoverageStatus: 'Active', planPremium: '475.00' });
    await redetermine('ENR-2027-001'); await setAptc('ENR-2027-001', '475.00'); await deadline(2027, 'December 31, 2026'); await setDate('2027-01-02');
    await reenroll('ENR-2027-001'); await expectFinal('BCA:48', 'ENR-2027-001', '$475.00', '$0.00');

    // ================= BCA:49 =================
    await setDate('2025-11-25'); await create('ENR-2026-009'); await update('ENR-2026-009', { planPremium: '502.50' });
    await redetermine('ENR-2026-009'); p = await setAptc('ENR-2026-009', '502.50'); ok(byId(p, 'net-premium-after-aptc') === '$0.00', 'BCA:49 net exactly $0.00');
    await deadline(2026, 'December 15, 2025'); await setDate('2025-12-16'); await reenroll('ENR-2026-009'); await applyMin('ENR-2026-009');
    await expectFinal('BCA:49', 'ENR-2026-009', '$497.50', '$5.00');

    // Guards
    p = await reenroll('ENR-2026-009'); ok(has(p, 'already re-enrolled'), 'cannot re-enroll twice');
    await setDate('2025-12-01'); await create('ENR-GUARD-1'); await update('ENR-GUARD-1', { planPremium: '100' }); await redetermine('ENR-GUARD-1'); await setAptc('ENR-GUARD-1', '100');
    p = await reenroll('ENR-GUARD-1'); ok(has(p, 'runs after the plan selection deadline'), 'no re-enrollment before the deadline');
    const apiEnr = await api('GET', '/api/redetermination/enrollees/ENR-2026-005'); ok(apiEnr.premiumRecord.aptc === 390 && apiEnr.premiumRecord.netPremium === 5, 'API premium record');
    ok((await api('GET', '/api/redetermination/enrollees/ENR-DEMO-001')).reenrolled_metal === null, 'seeded demo enrollee present');

    // ================= BCA:11 crosswalk =================
    await api('POST', '/api/clock', { date: '2025-11-20' });
    await api('POST', '/api/redetermination/enrollees/ENR-DEMO-001/redetermine', { aptc: '200' });
    await api('POST', '/api/clock', { date: '2025-12-16' });
    const cw = await api('POST', '/api/redetermination/enrollees/ENR-DEMO-001/reenroll'); ok(cw.crosswalk && cw.crosswalk.targetMetal === 'Bronze', 'BCA:11 CSR bronze stays bronze');

    // ================= Consumer flows (BCA:2, 4-10, 14-17) =================
    await setDate('2025-11-15');
    p = await req('POST', '/login', { email: 'jane.consumer@example.com', password: 'Password123!', next: '/dashboard' }); ok(has(p, 'Welcome, Jane'), 'login');
    const apply = async ({ year = '2026', status = 'citizen', income = '32000', tax = '', alt = '' }) => {
      let q = await req('POST', '/apply/start', { zip: '78701', coverageYear: year });
      const num = /APP-\d{4}-\d{6}/.exec(q.url)[0];
      await req('POST', `/apply/${num}/household`, { m0_first_name: 'Jane', m0_last_name: 'Consumer', m0_dob: '1986-03-14', m0_sex: 'F', m0_relationship: 'Self', m0_applying: '1', m0_tobacco: '0', m0_immigration_status: status, m0_medicaid_ineligible_immigration: '0' });
      await req('POST', `/apply/${num}/income`, { i0_member_name: 'Jane Consumer', i0_income_type: 'Job', i0_employer: 'Acme', i0_annual_amount: income, taxDataIncome: tax, alternateDataIncome: alt });
      q = await req('POST', `/apply/${num}/submit`, { agentNpn: '', agree: '1', signature: 'Jane Consumer' });
      return { num, page: q };
    };
    let a = await apply({ status: 'daca', tax: '32000' });
    ok(has(a.page, 'Not eligible for QHP enrollment, APTC or CSR') && !has(a.page, 'btn-continue-to-plans'), 'BCA:2 DACA applicant not eligible');
    a = await apply({ status: 'deferred_action', tax: '32000' });
    ok(has(a.page, 'All applicants eligible to enroll'), 'BCA:2 non-DACA deferred action eligible');
    ok(has(a.page, 'APTC denied') && has(a.page, '155.305(f)(4)(iii)'), 'BCA:6 PY2026 single FTR year denies APTC');
    a = await apply({ year: '2027', tax: '32000' });
    ok(has(a.page, 'APTC eligible') && has(a.page, '155.305(f)(4)(i)'), 'BCA:4 PY2027 one FTR year: warning only');
    a = await apply({ income: '22000', tax: '12000' });
    ok(has(a.page, 'Inconsistency INC-') && has(a.page, '2026-02-13'), 'BCA:8 sub-100% FPL income increase opens 90-day inconsistency');
    a = await apply({ income: '32000', tax: '' });
    ok(has(a.page, 'Inconsistency INC-'), 'BCA:10 PY2026 no tax data -> inconsistency');
    a = await apply({ year: '2027', income: '32000', tax: '' });
    ok(has(a.page, 'Attestation accepted (no tax data)'), 'BCA:10 PY2027 no tax data -> attestation accepted');
    a = await apply({ income: '22000', alt: '12000' });
    ok(has(a.page, 'Household income (alternate data)') || has(a.page, 'Inconsistency INC-'), 'BCA:9 alternate data path check');

    // BCA:7 deadline check ends APTC after day 90
    await setDate('2026-02-14');
    p = await req('POST', '/exchange/inconsistencies/deadline-check', {}); ok(has(p, 'expired'), 'BCA:7 deadline check runs');
    ok(has(p, 'Expired - APTC/CSR Ended'), 'BCA:7 expired inconsistency ends APTC/CSR');

    // BCA:14, 16 enrollment window and effective date (PY2026)
    await setDate('2025-12-20');
    a = await apply({ tax: '32000', status: 'citizen' });
    p = await req('GET', `/apply/${a.num}/plans`); ok(byId(p, 'oep-effective-date') === '2026-01-01', 'BCA:16 Dec 20 selection -> Jan 1, 2026');
    await setDate('2026-01-10'); p = await req('GET', `/apply/${a.num}/plans`); ok(byId(p, 'oep-effective-date') === '2026-02-01', 'BCA:16 Jan 10 selection -> Feb 1, 2026');
    await setDate('2026-01-16'); p = await req('POST', `/apply/${a.num}/enroll`, { planId: '10101TX0010001' }); ok(has(p, 'Open Enrollment is closed'), 'BCA:14 OEP closed Jan 16, 2026');
    // BCA:15, 17 PY2027: Jan 1 effective date, closes Dec 31
    await setDate('2026-12-31');
    a = await apply({ year: '2027', tax: '32000' });
    p = await req('POST', `/apply/${a.num}/enroll`, { planId: '10101TX0010001' }); ok(has(p, '2027-01-01'), 'BCA:17 PY2027 selection Dec 31 -> Jan 1, 2027');
    await setDate('2027-01-01'); a = await apply({ year: '2027', tax: '32000' });
    p = await req('POST', `/apply/${a.num}/enroll`, { planId: '10101TX0010001' }); ok(has(p, 'Open Enrollment is closed'), 'BCA:15 PY2027 OEP closed Jan 1, 2027');
    p = await req('POST', '/exchange/parameters', { key: 'oep_end_2027', value: '2027-01-15' }); ok(has(p, 'not saved'), 'BCA:15 OEP after Dec 31 rejected');
    p = await req('POST', '/exchange/parameters', { key: 'oep_start_2027', value: '2026-10-01' }); ok(has(p, '9 weeks'), 'BCA:15 OEP over 63 days rejected');

    // BCA:22 SEP verification in 2026; BCA:21 d(16) not before 2027
    await setDate('2026-03-01');
    a = await apply({ tax: '32000' });
    p = await req('POST', '/sep', { app: a.num, sepType: 'move', eventDate: '2026-02-20', planId: '10101TX0010001', documents: 'none' });
    ok(has(p, 'Denied - Eligibility Not Verified') && has(p, '155.505(b)(1)(iii)'), 'BCA:22 unverified SEP denied with appeal rights');
    p = await req('POST', '/sep', { app: a.num, sepType: 'move', eventDate: '2026-02-20', planId: '10101TX0010001', documents: 'provided' });
    ok(has(p, 'Special enrollment approved') && byId(p, 'sep-effective-date') === '2026-04-01', 'BCA:22 verified SEP approved, effective Apr 1');
    p = await req('POST', '/sep', { app: a.num, sepType: 'd16', eventDate: '2026-03-01', planId: '10101TX0030001', documents: 'provided' });
    ok(has(p, 'Denied - SEP Not Available'), 'BCA:21 d(16) not available in 2026');
    p = await req('GET', '/exchange/sep'); ok(has(p, '50%'), 'BCA:22 verification rate shown');

    // Plan validation (BCA:24, 25, 28, 38)
    p = await req('GET', '/exchange/plan-validation/10101TX0010001'); ok(has(p, 'Routine non-pediatric dental services is classified as EHB'), 'BCA:24 2026 adult dental as EHB flagged');
    p = await req('GET', '/exchange/plan-validation/10202TX0050001'); ok(has(p, 'Specified sex-trait modification procedure'), 'BCA:24/30 sex-trait procedure as EHB flagged');
    const v = await api('GET', '/api/plan-validation/10101TX0070001'); ok(v.issues.some(i => i.includes('156.201(c)')), 'BCA:28 duplicate standardized plan flagged');
    const ns = await api('GET', '/api/plan-validation/10202TX0100001'); ok(ns.issues.some(i => i.includes('156.202(b)')), 'BCA:38 over-limit non-standardized cell flagged');

    // Agents (BCA:3, 34)
    p = await req('POST', '/exchange/agents/17000002/suspend', { ground: 'standards_of_conduct', notes: 'test' }); ok(has(p, 'suspended from Exchange systems'), 'BCA:3 suspension');
    p = await req('POST', '/exchange/agents/17000002/reinstate', { resolution: '' }); ok(has(p, 'remedied or sufficiently mitigated'), 'BCA:3 lift needs remediation basis');
    p = await req('POST', '/exchange/agents/17000002/reinstate', { resolution: 'Retraining completed' }); ok(has(p, 'reinstated') && has(p, '155.220(k)(3)'), 'BCA:3 lifted with authority recorded');
    p = await req('POST', '/exchange/agents/17000003/terminate', { evidentiaryBasis: '' }); ok(has(p, 'Document the evidentiary basis'), 'BCA:34 termination blocked without evidence');
    p = await req('POST', '/exchange/agents/17000003/terminate', { evidentiaryBasis: 'Enrollment audit of 40 files', preponderance: '1' }); ok(has(p, 'Terminated for Cause') && has(p, 'Preponderance of the evidence'), 'BCA:34 termination recorded');

    // Reconsideration instructions (BCA:32), FTR notices (BCA:5/6), data inaccuracy overdue (BCA:35)
    p = await req('POST', '/exchange/notices/generate', { planYear: '2026' }); ok(has(p, 'FTR Denial Notice - Plan Year 2026'), 'BCA:6 PY2026 FTR denial notices');
    ok(!/Indirect notice[^<]*IRS data shows/.test(p.text), 'BCA:5 indirect notices do not cite IRS data');
    await setDate('2026-11-10'); p = await req('GET', '/exchange/data-inaccuracy'); ok(has(p, 'Overdue - Flagged for HHS Review'), 'BCA:35 overdue report flagged');

    // ================= Every new page renders cleanly =================
    for (const u of ['/exchange', '/exchange/redetermination', '/exchange/redetermination/ENR-2026-005', '/exchange/redetermination/ENR-2026-005/premium-record', '/exchange/834',
      '/exchange/inconsistencies', '/exchange/sep', '/exchange/plan-validation', '/exchange/plan-validation?year=2025', '/exchange/plan-validation/10101TX0010001', '/exchange/clock',
      '/exchange/tools', '/exchange/agents/17000001', '/exchange/agents/17000003', '/exchange/notices', '/exchange/parameters', '/exchange/data-inaccuracy/DIR-2026-0001', '/dashboard', '/sep/new',
      ...(await api('GET', '/api/rules')).filter(t => t.requirements.some(r => r.startsWith('BCA'))).map(t => `/exchange/tools/${t.id}`)]) {
      const pg = await req('GET', u);
      ok(pg.status === 200, `${u} returns 200 (got ${pg.status})`);
      ok(!/undefined|\[object [A-Za-z]+\]|>NaN</.test(pg.text), `${u} has no undefined/[object]/NaN text`);
    }
    for (const t of (await api('GET', '/api/rules')).filter(x => x.requirements.every(r => r.startsWith('BCA')))) {
      const q = Object.fromEntries(t.inputs.map(i => [i.name, i.default ?? (i.options ? i.options[0] : '')]));
      const r = await (await fetch(`${BASE}/api/rules/${t.id}?${new URLSearchParams(q)}`)).json();
      ok(r.outcome || r.error, `${t.id} runs with default inputs (${r.error || 'ok'})`);
      ok(!r.error, `${t.id} default inputs are valid (${r.error || ''})`);
    }

    // ================= Rule API =================
    ok((await rule('lawful-presence', { status: 'daca' })).result.eligible === false, 'lawful-presence DACA');
    ok((await rule('ftr-eligibility', { planYear: '2025', failedYears: '2', channel: 'indirect' })).result.rule === '45 CFR 155.305(f)(4)(ii)', 'ftr 2-year rule');
    ok((await rule('inconsistency-deadline', { noticeDate: '2026-01-01', type: 'income', extension: '0' })).result.deadline === '2026-04-01', 'inconsistency 90 days');
    const iic = q => rule('income-increase-check', { planYear: '2026', path: 'basic', householdSize: '1', thresholdPct: '10', lpMedicaidIneligible: 'no', ...q });
    ok((await iic({ dataIncome: '15000', attestedIncome: '16500' })).result.triggered === false, 'exactly 10% does not trigger');
    ok((await iic({ dataIncome: '15000', attestedIncome: '16600' })).result.triggered === true, 'above 10% triggers');
    ok((await iic({ dataIncome: '15000', attestedIncome: '16600', lpMedicaidIneligible: 'yes' })).result.triggered === false, 'immigration exception');
    ok((await iic({ planYear: '2027', dataIncome: '15000', attestedIncome: '20000' })).result.triggered === false, 'not applied PY2027');
    ok((await rule('minimum-premium', { benefitYear: '2026', platform: 'SBE-FP', grossPremium: '300', aptc: '300', updatedAppDate: '', deadline: '2025-12-15' })).result.applies === true, 'SBE-FP is Federal platform');
    ok((await rule('threshold-config', { planYear: '2026', policies: 'gross98' })).result.valid === false, '2026 gross threshold rejected');
    ok((await rule('premium-threshold', { issuer: '2', paymentType: 'ongoing', grossPremium: '600', aptc: '400', amountPaid: '195', planYear: '2026' })).result.sufficient === false, '2026 ignores gross/fixed thresholds');
    ok((await rule('premium-threshold', { issuer: '2', paymentType: 'ongoing', grossPremium: '600', aptc: '400', amountPaid: '195', planYear: '2027' })).result.sufficient === true, '2027 fixed-dollar threshold');
    ok((await rule('oep-window', { benefitYear: '2027' })).result.valid === true, 'PY2027 OEP valid');
    ok((await rule('sep-d16', { planYear: '2027', fplPercent: '150', aptcEligible: 'yes', currentMetal: 'Bronze', newMetal: 'Silver', selectionDate: '2027-03-10' })).result.change.allowed === true, 'd16 silver change 2027');
    ok((await rule('sep-d16', { planYear: '2027', fplPercent: '151', aptcEligible: 'yes', currentMetal: '', newMetal: 'Silver', selectionDate: '2027-03-10' })).result.availability.available === false, 'd16 151% FPL');
    ok((await rule('sep-verification', { date: '2027-01-01', platform: 'FFE', verified: 'no' })).result.required === false, 'SEP verification ends 2027');
    ok((await rule('sep-verification-rate', { verified: '74', total: '100' })).result.meets === false, '74% below standard');
    ok((await rule('ehb-benchmark', { singleCategory: 'no', women: 'yes', children: 'no', disabilities: 'yes', discriminatory: 'no' })).result.outcome === 'Flagged for review', 'EHB benchmark (iv)');
    ok((await rule('ehb-prohibited', { planYearStart: '2027-01-01', benefit: 'routine_adult_dental' })).result.mayBeEhb === true, '2027 adult dental may be EHB');
    ok((await rule('ehb-prohibited', { planYearStart: '2026-07-01', benefit: 'sex_trait_modification' })).result.mayBeEhb === false, 'Jul 2026 sex-trait prohibited');
    ok((await rule('ehb-prohibited', { planYearStart: '2025-12-01', benefit: 'sex_trait_modification' })).result.mayBeEhb === true, 'Dec 2025 sex-trait not in list');
    const av = q => rule('av-de-minimis', { qualifyingBronze: 'no', ...q });
    ok((await av({ metal: 'Silver', av: '65.9' })).result.pass === false && (await av({ metal: 'Silver', av: '66' })).result.pass === true, 'silver -4 pp floor');
    ok((await av({ metal: 'Silver', av: '68.5' })).result.pass === true, 'BCA:26 68.5% silver passes');
    ok((await av({ metal: 'Bronze', av: '65.1', qualifyingBronze: 'yes' })).result.pass === false && (await av({ metal: 'Bronze', av: '64.9', qualifyingBronze: 'yes' })).result.pass === true, 'qualifying bronze +5 pp');
    ok((await rule('preponderance', { support: '50' })).result.established === false, '50/50 not established');
    ok((await rule('termination-for-cause', { evidentiaryBasis: 'x', standardMet: 'yes' })).result.allowed === true, 'termination allowed');
    ok((await rule('chronic-exception-cell', { plan: '20303OH0200001', exceptedCost: '750', comparatorCost: '1000' })).result.comparators.length === 1, 'BCA:39 comparator cell excludes dental sub-dimension plan');
    const reqs = await api('GET', '/api/requirements'); ok(Array.from({ length: 38 }, (_, i) => `BCA:${i + 2}`).every(k => reqs[k]), 'all 38 BCA requirements traced');
  } finally {
    child.kill();
    setTimeout(() => { try { fs.unlinkSync(dbFile); } catch { /* ignore */ } }, 300);
  }
  console.log(`\n${passes} checks passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
