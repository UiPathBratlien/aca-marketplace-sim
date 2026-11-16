'use strict';
// Consumer marketplace calculations: ZIP lookup, age rating, SLCSP, APTC, CSR, Medicaid screening.
// Simplified for testing; schedule values are configurable through reg_parameters.
const D = require('./db');

function lookupZip(zip) {
  return D.get(`SELECT z.zip, z.city, c.fips, c.name AS county, c.state, s.name AS state_name, s.exchange_type, s.medicaid_expansion
    FROM zip_codes z JOIN counties c ON c.fips = z.county_fips JOIN states s ON s.code = c.state WHERE z.zip = ?`, String(zip || '').trim());
}

function ageFactor(age) {
  if (age < 15) return 0.765;
  if (age < 21) return 0.833 + (age - 15) * 0.025;
  if (age <= 24) return 1.0;
  if (age <= 39) return 1.0 + (age - 24) * 0.0187;
  if (age <= 49) return 1.278 + (age - 40) * 0.034;
  if (age <= 63) return 1.635 + (age - 50) * 0.098;
  return 3.0;
}

function ageOn(dob, onDate) {
  const b = new Date(dob + 'T00:00:00Z'), o = new Date(onDate + 'T00:00:00Z');
  if (Number.isNaN(b.getTime())) return null;
  let a = o.getUTCFullYear() - b.getUTCFullYear();
  if (o.getUTCMonth() < b.getUTCMonth() || (o.getUTCMonth() === b.getUTCMonth() && o.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

function fplAmount(size) {
  return Number(D.param('fpl_base_2025', 15650)) + Number(D.param('fpl_increment_2025', 5500)) * (Math.max(1, size) - 1);
}

function applicablePercent(fpl) {
  const enhanced = D.param('enhanced_ptc_extended_2026', 'false') === 'true';
  const lerp = (lo, hi, a, b) => a + ((fpl - lo) / (hi - lo)) * (b - a);
  if (enhanced) {
    if (fpl < 150) return 0;
    if (fpl < 200) return lerp(150, 200, 0, 2);
    if (fpl < 250) return lerp(200, 250, 2, 4);
    if (fpl < 300) return lerp(250, 300, 4, 6);
    if (fpl < 400) return lerp(300, 400, 6, 8.5);
    return 8.5;
  }
  if (fpl > 400) return null;                 // no PTC above 400% FPL
  if (fpl < 133) return 2.10;
  if (fpl < 150) return lerp(133, 150, 3.14, 4.19);
  if (fpl < 200) return lerp(150, 200, 4.19, 6.60);
  if (fpl < 250) return lerp(200, 250, 6.60, 8.44);
  if (fpl < 300) return lerp(250, 300, 8.44, 9.96);
  return 9.96;
}

function plansInCounty(fips, year = 2026) {
  return D.all(`SELECT p.*, i.name AS issuer_name FROM plans p JOIN issuers i ON i.id = p.issuer_id
    JOIN plan_service_areas a ON a.plan_id = p.id WHERE a.county_fips = ? AND p.plan_year = ? ORDER BY p.base_premium`, fips, year);
}

const r2 = n => Math.round(n * 100) / 100;
function householdPremium(plan, ages) { return r2(ages.reduce((s, a) => s + plan.base_premium * ageFactor(a), 0)); }

function slcsp(fips, ages) {
  const silvers = plansInCounty(fips).filter(p => p.metal === 'Silver').map(p => ({ p, prem: householdPremium(p, ages) })).sort((a, b) => a.prem - b.prem);
  if (!silvers.length) return null;
  const pick = silvers[Math.min(1, silvers.length - 1)];
  return { plan: pick.p, premium: pick.prem };
}

// members: [{ age, applying }]
function eligibility({ zip, householdSize, income, members }) {
  const loc = lookupZip(zip);
  if (!loc) return { error: `We don't have plans for ZIP code ${zip}. Try 78701, 77002, 79830, 43215, 45651, 72201 or 30303.` };
  const size = Math.max(1, Number(householdSize) || members.length || 1);
  const inc = Math.max(0, Number(income) || 0);
  const fpl = r2((inc / fplAmount(size)) * 100);
  const applyingAges = members.filter(m => m.applying !== false).map(m => m.age);
  const res = { location: loc, householdSize: size, income: inc, fplPercent: fpl, medicaidEligible: false, aptcEligible: false, aptcMonthly: 0, csrVariant: null, slcsp: null, applicablePercent: null };
  if (loc.medicaid_expansion && fpl < 138) { res.medicaidEligible = true; res.message = `Based on your income (${fpl}% of the federal poverty level), you may qualify for Medicaid in ${loc.state_name}.`; return res; }
  if (fpl < 100) { res.message = `Household income below 100% of the federal poverty level in a non-expansion state. You may not qualify for premium tax credits.`; return res; }
  const ap = applicablePercent(fpl);
  const bench = slcsp(loc.fips, applyingAges.length ? applyingAges : [40]);
  res.slcsp = bench ? { planId: bench.plan.id, planName: bench.plan.name, premium: bench.premium } : null;
  if (ap === null || !bench) { res.message = 'Your household income is above 400% of the federal poverty level, so you do not qualify for premium tax credits in 2026.'; return res; }
  res.applicablePercent = r2(ap);
  const contribution = r2((inc * ap) / 100 / 12);
  res.expectedContribution = contribution;
  res.aptcMonthly = Math.max(0, r2(bench.premium - contribution));
  res.aptcEligible = res.aptcMonthly > 0;
  if (res.aptcEligible) {
    if (fpl <= 150) res.csrVariant = '94'; else if (fpl <= 200) res.csrVariant = '87'; else if (fpl <= 250) res.csrVariant = '73';
  }
  res.message = res.aptcEligible
    ? `You qualify for an estimated premium tax credit of $${res.aptcMonthly.toFixed(2)} per month.${res.csrVariant ? ' You also qualify for extra savings on Silver plans (cost-sharing reductions).' : ''}`
    : 'Benchmark plan is affordable at your income; no premium tax credit applies.';
  return res;
}

module.exports = { lookupZip, ageFactor, ageOn, fplAmount, applicablePercent, plansInCounty, householdPremium, slcsp, eligibility, r2 };
