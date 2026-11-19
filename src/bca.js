'use strict';
// 2025 edition changes to 45 CFR Parts 155 and 156 (CFR-2024 vol 2 -> CFR-2025 vol 2).
// Each rule maps to Test Manager project BCA requirements (BCA:2 - BCA:39).
// The rules are used by the consumer flows, the Exchange portal and the rule tools (/exchange/tools, /api/rules).
const D = require('./db');
const R = require('./rules');
const { RuleError, num, int, bool, money, round, addDays, daysBetween } = R;

const reqDate = (v, name) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10))) throw new RuleError(`${name} must be a date (YYYY-MM-DD).`); return String(v).slice(0, 10); };
const yearOf = v => int(v, 'Plan year');
const FEDERAL_PLATFORM = ['FFE', 'SBE-FP'];

// ---------- BCA:2 lawful presence (45 CFR 155.20 as revised) ----------
const IMMIGRATION_STATUSES = [
  ['citizen', 'U.S. citizen or national', true, false],
  ['qualified_noncitizen', 'Qualified noncitizen (e.g. lawful permanent resident, refugee, asylee)', true, true],
  ['nonimmigrant', 'Valid nonimmigrant status (e.g. work or student visa)', true, true],
  ['parolee', 'Paroled into the United States', true, true],
  ['tps', 'Temporary Protected Status', true, true],
  ['withholding', 'Withholding of removal or Convention Against Torture protection', true, true],
  ['deferred_action', 'Granted deferred action (other than DACA) — § 155.20 paragraph (9)', true, true],
  ['pending_asylum', 'Pending asylum application with employment authorization', true, true],
  ['other_listed', 'Other category listed in § 155.20 "Lawfully present"', true, true],
  ['daca', 'DACA recipient — deferred action under 8 CFR 236.22 (excluded, § 155.20 paragraph (14))', false, true],
  ['none', 'No qualifying immigration status', false, true],
];
function lawfulPresence(status) {
  const s = IMMIGRATION_STATUSES.find(x => x[0] === status);
  if (!s) throw new RuleError('Select an immigration status.');
  const [code, label, eligible, noncitizen] = s;
  if (code === 'citizen') return { code, label, lawfullyPresent: null, eligible: true, reason: 'U.S. citizen or national — eligible to enroll in a QHP.' };
  if (code === 'daca') return { code, label, lawfullyPresent: false, eligible: false,
    reason: 'DACA recipients (deferred action under 8 CFR 236.22) are excluded from "lawfully present" by 45 CFR 155.20 paragraph (14). Not eligible for QHP enrollment, APTC or CSR.' };
  return { code, label, lawfullyPresent: eligible, eligible, noncitizen,
    reason: eligible ? `Lawfully present under 45 CFR 155.20 (${label}).` : 'No status listed in 45 CFR 155.20 "Lawfully present" — not eligible for QHP enrollment, APTC or CSR.' };
}

// ---------- BCA:4-6 failure to file and reconcile (45 CFR 155.305(f)(4)) ----------
function ftrEligibility({ planYear, failedYears, channel, name }) {
  const y = yearOf(planYear); const n = int(failedYears, 'Failed tax years');
  if (!['direct', 'indirect'].includes(channel)) throw new RuleError('Notice channel must be direct or indirect.');
  if (n < 0) throw new RuleError('Failed tax years cannot be negative.');
  const who = name || 'Tax filer';
  const directBody = years => `${who}: IRS data shows that you or your spouse did not file a federal income tax return and reconcile advance payments of the premium tax credit (APTC) for ${years}. [Direct notice — contains Federal tax information; safeguarded per IRC 6103]`;
  const indirectBody = 'Our records indicate that someone in your household may need to file a federal income tax return and reconcile advance payments of the premium tax credit (IRS Form 8962). [Indirect notice — no Federal tax information disclosed]';
  if (n === 0) return { planYear: y, aptcEligible: true, rule: 'None', notice: null, body: null, fti: false, reason: 'No failure to file and reconcile reported by HHS.' };
  if (y === 2026) {
    return { planYear: y, aptcEligible: false, rule: '45 CFR 155.305(f)(4)(iii)', notice: 'FTR Denial Notice - Plan Year 2026', fti: channel === 'direct',
      body: channel === 'direct' ? `${directBody(n === 1 ? 'a tax year' : `${n} tax years`)} You are not eligible for APTC for plan year 2026.` : `${indirectBody} You are not eligible for APTC for plan year 2026 until this is resolved.`,
      reason: 'Plan year 2026: APTC is denied after HHS reports a failure to file and reconcile for even one tax year (45 CFR 155.305(f)(4)(iii)).' };
  }
  if (n >= 2) {
    return { planYear: y, aptcEligible: false, rule: '45 CFR 155.305(f)(4)(ii)', notice: 'FTR Notice - Second Consecutive Year', fti: channel === 'direct',
      body: channel === 'direct' ? `${directBody('two consecutive tax years')} You are no longer eligible for APTC.` : `${indirectBody} You may lose APTC eligibility.`,
      reason: 'APTC is denied after two consecutive tax years of failure to file and reconcile (45 CFR 155.305(f)(4) and (f)(4)(ii)).' };
  }
  return { planYear: y, aptcEligible: true, rule: '45 CFR 155.305(f)(4)(i)', notice: 'FTR Notice - First Year', fti: channel === 'direct',
    body: channel === 'direct' ? `${directBody('a tax year')} If you do not file and reconcile for two consecutive tax years, you will lose APTC.` : `${indirectBody} You may lose APTC in the future.`,
    reason: 'One year of failure to file and reconcile: warning notice only; APTC continues (45 CFR 155.305(f)(4)(i)).' };
}

// ---------- BCA:7 inconsistency period (45 CFR 155.315(f)) ----------
function inconsistencyDeadline(noticeDate, incType, goodFaithDays) {
  const d = reqDate(noticeDate, 'Notice date');
  const days = Number(D.param('inconsistency_days', 90));
  const ext = goodFaithDays === '' || goodFaithDays == null ? 0 : int(goodFaithDays, 'Good-faith extension days');
  if (ext < 0) throw new RuleError('Extension days cannot be negative.');
  return { noticeDate: d, type: incType || 'income', days, extension: ext, deadline: addDays(d, days + ext),
    reason: `${days} days from the notice date${ext ? ` plus a ${ext}-day good-faith extension under § 155.315(f)(3)` : ''}. There is no automatic 60-day extension for household income (former § 155.315(f)(7) removed).` };
}

