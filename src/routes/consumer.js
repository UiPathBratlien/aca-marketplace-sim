'use strict';
// Consumer marketplace (healthcare.gov-style): screener, plan browsing, accounts, application, enrollment,
// premium payments (ACA:14/40), appeals (ACA:15/41), agent/broker help (ACA:10/37), consent form (ACA:11), notices (ACA:12/38).
const D = require('../db');
const R = require('../rules');
const M = require('../marketplace');
const { getR, postR, h, raw, field, select, textarea, button, linkBtn, alertBox, errors, table, dl, badge, redirect } = require('../web');
const { breadcrumb } = require('../layout');

const YEAR = 2026;
const COVERAGE_START = `${YEAR}-01-01`;
const money = R.money;
const requireLogin = (ctx, next) => { if (!ctx.user) { redirect(ctx.res, `/login?next=${encodeURIComponent(ctx.url)}`); return false; } return true; };
const ownApp = (ctx, num) => D.get('SELECT * FROM applications WHERE app_number = ? AND user_id = ?', num, ctx.user.id);

// ---------------- Home ----------------
getR('/', ctx => ctx.render('Health coverage for 2026', h`
  <section class="hero" id="hero"><div class="hero-inner">
    <h1 id="page-title">Health insurance for 2026</h1>
    <p class="hero-lead">Open Enrollment for 2026 coverage is open. Most people can find a plan for $10 or less per month after savings.</p>
    <form method="get" action="/plans" class="hero-form" id="zip-form">
      ${field({ name: 'zip', id: 'home-zip', label: 'Enter your ZIP code', placeholder: '78701', required: true })}
      ${button('See plans & prices', { id: 'btn-see-plans' })}
    </form>
    <div class="hero-actions">${linkBtn('Apply for coverage', '/apply', { id: 'btn-apply-now', cls: 'btn btn-accent' })}${linkBtn('See if you can save', '/screener', { id: 'btn-screener', cls: 'btn btn-outline-light' })}</div>
  </div></section>
  <div class="grid3">
    <div class="card"><h2>Preview plans & prices</h2><p>Compare plans available in your area before you apply.</p>${linkBtn('Preview plans', '/plans', { cls: 'btn btn-outline', id: 'card-preview-plans' })}</div>
    <div class="card"><h2>See if you qualify for savings</h2><p>Estimate premium tax credits and cost-sharing reductions based on income.</p>${linkBtn('Estimate savings', '/screener', { cls: 'btn btn-outline', id: 'card-screener' })}</div>
    <div class="card"><h2>Get help</h2><p>Find a licensed agent or broker who can help you apply.</p>${linkBtn('Find local help', '/help/local', { cls: 'btn btn-outline', id: 'card-local-help' })}</div>
  </div>
  <div class="card"><h2>Key dates</h2>${dl([['Open Enrollment starts', 'November 1, 2025'], ['Enroll by December 15', 'Coverage starts January 1, 2026'], ['Open Enrollment ends', 'January 15, 2026']], 'key-dates')}</div>`, { active: 'home' }));

// ---------------- Screener ----------------
function screenerForm(v = {}, errs = []) {
  return h`${errors(errs)}<form method="post" action="/screener" class="card narrow" id="screener-form">
    ${field({ name: 'zip', id: 'screener-zip', label: 'ZIP code', value: v.zip || '', required: true })}
    ${field({ name: 'householdSize', id: 'household-size', label: 'Household size', type: 'number', value: v.householdSize || '1', min: 1, max: 10, required: true, hint: 'Include yourself, your spouse and anyone you claim as a tax dependent.' })}
    ${field({ name: 'income', id: 'household-income', label: 'Estimated 2026 household income ($)', type: 'number', value: v.income || '', required: true })}
    ${field({ name: 'ages', id: 'ages', label: 'Ages of people who need coverage', value: v.ages || '40', hint: 'Separate with commas, e.g. 40, 38, 10', required: true })}
    <div class="actions">${button('See results', { id: 'btn-see-results' })}</div></form>`;
}
const parseAges = s => String(s || '').split(/[,\s]+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 120);
getR('/screener', ctx => ctx.render('See if you can save', h`<h1 id="page-title">See if you can save on coverage</h1>${screenerForm(ctx.query)}`, { active: 'screener' }));
postR('/screener', ctx => {
  const b = ctx.body; const errs = [];
  const ages = parseAges(b.ages);
  if (!/^\d{5}$/.test(b.zip || '')) errs.push('Enter a 5-digit ZIP code.');
  if (!(Number(b.householdSize) >= 1)) errs.push('Household size must be at least 1.');
  if (b.income === undefined || b.income === '' || Number.isNaN(Number(b.income)) || Number(b.income) < 0) errs.push('Enter household income as a number.');
  if (!ages.length) errs.push('Enter at least one age.');
  if (Number(b.householdSize) < ages.length) errs.push('Household size cannot be smaller than the number of people who need coverage.');
  let r;
  if (!errs.length) { r = M.eligibility({ zip: b.zip, householdSize: b.householdSize, income: b.income, members: ages.map(age => ({ age })) }); if (r.error) errs.push(r.error); }
  if (errs.length) return ctx.render('See if you can save', h`<h1 id="page-title">See if you can save on coverage</h1>${screenerForm(b, errs)}`, { active: 'screener' });
  const q = new URLSearchParams({ zip: b.zip, income: b.income, household: b.householdSize, ages: ages.join(',') }).toString();
  return ctx.render('Your estimated savings', h`<h1 id="page-title">Your estimated savings</h1>
    ${alertBox(r.medicaidEligible ? 'info' : (r.aptcEligible ? 'success' : 'warning'), r.medicaidEligible ? 'You may qualify for Medicaid' : (r.aptcEligible ? 'You may qualify for savings' : 'No premium tax credit estimated'), r.message, 'screener-result')}
    <div class="card">${dl([['Location', `${r.location.city}, ${r.location.county}, ${r.location.state}`], ['Household income', money(r.income)], ['Percent of federal poverty level', h`<span id="fpl-percent">${r.fplPercent}%</span>`],
      ['Estimated monthly premium tax credit', h`<span id="aptc-estimate" data-testid="aptc-estimate">${money(r.aptcMonthly)}</span>`],
      ['Cost-sharing reduction', h`<span id="csr-estimate">${r.csrVariant ? `Silver ${r.csrVariant}% AV variant` : 'Not eligible'}</span>`],
      ['Benchmark plan (SLCSP)', r.slcsp ? `${r.slcsp.planName} — ${money(r.slcsp.premium)}/month` : '—'],
      ['Medicaid', h`<span id="medicaid-estimate">${r.medicaidEligible ? 'Likely eligible' : 'Not likely eligible'}</span>`]], 'screener-details')}
    <div class="actions">${linkBtn('Preview plans with these savings', `/plans?${q}`, { id: 'btn-preview-with-savings' })}${linkBtn('Apply now', '/apply', { cls: 'btn btn-outline', id: 'btn-screener-apply' })}</div></div>`, { active: 'screener' });
});

