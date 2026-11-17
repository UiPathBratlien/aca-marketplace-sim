'use strict';
// SQLite data layer (Node 24 built-in node:sqlite). Schema + deterministic seed data.
// All data is fictional test data for automation testing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.ACA_DB_PATH || path.join(__dirname, '..', 'data', 'aca.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE states (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  exchange_type TEXT NOT NULL,            -- FFE | SBE-FP | SBE
  plan_management INTEGER NOT NULL,       -- 1 = State performs plan-management functions
  medicaid_expansion INTEGER NOT NULL
);
CREATE TABLE counties (
  fips TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL REFERENCES states(code),
  population INTEGER NOT NULL, rural INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE zip_codes (zip TEXT PRIMARY KEY, city TEXT NOT NULL, county_fips TEXT NOT NULL REFERENCES counties(fips));
CREATE TABLE issuers (
  id INTEGER PRIMARY KEY, hios_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
  payment_threshold_policy TEXT NOT NULL DEFAULT 'none'   -- comma list of: net95, gross98, fixed10
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY, issuer_id INTEGER NOT NULL REFERENCES issuers(id), name TEXT NOT NULL,
  plan_year INTEGER NOT NULL, metal TEXT NOT NULL, plan_type TEXT NOT NULL,
  standardized INTEGER NOT NULL DEFAULT 0, standardized_design TEXT,
  product_id TEXT NOT NULL, network_id TEXT NOT NULL, drug_list_id TEXT NOT NULL,
  adult_dental INTEGER NOT NULL DEFAULT 0, pediatric_dental INTEGER NOT NULL DEFAULT 1, adult_vision INTEGER NOT NULL DEFAULT 0,
  deductible INTEGER NOT NULL, moop INTEGER NOT NULL, coinsurance INTEGER NOT NULL,
  primary_care TEXT NOT NULL, specialist TEXT NOT NULL, generic_rx TEXT NOT NULL, er TEXT NOT NULL,
  base_premium REAL NOT NULL,             -- monthly premium for a 21-year-old
  actuarial_value REAL NOT NULL, hsa_eligible INTEGER NOT NULL DEFAULT 0, quality_rating INTEGER
);
CREATE TABLE plan_service_areas (
  plan_id TEXT NOT NULL REFERENCES plans(id), county_fips TEXT NOT NULL REFERENCES counties(fips),
  PRIMARY KEY (plan_id, county_fips)
);
CREATE TABLE bhp_slcsp_candidates (
  county_fips TEXT NOT NULL REFERENCES counties(fips), plan_id TEXT NOT NULL REFERENCES plans(id),
  population_served INTEGER NOT NULL, PRIMARY KEY (county_fips, plan_id)
);
CREATE TABLE qhp_certifications (
  plan_id TEXT PRIMARY KEY, plan_name TEXT NOT NULL, issuer_id INTEGER NOT NULL REFERENCES issuers(id),
  state TEXT NOT NULL REFERENCES states(code), plan_year INTEGER NOT NULL, metal TEXT NOT NULL, plan_type TEXT NOT NULL,
  queue TEXT NOT NULL,                    -- pending | active | submission | in_progress | comprehensive | quality
  status TEXT NOT NULL, submitted_on TEXT NOT NULL,
  actuarial_value REAL NOT NULL, av_minimum REAL NOT NULL,
  moop_individual INTEGER NOT NULL, moop_limit INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE qhp_assessments (
  plan_id TEXT NOT NULL REFERENCES qhp_certifications(plan_id), criterion TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT, PRIMARY KEY (plan_id, criterion)
);
CREATE TABLE qhp_checklist_items (
  id INTEGER PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES qhp_certifications(plan_id),
  section TEXT NOT NULL, item TEXT NOT NULL, value TEXT NOT NULL, detail TEXT
);
CREATE TABLE qhp_denials (
  id INTEGER PRIMARY KEY, denial_number TEXT UNIQUE NOT NULL, plan_id TEXT NOT NULL REFERENCES qhp_certifications(plan_id),
  section TEXT NOT NULL, denial_reason TEXT NOT NULL, notes TEXT, regulatory_basis TEXT NOT NULL,
  authority TEXT NOT NULL, violations TEXT NOT NULL, status_after TEXT NOT NULL, denial_letter TEXT NOT NULL,
  denied_by TEXT NOT NULL, denied_on TEXT NOT NULL, reconsideration_deadline TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE qhp_reconsiderations (
  id INTEGER PRIMARY KEY, request_number TEXT UNIQUE NOT NULL, denial_id INTEGER NOT NULL REFERENCES qhp_denials(id),
  plan_id TEXT NOT NULL, received_on TEXT NOT NULL, evidence_standard TEXT NOT NULL, evidence_summary TEXT NOT NULL,
  outcome TEXT NOT NULL, outcome_reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'consumer', created_at TEXT NOT NULL
);
CREATE TABLE agencies (id INTEGER PRIMARY KEY, name TEXT NOT NULL, agency_npn TEXT UNIQUE NOT NULL, state TEXT NOT NULL);
CREATE TABLE agents (
  id INTEGER PRIMARY KEY, npn TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  agency_id INTEGER REFERENCES agencies(id), is_lead_agent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
  phone TEXT, status TEXT NOT NULL DEFAULT 'Active', suspension_ground TEXT, suspended_on TEXT
);
CREATE TABLE compliance_actions (
  id INTEGER PRIMARY KEY, action_number TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
  agency_id INTEGER REFERENCES agencies(id), agent_id INTEGER REFERENCES agents(id),
  basis TEXT NOT NULL, notes TEXT, outcome TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE applications (
  id INTEGER PRIMARY KEY, app_number TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  coverage_year INTEGER NOT NULL, zip TEXT, county_fips TEXT, state TEXT, status TEXT NOT NULL,
  household_size INTEGER, annual_income REAL, fpl_percent REAL,
  medicaid_eligible INTEGER, aptc_eligible INTEGER, aptc_monthly REAL, csr_variant TEXT,
  slcsp_plan_id TEXT, slcsp_premium REAL,
  assisted_by_agent_id INTEGER REFERENCES agents(id),
  consent_given INTEGER NOT NULL DEFAULT 0, consent_review_confirmed INTEGER NOT NULL DEFAULT 0, consent_method TEXT,
  signature TEXT, created_at TEXT NOT NULL, submitted_at TEXT
);
CREATE TABLE household_members (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL, dob TEXT NOT NULL, sex TEXT, relationship TEXT NOT NULL,
  applying INTEGER NOT NULL DEFAULT 1, tobacco INTEGER NOT NULL DEFAULT 0, ssn_last4 TEXT
);
CREATE TABLE income_sources (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL, income_type TEXT NOT NULL, employer TEXT, annual_amount REAL NOT NULL
);
CREATE TABLE enrollments (
  id INTEGER PRIMARY KEY, enrollment_number TEXT UNIQUE NOT NULL, application_id INTEGER NOT NULL REFERENCES applications(id),
  user_id INTEGER NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL REFERENCES plans(id),
  gross_premium REAL NOT NULL, aptc_applied REAL NOT NULL, net_premium REAL NOT NULL,
  status TEXT NOT NULL, effective_date TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE premium_payments (
  id INTEGER PRIMARY KEY, payment_number TEXT UNIQUE NOT NULL, enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  payment_type TEXT NOT NULL, amount_due REAL NOT NULL, amount_paid REAL NOT NULL,
  policy_applied TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE appeals (
  id INTEGER PRIMARY KEY, appeal_number TEXT UNIQUE NOT NULL, user_id INTEGER REFERENCES users(id),
  application_number TEXT, filer_role TEXT NOT NULL, filer_name TEXT NOT NULL, appellant_name TEXT NOT NULL,
  appeals_entity TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE ftr_cases (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), tax_filer_name TEXT NOT NULL,
  application_number TEXT, consecutive_ftr_years INTEGER NOT NULL, last_ftr_tax_year INTEGER NOT NULL,
  notice_channel TEXT NOT NULL,           -- direct | indirect
  aptc_status TEXT NOT NULL DEFAULT 'Eligible'
);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY, notice_number TEXT UNIQUE NOT NULL, user_id INTEGER REFERENCES users(id),
  ftr_case_id INTEGER REFERENCES ftr_cases(id), recipient TEXT NOT NULL, notice_type TEXT NOT NULL,
  channel TEXT NOT NULL, contains_fti INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE data_inaccuracy_reports (
  id INTEGER PRIMARY KEY, report_number TEXT UNIQUE NOT NULL, issuer_id INTEGER NOT NULL REFERENCES issuers(id),
  state TEXT NOT NULL, description TEXT NOT NULL, received_on TEXT NOT NULL,
  complete INTEGER NOT NULL DEFAULT 0, completed_on TEXT, resolution_deadline TEXT,
  status TEXT NOT NULL, resolution TEXT, resolved_on TEXT, submitted_to_hhs_on TEXT
);
CREATE TABLE qis_submissions (
  id INTEGER PRIMARY KEY, issuer_id INTEGER NOT NULL REFERENCES issuers(id), plan_year INTEGER NOT NULL,
  exchange_type TEXT NOT NULL, focus_area TEXT NOT NULL, target_met INTEGER NOT NULL
);
CREATE TABLE reg_parameters (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT NOT NULL, citation TEXT);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT, actor TEXT NOT NULL, at TEXT NOT NULL
);
`;

const TABLES = ['audit_log', 'reg_parameters', 'qis_submissions', 'data_inaccuracy_reports', 'notices', 'ftr_cases',
  'appeals', 'premium_payments', 'enrollments', 'income_sources', 'household_members', 'applications',
  'compliance_actions', 'agents', 'agencies', 'users', 'qhp_reconsiderations', 'qhp_denials', 'qhp_checklist_items',
  'qhp_assessments', 'qhp_certifications', 'bhp_slcsp_candidates', 'plan_service_areas', 'plans', 'issuers',
  'zip_codes', 'counties', 'states'];

function nowIso() { return new Date().toISOString(); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
}

function insert(table, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`;
  const params = {};
  for (const c of cols) params[c] = row[c] === undefined ? null : (typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c]);
  return db.prepare(sql).run(params);
}

function seed() {
  const created = nowIso();

  // ---- Geography (sample data; exchange models are illustrative) ----
  [
    ['TX', 'Texas', 'FFE', 0, 0],
    ['OH', 'Ohio', 'FFE', 1, 1],          // FFE State performing plan-management functions (ECP review -> HHS for PY2026)
    ['AR', 'Arkansas', 'SBE-FP', 1, 1],
    ['GA', 'Georgia', 'SBE', 1, 0],
  ].forEach(([code, name, exchange_type, plan_management, medicaid_expansion]) =>
    insert('states', { code, name, exchange_type, plan_management, medicaid_expansion }));

  [
    ['48453', 'Travis County', 'TX', 1290188, 0],
    ['48201', 'Harris County', 'TX', 4731145, 0],
    ['48043', 'Brewster County', 'TX', 9546, 1],
    ['39049', 'Franklin County', 'OH', 1323807, 0],
    ['39163', 'Vinton County', 'OH', 12800, 1],
    ['05119', 'Pulaski County', 'AR', 399125, 0],
    ['13121', 'Fulton County', 'GA', 1066710, 0],
  ].forEach(([fips, name, state, population, rural]) => insert('counties', { fips, name, state, population, rural }));

  [
    ['78701', 'Austin', '48453'], ['78702', 'Austin', '48453'], ['77002', 'Houston', '48201'], ['77098', 'Houston', '48201'],
    ['79830', 'Alpine', '48043'], ['43215', 'Columbus', '39049'], ['45651', 'McArthur', '39163'],
    ['72201', 'Little Rock', '05119'], ['30303', 'Atlanta', '13121'],
  ].forEach(([zip, city, county_fips]) => insert('zip_codes', { zip, city, county_fips }));

  // ---- Issuers (fictional) ----
  const issuers = [
    [1, '10101', 'Bluebonnet Health Plan', 'TX', 'net95'],
    [2, '10202', 'Gulf Prairie Health', 'TX', 'gross98,fixed10'],
    [3, '20303', 'Lakeshore Health Cooperative', 'OH', 'net95,fixed10'],
    [4, '20404', 'Riverbend Mutual Health', 'OH', 'none'],
    [5, '30505', 'Ozark Valley Health', 'AR', 'net95'],
    [6, '40606', 'Peach Orchard Health', 'GA', 'none'],
  ];
  issuers.forEach(([id, hios_id, name, state, payment_threshold_policy]) =>
    insert('issuers', { id, hios_id, name, state, payment_threshold_policy }));

  // ---- Marketplace plans (PY 2026) ----
  const designs = [
    // key, metal, type, std, stdDesign, ded, moop, coins, pcp, spec, rx, er, premium21, av, hsa
    ['BR', 'Bronze', 'EPO', 0, null, 7400, 10150, 40, '$50 after deductible', '$100 after deductible', '$25', '40% after deductible', 268, 0.62, 0],
    ['EB', 'Expanded Bronze', 'HMO', 1, 'Standardized Expanded Bronze', 7500, 10000, 50, '$50 copay', '$100 after deductible', '$25', '50% after deductible', 281, 0.645, 0],
    ['SS', 'Silver', 'HMO', 1, 'Standardized Silver', 6000, 8900, 40, '$40 copay', '$80 copay', '$20', '40% after deductible', 352, 0.70, 0],
    ['SL', 'Silver', 'PPO', 0, null, 4500, 9200, 30, '$35 copay', '$70 copay', '$15', '30% after deductible', 371, 0.71, 0],
    ['GD', 'Gold', 'HMO', 0, null, 1500, 8000, 20, '$20 copay', '$50 copay', '$10', '$350 copay', 438, 0.80, 0],
    ['PL', 'Platinum', 'PPO', 0, null, 0, 4000, 10, '$10 copay', '$30 copay', '$5', '$250 copay', 545, 0.90, 0],
  ];
  const premiumAdj = { 1: 1.00, 2: 1.06, 3: 0.92, 4: 0.97, 5: 0.89, 6: 1.03 };
  const countiesByState = {};
  db.prepare('SELECT fips, state FROM counties').all().forEach(c => (countiesByState[c.state] ||= []).push(c.fips));
  issuers.forEach(([iid, hios, iname, st]) => {
    designs.forEach(([key, metal, type, std, stdDesign, ded, moop, coins, pcp, spec, rx, er, p21, av, hsa], idx) => {
      const id = `${hios}${st}${String(idx + 1).padStart(3, '0')}0001`;
      const metalShort = metal.replace('Expanded ', 'Exp. ');
      insert('plans', {
        id, issuer_id: iid, name: `${iname.split(' ')[0]} ${metalShort} ${type}${std ? ' Standard' : ''}`,
        plan_year: 2026, metal, plan_type: type, standardized: std, standardized_design: stdDesign,
        product_id: `${hios}${st}${type === 'HMO' ? '001' : type === 'PPO' ? '002' : '003'}`,
        network_id: `${st}N${String(iid).padStart(3, '0')}`, drug_list_id: `${st}D${String(iid).padStart(3, '0')}`,
        adult_dental: 0, pediatric_dental: 1, adult_vision: key === 'GD' ? 1 : 0,
        deductible: ded, moop, coinsurance: coins, primary_care: pcp, specialist: spec, generic_rx: rx, er,
        base_premium: Math.round(p21 * premiumAdj[iid] * 100) / 100, actuarial_value: av, hsa_eligible: hsa,
        quality_rating: ((iid + idx) % 5) + 1,
      });
      for (const f of countiesByState[st]) insert('plan_service_areas', { plan_id: id, county_fips: f });
    });
  });

  // Extra plans to exercise plan-design rules (meaningful difference, nonstandard limits)
  const extra = (row, counties) => {
    insert('plans', Object.assign({
      plan_year: 2026, adult_dental: 0, pediatric_dental: 1, adult_vision: 0, hsa_eligible: 0, quality_rating: 3,
      primary_care: '$40 copay', specialist: '$80 copay', generic_rx: '$20', er: '40% after deductible',
    }, row));
    counties.forEach(f => insert('plan_service_areas', { plan_id: row.id, county_fips: f }));
  };
  // Duplicate standardized silver from Bluebonnet: same product, network and drug list as 10101TX0030001 -> NOT meaningfully different
  extra({ id: '10101TX0070001', issuer_id: 1, name: 'Bluebonnet Silver HMO Standard Plus', metal: 'Silver', plan_type: 'HMO',
    standardized: 1, standardized_design: 'Standardized Silver', product_id: '10101TX001', network_id: 'TXN001', drug_list_id: 'TXD001',
    deductible: 6000, moop: 8900, coinsurance: 40, base_premium: 355, actuarial_value: 0.70 }, countiesByState.TX);
  // Second standardized silver from Bluebonnet with a different network -> meaningfully different
  extra({ id: '10101TX0080001', issuer_id: 1, name: 'Bluebonnet Silver HMO Standard Select Network', metal: 'Silver', plan_type: 'HMO',
    standardized: 1, standardized_design: 'Standardized Silver', product_id: '10101TX001', network_id: 'TXN901', drug_list_id: 'TXD001',
    deductible: 6000, moop: 8900, coinsurance: 40, base_premium: 341, actuarial_value: 0.70 }, countiesByState.TX);
  // PY2025 standardized plans (2025 Payment Notice, 89 FR 26358–59): silver $5,000/$8,000, expanded bronze $7,500/$9,200.
  // The two silvers are identical, which PY2025 allowed (no meaningful-difference rule until 45 CFR 156.201(c) for PY2026).
  extra({ id: '10101TX0032025', plan_year: 2025, issuer_id: 1, name: 'Bluebonnet Silver HMO Standard (PY2025)', metal: 'Silver', plan_type: 'HMO',
    standardized: 1, standardized_design: 'Standardized Silver', product_id: '10101TX001', network_id: 'TXN001', drug_list_id: 'TXD001',
    deductible: 5000, moop: 8000, coinsurance: 40, base_premium: 338, actuarial_value: 0.70 }, countiesByState.TX);
  extra({ id: '10101TX0072025', plan_year: 2025, issuer_id: 1, name: 'Bluebonnet Silver HMO Standard Plus (PY2025)', metal: 'Silver', plan_type: 'HMO',
    standardized: 1, standardized_design: 'Standardized Silver', product_id: '10101TX001', network_id: 'TXN001', drug_list_id: 'TXD001',
    deductible: 5000, moop: 8000, coinsurance: 40, base_premium: 340, actuarial_value: 0.70 }, countiesByState.TX);
  extra({ id: '10101TX0022025', plan_year: 2025, issuer_id: 1, name: 'Bluebonnet Exp. Bronze HMO Standard (PY2025)', metal: 'Expanded Bronze', plan_type: 'HMO',
    standardized: 1, standardized_design: 'Standardized Expanded Bronze', product_id: '10101TX001', network_id: 'TXN001', drug_list_id: 'TXD001',
    deductible: 7500, moop: 9200, coinsurance: 50, base_premium: 270, actuarial_value: 0.645 }, countiesByState.TX);
  // Gulf Prairie: three non-standardized Gold PPO plans, same service area, no dental/vision -> exceeds 2-plan limit
  ['A', 'B', 'C'].forEach((s, i) => extra({ id: `10202TX01${i}0001`, issuer_id: 2, name: `Gulf Gold PPO Choice ${s}`, metal: 'Gold', plan_type: 'PPO',
    standardized: 0, product_id: '10202TX002', network_id: 'TXN002', drug_list_id: 'TXD002', deductible: 1000 + i * 250, moop: 7500,
    coinsurance: 20, base_premium: 452 + i * 6, actuarial_value: 0.79 }, countiesByState.TX));
  // Lakeshore: three non-standardized Silver HMO plans; one adds adult dental (separate category) -> within limit
  [['A', 0], ['B', 0], ['C', 1]].forEach(([s, dental], i) => extra({ id: `20303OH02${i}0001`, issuer_id: 3, name: `Lakeshore Silver HMO Flex ${s}${dental ? ' + Adult Dental' : ''}`,
    metal: 'Silver', plan_type: 'HMO', standardized: 0, product_id: '20303OH001', network_id: 'OHN003', drug_list_id: 'OHD003',
    adult_dental: dental, deductible: 4000 + i * 300, moop: 9000, coinsurance: 30, base_premium: 340 + i * 5, actuarial_value: 0.70 }, countiesByState.OH));

  // Harris County is served by two different SLCSPs in different portions of the county (BHP SLCSP selection)
  insert('bhp_slcsp_candidates', { county_fips: '48201', plan_id: '10101TX0030001', population_served: 3075244 });
  insert('bhp_slcsp_candidates', { county_fips: '48201', plan_id: '10202TX0030001', population_served: 1655901 });
  insert('bhp_slcsp_candidates', { county_fips: '39163', plan_id: '20303OH0030001', population_served: 4100 });
  insert('bhp_slcsp_candidates', { county_fips: '39163', plan_id: '20404OH0030001', population_served: 8700 });

  // ---- QHP certification records used by Test Manager cases ACA:151-160 ----
  const certs = [
    // plan_id, name, issuer, state, metal, type, queue, status, av, avMin, moop, moopLimit
    ['QHP-2026-001', 'Bluebonnet Silver HMO Value', 1, 'TX', 'Silver', 'HMO', 'review', 'Pending Review', 70, 70, 9200, 9450],
    ['QHP-2026-002', 'Gulf Prairie Gold EPO Family', 2, 'TX', 'Gold', 'EPO', 'pending', 'Pending Certification', 80, 80, 8500, 9450],
    ['QHP-2026-003', 'Lakeshore Bronze Saver', 3, 'OH', 'Bronze', 'EPO', 'active', 'Certified - Under Review', 58, 60, 9400, 9450],
    ['QHP-2026-004', 'Riverbend Rural Silver HMO', 4, 'OH', 'Silver', 'HMO', 'submission', 'Submitted', 70, 70, 9300, 9450],
    ['QHP-2026-005', 'Bluebonnet Silver PPO Plus', 1, 'TX', 'Silver', 'PPO', 'in_progress', 'In Review', 70, 70, 10500, 9450],
    ['QHP-2026-006', 'Gulf Prairie Silver Essentials', 2, 'TX', 'Silver', 'HMO', 'pending', 'Pending Certification', 70, 70, 9000, 9450],
    ['QHP-2026-007', 'Lakeshore Gold Community', 3, 'OH', 'Gold', 'HMO', 'quality', 'Pending Quality Review', 80, 80, 8000, 9450],
    ['QHP-2026-008', 'Riverbend Bronze Basic', 4, 'OH', 'Bronze', 'PPO', 'comprehensive', 'Pending Full Assessment', 57, 60, 9450, 9450],
    ['QHP-2026-009', 'Ozark Valley Silver Choice', 5, 'AR', 'Silver', 'PPO', 'transparency', 'Pending Transparency Review', 70, 70, 9100, 9450],
    ['QHP-2026-010', 'Bluebonnet Platinum Premier', 1, 'TX', 'Platinum', 'PPO', 'accreditation', 'Pending Accreditation Review', 90, 90, 4500, 9450],
    ['QHP-2026-011', 'Gulf Prairie Bronze HSA', 2, 'TX', 'Bronze', 'EPO', 'active', 'Certified', 61, 60, 9450, 9450],
    ['QHP-2026-012', 'Lakeshore Silver Standard', 3, 'OH', 'Silver', 'HMO', 'review', 'Pending Review', 70, 70, 8900, 9450],
    ['QHP-2026-013', 'Riverbend Gold Advantage', 4, 'OH', 'Gold', 'PPO', 'pending', 'Pending Certification', 80, 80, 8200, 9450],
    ['QHP-2026-014', 'Ozark Valley Bronze Value', 5, 'AR', 'Bronze', 'HMO', 'submission', 'Submitted', 60, 60, 9450, 9450],
    ['QHP-2026-015', 'Peach Orchard Silver Select', 6, 'GA', 'Silver', 'HMO', 'in_progress', 'In Review', 70, 70, 9100, 9450],
  ];
  const submittedOn = ['2026-05-14', '2026-05-15', '2026-04-30', '2026-06-02', '2026-05-20', '2026-05-21', '2026-05-22',
    '2026-05-28', '2026-05-29', '2026-06-01', '2026-04-15', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06'];
  certs.forEach(([plan_id, plan_name, issuer_id, state, metal, plan_type, queue, status, av, avMin, moop, moopLimit], i) => {
    insert('qhp_certifications', { plan_id, plan_name, issuer_id, state, plan_year: 2026, metal, plan_type, queue, status,
      submitted_on: submittedOn[i], actuarial_value: av, av_minimum: avMin, moop_individual: moop, moop_limit: moopLimit, updated_at: created });
  });

  // Default assessments: Compliant everywhere, then per-plan exceptions
  const CRITERIA = ['network', 'ehb', 'av', 'cost_sharing', 'discrimination', 'qis', 'transparency', 'accreditation', 'ecp'];
  const det = {
    network: 'Provider network meets time and distance standards in all service-area counties.',
    ehb: 'All ten essential health benefit categories covered.',
    av: 'Actuarial value within permitted range for metal level.',
    cost_sharing: 'Maximum out-of-pocket within 2026 limit.',
    discrimination: 'No discriminatory benefit design identified.',
    qis: 'Quality improvement strategy submitted and accepted.',
    transparency: 'All machine-readable files submitted.',
    accreditation: 'Accredited by a recognized accrediting entity (valid through 12/31/2027).',
    ecp: 'Essential community provider threshold met (35%).',
  };
  const overrides = {
    'QHP-2026-001': { network: ['Not Reviewed', 'Network adequacy data received; review not completed.'] },
    'QHP-2026-003': { av: ['Failed', 'Bronze plan actuarial value 58% is below the 60% minimum (test configuration).'] },
    'QHP-2026-004': { network: ['Failed', 'Insufficient primary care providers in rural counties'] },
    'QHP-2026-005': { cost_sharing: ['Failed', 'Maximum out-of-pocket $10,500 exceeds 2026 limit of $9,450.'] },
    'QHP-2026-006': { discrimination: ['Flagged', 'HIV medication coverage limited to $500 monthly cap'] },
    'QHP-2026-007': { qis: ['Missing', 'No quality improvement strategy document provided'] },
    'QHP-2026-008': {
      network: ['Failed', 'Insufficient specialist access in 2 counties.'],
      ehb: ['Failed', 'Habilitative services not covered.'],
      av: ['Failed', 'Bronze plan actuarial value 57% is below the 60% minimum (test configuration).'],
    },
    'QHP-2026-009': { transparency: ['Failed', 'In-Network Rates File: Not Submitted'] },
    'QHP-2026-010': { accreditation: ['Failed', 'No valid accreditation from recognized entity'] },
  };
  for (const [plan_id] of certs) {
    for (const c of CRITERIA) {
      const o = overrides[plan_id] && overrides[plan_id][c];
      insert('qhp_assessments', { plan_id, criterion: c, status: o ? o[0] : 'Passed', detail: o ? o[1] : det[c] });
    }
  }

  // Section checklists
  const general = ['Network Adequacy Standards', 'Essential Health Benefits', 'Actuarial Value', 'Cost-Sharing Limits',
    'Non-Discrimination in Benefit Design', 'Quality Improvement Strategy', 'Transparency in Coverage', 'Accreditation',
    'Essential Community Providers'];
  const ehb = ['Ambulatory Patient Services', 'Emergency Services', 'Hospitalization', 'Maternity and Newborn Care',
    'Mental Health and Substance Use Disorder Services', 'Prescription Drugs', 'Rehabilitative and Habilitative Services',
    'Laboratory Services', 'Preventive and Wellness Services', 'Pediatric Dental Services', 'Pediatric Vision Services'];
  const mrf = [['In-Network Rates File', 'Submitted'], ['Allowed Amounts File', 'Submitted'], ['Prescription Drug File', 'Submitted']];
  for (const [plan_id] of certs) {
    general.forEach(item => insert('qhp_checklist_items', { plan_id, section: 'general', item,
      value: plan_id === 'QHP-2026-001' ? 'Not Reviewed' : 'Compliant' }));
    ehb.forEach(item => insert('qhp_checklist_items', { plan_id, section: 'ehb', item,
      value: plan_id === 'QHP-2026-008' && item.startsWith('Rehabilitative') ? 'Not Covered' : 'Covered' }));
    mrf.forEach(([item, v]) => insert('qhp_checklist_items', { plan_id, section: 'transparency', item,
      value: plan_id === 'QHP-2026-009' && item === 'In-Network Rates File' ? 'Not Submitted' : v }));
  }
  // Network adequacy report rows
  const netRows = {
    'QHP-2026-004': [['Vinton County, OH', 'Primary Care', '41 miles', '30 miles', 'Not Met'],
      ['Meigs County, OH', 'Primary Care', '38 miles', '30 miles', 'Not Met'],
      ['Monroe County, OH', 'Primary Care', '45 miles', '30 miles', 'Not Met'],
      ['Franklin County, OH', 'Primary Care', '6 miles', '10 miles', 'Met']],
  };
  for (const [plan_id] of certs) {
    const rows = netRows[plan_id] || [['All service-area counties', 'Primary Care', 'Within standard', 'Standard', 'Met']];
    rows.forEach(r => insert('qhp_checklist_items', { plan_id, section: 'network', item: `${r[0]}|${r[1]}`, value: r[4], detail: `${r[2]}|${r[3]}` }));
  }
  // Accreditation record
  for (const [plan_id] of certs) {
    if (plan_id === 'QHP-2026-010') {
      insert('qhp_checklist_items', { plan_id, section: 'accreditation', item: 'Accrediting entity', value: 'No valid accreditation from recognized entity' });
      insert('qhp_checklist_items', { plan_id, section: 'accreditation', item: 'Accreditation expiration', value: 'Expired: 12/31/2025' });
    } else {
      insert('qhp_checklist_items', { plan_id, section: 'accreditation', item: 'Accrediting entity', value: 'Accredited - recognized accrediting entity' });
      insert('qhp_checklist_items', { plan_id, section: 'accreditation', item: 'Accreditation expiration', value: 'Valid through: 12/31/2027' });
    }
    insert('qhp_checklist_items', { plan_id, section: 'qis', item: 'QIS submission',
      value: plan_id === 'QHP-2026-007' ? 'No quality improvement strategy document provided' : 'QIS document received 2026-05-01' });
    insert('qhp_checklist_items', { plan_id, section: 'benefit', item: 'Flagged benefit design',
      value: plan_id === 'QHP-2026-006' ? 'HIV medication coverage limited to $500 monthly cap' : 'No flagged benefit design elements' });
  }

  // ---- Users ----
  insert('users', { email: 'jane.consumer@example.com', password_hash: hashPassword('Password123!'), first_name: 'Jane', last_name: 'Consumer', role: 'consumer', created_at: created });
  insert('users', { email: 'reviewer@exchange.test', password_hash: hashPassword('Password123!'), first_name: 'Riley', last_name: 'Reviewer', role: 'reviewer', created_at: created });
  insert('users', { email: 'sam.filer@example.com', password_hash: hashPassword('Password123!'), first_name: 'Sam', last_name: 'Filer', role: 'consumer', created_at: created });

  // ---- Agents & brokers ----
  insert('agencies', { id: 1, name: 'Capitol Insurance Advisors LLC', agency_npn: '9000001', state: 'TX' });
  insert('agencies', { id: 2, name: 'Heartland Benefits Group', agency_npn: '9000002', state: 'OH' });
  [
    ['17000001', 'Maria', 'Lopez', 1, 1, 'TX', '512-555-0101'],
    ['17000002', 'David', 'Chen', 1, 0, 'TX', '512-555-0102'],
    ['17000003', 'Aisha', 'Brown', 1, 0, 'TX', '713-555-0103'],
    ['17000004', 'Tom', 'Kowalski', 2, 1, 'OH', '614-555-0104'],
    ['17000005', 'Priya', 'Natarajan', 2, 0, 'OH', '614-555-0105'],
    ['17000006', 'Grace', 'Okafor', null, 0, 'GA', '404-555-0106'],
  ].forEach(([npn, first_name, last_name, agency_id, is_lead_agent, state, phone]) =>
    insert('agents', { npn, first_name, last_name, agency_id, is_lead_agent, state, phone, status: 'Active' }));

  // ---- Consumer sample data ----
  insert('applications', { app_number: 'APP-2026-000101', user_id: 1, coverage_year: 2026, zip: '78701', county_fips: '48453', state: 'TX',
    status: 'Submitted', household_size: 1, annual_income: 38000, fpl_percent: 242.8, medicaid_eligible: 0, aptc_eligible: 1,
    aptc_monthly: 180.12, csr_variant: '73', slcsp_plan_id: '10202TX0030001', slcsp_premium: 470.10, consent_given: 0,
    consent_review_confirmed: 0, signature: 'Jane Consumer', created_at: created, submitted_at: created });
  insert('household_members', { application_id: 1, first_name: 'Jane', last_name: 'Consumer', dob: '1986-03-14', sex: 'F', relationship: 'Self', applying: 1, ssn_last4: '1234' });
  insert('income_sources', { application_id: 1, member_name: 'Jane Consumer', income_type: 'Job', employer: 'Austin Coffee Co.', annual_amount: 38000 });

  insert('ftr_cases', { user_id: 1, tax_filer_name: 'Jane Consumer', application_number: 'APP-2026-000101', consecutive_ftr_years: 1, last_ftr_tax_year: 2024, notice_channel: 'direct' });
  insert('ftr_cases', { user_id: 3, tax_filer_name: 'Sam Filer', application_number: 'APP-2026-000102', consecutive_ftr_years: 2, last_ftr_tax_year: 2024, notice_channel: 'indirect' });
  insert('ftr_cases', { user_id: null, tax_filer_name: 'Lee Household', application_number: 'APP-2026-000103', consecutive_ftr_years: 2, last_ftr_tax_year: 2024, notice_channel: 'direct' });
  insert('ftr_cases', { user_id: null, tax_filer_name: 'Pat Reconciled', application_number: 'APP-2026-000104', consecutive_ftr_years: 0, last_ftr_tax_year: 2022, notice_channel: 'direct' });

  insert('data_inaccuracy_reports', { report_number: 'DIR-2026-0001', issuer_id: 6, state: 'GA', description: 'APTC amount on 834 differs from issuer billing for 42 enrollees.',
    received_on: '2026-09-02', complete: 1, completed_on: '2026-09-10', resolution_deadline: '2026-11-09', status: 'Open' });
  insert('data_inaccuracy_reports', { report_number: 'DIR-2026-0002', issuer_id: 5, state: 'AR', description: 'Effective dates mismatch for 7 enrollments.',
    received_on: '2026-10-20', complete: 0, status: 'Awaiting Complete Submission' });

  // QIS submissions (PY2025). Only FFE issuer data is published in the aggregate report.
  const qis = [[1, 'FFE', 'Health Outcomes', 1], [1, 'FFE', 'Preventing Readmissions', 1], [2, 'FFE', 'Health Outcomes', 0],
    [2, 'FFE', 'Patient Safety', 1], [3, 'FFE', 'Health Outcomes', 1], [3, 'FFE', 'Wellness and Health Promotion', 1],
    [4, 'FFE', 'Health Equity', 0], [4, 'FFE', 'Patient Safety', 1], [5, 'SBE-FP', 'Health Outcomes', 1], [6, 'SBE', 'Health Equity', 1]];
  qis.forEach(([issuer_id, exchange_type, focus_area, target_met]) => insert('qis_submissions', { issuer_id, plan_year: 2025, exchange_type, focus_area, target_met }));

  // ---- Regulatory parameters ----
  [
    ['coverage_year', '2026', 'Current open enrollment coverage year', null],
    ['moop_limit_2026', '9450', 'Individual maximum out-of-pocket limit used by QHP certification review (Test Manager test data value)', '45 CFR 156.130'],
    ['fpl_base_2025', '15650', 'Poverty guideline, household of 1 (used for 2026 coverage)', 'HHS Poverty Guidelines'],
    ['fpl_increment_2025', '5500', 'Poverty guideline increment per additional person', 'HHS Poverty Guidelines'],
    ['enhanced_ptc_extended_2026', 'false', 'Whether enhanced premium tax credits were extended through 2026 by July 31, 2025', '90 FR 4486-88'],
    ['ra_user_fee_2025', '0.18', 'Risk adjustment user fee PMPM, benefit year 2025', '89 FR 26256-57'],
    ['ra_user_fee_2026', '0.20', 'Risk adjustment user fee PMPM, benefit year 2026', '90 FR 4448-49'],
    ['radv_appeal_rerun_threshold', '10000', 'Minimum change to filing issuer RA transfers to rerun HHS-RADV after appeal', '45 CFR 156.1220(a)(2)(i)'],
    ['reconsideration_days', '7', 'Calendar days for FFE certification denial reconsideration request', '45 CFR 155.1090(a)(2)'],
    ['data_inaccuracy_days', '60', 'Calendar days for State Exchange to resolve complete issuer data inaccuracy report', '45 CFR 155.400(d)(1)'],
    ['payment_fixed_threshold', '10', 'Fixed-dollar premium payment threshold (inflation adjusted)', '45 CFR 155.400(g)'],
  ].forEach(([key, value, description, citation]) => insert('reg_parameters', { key, value, description, citation }));

  insert('audit_log', { entity: 'system', entity_id: 'seed', action: 'Database seeded', detail: DB_PATH, actor: 'system', at: created });
}

function reset() {
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t};`);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA);
    seed();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function init() {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qhp_certifications'").get();
  if (!exists || process.env.ACA_RESET_ON_START === '1') reset();
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const param = (key, fallback) => { const r = get('SELECT value FROM reg_parameters WHERE key = ?', key); return r ? r.value : fallback; };

function nextNumber(prefix, table, col) {
  const year = new Date().getFullYear();
  const row = get(`SELECT COUNT(*) AS n FROM ${table}`);
  let n = row.n + 1;
  let candidate;
  do { candidate = `${prefix}-${year}-${String(n).padStart(6, '0')}`; n++; }
  while (get(`SELECT 1 AS x FROM ${table} WHERE ${col} = ?`, candidate));
  return candidate;
}

function audit(entity, entityId, action, detail, actor) {
  insert('audit_log', { entity, entity_id: String(entityId), action, detail: detail || null, actor: actor || 'anonymous', at: nowIso() });
}

module.exports = { db, DB_PATH, TABLES, init, reset, all, get, run, insert, param, nextNumber, audit, hashPassword, verifyPassword, nowIso };