// ---------- BCA:8, BCA:9 income-increase check, plan years before 2027 ----------
const fplAmount = size => Number(D.param('fpl_base_2025', 15650)) + Number(D.param('fpl_increment_2025', 5500)) * (Math.max(1, size) - 1);
function incomeIncreaseCheck({ planYear, path, dataIncome, attestedIncome, householdSize, thresholdPct, lpMedicaidIneligible }) {
  const y = yearOf(planYear);
  const size = int(householdSize || 1, 'Household size');
  const data = num(dataIncome, path === 'alternate' ? 'Alternate data income' : 'Tax return income');
  const att = num(attestedIncome, 'Attested income');
  const threshold = thresholdPct === '' || thresholdPct == null ? Number(D.param('income_increase_threshold_pct', 10)) : num(thresholdPct, 'Threshold');
  if (threshold < 10) throw new RuleError('The reasonable threshold may not be less than 10%.');
  const dataFpl = round((data / fplAmount(size)) * 100, 2); const attFpl = round((att / fplAmount(size)) * 100, 2);
  const increasePct = data > 0 ? round(((att - data) / data) * 100, 2) : Infinity;
  const cite = path === 'alternate' ? '45 CFR 155.320(c)(3)(vi)(C)(2)' : '45 CFR 155.320(c)(3)(iii)(A)';
  const base = { planYear: y, path: path || 'basic', dataFpl, attestedFpl: attFpl, increasePct: Number.isFinite(increasePct) ? increasePct : null, threshold, rule: cite };
  if (y >= 2027) return { ...base, triggered: false, reason: `${cite} applies only to plan years before 2027.` };
  if (dataFpl >= 100) return { ...base, triggered: false, reason: `Data shows income at ${dataFpl}% FPL (not under 100%); this check does not apply.` };
  const applicable = attFpl >= 100 && attFpl <= 400;
  if (!applicable) return { ...base, triggered: false, reason: 'Attested income would not make the taxpayer an applicable taxpayer (26 CFR 1.36B-2(b)).' };
  if (!(increasePct > threshold)) return { ...base, triggered: false, reason: `Attested income is ${increasePct}% above the data, not more than the ${threshold}% threshold.` };
  if ((path || 'basic') === 'basic' && bool(lpMedicaidIneligible)) return { ...base, triggered: false, reason: 'Exception: lawfully present noncitizen ineligible for Medicaid by reason of immigration status (§ 155.305(f)(2)); attestation accepted.' };
  return { ...base, triggered: true, reason: `Data shows ${dataFpl}% FPL, attested income is ${Number.isFinite(increasePct) ? increasePct + '%' : 'far'} above it (threshold ${threshold}%) and would qualify for APTC: open an income inconsistency under § 155.315(f)(1)–(4).` };
}

// ---------- BCA:10 no tax data returned (45 CFR 155.320(c)(5)) ----------
function noTaxData(planYear) {
  const y = yearOf(planYear);
  return y >= 2027
    ? { planYear: y, acceptAttestation: true, path: 'Attestation accepted', reason: 'Plan year 2027 or later: when no tax data is returned, income and family size attestations are accepted without further verification (45 CFR 155.320(c)(5)).' }
    : { planYear: y, acceptAttestation: false, path: 'Alternate verification', reason: 'Plan year before 2027: no blanket acceptance; verify income through alternate data sources (§ 155.320(c)(3)(vi)) and open an inconsistency if needed.' };
}

// ---------- BCA:11 re-enrollment crosswalk (45 CFR 155.335(j)) ----------
function crosswalk(currentMetal, csrEligible) {
  if (!currentMetal) throw new RuleError('Select the current metal level.');
  return { targetMetal: currentMetal, rule: '45 CFR 155.335(j)(1)–(2)',
    reason: currentMetal === 'Bronze' && csrEligible
      ? 'CSR-eligible bronze enrollee is re-enrolled in a bronze QHP. The former optional bronze-to-silver crosswalk (old § 155.335(j)(4)) was removed.'
      : `Re-enrolled in a ${currentMetal} QHP under the (j)(1)–(j)(3) hierarchy.` };
}

// ---------- BCA:12 $5 minimum premium for $0 passive re-enrollees (45 CFR 155.335(n)) ----------
function minimumPremium({ benefitYear, platform, grossPremium, aptc, updatedAppDate, deadline }) {
  const y = yearOf(benefitYear);
  const gross = round(num(grossPremium, 'Plan premium'), 2);
  const credit = round(Math.min(gross, num(aptc ?? 0, 'APTC')), 2);
  const net = round(gross - credit, 2);
  const min = Number(D.param('minimum_premium_amount', 5));
  const dl = deadline ? reqDate(deadline, 'Plan selection deadline') : null;
  const appDate = updatedAppDate ? reqDate(updatedAppDate, 'Updated application date') : null;
  const conditions = [
    ['Benefit year 2026', y === 2026],
    ['Federal platform (FFE or SBE-FP)', FEDERAL_PLATFORM.includes(platform)],
    ['Net premium after APTC is $0', net === 0],
    ['No updated application on or before the plan selection deadline', !(appDate && dl && appDate <= dl)],
  ];
  const applies = conditions.every(c => c[1]);
  const failed = conditions.filter(c => !c[1]).map(c => c[0]);
  if (!applies) return { applies: false, grossPremium: gross, aptc: credit, netPremium: net, conditions, rule: '45 CFR 155.335(n)',
    reason: `$${min} minimum premium not applied — condition not met: ${failed.join('; ')}.` };
  const newAptc = round(Math.max(0, gross - min), 2);
  return { applies: true, grossPremium: gross, aptc: newAptc, netPremium: round(gross - newAptc, 2), originalAptc: credit, conditions, rule: '45 CFR 155.335(n)',
    reason: `APTC reduced from ${money(credit)} to ${money(newAptc)} so the enrollee pays ${money(gross - newAptc)} per month (benefit year 2026, Federal platform, $0 premium, no updated application by ${dl}).` };
}