// ---------------- Plans ----------------
function planQuery(q) {
  const ages = parseAges(q.ages || '40');
  return { zip: q.zip || '', income: q.income || '', household: q.household || String(ages.length || 1), ages: ages.length ? ages : [40], metal: [].concat(q.metal || []), sort: q.sort || 'premium' };
}
function planCard(p, prem, aptc, qs, i) {
  const net = Math.max(0, M.r2(prem - aptc));
  return h`<article class="plan-card" id="plan-${p.id}" data-testid="plan-card" data-plan-id="${p.id}">
    <div class="plan-card-head"><div><span class="metal metal-${p.metal.toLowerCase().replace(/\s+/g, '-')}">${p.metal}</span> <span class="ptype">${p.plan_type}</span>${p.standardized ? h` <span class="std">Easy Pricing</span>` : ''}</div>
      <div class="stars" aria-label="Quality rating ${p.quality_rating} of 5">${'★'.repeat(p.quality_rating || 0)}${'☆'.repeat(5 - (p.quality_rating || 0))}</div></div>
    <h3 class="plan-name"><a href="/plans/${p.id}?${qs}" id="plan-link-${i}">${p.name}</a></h3><p class="muted">${p.issuer_name} · Plan ID ${p.id}</p>
    <div class="plan-nums">
      <div><span class="big" data-testid="plan-premium">${money(net)}</span><span class="lbl">Estimated monthly premium${aptc > 0 ? h`<br><s>${money(prem)}</s> after ${money(Math.min(aptc, prem))} savings` : ''}</span></div>
      <div><span class="big">${money(p.deductible)}</span><span class="lbl">Deductible</span></div>
      <div><span class="big">${money(p.moop)}</span><span class="lbl">Out-of-pocket maximum</span></div>
    </div>
    <div class="plan-foot"><span>Primary care: ${p.primary_care}</span><span>Generic drugs: ${p.generic_rx}</span>
      <label class="compare"><input type="checkbox" name="ids" value="${p.id}" form="compare-form" id="compare-${p.id}"> Compare</label>
      ${linkBtn('Plan details', `/plans/${p.id}?${qs}`, { cls: 'btn btn-small btn-outline', id: `details-${p.id}` })}</div></article>`;
}
getR('/plans', ctx => {
  const q = planQuery(ctx.query);
  const form = h`<form method="get" action="/plans" class="card filters" id="plan-search-form">
    ${field({ name: 'zip', id: 'plans-zip', label: 'ZIP code', value: q.zip, required: true })}
    ${field({ name: 'income', id: 'plans-income', label: 'Household income ($, optional)', value: q.income })}
    ${field({ name: 'household', id: 'plans-household', label: 'Household size', value: q.household })}
    ${field({ name: 'ages', id: 'plans-ages', label: 'Ages', value: q.ages.join(',') })}
    <fieldset class="metal-filter"><legend>Metal level</legend>${['Bronze', 'Expanded Bronze', 'Silver', 'Gold', 'Platinum'].map(m => h`<label><input type="checkbox" name="metal" value="${m}" id="metal-${m.toLowerCase().replace(/\s+/g, '-')}" ${q.metal.includes(m) ? raw('checked') : ''}> ${m}</label>`)}</fieldset>
    ${select({ name: 'sort', id: 'sort', label: 'Sort by', options: [['premium', 'Lowest monthly premium'], ['deductible', 'Lowest deductible'], ['moop', 'Lowest out-of-pocket maximum']], value: q.sort })}
    <div class="actions">${button('Update results', { id: 'btn-update-results' })}</div></form>`;
  if (!q.zip) return ctx.render('Preview plans & prices', h`<h1 id="page-title">Preview plans & prices</h1>${form}`, { active: 'plans' });
  const loc = M.lookupZip(q.zip);
  if (!loc) return ctx.render('Preview plans & prices', h`<h1 id="page-title">Preview plans & prices</h1>${alertBox('error', 'ZIP code not found', 'Try 78701, 77002, 79830, 43215, 45651, 72201 or 30303.', 'zip-error')}${form}`, { active: 'plans' });
  let aptc = 0; let elig = null;
  if (q.income !== '') { elig = M.eligibility({ zip: q.zip, householdSize: q.household, income: q.income, members: q.ages.map(age => ({ age })) }); aptc = elig.aptcMonthly || 0; }
  let plans = M.plansInCounty(loc.fips).map(p => ({ p, prem: M.householdPremium(p, q.ages) }));
  if (q.metal.length) plans = plans.filter(x => q.metal.includes(x.p.metal));
  const key = { premium: x => x.prem, deductible: x => x.p.deductible, moop: x => x.p.moop }[q.sort] || (x => x.prem);
  plans.sort((a, b) => key(a) - key(b));
  const qs = new URLSearchParams({ zip: q.zip, income: q.income, household: q.household, ages: q.ages.join(',') }).toString();
  return ctx.render('Plans & prices', h`<h1 id="page-title">2026 plans in ${loc.county}, ${loc.state}</h1>
    <p class="lead" id="plan-count">${plans.length} plans available${aptc > 0 ? h` · Estimated savings applied: <strong id="applied-aptc">${money(aptc)}/month</strong>` : ''}</p>
    <div class="plans-layout">${form}<div class="plan-list" id="plan-list">
      <form method="get" action="/plans/compare" id="compare-form"><input type="hidden" name="q" value="${qs}"><div class="actions">${button('Compare selected plans', { id: 'btn-compare', cls: 'btn btn-small btn-outline' })}</div></form>
      ${plans.map((x, i) => planCard(x.p, x.prem, aptc, qs, i + 1))}</div></div>`, { active: 'plans', wide: true });
});
getR('/plans/compare', ctx => {
  const ids = [].concat(ctx.query.ids || []).slice(0, 3);
  const plans = ids.map(id => D.get('SELECT p.*, i.name issuer_name FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', id)).filter(Boolean);
  if (plans.length < 2) { ctx.flash('warning', 'Select 2 or 3 plans to compare.'); return redirect(ctx.res, `/plans?${ctx.query.q || ''}`); }
  const rows = [['Issuer', p => p.issuer_name], ['Metal level', p => p.metal], ['Plan type', p => p.plan_type], ['Monthly premium (age 21 base)', p => money(p.base_premium)], ['Deductible', p => money(p.deductible)],
    ['Out-of-pocket maximum', p => money(p.moop)], ['Primary care', p => p.primary_care], ['Specialist', p => p.specialist], ['Generic drugs', p => p.generic_rx], ['Emergency room', p => p.er], ['Adult dental', p => (p.adult_dental ? 'Yes' : 'No')], ['Adult vision', p => (p.adult_vision ? 'Yes' : 'No')]];
  return ctx.render('Compare plans', h`<h1 id="page-title">Compare plans</h1>${table(['', ...plans.map(p => p.name)], rows.map(([l, f]) => [l, ...plans.map(f)]), { id: 'compare-table' })}
    <div class="actions">${linkBtn('Back to plans', `/plans?${ctx.query.q || ''}`, { cls: 'btn btn-outline' })}</div>`, { active: 'plans' });
});
getR('/plans/:id', ctx => {
  const p = D.get('SELECT p.*, i.name issuer_name FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', ctx.params.id);
  if (!p) return ctx.notFound('Plan not found.');
  const q = planQuery(ctx.query);
  const prem = M.householdPremium(p, q.ages);
  return ctx.render(p.name, h`${breadcrumb([['Plans', `/plans?${new URLSearchParams({ zip: q.zip, income: q.income, household: q.household, ages: q.ages.join(',') })}`], [p.name]])}
    <h1 id="page-title">${p.name}</h1><p class="muted">${p.issuer_name} · ${p.metal} ${p.plan_type} · Plan ID <span id="plan-id">${p.id}</span></p>
    <div class="card">${dl([['Monthly premium (before savings)', h`<span id="plan-premium">${money(prem)}</span>`], ['Deductible', money(p.deductible)], ['Out-of-pocket maximum', money(p.moop)], ['Coinsurance', `${p.coinsurance}%`],
      ['Primary care visit', p.primary_care], ['Specialist visit', p.specialist], ['Generic drugs', p.generic_rx], ['Emergency room', p.er], ['Actuarial value', `${Math.round(p.actuarial_value * 100)}%`],
      ['Standardized (Easy Pricing)', p.standardized ? `Yes — ${p.standardized_design}` : 'No'], ['Network ID', p.network_id], ['Drug list ID', p.drug_list_id],
      ['Adult dental / Pediatric dental / Adult vision', `${p.adult_dental ? 'Yes' : 'No'} / ${p.pediatric_dental ? 'Yes' : 'No'} / ${p.adult_vision ? 'Yes' : 'No'}`], ['HSA eligible', p.hsa_eligible ? 'Yes' : 'No']], 'plan-details')}
    <div class="actions">${linkBtn('Apply to enroll', '/apply', { id: 'btn-apply-to-enroll' })}</div></div>`, { active: 'plans' });
});

