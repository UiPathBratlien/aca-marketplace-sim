'use strict';
// End-to-end HTTP smoke test. Walks every Test Manager case (ACA:151-160) step by step, plus consumer and rule checks.
// Runs against a throwaway database:  npm run smoke
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(os.tmpdir(), `aca-smoke-${Date.now()}.db`);
let failures = 0; let passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; } else { failures++; console.log('  FAIL:', msg); } };

let cookie = '';
async function req(method, url, form) {
  const opts = { method, redirect: 'manual', headers: { cookie } };
  if (form) { opts.body = new URLSearchParams(form).toString(); opts.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  let r = await fetch(BASE + url, opts);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  let hops = 0;
  while (r.status === 303 && hops++ < 5) { r = await fetch(BASE + r.headers.get('location'), { headers: { cookie } }); }
  return { status: r.status, url: r.url.replace(BASE, ''), text: await r.text() };
}
const has = (page, s) => page.text.includes(s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')) || page.text.includes(s);
function expectAll(page, list, tc) { list.forEach(s => ok(has(page, s), `${tc}: expected "${s}" on ${page.url}`)); }

async function checklistIds(planId, section) {
  const r = await (await fetch(`${BASE}/api/qhp-certifications/${planId}`)).json();
  return r;
}

async function main() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')],
    { env: { ...process.env, PORT: String(PORT), ACA_DB_PATH: dbFile, ACA_RESET_ON_START: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { child.stdout.on('data', d => { if (String(d).includes('running')) res(); }); child.on('exit', c => rej(new Error('server exited ' + c))); });
  try {
    // Helper to find checklist item row ids from the review page HTML
    const itemName = (html, label) => { const m = new RegExp(`name="(item_\\d+)" id="status-${label}"`).exec(html); return m && m[1]; };

    // ---- ACA:151 ----
    let p = await req('GET', '/exchange'); expectAll(p, ['New Certification Review'], 'ACA:151');
    p = await req('GET', '/exchange/workflow/new'); expectAll(p, ['Plan identifier', 'Load Plan Details'], 'ACA:151');
    p = await req('POST', '/exchange/open', { section: 'general', back: '/exchange/workflow/new', planIdentifier: 'QHP-2026-001' });
    expectAll(p, ['General Certification Criteria', 'Network Adequacy Standards', 'Non-Compliant', 'Denial reason', 'Deny Certification',
      'Are you sure you want to deny certification for QHP-2026-001?', 'Confirm Denial'], 'ACA:151');
    let f = { section: 'general', action: 'deny', reason: 'Plan fails to meet network adequacy requirements under 45 CFR 155.1000(c)(1)' };
    f[itemName(p.text, 'network-adequacy-standards')] = 'Non-Compliant';
    p = await req('POST', '/exchange/review/QHP-2026-001/deny', f);
    expectAll(p, ['Certification denied', 'Denied', '45 CFR 155.1000(c)'], 'ACA:151');
    p = await req('GET', '/exchange/plans/QHP-2026-001'); expectAll(p, ['Denied', 'Plan fails to meet network adequacy requirements under 45 CFR 155.1000(c)(1)', '45 CFR 155.1000(c)'], 'ACA:151');

    // ---- ACA:152 ----
    p = await req('GET', '/exchange/queue'); expectAll(p, ['Certification Queue', 'Pending certifications', 'QHP-2026-002', 'Begin Certification Review'], 'ACA:152');
    p = await req('POST', '/exchange/open', { section: 'general', back: '/exchange/queue', planId: 'QHP-2026-002' });
    p = await req('GET', '/exchange/review/QHP-2026-002?section=ehb');
    expectAll(p, ['Essential Health Benefits', 'Pediatric Dental Services', 'Not Covered', 'Denial reason', 'Failure to meet 45 CFR 155.1000(c)(2) - Essential Health Benefits', 'Additional comments', 'Issue Denial'], 'ACA:152');
    f = { section: 'ehb', reason: 'Failure to meet 45 CFR 155.1000(c)(2) - Essential Health Benefits', notes: 'Plan does not provide required pediatric dental services coverage' };
    f[itemName(p.text, 'pediatric-dental-services')] = 'Not Covered';
    p = await req('POST', '/exchange/review/QHP-2026-002/deny', f);
    expectAll(p, ['45 CFR 155.1000(c)(2)', 'Certification Denied'], 'ACA:152');

    // ---- ACA:153 ----
    p = await req('GET', '/exchange/active?q=QHP-2026-003'); expectAll(p, ['Active Certifications', 'Search', 'QHP-2026-003', 'Review Certification Status'], 'ACA:153');
    p = await req('GET', '/exchange/review/QHP-2026-003?section=av'); expectAll(p, ['Actuarial Value', '58%', 'Bronze', 'Flag Non-Compliance', 'Violation type', 'Actuarial Value Below Required Threshold', 'Justification', 'Deny Certification'], 'ACA:153');
    p = await req('POST', '/exchange/review/QHP-2026-003/deny', { section: 'av', reason: 'Actuarial Value Below Required Threshold', notes: 'Bronze plan actuarial value of 58% fails to meet 60% minimum under 45 CFR 155.1000(c)' });
    expectAll(p, ['Certification denial confirmed', '45 CFR 155.1000(c)'], 'ACA:153');

    // ---- ACA:154 ----
    p = await req('GET', '/exchange/submissions'); expectAll(p, ['New Plan Submissions', 'QHP-2026-004', 'Start Certification Process'], 'ACA:154');
    p = await req('GET', '/exchange/review/QHP-2026-004?section=network'); expectAll(p, ['Provider Network', 'Analyze Network Adequacy', 'Insufficient primary care providers in rural counties', 'Network adequacy assessment', 'Failed', 'Denial basis', 'Network Adequacy Non-Compliance per 45 CFR 155.1000(c)', 'Denial notes', 'Execute Denial'], 'ACA:154');
    p = await req('POST', '/exchange/review/QHP-2026-004/deny', { section: 'network', assessment: 'Failed', reason: 'Network Adequacy Non-Compliance per 45 CFR 155.1000(c)', notes: 'Plan network fails to provide adequate access to primary care in 3 rural counties as required by general certification criteria' });
    expectAll(p, ['Denial letter', '45 CFR 155.1000(e)'], 'ACA:154');

    // ---- ACA:155 ----
    p = await req('GET', '/exchange/login'); expectAll(p, ['Sign In'], 'ACA:155');
    p = await req('POST', '/login', { email: 'reviewer@exchange.test', password: 'Password123!', next: '/exchange' }); expectAll(p, ['Riley Reviewer'], 'ACA:155');
    p = await req('GET', '/exchange/reviews?filter=in_progress'); expectAll(p, ['Certification Reviews', 'In-Progress Reviews', 'QHP-2026-005', 'Continue Review'], 'ACA:155');
    p = await req('GET', '/exchange/review/QHP-2026-005?section=cost'); expectAll(p, ['Cost-Sharing Limits', '$10,500', '$9,450', 'Cost-sharing evaluation', 'Non-Compliant', 'Exceeds Maximum Out-of-Pocket Limits - 45 CFR 155.1000(c)', 'Explanation', 'Deny Certification'], 'ACA:155');
    p = await req('POST', '/exchange/review/QHP-2026-005/deny', { section: 'cost', assessment: 'Non-Compliant', reason: 'Exceeds Maximum Out-of-Pocket Limits - 45 CFR 155.1000(c)', notes: 'Plan out-of-pocket maximum of $10,500 exceeds 2026 regulatory limit of $9,450' });
    expectAll(p, ['general certification criteria', 'Riley Reviewer'], 'ACA:155');

    // ---- ACA:156 ----
    p = await req('GET', '/exchange/pending'); expectAll(p, ['Pending Certifications', 'Plan ID', 'Retrieve Plan'], 'ACA:156');
    p = await req('POST', '/exchange/open', { section: 'general', back: '/exchange/pending', planIdentifier: 'QHP-2026-006' }); ok(p.url.includes('QHP-2026-006'), 'ACA:156 retrieve plan');
    p = await req('GET', '/exchange/review/QHP-2026-006?section=benefit'); expectAll(p, ['Benefit Design Review', 'Discrimination Analysis', 'HIV medication coverage limited to $500 monthly cap', 'Discriminatory Design Detected', 'Denial category', 'Benefit Design Discrimination - 45 CFR 155.1000(c)', 'Denial justification', 'Initiate Denial Process'], 'ACA:156');
    p = await req('POST', '/exchange/review/QHP-2026-006/deny', { section: 'benefit', assessment: 'Discriminatory Design Detected', reason: 'Benefit Design Discrimination - 45 CFR 155.1000(c)', notes: 'Plan imposes discriminatory coverage limit on HIV medications in violation of non-discrimination requirements' });
    expectAll(p, ['Denial workflow activated', 'Discrimination violation cited', 'Denied - Discrimination Violation'], 'ACA:156');

    // ---- ACA:157 ----
    p = await req('GET', '/exchange/workflow'); expectAll(p, ['Certification Workflow', 'Quality Standards Review'], 'ACA:157');
    p = await req('GET', '/exchange/workflow/quality'); expectAll(p, ['Plan identifier', 'Load Plan for Review'], 'ACA:157');
    p = await req('POST', '/exchange/open', { section: 'qis', back: '/exchange/workflow/quality', planIdentifier: 'QHP-2026-007' });
    expectAll(p, ['Quality Improvement Strategy', 'No quality improvement strategy document provided', 'Missing', 'Denial basis', 'Failure to Submit Quality Improvement Strategy - 45 CFR 155.1000(c)', 'Comments', 'Process Denial'], 'ACA:157');
    p = await req('POST', '/exchange/review/QHP-2026-007/deny', { section: 'qis', assessment: 'Missing', reason: 'Failure to Submit Quality Improvement Strategy - 45 CFR 155.1000(c)', notes: 'Plan has not provided required quality improvement strategy documentation as mandated by general certification criteria' });
    expectAll(p, ['Denial confirmed', 'Quality Improvement Strategy'], 'ACA:157');

    // ---- ACA:158 ----
    p = await req('GET', '/exchange/comprehensive'); expectAll(p, ['Comprehensive Reviews', 'QHP-2026-008', 'Begin Full Certification Assessment'], 'ACA:158');
    p = await req('POST', '/exchange/open', { section: 'summary', back: '/exchange/comprehensive', planId: 'QHP-2026-008' });
    expectAll(p, ['Compliance Summary', 'Network Adequacy: Failed', 'Essential Health Benefits: Failed', 'Actuarial Value: Failed', 'Aggregate Violations', 'Denial type', 'Multiple General Certification Criteria Failures - 45 CFR 155.1000(c)', 'Comprehensive denial notes', 'Issue Comprehensive Denial'], 'ACA:158');
    p = await req('POST', '/exchange/review/QHP-2026-008/deny', { section: 'summary', reason: 'Multiple General Certification Criteria Failures - 45 CFR 155.1000(c)', notes: 'Plan fails network adequacy, essential health benefits coverage, and actuarial value requirements under general certification criteria' });
    expectAll(p, ['Network Adequacy: Failed', 'Essential Health Benefits: Failed', 'Actuarial Value: Failed', 'Denied - Multiple Criteria Failures', '45 CFR 155.1000(e)'], 'ACA:158');

    // ---- ACA:159 ----
    p = await req('GET', '/exchange/transparency?q=QHP-2026-009'); expectAll(p, ['Transparency Compliance', 'Plan search', 'Search Plans', 'QHP-2026-009', 'Review Transparency Requirements'], 'ACA:159');
    p = await req('POST', '/exchange/open', { section: 'transparency', back: '/exchange/transparency', planId: 'QHP-2026-009' });
    expectAll(p, ['Machine-Readable Files', 'In-Network Rates File: Not Submitted', 'Transparency compliance', 'Transparency in Coverage Violation - 45 CFR 155.1000(c)', 'Denial explanation', 'Deny Certification'], 'ACA:159');
    p = await req('POST', '/exchange/review/QHP-2026-009/deny', { section: 'transparency', assessment: 'Non-Compliant', reason: 'Transparency in Coverage Violation - 45 CFR 155.1000(c)', notes: 'Plan failed to submit required machine-readable in-network rates file as mandated by transparency requirements' });
    expectAll(p, ['Certification denial processed', 'Transparency in Coverage'], 'ACA:159');

    // ---- ACA:160 ----
    p = await req('GET', '/exchange/accreditation'); expectAll(p, ['Accreditation Verification', 'New Accreditation Review'], 'ACA:160');
    p = await req('GET', '/exchange/accreditation/new'); expectAll(p, ['Plan identifier', 'Retrieve Plan Data'], 'ACA:160');
    p = await req('POST', '/exchange/open', { section: 'accreditation', back: '/exchange/accreditation/new', planIdentifier: 'QHP-2026-010' });
    expectAll(p, ['Accreditation Status', 'No valid accreditation from recognized entity', 'Expired: 12/31/2025', 'Non-Compliant', 'Lack of Required Accreditation - 45 CFR 155.1000(c)', 'Denial rationale', 'Execute Certification Denial'], 'ACA:160');
    p = await req('POST', '/exchange/review/QHP-2026-010/deny', { section: 'accreditation', assessment: 'Non-Compliant', reason: 'Lack of Required Accreditation - 45 CFR 155.1000(c)', notes: 'Plan accreditation expired on 12/31/2025 and no current accreditation exists as required by general certification criteria' });
    expectAll(p, ['Denial notification generated', 'Accreditation', 'Certification Denied - Accreditation Failure', '45 CFR 155.1000(e)'], 'ACA:160');

    // ---- Negative: validation ----
    p = await req('POST', '/exchange/review/QHP-2026-011/deny', { section: 'cost', assessment: 'Compliant', reason: 'Exceeds Maximum Out-of-Pocket Limits - 45 CFR 155.1000(c)', notes: 'x' });
    expectAll(p, ['Certification can only be denied when the assessment indicates non-compliance'], 'negative');
    p = await req('POST', '/exchange/open', { section: 'general', back: '/exchange/workflow/new', planIdentifier: 'QHP-9999-999' });
    expectAll(p, ['No plan found with identifier QHP-9999-999'], 'negative');

    // ---- Reconsideration ----
    const den = (await (await fetch(`${BASE}/api/denials`)).json()).find(d => d.plan_id === 'QHP-2026-005');
    p = await req('POST', '/exchange/reconsiderations', { denial: den.denial_number, receivedOn: '2099-01-01', evidenceStandard: 'clear_and_convincing', evidenceSummary: 'late' });
    expectAll(p, ['Rejected - Untimely'], 'ACA:43');

    // ---- Consumer flow ----
    cookie = '';
    p = await req('POST', '/account/create', { firstName: 'Test', lastName: 'Person', email: 'test.person@example.com', password: 'Passw0rd!', confirmPassword: 'Passw0rd!', terms: '1' });
    expectAll(p, ['Welcome, Test'], 'consumer');
    p = await req('POST', '/apply/start', { zip: '78701', coverageYear: '2026' }); const appNum = /APP-\d{4}-\d{6}/.exec(p.url)[0];
    p = await req('POST', `/apply/${appNum}/household`, { m0_first_name: 'Test', m0_last_name: 'Person', m0_dob: '1985-06-01', m0_sex: 'F', m0_relationship: 'Self', m0_applying: '1', m0_tobacco: '0' });
    p = await req('POST', `/apply/${appNum}/income`, { i0_member_name: 'Test Person', i0_income_type: 'Job', i0_employer: 'Acme', i0_annual_amount: '32000' });
    p = await req('POST', `/apply/${appNum}/submit`, { agentNpn: '', agree: '1', signature: 'Test Person' });
    expectAll(p, ['Application submitted', 'per month'], 'consumer');
    p = await req('POST', `/apply/${appNum}/enroll`, { planId: '10101TX0010001' }); expectAll(p, ['Enrollment confirmation', 'Pending Binder Payment'], 'consumer');
    const enrNum = /ENR-\d{4}-\d{6}/.exec(p.url)[0];
    p = await req('POST', `/enrollments/${enrNum}/pay`, { paymentType: 'binder', amount: '9999' }); expectAll(p, ['Payment accepted', 'Enrolled - Coverage Active'], 'consumer');
    p = await req('POST', '/appeals', { filerRole: 'application_filer', filerName: 'Test Person', appellantName: 'Kid Person', reason: 'Wrong income' }); expectAll(p, ['Accepted for Review'], 'ACA:41');

    // ---- Rules API ----
    const rule = async (id, q) => (await (await fetch(`${BASE}/api/rules/${id}?${new URLSearchParams(q)}`)).json());
    ok((await rule('bhp-paf', { implementation: 'partial', csrAdjustment: '0.15' })).result.paf === 1.0435, 'bhp-paf partial');
    ok((await rule('bhp-paf', { implementation: 'partial', csrAdjustment: '0' })).result.paf === 1.188, 'bhp-paf capped');
    ok((await rule('ra-user-fee', { benefitYear: '2026', memberMonths: '1000' })).result.fee === 200, 'ra fee 2026');
    ok((await rule('radv-iva-sample', { benefitYear: '2025', hccEnrollees: '150' })).result.size === 150, 'iva sample');
    ok((await rule('radv-appeal-rerun', { benefitYear: '2024', impact: '9999' })).result.rerun === false, 'rerun threshold');
    ok((await rule('exchange-user-fee', { benefitYear: '2026', exchangeType: 'FFE', extended: 'no', premium: '100' })).result.rate === 0.025, 'user fee');
    ok((await rule('meaningful-difference', { planA: '10101TX0030001', planB: '10101TX0070001' })).result.compliant === false, 'duplicate std plan rejected');
    ok((await rule('nonstandard-limit', { issuer: '2', planYear: '2026' })).result.compliant === false, 'nonstandard limit exceeded');
    ok((await rule('ecp-review', { state: 'OH', planYear: '2026', productType: 'medical' })).result.reviewer.startsWith('HHS'), 'ecp review HHS');
    ok((await rule('premium-threshold', { issuer: '2', paymentType: 'binder', grossPremium: '600', aptc: '400', amountPaid: '195' })).result.sufficient === false, 'binder excludes gross/fixed');
    const db = await (await fetch(`${BASE}/api/db/qhp_denials`)).json(); ok(db.count === 10, `10 denials recorded (got ${db.count})`);
  } finally {
    child.kill();
    setTimeout(() => { try { fs.unlinkSync(dbFile); } catch { /* ignore */ } }, 300);
  }
  console.log(`\n${passes} checks passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