// ---------- BCA:13 premium payment thresholds ----------
function thresholdConfigCheck(planYear, policies) {
  const y = yearOf(planYear);
  const list = String(policies || '').split(',').map(s => s.trim()).filter(Boolean).filter(p => p !== 'none');
  const issues = [];
  if (y <= 2026) for (const p of list) if (p !== 'net95') issues.push(`${p}: only the 95% net-premium threshold is permitted through December 31, 2026.`);
  for (const p of list) if (!['net95', 'gross98', 'fixed10'].includes(p)) issues.push(`${p}: unknown threshold type.`);
  return { planYear: y, valid: issues.length === 0, issues };
}

// ---------- BCA:14-17 open enrollment and effective dates (45 CFR 155.410) ----------
function oepWindow(benefitYear) {
  const y = yearOf(benefitYear);
  const start = D.param(`oep_start_${y}`, null), end = D.param(`oep_end_${y}`, null);
  if (!start || !end) throw new RuleError(`No open enrollment window is configured for benefit year ${y} (parameters oep_start_${y} / oep_end_${y}).`);
  return validateOep(y, start, end);
}
function validateOep(y, start, end) {
  reqDate(start, 'OEP start'); reqDate(end, 'OEP end');
  const days = daysBetween(start, end) + 1;
  const issues = [];
  if (y >= 2022 && y <= 2026) {
    if (start !== `${y - 1}-11-01`) issues.push(`(e)(4): OEP must begin November 1, ${y - 1}.`);
    if (end !== `${y}-01-15`) issues.push(`(e)(4): OEP must end January 15, ${y}.`);
    return { benefitYear: y, start, end, days, rule: '45 CFR 155.410(e)(4)', valid: issues.length === 0, issues };
  }
  if (y >= 2027) {
    if (start > `${y - 1}-11-01`) issues.push(`(e)(5): OEP must begin no later than November 1, ${y - 1}.`);
    if (end > `${y - 1}-12-31`) issues.push(`(e)(5): OEP must end no later than December 31, ${y - 1}.`);
    if (days > 63) issues.push(`(e)(5): OEP may not exceed 9 weeks (63 days); configured ${days} days.`);
    return { benefitYear: y, start, end, days, rule: '45 CFR 155.410(e)(5)', valid: issues.length === 0, issues };
  }
  return { benefitYear: y, start, end, days, rule: 'Earlier rules', valid: true, issues };
}
function oepEffectiveDate(benefitYear, selectionDate) {
  const y = yearOf(benefitYear); const d = reqDate(selectionDate, 'Plan selection date');
  const w = oepWindow(y);
  if (d < w.start || d > w.end) return { benefitYear: y, selectionDate: d, inOep: false, effectiveDate: null, rule: w.rule, window: w,
    reason: `Open enrollment for ${y} runs ${w.start} to ${w.end}. A selection on ${d} needs a special enrollment period.` };
  if (y >= 2027) return { benefitYear: y, selectionDate: d, inOep: true, effectiveDate: `${y}-01-01`, rule: '45 CFR 155.410(f)(4)', window: w,
    reason: `Benefit year ${y}: every open enrollment selection made by December 31 takes effect January 1, ${y}.` };
  const eff = d <= `${y - 1}-12-31` ? `${y}-01-01` : `${y}-02-01`;
  return { benefitYear: y, selectionDate: d, inOep: true, effectiveDate: eff, rule: '45 CFR 155.410(f)(3)', window: w,
    reason: eff === `${y}-01-01` ? `Selected by December 31, ${y - 1}: coverage starts January 1, ${y}.` : `Selected January 1–15, ${y}: coverage starts February 1, ${y}.` };
}