// ---------------- Accounts ----------------
getR('/account/create', ctx => ctx.render('Create account', createForm({}, []), { active: '' }));
function createForm(v, errs) {
  return h`<h1 id="page-title">Create an account</h1>${errors(errs)}<form method="post" action="/account/create" class="card narrow" id="create-account-form">
    ${field({ name: 'firstName', id: 'first-name', label: 'First name', value: v.firstName, required: true, autocomplete: 'given-name' })}
    ${field({ name: 'lastName', id: 'last-name', label: 'Last name', value: v.lastName, required: true, autocomplete: 'family-name' })}
    ${field({ name: 'email', id: 'email', label: 'Email address', type: 'email', value: v.email, required: true, autocomplete: 'email' })}
    ${field({ name: 'password', id: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 8 characters with a letter and a number.', autocomplete: 'new-password' })}
    ${field({ name: 'confirmPassword', id: 'confirm-password', label: 'Confirm password', type: 'password', required: true, autocomplete: 'new-password' })}
    <div class="field check"><input type="checkbox" name="terms" id="accept-terms" value="1" ${v.terms ? raw('checked') : ''}><label for="accept-terms">I agree to the terms and privacy policy</label></div>
    <div class="actions">${button('Create account', { id: 'btn-create-account' })}</div>
    <p>Already have an account? <a href="/login" id="link-login">Log in</a></p></form>`;
}
postR('/account/create', ctx => {
  const b = ctx.body; const errs = [];
  if (!(b.firstName || '').trim()) errs.push('First name is required.');
  if (!(b.lastName || '').trim()) errs.push('Last name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) errs.push('Enter a valid email address.');
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(b.password || '')) errs.push('Password must be at least 8 characters with a letter and a number.');
  if (b.password !== b.confirmPassword) errs.push('Passwords do not match.');
  if (!b.terms) errs.push('You must agree to the terms.');
  if (!errs.length && D.get('SELECT 1 x FROM users WHERE LOWER(email) = LOWER(?)', b.email)) errs.push('An account with that email already exists.');
  if (errs.length) return ctx.render('Create account', createForm(b, errs), { active: '' });
  const r = D.insert('users', { email: b.email.trim().toLowerCase(), password_hash: D.hashPassword(b.password), first_name: b.firstName.trim(), last_name: b.lastName.trim(), role: 'consumer', created_at: D.nowIso() });
  ctx.session.userId = Number(r.lastInsertRowid);
  D.audit('user', b.email, 'Account created', null, b.email);
  ctx.flash('success', 'Your account has been created.');
  return redirect(ctx.res, '/dashboard');
});
getR('/login', ctx => ctx.render('Log in', loginForm(ctx.query.next || '', [], ''), { active: '' }));
function loginForm(next, errs, email) {
  return h`<h1 id="page-title">Log in</h1>${errors(errs)}<form method="post" action="/login" class="card narrow" id="login-form"><input type="hidden" name="next" value="${next}">
    ${field({ name: 'email', id: 'username', label: 'Email address', value: email, required: true, autocomplete: 'username' })}
    ${field({ name: 'password', id: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' })}
    <div class="actions">${button('Log in', { id: 'btn-login' })}</div><p>New here? <a href="/account/create" id="link-create-account">Create an account</a></p></form>`;
}
postR('/login', ctx => {
  const b = ctx.body;
  const u = D.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', (b.email || '').trim());
  if (!u || !D.verifyPassword(b.password || '', u.password_hash)) {
    if ((b.next || '').startsWith('/exchange')) { ctx.flash('error', 'Invalid username or password.'); return redirect(ctx.res, `/exchange/login?next=${encodeURIComponent(b.next)}`); }
    return ctx.render('Log in', loginForm(b.next || '', ['The email or password you entered is incorrect.'], b.email || ''), { active: '' });
  }
  ctx.session.userId = u.id;
  D.audit('user', u.email, 'Logged in', null, u.email);
  const next = (b.next || '').startsWith('/') && !(b.next || '').startsWith('//') ? b.next : (u.role === 'reviewer' ? '/exchange' : '/dashboard');
  return redirect(ctx.res, next);
});
postR('/logout', ctx => { ctx.session.userId = null; return redirect(ctx.res, ctx.query.next === '/exchange' ? '/exchange' : '/'); });

