'use strict';
// Regulatory rules engine. Each tool maps to one or more Test Manager requirements (ACA:n).
// Tools are exposed in the UI at /exchange/tools/<id> and via API at /api/rules/<id>.
const D = require('./db');

class RuleError extends Error {}
const num = (v, name) => {
  const n = Number(String(v ?? '').replace(/[$,%\s]/g, ''));
  if (String(v ?? '').trim() === '' || Number.isNaN(n)) throw new RuleError(`${name} must be a number.`);
  return n;
};
const int = (v, name) => Math.trunc(num(v, name));
const bool = v => ['1', 'true', 'yes', 'on', 'y'].includes(String(v ?? '').toLowerCase());
const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (Math.round(n * 10000) / 100).toFixed(2) + '%';
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new RuleError(`Invalid date: ${isoDate}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z'), dbb = new Date(b + 'T00:00:00Z');
  if (Number.isNaN(da.getTime()) || Number.isNaN(dbb.getTime())) throw new RuleError('Invalid date.');
  return Math.round((dbb - da) / 86400000);
}
const today = () => new Date().toISOString().slice(0, 10);
const reqDate = (v, name) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw new RuleError(`${name} must be a date (YYYY-MM-DD).`); return v; };

// ---------- Shared rule functions (also used by workflow pages) ----------
const rules = {
  bhpPaf(status, csrAdjustment) {
    if (status === 'full') return { paf: 1.188, method: 'Fully implemented BHP: PAF fixed at 1.188' };
    if (status === 'first_year') return { paf: 1.0, method: 'First year of BHP implementation using prior-year SLCSP: PAF = 1.00' };
    if (status === 'partial') {
      const adj = num(csrAdjustment, 'CSR adjustment');
      if (adj < 0) throw new RuleError('CSR adjustment cannot be negative.');
      const raw = 1.2 / (1 + adj);
      const paf = Math.min(1.188, Math.max(1.0, raw));
      return { paf: round(paf), raw: round(raw), method: `Not fully implemented: PAF = 1.20 / (1 + ${adj}) = ${round(raw)}, bounded to 1.00–1.188` };
    }
    throw new RuleError('Select a BHP implementation status.');
  },

  raCalibration(by) {
    const y = int(by, 'Benefit year');
    return { start: y - 6, end: y - 4, coefficients: y >= 2026 ? 'Final coefficients published in guidance (not inferred from the rule text)' : 'Coefficients finalized in the Payment Notice' };
  },

  raUserFee(by, months) {
    const y = int(by, 'Benefit year');
    const pmpm = Number(D.param(`ra_user_fee_${y}`, NaN));
    if (Number.isNaN(pmpm)) throw new RuleError(`No risk adjustment user fee configured for benefit year ${y}.`);
    const m = num(months, 'Billable member months');
    return { pmpm, fee: round(pmpm * m, 2) };
  },

  exchangeUserFee(by, exchangeType, extended) {
    const y = int(by, 'Benefit year');
    if (!['FFE', 'SBE-FP'].includes(exchangeType)) throw new RuleError('Exchange type must be FFE or SBE-FP.');
    let rates;
    if (y === 2025) rates = { FFE: 0.015, 'SBE-FP': 0.012, basis: '2025 Payment Notice rates' };
    else if (y === 2026) rates = extended
      ? { FFE: 0.022, 'SBE-FP': 0.018, basis: 'Enhanced PTC extended through 2026 by July 31, 2025' }
      : { FFE: 0.025, 'SBE-FP': 0.020, basis: 'Enhanced PTC not extended (expires)' };
    else throw new RuleError('User fee rates are configured for benefit years 2025 and 2026 only.');
    return { rate: rates[exchangeType], basis: rates.basis };
  },

  radvIvaSample(by, hccEnrollees) {
    const y = int(by, 'Benefit year'); const n = int(hccEnrollees, 'HCC enrollees');
    if (n < 0) throw new RuleError('HCC enrollees cannot be negative.');
    if (y >= 2025) return { size: Math.min(200, n), fpc: false, note: n >= 200 ? '200-enrollee sample' : 'Entire HCC-enrollee population sampled (below 200)' };
    // pre-2025: 200 with finite population correction for small populations (illustrative)
    const fpcSize = Math.ceil(200 / (1 + (200 - 1) / Math.max(n, 1)));
    return { size: Math.min(n, fpcSize), fpc: true, note: 'Finite population correction applied (pre-2025 methodology)' };
  },

  radvIvaExcluded(by, model, stratum, hasHcc, hasRxc) {
    const y = int(by, 'Benefit year'); const s = int(stratum, 'Stratum');
    if (s < 1 || s > 10) throw new RuleError('Stratum must be 1–10.');
    if (y < 2025) return { excluded: false, reason: 'No sampling exclusions before benefit year 2025' };
    if (s === 10 && !hasHcc && !hasRxc) return { excluded: true, reason: 'Stratum 10 enrollee with neither HCCs nor RXCs' };
    if (model === 'adult' && s >= 1 && s <= 3 && hasRxc && !hasHcc) return { excluded: true, reason: 'Adult strata 1–3 enrollee with RXCs only and no HCCs' };
    return { excluded: false, reason: 'Enrollee remains in IVA sampling population' };
  },

  radvSva(by) {
    const y = int(by, 'Benefit year');
    return y >= 2024 ? { method: 'Bootstrapped 90% confidence interval', subsample: 24 } : { method: 'Paired t-test with 95% confidence interval', subsample: 12 };
  },

  radvAppealRerun(by, impact) {
    const y = int(by, 'Benefit year'); const amt = Math.abs(num(impact, 'Impact amount'));
    const threshold = Number(D.param('radv_appeal_rerun_threshold', 10000));
    if (y < 2023) return { rerun: true, reason: 'Materiality threshold applies beginning with the 2023 benefit year appeal cycle' };
    return amt >= threshold ? { rerun: true, reason: `Impact ${money(amt)} meets the ${money(threshold)} threshold` } : { rerun: false, reason: `Impact ${money(amt)} is below the ${money(threshold)} threshold — results are not rerun` };
  },

  premiumThreshold({ policies, paymentType, grossPremium, aptc, amountPaid }) {
    const gross = num(grossPremium, 'Gross premium'); const credit = num(aptc || 0, 'APTC'); const paid = num(amountPaid, 'Amount paid');
    const net = Math.max(0, round(gross - credit, 2));
    const unpaid = round(net - paid, 2);
    const fixed = Number(D.param('payment_fixed_threshold', 10));
    const binder = paymentType === 'binder';
    const applied = [];
    if (unpaid <= 0) return { sufficient: true, net, unpaid: 0, applied: ['Paid in full'], note: 'Payment covers the full net premium.' };
    if (policies.includes('net95') && paid >= 0.95 * net) applied.push('Net premium threshold (≥95% of net premium)');
    if (!binder && policies.includes('gross98') && (paid + credit) >= 0.98 * gross) applied.push('Gross premium threshold (≥98% of gross premium)');
    if (!binder && policies.includes('fixed10') && unpaid <= fixed) applied.push(`Fixed-dollar threshold (unpaid ≤ ${money(fixed)})`);
    const excluded = binder ? ['Gross and fixed-dollar thresholds do not apply to binder payments'] : [];
    return applied.length
      ? { sufficient: true, net, unpaid, applied, note: 'Treated as payment in full under the issuer\'s uniformly applied threshold policy.', excluded }
      : { sufficient: false, net, unpaid, applied: [], note: binder ? 'Binder payment insufficient — coverage is not effectuated.' : 'Payment insufficient — grace period / termination rules apply.', excluded };
  },

  appealStanding(role) {
    const allowed = { applicant: 'Applicant', enrollee: 'Enrollee', application_filer: 'Application filer', authorized_representative: 'Authorized representative' };
    if (allowed[role]) return { accepted: true, reason: `${allowed[role]} may request an eligibility appeal (45 CFR 155.505(b))${role === 'application_filer' ? ' — authorized-representative status is not required to file' : ''}.` };
    return { accepted: false, reason: 'Only an applicant, enrollee, application filer, or authorized representative may file an eligibility appeal.' };
  },

  reconsideration(denialDate, receivedDate, evidenceStandard) {
    const days = Number(D.param('reconsideration_days', 7));
    const deadline = addDays(reqDate(denialDate, 'Denial date'), days);
    reqDate(receivedDate, 'Request received date');
    if (receivedDate > deadline) return { outcome: 'Rejected - Untimely', reason: `Request received ${receivedDate}, after the ${days}-calendar-day deadline of ${deadline} (45 CFR 155.1090(a)(2)).`, deadline };
    if (evidenceStandard !== 'clear_and_convincing') return { outcome: 'Denial Upheld', reason: 'Issuer did not provide clear and convincing evidence that HHS erred in determining noncompliance with 45 CFR 155.1000(c) (45 CFR 155.1090(a)(3)).', deadline };
    return { outcome: 'Reconsideration Granted', reason: 'Timely request with clear and convincing evidence that HHS erred; certification denial reversed for re-review.', deadline };
  },

  dataInaccuracyDeadline(completedOn) {
    const days = Number(D.param('data_inaccuracy_days', 60));
    return { deadline: addDays(reqDate(completedOn, 'Complete report received date'), days), days };
  },

  ftrNotice(consecutiveYears, channel, name) {
    const n = int(consecutiveYears, 'Consecutive FTR years');
    if (!['direct', 'indirect'].includes(channel)) throw new RuleError('Notice channel must be direct or indirect.');
    if (n <= 0) return { required: false, type: 'None', aptc: 'Eligible', fti: false, body: 'No failure-to-file-and-reconcile notice required.' };
    const who = name || 'Tax filer';
    const type = n === 1 ? 'FTR Notice - First Year' : 'FTR Notice - Second Consecutive Year';
    const consequence = n === 1
      ? 'If you do not file and reconcile for two consecutive tax years, you may lose advance payments of the premium tax credit (APTC).'
      : 'You have not filed and reconciled for two consecutive tax years. Your APTC will end unless you file your federal income tax return and reconcile APTC (IRS Form 8962).';
    const body = channel === 'direct'
      ? `${who}: IRS data shows that you did not file a federal income tax return and reconcile APTC for ${n === 1 ? 'a' : 'two consecutive'} tax year${n === 1 ? '' : 's'}. ${consequence} [Direct notice — contains Federal tax information; safeguarded per IRC 6103]`
      : `${who}: Our records indicate a household member may not have filed and reconciled APTC. ${consequence} [Indirect notice — no Federal tax information disclosed]`;
    return { required: true, type, aptc: n >= 2 ? 'APTC ends after second-year notice' : 'Eligible (warning issued)', fti: channel === 'direct', body };
  },

  ecpReviewer(stateCode, planYear, productType) {
    const st = D.get('SELECT * FROM states WHERE code = ?', stateCode);
    if (!st) throw new RuleError('Unknown state.');
    const y = int(planYear, 'Plan year');
    if (st.exchange_type === 'SBE') return { reviewer: 'State Exchange', reason: `${st.name} operates a State Exchange.` };
    if (st.exchange_type === 'FFE' && st.plan_management && y >= 2026) return { reviewer: 'HHS (HIOS MPMS ECP data)', reason: `${st.name} is an FFE State performing plan management; beginning PY 2026 HHS conducts ECP review for ${productType === 'sadp' ? 'SADPs' : 'medical QHPs'}.` };
    if (st.exchange_type === 'FFE' && st.plan_management) return { reviewer: 'State (plan management)', reason: 'Before PY 2026 the plan-management State conducted ECP review.' };
    return { reviewer: 'HHS', reason: `${st.name} uses the FFE; HHS performs certification review.` };
  },

  csrLoading(statePermits, reimbursed, justified) {
    if (!statePermits) return { permitted: false, reason: 'CSR loading is not federally mandated and requires applicable State authority.' };
    if (reimbursed) return { permitted: false, reason: 'Issuer is reimbursed for CSR amounts — loading not permitted.' };
    if (!justified) return { permitted: false, reason: 'Plan-specific adjustment must be actuarially justified.' };
    return { permitted: true, reason: 'State-permitted, actuarially justified, plan-specific CSR loading where the issuer is not reimbursed (45 CFR 156.80(d)(2)(i)).' };
  },

  mlrQualifying(ra, premiums, reportingYear) {
    const sumRa = ra.reduce((a, b) => a + b, 0); const sumP = premiums.reduce((a, b) => a + b, 0);
    if (sumP <= 0) throw new RuleError('Earned premiums must be greater than zero.');
    const ratio = sumRa / sumP;
    const qualifying = ratio >= 0.5;
    const y = int(reportingYear, 'MLR reporting year');
    const election = qualifying && y >= 2026;
    return { ratio, qualifying, election, reason: !qualifying ? 'Ratio below 50% — not a qualifying issuer.' : (y < 2026 ? 'Qualifying, but the election is available beginning with the 2026 MLR reporting year.' : 'Qualifying issuer may elect to account for RA transfers in the denominator / rebate calculation instead of adjusting incurred claims.') };
  },

  standardizedDesign(planYear, design, deductible, moop, coinsurance) {
    const tables = {
      2025: { silver: { ded: 5000, moop: 8000 }, expanded_bronze: { ded: 7500, moop: 9200, coins: 50 } },
      2026: { silver: { ded: 6000, moop: 8900 }, expanded_bronze: { ded: 7500, moop: 10000, coins: 50 } },
    };
    const y = int(planYear, 'Plan year');
    const t = tables[y] && tables[y][design];
    if (!t) throw new RuleError('Design tables are configured for standard silver and expanded bronze, plan years 2025–2026.');
    const issues = [];
    if (int(deductible, 'Deductible') !== t.ded) issues.push(`Deductible must be ${money(t.ded)}`);
    if (int(moop, 'MOOP') !== t.moop) issues.push(`Annual limitation on cost sharing must be ${money(t.moop)}`);
    if (t.coins && coinsurance !== '' && coinsurance != null && int(coinsurance, 'Coinsurance') !== t.coins) issues.push(`Coinsurance must be ${t.coins}%`);
    return { compliant: issues.length === 0, issues, table: t };
  },

  meaningfulDifference(a, b) {
    if (!a || !b) throw new RuleError('Select two plans.');
    if (a.id === b.id) throw new RuleError('Select two different plans.');
    const areaA = D.all('SELECT county_fips FROM plan_service_areas WHERE plan_id = ? ORDER BY 1', a.id).map(r => r.county_fips).join(',');
    const areaB = D.all('SELECT county_fips FROM plan_service_areas WHERE plan_id = ? ORDER BY 1', b.id).map(r => r.county_fips).join(',');
    const sameScope = a.issuer_id === b.issuer_id && a.plan_type === b.plan_type && a.metal === b.metal && areaA === areaB && a.standardized && b.standardized;
    if (!sameScope) return { applies: false, compliant: true, differences: [], reason: 'Rule applies only to multiple standardized plans from the same issuer with the same network type, metal level and service area.' };
    const differences = [];
    if (a.product_id !== b.product_id) differences.push('Product ID');
    if (a.network_id !== b.network_id) differences.push('Network ID');
    if (a.drug_list_id !== b.drug_list_id) differences.push('Drug list ID');
    if (a.adult_dental !== b.adult_dental || a.adult_vision !== b.adult_vision || a.pediatric_dental !== b.pediatric_dental) differences.push('Benefits');
    return { applies: true, compliant: differences.length > 0, differences, reason: differences.length ? 'Plans are meaningfully different.' : 'Plans are not meaningfully different — reject duplicate standardized offering (45 CFR 156.201(c)).' };
  },

  nonstandardLimit(issuerId, planYear) {
    const plans = D.all('SELECT * FROM plans WHERE issuer_id = ? AND plan_year = ? AND standardized = 0', issuerId, planYear);
    const groups = new Map();
    for (const p of plans) {
      const area = D.all('SELECT county_fips FROM plan_service_areas WHERE plan_id = ? ORDER BY 1', p.id).map(r => r.county_fips).join(',');
      const key = [p.plan_type, p.metal, area, p.adult_dental, p.pediatric_dental, p.adult_vision].join('|');
      if (!groups.has(key)) groups.set(key, { networkType: p.plan_type, metal: p.metal, adultDental: !!p.adult_dental, pediatricDental: !!p.pediatric_dental, adultVision: !!p.adult_vision, plans: [] });
      groups.get(key).plans.push(p.id);
    }
    const out = [...groups.values()].map(g => ({ ...g, count: g.plans.length, withinLimit: g.plans.length <= 2 }));
    return { groups: out, compliant: out.every(g => g.withinLimit) };
  },

  agentSuspensionGround(ground) {
    const grounds = SUSPENSION_GROUNDS.map(g => g[0]);
    if (!grounds.includes(ground)) return { immediate: false, reason: 'Not a listed ground for immediate suspension under 45 CFR 155.220(k)(3).' };
    return { immediate: true, reason: 'Immediate suspension of Exchange system access permitted for unacceptable risk (45 CFR 155.220(k)(3)). Consumer assistance through alternate channels (Marketplace Call Center, consumer website) remains available unless the agreement is suspended or terminated.' };
  },
};

const SUSPENSION_GROUNDS = [
  ['eligibility_accuracy', 'Unacceptable risk to accuracy of eligibility determinations'],
  ['exchange_operations', 'Unacceptable risk to Exchange operations'],
  ['consumers', 'Unacceptable risk to applicants, enrollees, or their information'],
  ['it_systems', 'Unacceptable risk to Exchange IT systems'],
  ['standards_of_conduct', 'Noncompliance with standards of conduct'],
  ['privacy_security', 'Noncompliance with privacy and security standards'],
];

const APPEAL_ROLES = [['applicant', 'Applicant'], ['enrollee', 'Enrollee'], ['application_filer', 'Application filer'], ['authorized_representative', 'Authorized representative'], ['other', 'Other (friend / not on application)']];

// ---------- Tool catalog (generic UI + API) ----------
const YES_NO = [['no', 'No'], ['yes', 'Yes']];
const TOOLS = [
  { id: 'bhp-paf', group: 'Basic Health Program', title: 'BHP Premium Adjustment Factor', reqs: ['ACA:1', 'ACA:25'], cite: '90 FR 4433–35',
    inputs: [{ name: 'implementation', label: 'BHP implementation status for SLCSP premium year', type: 'select', options: [['full', 'Fully implemented BHP'], ['first_year', 'First year of BHP (prior-year SLCSP)'], ['partial', 'Not fully implemented (State reports CSR adjustment)']] },
      { name: 'csrAdjustment', label: 'State-reported CSR adjustment (decimal, e.g. 0.15)', type: 'text', placeholder: '0.15' }],
    run: i => { const r = rules.bhpPaf(i.implementation, i.csrAdjustment); return { outcome: `PAF = ${r.paf.toFixed(3)}`, data: r, rows: [['Premium Adjustment Factor', r.paf.toFixed(3)], ['Method', r.method]] }; } },
  { id: 'bhp-slcsp', group: 'Basic Health Program', title: 'BHP County SLCSP Selection', reqs: ['ACA:26'], cite: '90 FR 4435–36',
    inputs: [{ name: 'county', label: 'County', type: 'select', options: () => D.all('SELECT DISTINCT c.fips, c.name, c.state FROM bhp_slcsp_candidates b JOIN counties c ON c.fips = b.county_fips ORDER BY c.name').map(c => [c.fips, `${c.name}, ${c.state}`]) }],
    run: i => {
      const c = D.all('SELECT b.*, p.name FROM bhp_slcsp_candidates b JOIN plans p ON p.id = b.plan_id WHERE county_fips = ? ORDER BY population_served DESC', i.county);
      if (!c.length) throw new RuleError('No SLCSP candidates for that county.');
      return { outcome: `Selected SLCSP: ${c[0].plan_id}`, data: { selected: c[0].plan_id, candidates: c },
        rows: [['Selected SLCSP', `${c[0].plan_id} — ${c[0].name}`], ['Basis', 'SLCSP operating in the largest portion of the county by total population'], ...c.map(x => [`Candidate ${x.plan_id}`, `${x.population_served.toLocaleString()} residents`])] };
    } },
  { id: 'ra-calibration', group: 'Risk Adjustment', title: 'Risk Adjustment Recalibration Data Years', reqs: ['ACA:2', 'ACA:27'], cite: '90 FR 4436–38',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }],
    run: i => { const r = rules.raCalibration(i.benefitYear); return { outcome: `EDGE data ${r.start}–${r.end}`, data: r, rows: [['EDGE data years', `${r.start}, ${r.start + 1}, ${r.end}`], ['Coefficients', r.coefficients]] }; } },
  { id: 'hepc-trend', group: 'Risk Adjustment', title: 'Hepatitis C Adjustment Phase-out', reqs: ['ACA:3', 'ACA:28'], cite: '90 FR 4438–40',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }],
    run: i => { const y = int(i.benefitYear, 'Benefit year'); const yrs = Math.min(3, y - 2025);
      const method = y <= 2025 ? 'Separate Hepatitis C market-pricing adjustment' : `Phase-out: general specialty-drug trend applied to ${yrs} year${yrs > 1 ? 's' : ''} of Hepatitis C cost trending`;
      return { outcome: method, data: { method, specialtyTrendYears: Math.max(0, yrs) }, rows: [['Method', method]] }; } },
  { id: 'prep-acf', group: 'Risk Adjustment', title: 'PrEP Affiliated Cost Factor', reqs: ['ACA:4', 'ACA:29'], cite: '90 FR 4440–45',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }, { name: 'model', label: 'Model', type: 'select', options: [['adult', 'Adult'], ['child', 'Child']] },
      { name: 'drug', label: 'PrEP drug type', type: 'select', options: [['nongeneric', 'Non-generic PrEP'], ['generic', 'Generic PrEP']] }],
    run: i => { const y = int(i.benefitYear, 'Benefit year');
      const ok = y >= 2026 && i.drug === 'nongeneric';
      const hierarchy = i.model === 'adult' ? 'Below RXC 1 (Anti-HIV agents); no hierarchy to HCC 1 (HIV/AIDS)' : 'Below HCC 1 (HIV/AIDS)';
      return { outcome: ok ? 'PrEP ACF recognized' : 'Not recognized', data: { recognized: ok, hierarchy },
        rows: [['PrEP ACF', ok ? 'Recognized' : 'Not recognized'], ['Reason', y < 2026 ? 'PrEP ACF begins in the 2026 models' : (i.drug === 'generic' ? 'Generic PrEP drugs are excluded' : 'Eligible non-generic PrEP')], ['Hierarchy', hierarchy]] }; } },
  { id: 'ra-user-fee', group: 'Risk Adjustment', title: 'Risk Adjustment User Fee', reqs: ['ACA:8', 'ACA:30'], cite: '90 FR 4448–49',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }, { name: 'memberMonths', label: 'Billable member months', type: 'number', value: '12000' }],
    run: i => { const r = rules.raUserFee(i.benefitYear, i.memberMonths); return { outcome: `Fee ${money(r.fee)}`, data: r, rows: [['PMPM rate', money(r.pmpm)], ['Total user fee', money(r.fee)]] }; } },
  { id: 'radv-iva-sample', group: 'HHS-RADV', title: 'IVA Sample Size (no FPC)', reqs: ['ACA:5', 'ACA:32'], cite: '90 FR 4452–54',
    inputs: [{ name: 'benefitYear', label: 'HHS-RADV benefit year', type: 'number', value: '2025' }, { name: 'hccEnrollees', label: 'Number of HCC enrollees', type: 'number', value: '150' }],
    run: i => { const r = rules.radvIvaSample(i.benefitYear, i.hccEnrollees); return { outcome: `Sample size ${r.size}`, data: r, rows: [['IVA sample size', String(r.size)], ['Finite population correction', r.fpc ? 'Applied' : 'Not applied'], ['Note', r.note]] }; } },
  { id: 'radv-iva-exclusion', group: 'HHS-RADV', title: 'IVA Sampling Exclusions', reqs: ['ACA:5', 'ACA:31'], cite: '90 FR 4449–52',
    inputs: [{ name: 'benefitYear', label: 'HHS-RADV benefit year', type: 'number', value: '2025' }, { name: 'model', label: 'Model', type: 'select', options: [['adult', 'Adult'], ['child', 'Child'], ['infant', 'Infant']] },
      { name: 'stratum', label: 'Stratum (1–10)', type: 'number', value: '10' }, { name: 'hasHcc', label: 'Enrollee has HCCs', type: 'select', options: YES_NO }, { name: 'hasRxc', label: 'Enrollee has RXCs', type: 'select', options: YES_NO }],
    run: i => { const r = rules.radvIvaExcluded(i.benefitYear, i.model, i.stratum, bool(i.hasHcc), bool(i.hasRxc)); return { outcome: r.excluded ? 'Excluded from IVA sampling' : 'Included in IVA sampling', data: r, rows: [['Result', r.excluded ? 'Excluded' : 'Included'], ['Reason', r.reason]] }; } },
  { id: 'radv-neyman', group: 'HHS-RADV', title: 'Neyman Allocation Data Source', reqs: ['ACA:5', 'ACA:33'], cite: '90 FR 4454–57',
    inputs: [{ name: 'benefitYear', label: 'HHS-RADV benefit year', type: 'number', value: '2025' }],
    run: i => { const y = int(i.benefitYear, 'Benefit year'); const src = y >= 2025 ? `Three most recent consecutive years of released HHS-RADV data (${y - 4}–${y - 2})` : 'Medicare Advantage RADV data';
      return { outcome: src, data: { source: src }, rows: [['Error standard deviation source', src]] }; } },
  { id: 'radv-sva', group: 'HHS-RADV', title: 'SVA Pairwise Means Test', reqs: ['ACA:6', 'ACA:34'], cite: '90 FR 4458–60',
    inputs: [{ name: 'benefitYear', label: 'HHS-RADV benefit year', type: 'number', value: '2024' }],
    run: i => { const r = rules.radvSva(i.benefitYear); return { outcome: r.method, data: r, rows: [['Pairwise test', r.method], ['Initial SVA subsample', `${r.subsample} enrollees`]] }; } },
  { id: 'radv-appeal-rerun', group: 'HHS-RADV', title: 'RADV Appeal Rerun Materiality', reqs: ['ACA:7', 'ACA:35'], cite: '45 CFR 156.1220(a)(2)(i)',
    inputs: [{ name: 'benefitYear', label: 'Benefit year of appeal cycle', type: 'number', value: '2024' }, { name: 'impact', label: 'Change to filing issuer RA transfers ($)', type: 'number', value: '9999' }],
    run: i => { const r = rules.radvAppealRerun(i.benefitYear, i.impact); return { outcome: r.rerun ? 'Rerun RADV results' : 'Do not rerun', data: r, rows: [['Decision', r.rerun ? 'Rerun' : 'No rerun'], ['Reason', r.reason]] }; } },
  { id: 'exchange-user-fee', group: 'Fees & Payments', title: 'Exchange User Fee Rate', reqs: ['ACA:19'], cite: '90 FR 4486–88',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }, { name: 'exchangeType', label: 'Exchange type', type: 'select', options: [['FFE', 'FFE'], ['SBE-FP', 'SBE-FP']] },
      { name: 'extended', label: 'Enhanced PTC extended through 2026 by July 31, 2025?', type: 'select', options: () => (D.param('enhanced_ptc_extended_2026') === 'true' ? [['yes', 'Yes'], ['no', 'No']] : [['no', 'No'], ['yes', 'Yes']]) },
      { name: 'premium', label: 'Monthly premium ($)', type: 'number', value: '500' }],
    run: i => { const r = rules.exchangeUserFee(i.benefitYear, i.exchangeType, bool(i.extended)); const fee = round(r.rate * num(i.premium, 'Premium'), 2);
      return { outcome: `${pct(r.rate)} of premium`, data: { ...r, fee }, rows: [['User fee rate', pct(r.rate)], ['Monthly user fee', money(fee)], ['Rate basis', r.basis]] }; } },
  { id: 'premium-threshold', group: 'Fees & Payments', title: 'Premium Payment Threshold', reqs: ['ACA:14', 'ACA:40'], cite: '45 CFR 155.400(g)',
    inputs: [{ name: 'issuer', label: 'Issuer (uniform threshold policy)', type: 'select', options: () => D.all('SELECT id, name, payment_threshold_policy p FROM issuers ORDER BY name').map(r => [String(r.id), `${r.name} (${r.p})`]) },
      { name: 'paymentType', label: 'Payment type', type: 'select', options: [['ongoing', 'Ongoing monthly premium'], ['binder', 'Binder (initial) payment']] },
      { name: 'grossPremium', label: 'Gross monthly premium ($)', type: 'number', value: '600' }, { name: 'aptc', label: 'APTC ($)', type: 'number', value: '400' }, { name: 'amountPaid', label: 'Amount paid ($)', type: 'number', value: '191' }],
    run: i => { const iss = D.get('SELECT * FROM issuers WHERE id = ?', Number(i.issuer)); if (!iss) throw new RuleError('Select an issuer.');
      const r = rules.premiumThreshold({ policies: iss.payment_threshold_policy.split(','), paymentType: i.paymentType, grossPremium: i.grossPremium, aptc: i.aptc, amountPaid: i.amountPaid });
      return { outcome: r.sufficient ? 'Treated as paid in full' : 'Insufficient payment', data: { ...r, policy: iss.payment_threshold_policy },
        rows: [['Net premium due', money(r.net)], ['Unpaid amount', money(r.unpaid)], ['Threshold applied', r.applied.join('; ') || 'None'], ['Result', r.note], ...(r.excluded || []).map(e => ['Note', e])] }; } },
  { id: 'csr-loading', group: 'Plan Design', title: 'CSR Loading Recognition', reqs: ['ACA:20', 'ACA:47'], cite: '45 CFR 156.80(d)(2)(i)',
    inputs: [{ name: 'statePermits', label: 'State authority permits CSR loading?', type: 'select', options: YES_NO }, { name: 'reimbursed', label: 'Issuer reimbursed for CSRs?', type: 'select', options: YES_NO }, { name: 'justified', label: 'Actuarially justified, plan-specific?', type: 'select', options: [['yes', 'Yes'], ['no', 'No']] }],
    run: i => { const r = rules.csrLoading(bool(i.statePermits), bool(i.reimbursed), bool(i.justified)); return { outcome: r.permitted ? 'CSR loading permitted' : 'CSR loading not permitted', data: r, rows: [['Result', r.permitted ? 'Permitted' : 'Not permitted'], ['Reason', r.reason]] }; } },
  { id: 'av-calculator', group: 'Plan Design', title: 'AV Calculator Version Check', reqs: ['ACA:21'], cite: '90 FR 4490–93',
    inputs: [{ name: 'planYear', label: 'Plan year', type: 'number', value: '2026' }, { name: 'version', label: 'AV Calculator version used', type: 'select', options: [['final', 'Final AV Calculator'], ['draft', 'Draft AV Calculator'], ['revised', 'Revised (mid-year) AV Calculator']] }],
    run: i => { const y = int(i.planYear, 'Plan year'); const ok = y >= 2026 ? i.version === 'final' : true;
      return { outcome: ok ? 'Accepted' : 'Rejected — use the final AV Calculator', data: { accepted: ok },
        rows: [['Required version', y >= 2026 ? `Final ${y} AV Calculator (single release)` : 'Draft/final cycle'], ['Feedback', y >= 2026 ? `Feedback is ordinarily applied to PY ${y + 1}` : 'Feedback may revise current-year calculator'], ['Result', ok ? 'Accepted' : 'Rejected']] }; } },
  { id: 'standardized-design', group: 'Plan Design', title: 'Standardized Plan Cost Sharing', reqs: ['ACA:22', 'ACA:45'], cite: '90 FR 4494–97',
    inputs: [{ name: 'planYear', label: 'Plan year', type: 'number', value: '2026' }, { name: 'design', label: 'Standardized design', type: 'select', options: [['silver', 'Standard Silver'], ['expanded_bronze', 'Expanded Bronze']] },
      { name: 'deductible', label: 'Deductible ($)', type: 'number', value: '6000' }, { name: 'moop', label: 'Annual limitation on cost sharing ($)', type: 'number', value: '8900' }, { name: 'coinsurance', label: 'Coinsurance (%)', type: 'number', value: '' }],
    run: i => { const r = rules.standardizedDesign(i.planYear, i.design, i.deductible, i.moop, i.coinsurance);
      return { outcome: r.compliant ? 'Design compliant' : 'Design non-compliant', data: r, rows: [['Result', r.compliant ? 'Compliant' : 'Non-compliant'], ['Required deductible', money(r.table.ded)], ['Required limit', money(r.table.moop)], ...r.issues.map(x => ['Issue', x])] }; } },
  { id: 'meaningful-difference', group: 'Plan Design', title: 'Standardized Plan Meaningful Difference', reqs: ['ACA:22', 'ACA:46'], cite: '45 CFR 156.201(c)',
    inputs: [{ name: 'planA', label: 'Plan A', type: 'select', options: () => D.all('SELECT id, name FROM plans WHERE standardized = 1 ORDER BY id').map(p => [p.id, `${p.id} — ${p.name}`]) },
      { name: 'planB', label: 'Plan B', type: 'select', options: () => D.all('SELECT id, name FROM plans WHERE standardized = 1 ORDER BY id').map(p => [p.id, `${p.id} — ${p.name}`]) }],
    run: i => { const r = rules.meaningfulDifference(D.get('SELECT * FROM plans WHERE id = ?', i.planA), D.get('SELECT * FROM plans WHERE id = ?', i.planB));
      return { outcome: !r.applies ? 'Rule not applicable' : (r.compliant ? 'Meaningfully different' : 'Not meaningfully different — reject'), data: r, rows: [['Result', r.reason], ['Differences', r.differences.join(', ') || 'None']] }; } },
  { id: 'nonstandard-limit', group: 'Plan Design', title: 'Non-standardized Plan Limit', reqs: ['ACA:23'], cite: '45 CFR 156.202',
    inputs: [{ name: 'issuer', label: 'Issuer', type: 'select', options: () => D.all('SELECT id, name FROM issuers ORDER BY name').map(r => [String(r.id), r.name]) }, { name: 'planYear', label: 'Plan year', type: 'number', value: '2026' }],
    run: i => { const r = rules.nonstandardLimit(Number(i.issuer), int(i.planYear, 'Plan year'));
      return { outcome: r.compliant ? 'Within limit' : 'Exceeds limit of 2 per category', data: r,
        rows: r.groups.map(g => [`${g.networkType} ${g.metal} | adult dental: ${g.adultDental ? 'Y' : 'N'}, pediatric dental: ${g.pediatricDental ? 'Y' : 'N'}, adult vision: ${g.adultVision ? 'Y' : 'N'}`, `${g.count} plan(s) — ${g.withinLimit ? 'OK' : 'EXCEEDS LIMIT'}`]) }; } },
  { id: 'mlr-qualifying', group: 'MLR', title: 'MLR Qualifying Issuer Election', reqs: ['ACA:24', 'ACA:48'], cite: '45 CFR 158.103, 158.240(c)(3)',
    inputs: [{ name: 'ra1', label: 'Net RA payments — year 1 ($)', type: 'number', value: '5000000' }, { name: 'ra2', label: 'Net RA payments — year 2 ($)', type: 'number', value: '5500000' }, { name: 'ra3', label: 'Net RA payments — year 3 ($)', type: 'number', value: '6000000' },
      { name: 'p1', label: 'Earned premiums — year 1 ($)', type: 'number', value: '10000000' }, { name: 'p2', label: 'Earned premiums — year 2 ($)', type: 'number', value: '10500000' }, { name: 'p3', label: 'Earned premiums — year 3 ($)', type: 'number', value: '11000000' },
      { name: 'reportingYear', label: 'MLR reporting year', type: 'number', value: '2026' }],
    run: i => { const r = rules.mlrQualifying([num(i.ra1, 'RA 1'), num(i.ra2, 'RA 2'), num(i.ra3, 'RA 3')], [num(i.p1, 'Premium 1'), num(i.p2, 'Premium 2'), num(i.p3, 'Premium 3')], i.reportingYear);
      return { outcome: r.election ? 'Election permitted' : 'Election not permitted', data: r, rows: [['3-year ratio', pct(r.ratio)], ['Qualifying issuer', r.qualifying ? 'Yes' : 'No'], ['Election', r.reason]] }; } },
  { id: 'ecp-review', group: 'Certification', title: 'ECP Review Responsibility', reqs: ['ACA:17', 'ACA:44'], cite: '90 FR 4505–07',
    inputs: [{ name: 'state', label: 'State', type: 'select', options: () => D.all('SELECT code, name, exchange_type, plan_management FROM states ORDER BY name').map(s => [s.code, `${s.name} (${s.exchange_type}${s.plan_management ? ', plan management' : ''})`]) },
      { name: 'planYear', label: 'Plan year', type: 'number', value: '2026' }, { name: 'productType', label: 'Product', type: 'select', options: [['medical', 'Medical QHP'], ['sadp', 'Stand-alone dental plan (SADP)']] }],
    run: i => { const r = rules.ecpReviewer(i.state, i.planYear, i.productType); return { outcome: `Reviewer: ${r.reviewer}`, data: r, rows: [['ECP reviewer', r.reviewer], ['Reason', r.reason]] }; } },
  { id: 'reconsideration-check', group: 'Certification', title: 'Certification Reconsideration Check', reqs: ['ACA:16', 'ACA:43'], cite: '45 CFR 155.1090(a)(2)–(3)',
    inputs: [{ name: 'denialDate', label: 'Denial date', type: 'date', value: today() }, { name: 'receivedDate', label: 'Request received date', type: 'date', value: today() },
      { name: 'evidence', label: 'Evidence standard met', type: 'select', options: EVIDENCE_OPTIONS() }],
    run: i => { const r = rules.reconsideration(i.denialDate, i.receivedDate, i.evidence); return { outcome: r.outcome, data: r, rows: [['Outcome', r.outcome], ['Deadline', r.deadline], ['Reason', r.reason]] }; } },
  { id: 'agent-suspension', group: 'Agents & Brokers', title: 'Immediate Suspension Grounds', reqs: ['ACA:10', 'ACA:37'], cite: '45 CFR 155.220(k)(3)',
    inputs: [{ name: 'ground', label: 'Ground', type: 'select', options: [...SUSPENSION_GROUNDS, ['late_fees', 'Late commission paperwork (not a listed ground)']] }],
    run: i => { const r = rules.agentSuspensionGround(i.ground); return { outcome: r.immediate ? 'Immediate suspension permitted' : 'Immediate suspension not permitted', data: r, rows: [['Result', r.immediate ? 'Permitted' : 'Not permitted'], ['Reason', r.reason]] }; } },
  { id: 'ftr-notice', group: 'Eligibility & Notices', title: 'FTR Notice Determination', reqs: ['ACA:12', 'ACA:38'], cite: '45 CFR 155.305(f)(4)(ii)',
    inputs: [{ name: 'years', label: 'Consecutive tax years failed to file and reconcile', type: 'number', value: '2' }, { name: 'channel', label: 'Notice channel', type: 'select', options: [['direct', 'Direct (to tax filer, FTI safeguarded)'], ['indirect', 'Indirect (no FTI disclosure)']] }],
    run: i => { const r = rules.ftrNotice(i.years, i.channel); return { outcome: r.type, data: r, rows: [['Notice', r.type], ['APTC', r.aptc], ['Contains FTI', r.fti ? 'Yes' : 'No'], ['Notice text', r.body]] }; } },
  { id: 'appeal-standing', group: 'Eligibility & Notices', title: 'Appeal Standing', reqs: ['ACA:15', 'ACA:41'], cite: '45 CFR 155.505(b)',
    inputs: [{ name: 'role', label: 'Filer role', type: 'select', options: APPEAL_ROLES }],
    run: i => { const r = rules.appealStanding(i.role); return { outcome: r.accepted ? 'Appeal accepted' : 'Appeal not accepted', data: r, rows: [['Result', r.accepted ? 'Accepted' : 'Not accepted'], ['Reason', r.reason]] }; } },
  { id: 'data-inaccuracy-deadline', group: 'Eligibility & Notices', title: 'State Exchange Data Inaccuracy Deadline', reqs: ['ACA:13', 'ACA:39'], cite: '45 CFR 155.400(d)(1)',
    inputs: [{ name: 'completedOn', label: 'Complete issuer report received', type: 'date', value: today() }],
    run: i => { const r = rules.dataInaccuracyDeadline(i.completedOn); return { outcome: `Resolve by ${r.deadline}`, data: r, rows: [['Resolution deadline', r.deadline], ['Rule', `${r.days} calendar days from receipt of a complete report`]] }; } },
];

function EVIDENCE_OPTIONS() { return [['clear_and_convincing', 'Clear and convincing evidence of HHS error'], ['preponderance', 'Preponderance of the evidence'], ['insufficient', 'Insufficient evidence']]; }

function resolveOptions(input) { return typeof input.options === 'function' ? input.options() : input.options; }
function runTool(id, inputs) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) throw new RuleError(`Unknown rule tool: ${id}`);
  return t.run(inputs || {});
}

module.exports = { rules, TOOLS, runTool, resolveOptions, RuleError, SUSPENSION_GROUNDS, APPEAL_ROLES, EVIDENCE_OPTIONS, addDays, daysBetween, today, money, pct, round, num, bool };