// ---------- BCA:18-22 special enrollment periods (45 CFR 155.420) ----------
const SEP_TYPES = [
  ['loss_of_coverage', 'Lost qualifying health coverage — § 155.420(d)(1)'],
  ['household_change', 'Marriage, birth, adoption or new dependent — § 155.420(d)(2)'],
  ['move', 'Permanent move to a new area — § 155.420(d)(7)'],
  ['d16', 'Monthly SEP for APTC-eligible people at or below 150% FPL — § 155.420(d)(16)'],
];
const METALS = ['Bronze', 'Expanded Bronze', 'Silver', 'Gold', 'Platinum'];
const metalRank = m => ({ Bronze: 1, 'Expanded Bronze': 1, Silver: 2, Gold: 3, Platinum: 4 }[m] || 0);
function d16Availability(planYear, fplPercent, aptcEligible) {
  const y = yearOf(planYear); const fpl = num(fplPercent, 'FPL percent');
  if (y < 2027) return { available: false, planYear: y, reason: 'The § 155.420(d)(16) monthly low-income SEP is not available before plan year 2027.' };
  if (!aptcEligible) return { available: false, planYear: y, reason: 'The d(16) SEP is only for people eligible for APTC.' };
  if (fpl > 150) return { available: false, planYear: y, reason: `Household income ${fpl}% FPL is above 150% FPL.` };
  return { available: true, planYear: y, reason: 'Eligible for the monthly d(16) SEP (at Exchange option), plan year 2027 or later.' };
}
function sepPlanChange(sepType, planYear, currentMetal, newMetal) {
  const y = yearOf(planYear);
  if (!currentMetal) return { allowed: true, rule: 'New enrollment', reason: 'Not currently enrolled: any available QHP may be selected.' };
  if (!newMetal) throw new RuleError('Select the new plan\'s metal level.');
  if (sepType === 'd16' && y >= 2027) {
    const ok = newMetal === 'Silver' || newMetal === currentMetal;
    return { allowed: ok, rule: '45 CFR 155.420(a)(4)(ii)(D)', reason: ok ? 'd(16) SEP (PY2027+): may change to any available silver-level QHP.' : 'd(16) SEP: change is limited to a silver-level QHP.' };
  }
  const diff = Math.abs(metalRank(newMetal) - metalRank(currentMetal));
  return { allowed: diff <= 1, rule: '45 CFR 155.420(a)(4)(iii)', sameMetal: diff === 0,
    reason: diff === 0 ? 'Same metal level — allowed.' : diff === 1 ? 'One metal level up or down — allowed only when no plan at the current metal level is available.' : `Change from ${currentMetal} to ${newMetal} is more than one metal level and is not allowed.` };
}
function sepEffectiveDate(sepType, planYear, selectionDate) {
  const y = yearOf(planYear); const d = reqDate(selectionDate, 'Plan selection date');
  const next = new Date(d + 'T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1, 1);
  const eff = next.toISOString().slice(0, 10);
  if (sepType === 'd16' && y >= 2027) return { effectiveDate: eff, rule: '45 CFR 155.420(b)(2)(vii)', reason: 'd(16) SEP: first day of the month after plan selection.' };
  return { effectiveDate: eff, rule: '45 CFR 155.420(b)(1)', reason: 'General rule: first day of the month after plan selection.' };
}
function sepVerificationRequired(date, platform) {
  const d = reqDate(date, 'Date');
  const req = d >= '2026-01-01' && d <= '2026-12-31' && FEDERAL_PLATFORM.includes(platform || 'FFE');
  return { required: req, rule: '45 CFR 155.420(g)',
    reason: req ? 'Pre-enrollment verification is required for every SEP type on the Federal platform from January 1 to December 31, 2026.' : (d >= '2027-01-01' ? 'The 2026 mandatory pre-enrollment SEP verification has ended (not renewed).' : 'Mandatory pre-enrollment SEP verification does not apply on this date or platform.') };
}
function sepVerificationRate(verified, total) {
  const v = int(verified, 'Verified enrollments'), t = int(total, 'Total new SEP enrollments');
  if (t <= 0) throw new RuleError('Total new SEP enrollments must be greater than zero.');
  const pct = round((v / t) * 100, 2); const min = Number(D.param('sep_verification_rate_min', 75));
  return { rate: pct, minimum: min, meets: pct >= min };
}

// ---------- BCA:23 EHB-benchmark scope (45 CFR 156.111(b)(2)) ----------
function ehbBenchmark({ singleCategory, women, children, disabilities, discriminatory }) {
  const deficiencies = [];
  if (bool(singleCategory)) deficiencies.push(['§ 156.111(b)(2)(iii)', 'Benefits are unduly weighted toward one EHB category (§ 156.110(a)). Rejected.', 'reject']);
  const missing = [['women', women], ['children', children], ['persons with disabilities', disabilities]].filter(x => !bool(x[1])).map(x => x[0]);
  if (missing.length) deficiencies.push(['§ 156.111(b)(2)(iv)', `Benefits do not serve: ${missing.join(', ')}. Flagged for review.`, 'review']);
  if (bool(discriminatory)) deficiencies.push(['§ 156.111(b)(2)(v)', 'Benefit design contravenes the nondiscrimination standards of § 156.125. Rejected.', 'reject']);
  const outcome = deficiencies.some(d => d[2] === 'reject') ? 'Rejected' : deficiencies.length ? 'Flagged for review' : 'Accepted';
  return { outcome, deficiencies: deficiencies.map(d => ({ citation: d[0], finding: d[1] })) };
}

// ---------- BCA:24, BCA:30 EHB prohibited benefits (45 CFR 156.115(d)) ----------
const BENEFITS = [
  ['ambulatory', 'Ambulatory patient services', false], ['prescription_drugs', 'Prescription drugs', false], ['pediatric_dental', 'Pediatric dental services', false],
  ['routine_adult_dental', 'Routine non-pediatric dental services', true], ['routine_adult_eye_exam', 'Routine non-pediatric eye exam services', true],
  ['long_term_nursing', 'Long-term / custodial nursing home care', true], ['orthodontia', 'Non-medically necessary orthodontia', true],
  ['sex_trait_modification', 'Specified sex-trait modification procedure (§ 156.400)', true],
];
function ehbProhibitedList(planYearStart) {
  const d = reqDate(planYearStart, 'Plan year start date');
  if (d < '2026-01-01') return { tier: 'Plan years beginning before 2026', codes: ['routine_adult_dental', 'routine_adult_eye_exam', 'long_term_nursing', 'orthodontia'] };
  if (d < '2027-01-01') return { tier: 'Plan years beginning in 2026', codes: ['routine_adult_dental', 'routine_adult_eye_exam', 'long_term_nursing', 'orthodontia', 'sex_trait_modification'] };
  return { tier: 'Plan years beginning 2027 or later', codes: ['routine_adult_eye_exam', 'long_term_nursing', 'orthodontia', 'sex_trait_modification'] };
}
function ehbClassification(planYearStart, benefitCode) {
  const b = BENEFITS.find(x => x[0] === benefitCode);
  if (!b) throw new RuleError('Select a benefit.');
  const list = ehbProhibitedList(planYearStart);
  const prohibited = list.codes.includes(benefitCode);
  return { benefit: b[1], tier: list.tier, mayBeEhb: !prohibited, rule: '45 CFR 156.115(d)',
    reason: prohibited ? `${b[1]} may not be classified as EHB (${list.tier}).` : `${b[1]} may be classified as EHB (${list.tier}).` };
}
function planEhbValidation(plan) {
  const start = `${plan.plan_year}-01-01`;
  const list = ehbProhibitedList(start);
  const rows = D.all('SELECT * FROM plan_benefits WHERE plan_id = ? ORDER BY benefit_code', plan.id);
  const violations = rows.filter(r => r.classified_ehb && list.codes.includes(r.benefit_code)).map(r => `${(BENEFITS.find(b => b[0] === r.benefit_code) || [0, r.benefit_code])[1]} is classified as EHB (not allowed: ${list.tier}).`);
  return { planId: plan.id, tier: list.tier, benefits: rows, compliant: violations.length === 0, violations };
}

// ---------- BCA:25-27 AV de minimis (45 CFR 156.140(c), 156.200(b)(3)) ----------
const AV_TARGETS = { Bronze: 60, 'Expanded Bronze': 60, Silver: 70, Gold: 80, Platinum: 90 };
function avDeMinimis(metal, avPercent, qualifyingBronze) {
  const target = AV_TARGETS[metal];
  if (!target) throw new RuleError('Select a metal level.');
  const av = num(avPercent, 'Actuarial value (%)');
  const bronzeQual = (metal === 'Bronze' || metal === 'Expanded Bronze') && bool(qualifyingBronze);
  const low = target - 4, high = target + (bronzeQual ? 5 : 2);
  const pass = av >= low - 1e-9 && av <= high + 1e-9;
  return { metal, av, target, low, high, pass, rule: '45 CFR 156.140(c)(1)', band: bronzeQual ? '−4/+5 pp (qualifying bronze)' : '−4/+2 pp',
    reason: `${metal} target ${target}%: allowed ${low}%–${high}% (${bronzeQual ? '−4/+5' : '−4/+2'} pp, § 156.140(c)(1)). AV ${av}% ${pass ? 'passes' : 'fails'}. The former § 156.140(c)(2) −2 pp bands and the § 156.200(b)(3) silver −0/+2 pp rule no longer apply.` };
}
function csrVariationDeMinimis(variant, avPercent) {
  const target = { 73: 73, 87: 87, 94: 94 }[String(variant)];
  if (!target) throw new RuleError('Select a silver plan variation (73, 87 or 94).');
  const av = num(avPercent, 'Actuarial value (%)');
  const lo = Number(D.param('csr_variation_de_minimis_low', -1)), hi = Number(D.param('csr_variation_de_minimis_high', 1));
  const pass = av >= target + lo - 1e-9 && av <= target + hi + 1e-9;
  return { variant: target, av, low: target + lo, high: target + hi, pass, rule: '45 CFR 156.400 (de minimis variation for a silver plan variation)',
    reason: `Silver ${target}% variation: allowed ${target + lo}%–${target + hi}% (band ${lo}/+${hi} pp from parameters). AV ${av}% ${pass ? 'passes' : 'fails'}.` };
}

// ---------- BCA:33, BCA:34 evidentiary standards ----------
function preponderance(supportPct) {
  const s = num(supportPct, 'Weight of supporting evidence (%)');
  if (s < 0 || s > 100) throw new RuleError('Enter a percentage from 0 to 100.');
  return { established: s > 50, reason: s > 50 ? 'More likely true than not: established by a preponderance of the evidence (45 CFR 155.20).' : 'Not more likely true than not (a 50/50 balance is not enough): not established.' };
}
function terminationForCause(evidentiaryBasis, standardMet) {
  if (!String(evidentiaryBasis || '').trim()) return { allowed: false, reason: 'Document the evidentiary basis before starting a termination for cause (45 CFR 155.220(g)(2)).' };
  if (!bool(standardMet)) return { allowed: false, reason: 'The noncompliance finding must be supported by a preponderance of the evidence (45 CFR 155.220(g)(2)).' };
  return { allowed: true, reason: 'Noncompliance under § 155.220(g)(1) supported by a preponderance of the evidence — termination for cause may proceed.' };
}

// ---------- BCA:35 data inaccuracy overdue ----------
function dataInaccuracyOverdue(deadline, onDate, resolvedOn) {
  if (!deadline) return { overdue: false };
  const d = reqDate(onDate || D.today(), 'Date');
  return { overdue: !resolvedOn && d > deadline, daysPast: !resolvedOn && d > deadline ? daysBetween(deadline, d) : 0 };
}

// ---------- BCA:39 chronic-condition exception comparator cell ----------
function comparatorCell(plan) {
  if (!plan) throw new RuleError('Select a plan.');
  const area = id => D.all('SELECT county_fips FROM plan_service_areas WHERE plan_id = ? ORDER BY 1', id).map(r => r.county_fips).join(',');
  const a = area(plan.id);
  const peers = D.all('SELECT * FROM plans WHERE issuer_id = ? AND plan_year = ? AND standardized = 0 AND id <> ? AND plan_type = ? AND metal = ? AND adult_dental = ? AND pediatric_dental = ? AND adult_vision = ?',
    plan.issuer_id, plan.plan_year, plan.id, plan.plan_type, plan.metal, plan.adult_dental, plan.pediatric_dental, plan.adult_vision).filter(p => area(p.id) === a);
  return { planId: plan.id, cell: { networkType: plan.plan_type, metal: plan.metal, adultDental: !!plan.adult_dental, pediatricDental: !!plan.pediatric_dental, adultVision: !!plan.adult_vision, serviceArea: a }, comparators: peers.map(p => p.id) };
}
function chronicReduction(exceptedCost, comparatorCost) {
  const e = num(exceptedCost, 'Excepted plan cost sharing'), c = num(comparatorCost, 'Comparator cost sharing');
  if (c <= 0) throw new RuleError('Comparator cost sharing must be greater than zero.');
  const pct = round(((c - e) / c) * 100, 2);
  return { reductionPct: pct, meets: pct >= 25 };
}

const rules = { lawfulPresence, ftrEligibility, inconsistencyDeadline, incomeIncreaseCheck, noTaxData, crosswalk, minimumPremium, thresholdConfigCheck,
  oepWindow, validateOep, oepEffectiveDate, d16Availability, sepPlanChange, sepEffectiveDate, sepVerificationRequired, sepVerificationRate, ehbBenchmark,
  ehbClassification, ehbProhibitedList, planEhbValidation, avDeMinimis, csrVariationDeMinimis, preponderance, terminationForCause, dataInaccuracyOverdue,
  comparatorCell, chronicReduction, fplAmount };

// ---------- Rule tools (shown at /exchange/tools and /api/rules) ----------
const G = 'BCA — 2025 CFR changes';
const YES_NO = [['no', 'No'], ['yes', 'Yes']];
const YES_FIRST = [['yes', 'Yes'], ['no', 'No']];
const yr = (v = '2026') => ({ name: 'planYear', label: 'Plan year', type: 'number', value: v });
const TOOLS = [
  { id: 'lawful-presence', group: G, title: 'Lawful Presence (DACA exclusion)', reqs: ['BCA:2'], cite: '45 CFR 155.20',
    inputs: [{ name: 'status', label: 'Immigration status', type: 'select', options: IMMIGRATION_STATUSES.map(s => [s[0], s[1]]) }],
    run: i => { const r = lawfulPresence(i.status); return { outcome: r.eligible ? 'Eligible to enroll' : 'Not lawfully present — not eligible', data: r, rows: [['Lawfully present', r.lawfullyPresent === null ? 'Citizen / national' : r.lawfullyPresent ? 'Yes' : 'No'], ['QHP, APTC and CSR', r.eligible ? 'Eligible' : 'Not eligible'], ['Reason', r.reason]] }; } },
  { id: 'ftr-eligibility', group: G, title: 'FTR APTC Eligibility by Plan Year', reqs: ['BCA:4', 'BCA:5', 'BCA:6'], cite: '45 CFR 155.305(f)(4)',
    inputs: [yr(), { name: 'failedYears', label: 'Tax years HHS reports as failed to file and reconcile', type: 'number', value: '1' }, { name: 'channel', label: 'Notice type', type: 'select', options: [['direct', 'Direct (to tax filer, FTI safeguarded)'], ['indirect', 'Indirect (no FTI disclosure)']] }],
    run: i => { const r = ftrEligibility(i); return { outcome: r.aptcEligible ? 'APTC eligible' : 'APTC denied', data: r, rows: [['Rule applied', r.rule], ['APTC', r.aptcEligible ? 'Eligible' : 'Denied'], ['Notice', r.notice || 'None'], ['Contains FTI', r.fti ? 'Yes' : 'No'], ['Notice text', r.body || '—'], ['Reason', r.reason]] }; } },
  { id: 'inconsistency-deadline', group: G, title: 'Inconsistency Resolution Deadline', reqs: ['BCA:7'], cite: '45 CFR 155.315(f)',
    inputs: [{ name: 'noticeDate', label: 'Inconsistency notice date', type: 'date', value: '' }, { name: 'type', label: 'Inconsistency type', type: 'select', options: [['income', 'Household income'], ['citizenship', 'Citizenship / immigration'], ['other', 'Other']] }, { name: 'extension', label: 'Good-faith extension granted (days)', type: 'number', value: '0' }],
    run: i => { const r = inconsistencyDeadline(i.noticeDate || D.today(), i.type, i.extension); return { outcome: `Resolve by ${r.deadline}`, data: r, rows: [['Deadline', r.deadline], ['Period', `${r.days} days${r.extension ? ` + ${r.extension}` : ''}`], ['Reason', r.reason]] }; } },
  { id: 'income-increase-check', group: G, title: 'Sub-100% FPL Income-Increase Check', reqs: ['BCA:8', 'BCA:9'], cite: '45 CFR 155.320(c)(3)(iii)(A), (vi)(C)(2)',
    inputs: [yr(), { name: 'path', label: 'Verification path', type: 'select', options: [['basic', 'Tax return data (c)(3)(iii)'], ['alternate', 'Alternate data (c)(3)(vi)']] },
      { name: 'householdSize', label: 'Household size', type: 'number', value: '1' }, { name: 'dataIncome', label: 'Income from data source ($)', type: 'number', value: '12000' }, { name: 'attestedIncome', label: 'Attested projected income ($)', type: 'number', value: '22000' },
      { name: 'thresholdPct', label: 'Reasonable threshold (%)', type: 'number', value: '10' }, { name: 'lpMedicaidIneligible', label: 'Lawfully present noncitizen, Medicaid-ineligible by immigration status?', type: 'select', options: YES_NO }],
    run: i => { const r = incomeIncreaseCheck(i); return { outcome: r.triggered ? 'Open income inconsistency' : 'No inconsistency', data: r, rows: [['Data FPL', `${r.dataFpl}%`], ['Attested FPL', `${r.attestedFpl}%`], ['Increase over data', r.increasePct === null ? 'n/a (no data income)' : `${r.increasePct}%`], ['Rule', r.rule], ['Reason', r.reason]] }; } },
  { id: 'no-tax-data', group: G, title: 'No Tax Data Returned', reqs: ['BCA:10'], cite: '45 CFR 155.320(c)(5)',
    inputs: [yr()], run: i => { const r = noTaxData(i.planYear); return { outcome: r.path, data: r, rows: [['Result', r.path], ['Reason', r.reason]] }; } },
  { id: 'reenrollment-crosswalk', group: G, title: 'Re-enrollment Crosswalk (CSR bronze)', reqs: ['BCA:11'], cite: '45 CFR 155.335(j)',
    inputs: [{ name: 'metal', label: 'Current metal level', type: 'select', options: METALS.map(m => [m, m]) }, { name: 'csrEligible', label: 'CSR-eligible?', type: 'select', options: YES_FIRST }],
    run: i => { const r = crosswalk(i.metal, bool(i.csrEligible)); return { outcome: `Re-enroll in ${r.targetMetal}`, data: r, rows: [['Re-enrollment metal level', r.targetMetal], ['Reason', r.reason]] }; } },
  { id: 'minimum-premium', group: G, title: '$5 Minimum Premium at Re-enrollment', reqs: ['BCA:12'], cite: '45 CFR 155.335(n)',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2026' }, { name: 'platform', label: 'Exchange platform', type: 'select', options: [['FFE', 'Federally-facilitated Exchange (Federal platform)'], ['SBE-FP', 'State Exchange on the Federal platform'], ['SBE', 'State-based Exchange']] },
      { name: 'grossPremium', label: 'Plan premium ($/month)', type: 'number', value: '450' }, { name: 'aptc', label: 'Calculated APTC ($/month)', type: 'number', value: '450' },
      { name: 'updatedAppDate', label: 'Updated application submitted on (blank = none)', type: 'date', value: '' }, { name: 'deadline', label: 'Plan selection deadline', type: 'date', value: '2025-12-15' }],
    run: i => { const r = minimumPremium(i); return { outcome: r.applies ? 'Minimum premium applied' : 'Not applied', data: r, rows: [['Adjusted APTC', money(r.aptc)], ['Enrollee net premium', money(r.netPremium)], ...r.conditions.map(([c, m]) => [c, m ? 'Met' : 'Not met']), ['Reason', r.reason]] }; } },
  { id: 'threshold-config', group: G, title: 'Issuer Premium Threshold Configuration', reqs: ['BCA:13'], cite: '45 CFR 155.400(g)',
    inputs: [yr(), { name: 'policies', label: 'Threshold types (comma list: net95, gross98, fixed10)', type: 'text', value: 'net95' }],
    run: i => { const r = thresholdConfigCheck(i.planYear, i.policies); return { outcome: r.valid ? 'Configuration valid' : 'Configuration rejected', data: r, rows: [['Result', r.valid ? 'Valid' : 'Rejected'], ...r.issues.map(x => ['Issue', x])] }; } },
  { id: 'oep-window', group: G, title: 'Open Enrollment Window', reqs: ['BCA:14', 'BCA:15'], cite: '45 CFR 155.410(e)(4)–(5)',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2027' }, { name: 'start', label: 'OEP start (blank = configured)', type: 'date', value: '' }, { name: 'end', label: 'OEP end (blank = configured)', type: 'date', value: '' }],
    run: i => { const y = yearOf(i.benefitYear); const r = i.start || i.end ? validateOep(y, i.start || D.param(`oep_start_${y}`, ''), i.end || D.param(`oep_end_${y}`, '')) : oepWindow(y);
      return { outcome: r.valid ? `${r.start} to ${r.end} (valid)` : 'Window not allowed', data: r, rows: [['Rule', r.rule], ['Window', `${r.start} to ${r.end}`], ['Length', `${r.days} days`], ['Result', r.valid ? 'Valid' : 'Invalid'], ...r.issues.map(x => ['Issue', x])] }; } },
  { id: 'oep-effective-date', group: G, title: 'Open Enrollment Effective Date', reqs: ['BCA:16', 'BCA:17'], cite: '45 CFR 155.410(f)(3)–(4)',
    inputs: [{ name: 'benefitYear', label: 'Benefit year', type: 'number', value: '2027' }, { name: 'selectionDate', label: 'Plan selection date', type: 'date', value: '2026-12-15' }],
    run: i => { const r = oepEffectiveDate(i.benefitYear, i.selectionDate); return { outcome: r.inOep ? `Coverage starts ${r.effectiveDate}` : 'Outside open enrollment', data: r, rows: [['Rule', r.rule], ['Effective date', r.effectiveDate || '—'], ['Reason', r.reason]] }; } },
  { id: 'sep-d16', group: G, title: 'Monthly Low-Income SEP (d)(16)', reqs: ['BCA:18', 'BCA:19', 'BCA:20', 'BCA:21'], cite: '45 CFR 155.420(a)(4), (b)(2)(vii), (d)(16)',
    inputs: [yr('2027'), { name: 'fplPercent', label: 'Household income (% FPL)', type: 'number', value: '140' }, { name: 'aptcEligible', label: 'APTC-eligible?', type: 'select', options: YES_FIRST },
      { name: 'currentMetal', label: 'Current plan metal (blank = not enrolled)', type: 'select', options: [['', 'Not enrolled'], ...METALS.map(m => [m, m])] }, { name: 'newMetal', label: 'New plan metal', type: 'select', options: METALS.map(m => [m, m]) },
      { name: 'selectionDate', label: 'Plan selection date', type: 'date', value: '2027-03-10' }],
    run: i => { const a = d16Availability(i.planYear, i.fplPercent, bool(i.aptcEligible));
      const c = a.available ? sepPlanChange('d16', i.planYear, i.currentMetal, i.newMetal) : null; const e = a.available ? sepEffectiveDate('d16', i.planYear, i.selectionDate) : null;
      return { outcome: a.available ? (c.allowed ? `SEP available — coverage starts ${e.effectiveDate}` : 'SEP available — plan change not allowed') : 'SEP not available', data: { availability: a, change: c, effective: e },
        rows: [['d(16) SEP', a.available ? 'Available' : 'Not available'], ['Reason', a.reason], ...(c ? [['Plan change', `${c.allowed ? 'Allowed' : 'Not allowed'} — ${c.reason}`], ['Effective date', `${e.effectiveDate} (${e.rule})`]] : [])] }; } },
  { id: 'sep-plan-change', group: G, title: 'SEP Plan Change (metal level)', reqs: ['BCA:19'], cite: '45 CFR 155.420(a)(4)(iii)',
    inputs: [{ name: 'sepType', label: 'SEP type', type: 'select', options: SEP_TYPES }, yr(), { name: 'currentMetal', label: 'Current metal', type: 'select', options: METALS.map(m => [m, m]) }, { name: 'newMetal', label: 'New metal', type: 'select', options: METALS.map(m => [m, m]) }],
    run: i => { const r = sepPlanChange(i.sepType, i.planYear, i.currentMetal, i.newMetal); return { outcome: r.allowed ? 'Change allowed' : 'Change not allowed', data: r, rows: [['Rule', r.rule], ['Reason', r.reason]] }; } },
  { id: 'sep-verification', group: G, title: 'SEP Pre-enrollment Verification', reqs: ['BCA:22'], cite: '45 CFR 155.420(g)',
    inputs: [{ name: 'date', label: 'Plan selection date', type: 'date', value: '2026-03-01' }, { name: 'platform', label: 'Platform', type: 'select', options: [['FFE', 'FFE'], ['SBE-FP', 'SBE-FP'], ['SBE', 'SBE']] }, { name: 'verified', label: 'Eligibility verified?', type: 'select', options: YES_FIRST }],
    run: i => { const r = sepVerificationRequired(i.date, i.platform); const denied = r.required && !bool(i.verified);
      return { outcome: denied ? 'Enrollment denied — appeal rights provided' : 'Enrollment may proceed', data: { ...r, denied }, rows: [['Verification required', r.required ? 'Yes' : 'No'], ['Reason', r.reason], ['Result', denied ? 'Denied. You may appeal under 45 CFR 155.505(b)(1)(iii).' : 'Proceed']] }; } },
  { id: 'sep-verification-rate', group: G, title: 'SEP Verification Rate (75%)', reqs: ['BCA:22'], cite: '45 CFR 155.420(g)',
    inputs: [{ name: 'verified', label: 'Verified new SEP enrollments', type: 'number', value: '75' }, { name: 'total', label: 'All new SEP enrollments', type: 'number', value: '100' }],
    run: i => { const r = sepVerificationRate(i.verified, i.total); return { outcome: r.meets ? 'Meets 75% standard' : 'Below 75% standard', data: r, rows: [['Verification rate', `${r.rate}%`], ['Minimum', `${r.minimum}%`]] }; } },
  { id: 'ehb-benchmark', group: G, title: 'EHB-Benchmark Scope of Benefits', reqs: ['BCA:23'], cite: '45 CFR 156.111(b)(2)(iii)–(v)',
    inputs: [{ name: 'singleCategory', label: 'Benefits unduly weighted toward one EHB category?', type: 'select', options: YES_NO }, { name: 'women', label: 'Serves women?', type: 'select', options: YES_FIRST },
      { name: 'children', label: 'Serves children?', type: 'select', options: YES_FIRST }, { name: 'disabilities', label: 'Serves persons with disabilities?', type: 'select', options: YES_FIRST }, { name: 'discriminatory', label: 'Discriminatory benefit design (§ 156.125)?', type: 'select', options: YES_NO }],
    run: i => { const r = ehbBenchmark(i); return { outcome: r.outcome, data: r, rows: [['Outcome', r.outcome], ...r.deficiencies.map(d => [d.citation, d.finding])] }; } },
  { id: 'ehb-prohibited', group: G, title: 'EHB Prohibited Benefits by Plan Year', reqs: ['BCA:24', 'BCA:30'], cite: '45 CFR 156.115(d); 156.400',
    inputs: [{ name: 'planYearStart', label: 'Plan year start date', type: 'date', value: '2026-01-01' }, { name: 'benefit', label: 'Benefit', type: 'select', options: BENEFITS.map(b => [b[0], b[1]]) }],
    run: i => { const r = ehbClassification(i.planYearStart, i.benefit); const list = ehbProhibitedList(i.planYearStart);
      return { outcome: r.mayBeEhb ? 'May be classified as EHB' : 'May NOT be classified as EHB', data: { ...r, prohibited: list.codes }, rows: [['Tier', r.tier], ['Result', r.reason], ['Prohibited in this tier', list.codes.map(c => BENEFITS.find(b => b[0] === c)[1]).join('; ')]] }; } },
  { id: 'av-de-minimis', group: G, title: 'AV De Minimis Range', reqs: ['BCA:25', 'BCA:26', 'BCA:27'], cite: '45 CFR 156.140(c)(1); 156.200(b)(3)',
    inputs: [{ name: 'metal', label: 'Metal level', type: 'select', options: METALS.map(m => [m, m]) }, { name: 'av', label: 'Calculated AV (%)', type: 'number', value: '68.1' }, { name: 'qualifyingBronze', label: 'Bronze plan that covers a major service before the deductible or is an HDHP?', type: 'select', options: YES_NO }],
    run: i => { const r = avDeMinimis(i.metal, i.av, i.qualifyingBronze); return { outcome: r.pass ? 'Within de minimis range' : 'Outside de minimis range', data: r, rows: [['Allowed range', `${r.low}%–${r.high}% (${r.band})`], ['Rule applied', r.rule], ['Reason', r.reason]] }; } },
  { id: 'csr-variation-av', group: G, title: 'Silver Plan Variation AV', reqs: ['BCA:29'], cite: '45 CFR 156.400',
    inputs: [{ name: 'variant', label: 'Silver plan variation', type: 'select', options: [['73', '73% AV'], ['87', '87% AV'], ['94', '94% AV']] }, { name: 'av', label: 'Calculated AV (%)', type: 'number', value: '73.5' }],
    run: i => { const r = csrVariationDeMinimis(i.variant, i.av); return { outcome: r.pass ? 'Within band' : 'Outside band — reject', data: r, rows: [['Allowed range', `${r.low}%–${r.high}%`], ['Reason', r.reason]] }; } },
  { id: 'preponderance', group: G, title: 'Preponderance of the Evidence', reqs: ['BCA:33'], cite: '45 CFR 155.20',
    inputs: [{ name: 'support', label: 'Weight of evidence supporting the fact (%)', type: 'number', value: '50' }],
    run: i => { const r = preponderance(i.support); return { outcome: r.established ? 'Established' : 'Not established', data: r, rows: [['Reason', r.reason]] }; } },
  { id: 'termination-for-cause', group: G, title: 'Agent/Broker Termination for Cause', reqs: ['BCA:34'], cite: '45 CFR 155.220(g)(2)',
    inputs: [{ name: 'evidentiaryBasis', label: 'Documented evidentiary basis', type: 'text', value: '' }, { name: 'standardMet', label: 'Finding supported by a preponderance of the evidence?', type: 'select', options: YES_NO }],
    run: i => { const r = terminationForCause(i.evidentiaryBasis, i.standardMet); return { outcome: r.allowed ? 'Termination may proceed' : 'Termination blocked', data: r, rows: [['Reason', r.reason]] }; } },
  { id: 'chronic-exception-cell', group: G, title: 'Chronic-Condition Exception Comparator', reqs: ['BCA:39'], cite: '45 CFR 156.202(d)',
    inputs: [{ name: 'plan', label: 'Excepted non-standardized plan', type: 'select', options: () => D.all('SELECT id, name FROM plans WHERE standardized = 0 ORDER BY id').map(p => [p.id, `${p.id} — ${p.name}`]) },
      { name: 'exceptedCost', label: 'Excepted plan cost sharing for the chronic-condition benefits ($)', type: 'number', value: '750' }, { name: 'comparatorCost', label: 'Lowest comparator plan cost sharing for the same benefits ($)', type: 'number', value: '1000' }],
    run: i => { const c = comparatorCell(D.get('SELECT * FROM plans WHERE id = ?', i.plan)); const r = chronicReduction(i.exceptedCost, i.comparatorCost);
      return { outcome: r.meets ? 'Meets 25% reduction' : 'Below 25% reduction', data: { ...c, ...r }, rows: [['Comparator cell', `${c.cell.networkType} ${c.cell.metal} | adult dental ${c.cell.adultDental ? 'Y' : 'N'}, pediatric dental ${c.cell.pediatricDental ? 'Y' : 'N'}, adult vision ${c.cell.adultVision ? 'Y' : 'N'}`],
        ['Comparator plans', c.comparators.join(', ') || 'None in this cell'], ['Cost-sharing reduction', `${r.reductionPct}%`]] }; } },
];
R.TOOLS.push(...TOOLS);

// Existing tools that also cover BCA requirements (the regulation text they implement did not change, or was extended).
const ALSO = { 'agent-suspension': ['BCA:3'], 'ftr-notice': ['BCA:5'], 'premium-threshold': ['BCA:13'], 'meaningful-difference': ['BCA:28'], 'standardized-plan-compliance': ['BCA:28'],
  'csr-loading': ['BCA:31'], 'reconsideration-check': ['BCA:32'], 'data-inaccuracy-deadline': ['BCA:35'], 'appeal-standing': ['BCA:36'], 'radv-appeal-rerun': ['BCA:37'], 'nonstandard-limit': ['BCA:38'] };
for (const [id, reqs] of Object.entries(ALSO)) { const t = R.TOOLS.find(x => x.id === id); if (t) for (const r of reqs) if (!t.reqs.includes(r)) t.reqs.push(r); }

module.exports = { rules, TOOLS, IMMIGRATION_STATUSES, SEP_TYPES, METALS, BENEFITS, FEDERAL_PLATFORM, AV_TARGETS };