// ---------------- Dashboard ----------------
getR('/dashboard', ctx => {
  if (!requireLogin(ctx)) return;
  const apps = D.all('SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC', ctx.user.id);
  const enr = D.all('SELECT e.*, p.name plan_name FROM enrollments e JOIN plans p ON p.id = e.plan_id WHERE e.user_id = ? ORDER BY e.id DESC', ctx.user.id);
  const notices = D.all('SELECT * FROM notices WHERE user_id = ? ORDER BY id DESC', ctx.user.id);
  const appeals = D.all('SELECT * FROM appeals WHERE user_id = ? ORDER BY id DESC', ctx.user.id);
  const appLink = a => (a.status === 'In Progress' ? `/apply/${a.app_number}/household` : `/apply/${a.app_number}/results`);
  return ctx.render('My account', h`<h1 id="page-title">Welcome, ${ctx.user.first_name}</h1>
    <div class="actions">${linkBtn('Start a new application', '/apply', { id: 'btn-dashboard-new-app' })}${linkBtn('File an appeal', '/appeals/new', { cls: 'btn btn-outline', id: 'btn-dashboard-appeal' })}</div>
    <div class="card"><h2>My applications</h2>${table(['Application', 'Year', 'Status', 'APTC / month', ''], apps.map(a => [a.app_number, a.coverage_year, badge(a.status), a.aptc_monthly != null ? money(a.aptc_monthly) : '—', h`<a href="${appLink(a)}" id="open-${a.app_number}">Open</a>`]), { id: 'my-applications', empty: 'You have no applications yet.' })}</div>
    <div class="card"><h2>My plans & programs</h2>${table(['Enrollment', 'Plan', 'Net premium', 'Status', 'Effective', ''], enr.map(e => [e.enrollment_number, e.plan_name, money(e.net_premium), badge(e.status), e.effective_date, h`<a href="/enrollments/${e.enrollment_number}" id="open-${e.enrollment_number}">View / pay</a>`]), { id: 'my-enrollments', empty: 'No enrollments yet.' })}</div>
    <div class="card"><h2>My notices</h2>${table(['Notice', 'Type', 'Date', 'Message'], notices.map(n => [n.notice_number, n.notice_type, n.created_at.slice(0, 10), n.body]), { id: 'my-notices', empty: 'No notices.' })}</div>
    <div class="card"><h2>My appeals</h2>${table(['Appeal', 'Filed', 'Status'], appeals.map(a => [a.appeal_number, a.created_at.slice(0, 10), badge(a.status)]), { id: 'my-appeals', empty: 'No appeals.' })}</div>`, { active: 'dashboard' });
});

// ---------------- Application ----------------
const STEPS = [['household', 'Household'], ['income', 'Income'], ['review', 'Review & sign'], ['results', 'Eligibility results'], ['plans', 'Choose a plan']];
function stepper(cur) {
  return h`<ol class="stepper" id="app-stepper">${STEPS.map(([k, l], i) => h`<li class="${k === cur ? 'on' : ''}" ${k === cur ? raw('aria-current="step"') : ''}><span>${i + 1}</span> ${l}</li>`)}</ol>`;
}
getR('/apply', ctx => {
  if (!requireLogin(ctx)) return;
  const draft = D.get("SELECT * FROM applications WHERE user_id = ? AND status = 'In Progress' ORDER BY id DESC", ctx.user.id);
  return ctx.render('Apply for coverage', h`<h1 id="page-title">Apply for ${YEAR} health coverage</h1>
    ${draft ? alertBox('info', 'You have an application in progress', h`Application ${draft.app_number}. ${linkBtn('Continue application', `/apply/${draft.app_number}/household`, { cls: 'btn btn-small', id: 'btn-continue-application' })}`, 'draft-notice') : ''}
    <form method="post" action="/apply/start" class="card narrow" id="start-application-form">
      ${field({ name: 'zip', id: 'app-zip', label: 'Home ZIP code', required: true, placeholder: '78701' })}
      ${select({ name: 'coverageYear', id: 'coverage-year', label: 'Coverage year', options: [[String(YEAR), String(YEAR)]] })}
      <div class="actions">${button('Start application', { id: 'btn-start-application' })}</div></form>`, { active: 'apply' });
});
postR('/apply/start', ctx => {
  if (!requireLogin(ctx)) return;
  const loc = M.lookupZip(ctx.body.zip);
  if (!loc) { ctx.flash('error', 'Enter a ZIP code we serve: 78701, 77002, 79830, 43215, 45651, 72201 or 30303.'); return redirect(ctx.res, '/apply'); }
  const num = D.nextNumber('APP', 'applications', 'app_number');
  D.insert('applications', { app_number: num, user_id: ctx.user.id, coverage_year: YEAR, zip: loc.zip, county_fips: loc.fips, state: loc.state, status: 'In Progress', created_at: D.nowIso() });
  D.audit('application', num, 'Started', loc.zip, ctx.user.email);
  return redirect(ctx.res, `/apply/${num}/household`);
});

const MEMBER_ROWS = 4;
function householdForm(ctx, a, v, errs) {
  const existing = D.all('SELECT * FROM household_members WHERE application_id = ? ORDER BY id', a.id);
  const val = (i, k, d = '') => (v[`m${i}_${k}`] !== undefined ? v[`m${i}_${k}`] : (existing[i] ? existing[i][k] ?? d : (i === 0 && k === 'first_name' ? ctx.user.first_name : i === 0 && k === 'last_name' ? ctx.user.last_name : d)));
  const rows = [];
  for (let i = 0; i < MEMBER_ROWS; i++) {
    rows.push(h`<fieldset class="member" id="member-${i + 1}"><legend>${i === 0 ? 'Primary applicant (you)' : `Household member ${i + 1} (optional)`}</legend><div class="grid2">
      ${field({ name: `m${i}_first_name`, id: `member${i + 1}-first-name`, label: 'First name', value: val(i, 'first_name'), required: i === 0 })}
      ${field({ name: `m${i}_last_name`, id: `member${i + 1}-last-name`, label: 'Last name', value: val(i, 'last_name'), required: i === 0 })}
      ${field({ name: `m${i}_dob`, id: `member${i + 1}-dob`, label: 'Date of birth', type: 'date', value: val(i, 'dob'), required: i === 0 })}
      ${select({ name: `m${i}_sex`, id: `member${i + 1}-sex`, label: 'Sex', options: [['F', 'Female'], ['M', 'Male']], placeholder: '-- Select --', value: val(i, 'sex') })}
      ${i === 0 ? h`<input type="hidden" name="m0_relationship" value="Self">` : select({ name: `m${i}_relationship`, id: `member${i + 1}-relationship`, label: 'Relationship to you', options: ['Spouse', 'Child', 'Stepchild', 'Parent', 'Other relative'], placeholder: '-- Select --', value: val(i, 'relationship') })}
      ${field({ name: `m${i}_ssn`, id: `member${i + 1}-ssn`, label: 'Social Security number (test data)', placeholder: '000-00-0000', value: v[`m${i}_ssn`] || '' })}
      ${select({ name: `m${i}_applying`, id: `member${i + 1}-applying`, label: 'Needs coverage?', options: [['1', 'Yes'], ['0', 'No']], value: String(val(i, 'applying', '1')) })}
      ${select({ name: `m${i}_tobacco`, id: `member${i + 1}-tobacco`, label: 'Tobacco use', options: [['0', 'No'], ['1', 'Yes']], value: String(val(i, 'tobacco', '0')) })}
    </div></fieldset>`);
  }
  return ctx.render('Household', h`${stepper('household')}<h1 id="page-title">Tell us about your household</h1><p class="muted">Application ${a.app_number} · ZIP ${a.zip}</p>${errors(errs)}
    <form method="post" action="/apply/${a.app_number}/household" id="household-form" class="card">${rows}<div class="actions">${button('Save & continue', { id: 'btn-save-continue' })}</div></form>`, { active: 'apply' });
}
getR('/apply/:num/household', ctx => { if (!requireLogin(ctx)) return; const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.'); return householdForm(ctx, a, {}, []); });
postR('/apply/:num/household', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  if (a.status !== 'In Progress') { ctx.flash('warning', 'This application was already submitted.'); return redirect(ctx.res, `/apply/${a.app_number}/results`); }
  const b = ctx.body; const errs = []; const members = [];
  for (let i = 0; i < MEMBER_ROWS; i++) {
    const fn = (b[`m${i}_first_name`] || '').trim(), ln = (b[`m${i}_last_name`] || '').trim(), dob = (b[`m${i}_dob`] || '').trim();
    if (i > 0 && !fn && !ln && !dob) continue;
    const label = i === 0 ? 'Primary applicant' : `Household member ${i + 1}`;
    if (!fn || !ln) errs.push(`${label}: first and last name are required.`);
    const age = M.ageOn(dob, COVERAGE_START);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || age === null || age < 0 || age > 120) errs.push(`${label}: enter a valid date of birth.`);
    else if (i === 0 && age < 18) errs.push('Primary applicant must be at least 18 years old.');
    const ssn = (b[`m${i}_ssn`] || '').replace(/\D/g, '');
    if (ssn && ssn.length !== 9) errs.push(`${label}: Social Security number must have 9 digits.`);
    if (i > 0 && !b[`m${i}_relationship`]) errs.push(`${label}: select a relationship.`);
    members.push({ first_name: fn, last_name: ln, dob, sex: b[`m${i}_sex`] || null, relationship: i === 0 ? 'Self' : b[`m${i}_relationship`], applying: b[`m${i}_applying`] === '0' ? 0 : 1, tobacco: b[`m${i}_tobacco`] === '1' ? 1 : 0, ssn_last4: ssn ? ssn.slice(-4) : null });
  }
  if (!errs.length && !members.some(m => m.applying)) errs.push('At least one person must need coverage.');
  if (errs.length) return householdForm(ctx, a, b, errs);
  D.run('DELETE FROM household_members WHERE application_id = ?', a.id);
  members.forEach(m => D.insert('household_members', { application_id: a.id, ...m }));
  D.run('UPDATE applications SET household_size = ? WHERE id = ?', members.length, a.id);
  return redirect(ctx.res, `/apply/${a.app_number}/income`);
});

const INCOME_ROWS = 3;
function incomeForm(ctx, a, v, errs) {
  const members = D.all('SELECT * FROM household_members WHERE application_id = ? ORDER BY id', a.id);
  const names = members.map(m => `${m.first_name} ${m.last_name}`);
  const existing = D.all('SELECT * FROM income_sources WHERE application_id = ? ORDER BY id', a.id);
  const val = (i, k) => (v[`i${i}_${k}`] !== undefined ? v[`i${i}_${k}`] : (existing[i] ? existing[i][k] : ''));
  const rows = [];
  for (let i = 0; i < INCOME_ROWS; i++) {
    rows.push(h`<fieldset class="member" id="income-${i + 1}"><legend>Income source ${i + 1}${i ? ' (optional)' : ''}</legend><div class="grid2">
      ${select({ name: `i${i}_member_name`, id: `income${i + 1}-member`, label: 'Whose income?', options: names, placeholder: '-- Select --', value: val(i, 'member_name') })}
      ${select({ name: `i${i}_income_type`, id: `income${i + 1}-type`, label: 'Type', options: ['Job', 'Self-employment', 'Unemployment', 'Social Security', 'Retirement', 'Other'], placeholder: '-- Select --', value: val(i, 'income_type') })}
      ${field({ name: `i${i}_employer`, id: `income${i + 1}-employer`, label: 'Employer / source', value: val(i, 'employer') })}
      ${field({ name: `i${i}_annual_amount`, id: `income${i + 1}-amount`, label: 'Expected 2026 annual amount ($)', value: val(i, 'annual_amount') })}
    </div></fieldset>`);
  }
  return ctx.render('Income', h`${stepper('income')}<h1 id="page-title">Household income</h1><p class="muted">Application ${a.app_number}</p>${errors(errs)}
    <form method="post" action="/apply/${a.app_number}/income" id="income-form" class="card">
      <div class="field check"><input type="checkbox" name="noIncome" id="no-income" value="1" ${v.noIncome ? raw('checked') : ''}><label for="no-income">No one in my household has income</label></div>
      ${rows}<div class="actions">${linkBtn('Back', `/apply/${a.app_number}/household`, { cls: 'btn btn-outline', id: 'btn-back' })}${button('Save & continue', { id: 'btn-save-continue' })}</div></form>`, { active: 'apply' });
}
getR('/apply/:num/income', ctx => { if (!requireLogin(ctx)) return; const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.'); return incomeForm(ctx, a, {}, []); });
postR('/apply/:num/income', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  if (a.status !== 'In Progress') return redirect(ctx.res, `/apply/${a.app_number}/results`);
  const b = ctx.body; const errs = []; const rows = [];
  if (!b.noIncome) {
    for (let i = 0; i < INCOME_ROWS; i++) {
      const amt = (b[`i${i}_annual_amount`] || '').replace(/[$,\s]/g, '');
      if (!b[`i${i}_member_name`] && !b[`i${i}_income_type`] && !amt) continue;
      if (!b[`i${i}_member_name`] || !b[`i${i}_income_type`]) errs.push(`Income source ${i + 1}: select whose income and the type.`);
      if (amt === '' || Number.isNaN(Number(amt)) || Number(amt) < 0) errs.push(`Income source ${i + 1}: enter a valid annual amount.`);
      rows.push({ member_name: b[`i${i}_member_name`], income_type: b[`i${i}_income_type`], employer: (b[`i${i}_employer`] || '').trim() || null, annual_amount: Number(amt) });
    }
    if (!rows.length && !errs.length) errs.push('Enter at least one income source or check "No one in my household has income".');
  }
  if (errs.length) return incomeForm(ctx, a, b, errs);
  D.run('DELETE FROM income_sources WHERE application_id = ?', a.id);
  rows.forEach(r => D.insert('income_sources', { application_id: a.id, ...r }));
  D.run('UPDATE applications SET annual_income = ? WHERE id = ?', rows.reduce((s, r) => s + r.annual_amount, 0), a.id);
  return redirect(ctx.res, `/apply/${a.app_number}/review`);
});

function reviewPage(ctx, a, v, errs) {
  const members = D.all('SELECT * FROM household_members WHERE application_id = ? ORDER BY id', a.id);
  const incomes = D.all('SELECT * FROM income_sources WHERE application_id = ? ORDER BY id', a.id);
  const agents = D.all("SELECT * FROM agents WHERE status = 'Active' ORDER BY last_name");
  const primary = members[0];
  return ctx.render('Review & sign', h`${stepper('review')}<h1 id="page-title">Review & sign</h1><p class="muted">Application ${a.app_number}</p>${errors(errs)}
    <div class="card"><h2>Household</h2>${table(['Name', 'Date of birth', 'Relationship', 'Needs coverage'], members.map(m => [`${m.first_name} ${m.last_name}`, m.dob, m.relationship, m.applying ? 'Yes' : 'No']), { id: 'review-household' })}
      <h2>Income</h2>${table(['Member', 'Type', 'Source', 'Annual amount'], incomes.map(i => [i.member_name, i.income_type, i.employer || '—', money(i.annual_amount)]), { id: 'review-income', empty: 'No income reported.' })}
      <p>Total household income: <strong id="review-total-income">${money(a.annual_income || 0)}</strong></p></div>
    <form method="post" action="/apply/${a.app_number}/submit" class="card" id="sign-form">
      <h2>Agent or broker assistance</h2>
      ${select({ name: 'agentNpn', id: 'assisting-agent', label: 'Did a licensed agent or broker help you with this application?', options: [['', 'No, I applied on my own'], ...agents.map(g => [g.npn, `${g.first_name} ${g.last_name} (NPN ${g.npn})`])], value: v.agentNpn || '' })}
      ${field({ name: 'agentNpnManual', id: 'agent-npn', label: 'Or enter the agent/broker NPN', value: v.agentNpnManual || '' })}
      <fieldset class="consent" id="consent-section"><legend>Optional consent & application review (model consent form)</legend>
        <p class="muted">Complete this section only if an agent or broker helped you. It documents your consent and that you reviewed your application for accuracy.</p>
        <div class="field check"><input type="checkbox" name="consentGiven" value="1" id="consent-given" ${v.consentGiven ? raw('checked') : ''}><label for="consent-given">I give consent for the agent/broker to help me with my Marketplace application and enrollment</label></div>
        <div class="field check"><input type="checkbox" name="reviewConfirmed" value="1" id="review-confirmed" ${v.reviewConfirmed ? raw('checked') : ''}><label for="review-confirmed">I reviewed my application information with the agent/broker and confirm it is accurate</label></div>
        ${select({ name: 'consentMethod', id: 'consent-method', label: 'How was consent documented?', options: [['', '-- Select --'], ['signature', 'Signed consent form'], ['audio', 'Audio recording (CMS optional script)'], ['electronic', 'Electronic consent']], value: v.consentMethod || '' })}
      </fieldset>
      <h2>Sign</h2>
      <div class="field check"><input type="checkbox" name="agree" value="1" id="agree-terms" ${v.agree ? raw('checked') : ''}><label for="agree-terms">I agree that the information on this application is true and I understand my obligation to file a federal tax return and reconcile any advance premium tax credits</label></div>
      ${field({ name: 'signature', id: 'electronic-signature', label: `Electronic signature — type your full name (${primary ? `${primary.first_name} ${primary.last_name}` : ''})`, value: v.signature || '', required: true })}
      <div class="actions">${linkBtn('Back', `/apply/${a.app_number}/income`, { cls: 'btn btn-outline', id: 'btn-back' })}${button('Submit application', { id: 'btn-submit-application' })}</div></form>`, { active: 'apply' });
}
getR('/apply/:num/review', ctx => { if (!requireLogin(ctx)) return; const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.'); return reviewPage(ctx, a, {}, []); });
postR('/apply/:num/submit', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  if (a.status !== 'In Progress') return redirect(ctx.res, `/apply/${a.app_number}/results`);
  const b = ctx.body; const errs = [];
  const members = D.all('SELECT * FROM household_members WHERE application_id = ? ORDER BY id', a.id);
  if (!members.length) errs.push('Add household members before submitting.');
  const primary = members[0];
  if (!b.agree) errs.push('You must agree to the statements before submitting.');
  if (primary && (b.signature || '').trim().toLowerCase() !== `${primary.first_name} ${primary.last_name}`.toLowerCase()) errs.push('Electronic signature must match the primary applicant\'s full name.');
  const npn = (b.agentNpnManual || '').trim() || b.agentNpn || '';
  let agent = null;
  if (npn) {
    agent = D.get('SELECT * FROM agents WHERE npn = ?', npn);
    if (!agent) errs.push(`No agent or broker found with NPN ${npn}.`);
    else if (agent.status !== 'Active') errs.push(`Agent/broker ${npn} is suspended from Exchange transactions. You can apply on your own or call the Marketplace Call Center.`);
  }
  if (b.reviewConfirmed && !b.consentGiven) errs.push('Consent must be given before confirming an agent-assisted review.');
  if ((b.consentGiven || b.reviewConfirmed) && !agent) errs.push('Consent and review confirmation apply only when an agent or broker assisted you.');
  if (errs.length) return reviewPage(ctx, a, b, errs);
  const ages = members.filter(m => m.applying).map(m => M.ageOn(m.dob, COVERAGE_START));
  const e = M.eligibility({ zip: a.zip, householdSize: members.length, income: a.annual_income || 0, members: members.map(m => ({ age: M.ageOn(m.dob, COVERAGE_START), applying: !!m.applying })) });
  D.run(`UPDATE applications SET status = 'Submitted', household_size = ?, fpl_percent = ?, medicaid_eligible = ?, aptc_eligible = ?, aptc_monthly = ?, csr_variant = ?, slcsp_plan_id = ?, slcsp_premium = ?,
    assisted_by_agent_id = ?, consent_given = ?, consent_review_confirmed = ?, consent_method = ?, signature = ?, submitted_at = ? WHERE id = ?`,
    members.length, e.fplPercent, e.medicaidEligible ? 1 : 0, e.aptcEligible ? 1 : 0, e.aptcMonthly, e.csrVariant, e.slcsp ? e.slcsp.planId : null, e.slcsp ? e.slcsp.premium : null,
    agent ? agent.id : null, b.consentGiven ? 1 : 0, b.reviewConfirmed ? 1 : 0, b.consentMethod || null, b.signature.trim(), D.nowIso(), a.id);
  D.audit('application', a.app_number, 'Submitted', `ages=${ages.join(',')}; aptc=${e.aptcMonthly}`, ctx.user.email);
  return redirect(ctx.res, `/apply/${a.app_number}/results`);
});
getR('/apply/:num/results', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  if (a.status === 'In Progress') return redirect(ctx.res, `/apply/${a.app_number}/household`);
  const agent = a.assisted_by_agent_id ? D.get('SELECT * FROM agents WHERE id = ?', a.assisted_by_agent_id) : null;
  return ctx.render('Eligibility results', h`${stepper('results')}<h1 id="page-title">Your eligibility results</h1>
    ${alertBox('success', 'Application submitted', h`Application <strong id="application-number">${a.app_number}</strong> was submitted.`, 'application-submitted')}
    <div class="card">${dl([['Household size', a.household_size], ['Household income', money(a.annual_income || 0)], ['Federal poverty level', `${a.fpl_percent}%`],
      ['Premium tax credit (APTC)', h`<span id="eligibility-aptc" data-testid="eligibility-aptc">${a.aptc_eligible ? `${money(a.aptc_monthly)} per month` : 'Not eligible'}</span>`],
      ['Cost-sharing reductions', h`<span id="eligibility-csr">${a.csr_variant ? `Eligible — Silver ${a.csr_variant}%` : 'Not eligible'}</span>`],
      ['Medicaid / CHIP', h`<span id="eligibility-medicaid">${a.medicaid_eligible ? 'Likely eligible — your information will be sent to the State Medicaid agency' : 'Not eligible'}</span>`],
      ['Benchmark plan (SLCSP)', a.slcsp_plan_id ? `${a.slcsp_plan_id} — ${money(a.slcsp_premium)}/month` : '—'],
      ['Assisting agent/broker', agent ? `${agent.first_name} ${agent.last_name} (NPN ${agent.npn})` : 'None'],
      ['Consent documented', a.consent_given ? `Yes (${a.consent_method || 'method not specified'}); review confirmed: ${a.consent_review_confirmed ? 'Yes' : 'No'}` : 'No']], 'eligibility-details')}
    <div class="actions">${a.medicaid_eligible ? '' : linkBtn('Continue to plans', `/apply/${a.app_number}/plans`, { id: 'btn-continue-to-plans' })}${linkBtn('Disagree? File an appeal', `/appeals/new?app=${a.app_number}`, { cls: 'btn btn-outline', id: 'btn-file-appeal' })}</div></div>`, { active: 'apply' });
});
getR('/apply/:num/plans', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  if (a.status === 'In Progress') return redirect(ctx.res, `/apply/${a.app_number}/household`);
  const ages = D.all('SELECT dob FROM household_members WHERE application_id = ? AND applying = 1', a.id).map(m => M.ageOn(m.dob, COVERAGE_START));
  const plans = M.plansInCounty(a.county_fips).map(p => ({ p, prem: M.householdPremium(p, ages) })).sort((x, y) => x.prem - y.prem);
  const aptc = a.aptc_monthly || 0;
  return ctx.render('Choose a plan', h`${stepper('plans')}<h1 id="page-title">Choose a plan</h1><p class="lead">Savings applied: <strong id="applied-aptc">${money(aptc)}/month</strong></p>
    ${table(['Plan', 'Metal', 'Premium', 'After savings', 'Deductible', ''], plans.map(({ p, prem }) => [h`<a href="/plans/${p.id}">${p.name}</a>`, p.metal, money(prem), money(Math.max(0, prem - aptc)), money(p.deductible),
      h`<form method="post" action="/apply/${a.app_number}/enroll" class="inline"><input type="hidden" name="planId" value="${p.id}"><button type="submit" class="btn btn-small" id="enroll-${p.id}" data-testid="enroll-${p.id}">Enroll</button></form>`]), { id: 'enroll-plans' })}`, { active: 'apply', wide: true });
});
postR('/apply/:num/enroll', ctx => {
  if (!requireLogin(ctx)) return;
  const a = ownApp(ctx, ctx.params.num); if (!a) return ctx.notFound('Application not found.');
  const p = D.get('SELECT p.* FROM plans p JOIN plan_service_areas s ON s.plan_id = p.id WHERE p.id = ? AND s.county_fips = ?', ctx.body.planId || '', a.county_fips);
  if (!p || a.status === 'In Progress') { ctx.flash('error', 'Select a plan available in your area.'); return redirect(ctx.res, `/apply/${a.app_number}/plans`); }
  if (D.get("SELECT 1 x FROM enrollments WHERE application_id = ? AND status NOT LIKE 'Cancelled%'", a.id)) { ctx.flash('warning', 'This application already has an enrollment.'); return redirect(ctx.res, '/dashboard'); }
  const ages = D.all('SELECT dob FROM household_members WHERE application_id = ? AND applying = 1', a.id).map(m => M.ageOn(m.dob, COVERAGE_START));
  const gross = M.householdPremium(p, ages);
  const aptc = Math.min(gross, a.aptc_monthly || 0);
  const num = D.nextNumber('ENR', 'enrollments', 'enrollment_number');
  D.insert('enrollments', { enrollment_number: num, application_id: a.id, user_id: ctx.user.id, plan_id: p.id, gross_premium: gross, aptc_applied: M.r2(aptc), net_premium: M.r2(gross - aptc),
    status: 'Pending Binder Payment', effective_date: COVERAGE_START, created_at: D.nowIso() });
  D.run("UPDATE applications SET status = 'Enrolled' WHERE id = ?", a.id);
  D.audit('enrollment', num, 'Created', p.id, ctx.user.email);
  ctx.flash('success', `You're enrolled in ${p.name}. Pay your first premium to activate coverage.`);
  return redirect(ctx.res, `/enrollments/${num}`);
});

// ---------------- Enrollment & payments ----------------
function enrollmentPage(ctx, e, v = {}, result = null) {
  const p = D.get('SELECT p.*, i.name issuer_name, i.payment_threshold_policy FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', e.plan_id);
  const pays = D.all('SELECT * FROM premium_payments WHERE enrollment_id = ? ORDER BY id DESC', e.id);
  const binderDone = pays.some(x => x.payment_type === 'binder' && /full/.test(x.result));
  return ctx.render(`Enrollment ${e.enrollment_number}`, h`<h1 id="page-title">Enrollment confirmation</h1>
    ${result ? alertBox(result.sufficient ? 'success' : 'error', result.sufficient ? 'Payment accepted' : 'Payment insufficient', result.note, 'payment-result') : ''}
    <div class="card">${dl([['Confirmation number', h`<span id="enrollment-number" data-testid="enrollment-number">${e.enrollment_number}</span>`], ['Plan', `${p.name} (${p.id})`], ['Issuer', p.issuer_name],
      ['Monthly premium', money(e.gross_premium)], ['Premium tax credit applied', money(e.aptc_applied)], ['You pay', h`<span id="net-premium">${money(e.net_premium)}</span>`],
      ['Coverage starts', e.effective_date], ['Status', h`<span id="enrollment-status" data-testid="enrollment-status">${badge(e.status)}</span>`]], 'enrollment-details')}</div>
    <form method="post" action="/enrollments/${e.enrollment_number}/pay" class="card narrow" id="payment-form"><h2>${binderDone ? 'Make a monthly payment' : 'Pay your first premium (binder payment)'}</h2>
      <input type="hidden" name="paymentType" value="${binderDone ? 'ongoing' : 'binder'}">
      ${field({ name: 'amount', id: 'payment-amount', label: 'Payment amount ($)', value: v.amount ?? e.net_premium.toFixed(2), required: true })}
      ${select({ name: 'method', id: 'payment-method', label: 'Payment method', options: ['Bank account (ACH)', 'Debit card', 'Credit card'] })}
      <div class="actions">${button('Submit payment', { id: 'btn-submit-payment' })}</div></form>
    <div class="card"><h2>Payment history</h2>${table(['Payment', 'Type', 'Due', 'Paid', 'Threshold policy', 'Result'], pays.map(x => [x.payment_number, x.payment_type, money(x.amount_due), money(x.amount_paid), x.policy_applied || '—', x.result]), { id: 'payment-history', empty: 'No payments yet.' })}</div>`, { active: 'dashboard' });
}
const ownEnrollment = ctx => D.get('SELECT * FROM enrollments WHERE enrollment_number = ? AND user_id = ?', ctx.params.num, ctx.user.id);
getR('/enrollments/:num', ctx => { if (!requireLogin(ctx)) return; const e = ownEnrollment(ctx); if (!e) return ctx.notFound('Enrollment not found.'); return enrollmentPage(ctx, e); });
postR('/enrollments/:num/pay', ctx => {
  if (!requireLogin(ctx)) return;
  const e = ownEnrollment(ctx); if (!e) return ctx.notFound('Enrollment not found.');
  const iss = D.get('SELECT i.* FROM plans p JOIN issuers i ON i.id = p.issuer_id WHERE p.id = ?', e.plan_id);
  const type = ctx.body.paymentType === 'ongoing' ? 'ongoing' : 'binder';
  let r;
  try { r = R.rules.premiumThreshold({ policies: iss.payment_threshold_policy.split(','), paymentType: type, grossPremium: e.gross_premium, aptc: e.aptc_applied, amountPaid: ctx.body.amount }); }
  catch (err) { ctx.flash('error', err.message); return redirect(ctx.res, `/enrollments/${e.enrollment_number}`); }
  const result = r.sufficient ? `Paid in full${r.applied[0] !== 'Paid in full' ? ` (${r.applied.join('; ')})` : ''}` : (type === 'binder' ? 'Insufficient — coverage not effectuated' : 'Insufficient — grace period');
  D.insert('premium_payments', { payment_number: D.nextNumber('PAY', 'premium_payments', 'payment_number'), enrollment_id: e.id, payment_type: type, amount_due: r.net, amount_paid: R.num(ctx.body.amount, 'Amount'),
    policy_applied: iss.payment_threshold_policy, result, created_at: D.nowIso() });
  const status = r.sufficient ? 'Enrolled - Coverage Active' : (type === 'binder' ? 'Pending Binder Payment' : 'Grace Period');
  D.run('UPDATE enrollments SET status = ? WHERE id = ?', status, e.id);
  D.audit('enrollment', e.enrollment_number, `Payment ${type}`, result, ctx.user.email);
  return enrollmentPage(ctx, D.get('SELECT * FROM enrollments WHERE id = ?', e.id), {}, r);
});

// ---------------- Appeals (ACA:15 / ACA:41) ----------------
function appealForm(ctx, v, errs) {
  return ctx.render('File an appeal', h`<h1 id="page-title">Request an eligibility appeal</h1>
    <p class="lead">An applicant, enrollee, or the application filer may request an appeal of a Marketplace eligibility decision.</p>${errors(errs)}
    <form method="post" action="/appeals" class="card narrow" id="appeal-form">
      ${select({ name: 'filerRole', id: 'filer-role', label: 'Who is filing this appeal?', options: R.APPEAL_ROLES, placeholder: '-- Select --', value: v.filerRole, required: true })}
      ${field({ name: 'filerName', id: 'filer-name', label: 'Your full name', value: v.filerName ?? (ctx.user ? `${ctx.user.first_name} ${ctx.user.last_name}` : ''), required: true })}
      ${field({ name: 'appellantName', id: 'appellant-name', label: 'Name of the person whose eligibility is being appealed', value: v.appellantName || '', required: true })}
      ${field({ name: 'applicationNumber', id: 'application-number', label: 'Application number', value: v.applicationNumber ?? (ctx.query.app || ''), placeholder: 'APP-2026-000101' })}
      ${select({ name: 'entity', id: 'appeals-entity', label: 'Appeals entity', options: ['HHS Marketplace Appeals Center', 'State Exchange appeals entity'], value: v.entity })}
      ${textarea({ name: 'reason', id: 'appeal-reason', label: 'Why are you appealing?', value: v.reason || '', required: true })}
      <div class="actions">${button('Submit appeal', { id: 'btn-submit-appeal' })}</div></form>`, { active: 'appeals' });
}
getR('/appeals/new', ctx => appealForm(ctx, {}, []));
postR('/appeals', ctx => {
  const b = ctx.body; const errs = [];
  if (!b.filerRole) errs.push('Select who is filing the appeal.');
  if (!(b.filerName || '').trim()) errs.push('Your name is required.');
  if (!(b.appellantName || '').trim()) errs.push('Enter the name of the person whose eligibility is being appealed.');
  if (!(b.reason || '').trim()) errs.push('Enter the reason for the appeal.');
  if (errs.length) return appealForm(ctx, b, errs);
  const s = R.rules.appealStanding(b.filerRole);
  const num = D.nextNumber('APL', 'appeals', 'appeal_number');
  const role = (R.APPEAL_ROLES.find(r => r[0] === b.filerRole) || [b.filerRole, b.filerRole])[1];
  D.insert('appeals', { appeal_number: num, user_id: ctx.user ? ctx.user.id : null, application_number: (b.applicationNumber || '').trim() || null, filer_role: role, filer_name: b.filerName.trim(),
    appellant_name: b.appellantName.trim(), appeals_entity: b.entity || 'HHS Marketplace Appeals Center', reason: b.reason.trim(),
    status: s.accepted ? 'Accepted for Review' : 'Not Accepted - No Standing', status_reason: s.reason, created_at: D.nowIso() });
  D.audit('appeal', num, s.accepted ? 'Accepted' : 'Rejected', s.reason, ctx.user ? ctx.user.email : 'anonymous');
  return ctx.render('Appeal submitted', h`<h1 id="page-title">${s.accepted ? 'Appeal request received' : 'Appeal request not accepted'}</h1>
    ${alertBox(s.accepted ? 'success' : 'error', s.accepted ? 'Your appeal was accepted for review' : 'We could not accept this appeal', s.reason, 'appeal-result')}
    <div class="card">${dl([['Appeal number', h`<span id="appeal-number">${num}</span>`], ['Filer role', role], ['Status', h`<span id="appeal-status">${badge(s.accepted ? 'Accepted for Review' : 'Not Accepted - No Standing')}</span>`]], 'appeal-details')}</div>`, { active: 'appeals' });
});

// ---------------- Find local help ----------------
getR('/help/local', ctx => {
  const st = ctx.query.state || '';
  const agents = D.all(`SELECT a.*, g.name agency FROM agents a LEFT JOIN agencies g ON g.id = a.agency_id WHERE a.status = 'Active' ${st ? 'AND a.state = ?' : ''} ORDER BY a.last_name`, ...(st ? [st] : []));
  return ctx.render('Find local help', h`<h1 id="page-title">Find local help</h1><p class="lead">Licensed agents and brokers who can help you apply and enroll. Suspended agents are not listed.</p>
    <form method="get" action="/help/local" class="card narrow inline-search" id="local-help-form">
      ${select({ name: 'state', id: 'help-state', label: 'State', options: [['', 'All states'], ...D.all('SELECT code, name FROM states ORDER BY name').map(s => [s.code, s.name])], value: st })}
      <div class="actions">${button('Search', { id: 'btn-search-help' })}</div></form>
    ${table(['Name', 'NPN', 'Agency', 'State', 'Phone'], agents.map(a => [`${a.first_name} ${a.last_name}`, a.npn, a.agency || 'Independent', a.state, a.phone]), { id: 'local-help-results', empty: 'No agents or brokers found.' })}`, { active: 'local-help' });
});

module.exports = {};
