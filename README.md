# CoverWell Marketplace — ACA test application

A local test target for the UiPath Test Manager project **ACA** ("CCIIO ACA healthcare.gov") and the
`JOSGroupACA` Studio project. It has:

- **Consumer marketplace** (healthcare.gov-style): savings screener, plan browsing and comparison, accounts,
  a multi-step 2026 application, eligibility (APTC / CSR / Medicaid), enrollment, binder and monthly payments,
  appeals, and "find local help".
- **Exchange QHP Certification Portal** (`/exchange`): the certification-denial workflow exercised by test cases
  ACA:151–160, plus reconsideration, agents and brokers, FTR notices, data-inaccuracy reports, the QIS report and rule tools.
- **SQLite database** (`data/aca.db`) with seeded, fictional data, a reset button, and a JSON API for data tests.

All names, issuers, plans and people are fictional. No npm packages are needed.

## Run

Requires Node.js 22.13+ (it uses the built-in `node:sqlite`; Node 24 is installed on this machine).

```
start.cmd            # or: npm start
```

| URL | What |
|---|---|
| http://localhost:3000/ | Consumer site |
| http://localhost:3000/exchange | Exchange certification portal |
| http://localhost:3000/exchange/admin | Reset test data, table counts, seeded accounts |
| http://localhost:3000/api | JSON API index |

Environment options: `PORT`, `ACA_DB_PATH` (move the DB out of OneDrive if file locking becomes a problem),
`ACA_RESET_ON_START=1` (reseed at every start).

Seeded logins (password `Password123!` for all): `jane.consumer@example.com`, `sam.filer@example.com`, `reviewer@exchange.test`.

**Reset between test runs:** each denial changes plan status. Lists are keyed on a fixed queue, so the tests can be rerun,
but for a clean baseline click **Reset Test Data** or call `POST /api/admin/reset` (for example from an HTTP Request
activity in a test's setup).

Self-test: `npm run smoke` runs every ACA:151–160 step over HTTP against a throwaway database (168 checks).

## Test case → navigation map (requirement ACA:42)

| Test case | Plan | Entry point → action button | Section | Final button | Resulting status |
|---|---|---|---|---|---|
| ACA:151 | QHP-2026-001 | Certification Workflow / Dashboard → **New Certification Review** → *Plan identifier* → **Load Plan Details** | General Certification Criteria | **Deny Certification** → dialog → **Confirm Denial** | Denied |
| ACA:152 | QHP-2026-002 | **Certification Queue** → select plan → **Begin Certification Review** | Essential Health Benefits | **Issue Denial** | Certification Denied |
| ACA:153 | QHP-2026-003 | **Active Certifications** → search → **Search** → select → **Review Certification Status** | Actuarial Value → **Flag Non-Compliance** | **Deny Certification** | Denied |
| ACA:154 | QHP-2026-004 | **New Plan Submissions** → select → **Start Certification Process** | Provider Network → **Analyze Network Adequacy** | **Execute Denial** (letter cites 155.1000(e)) | Denied |
| ACA:155 | QHP-2026-005 | Sign in → **Certification Reviews** → **In-Progress Reviews** → select → **Continue Review** | Cost-Sharing Limits | **Deny Certification** | Denied |
| ACA:156 | QHP-2026-006 | **Pending Certifications** → *Plan ID* → **Retrieve Plan** | Benefit Design Review → **Discrimination Analysis** | **Initiate Denial Process** | Denied - Discrimination Violation |
| ACA:157 | QHP-2026-007 | **Certification Workflow** → **Quality Standards Review** → **Load Plan for Review** | Quality Improvement Strategy | **Process Denial** | Denied |
| ACA:158 | QHP-2026-008 | **Comprehensive Reviews** → select → **Begin Full Certification Assessment** | Compliance Summary → **Aggregate Violations** | **Issue Comprehensive Denial** | Denied - Multiple Criteria Failures |
| ACA:159 | QHP-2026-009 | **Transparency Compliance** → *Plan search* → **Search Plans** → select → **Review Transparency Requirements** | Machine-Readable Files | **Deny Certification** | Denied |
| ACA:160 | QHP-2026-010 | **Accreditation Verification** → **New Accreditation Review** → **Retrieve Plan Data** | Accreditation Status | **Execute Certification Denial** | Certification Denied - Accreditation Failure |

After a denial the app shows a notification with the regulatory basis, the denial authority (45 CFR 155.1000(e)), the
violations and a denial letter. **View Certification Record** shows the stored denial reason. Every interactive element
has a stable `id` and `data-testid` for selectors (for example `#certification-status`, `#denial-confirmation-message`,
`#regulatory-basis`, `#confirm-dialog-message`, `#tab-ehb`).

Seed values follow the test data where it differs from the actual 2026 parameters: the $9,450 MOOP limit and the 60% bronze AV minimum.
Both are editable on **Regulatory Parameters** / in the `qhp_certifications` table.

## Other requirements (no test cases yet)

Each rule is available in the UI at `/exchange/tools/<id>` and as an API at `GET|POST /api/rules/<id>`.
`GET /api/requirements` returns the full traceability map.

| Requirement(s) | Where |
|---|---|
| ACA:1, 25 BHP PAF · ACA:26 county SLCSP | tools `bhp-paf`, `bhp-slcsp` |
| ACA:2, 27 calibration years · ACA:3, 28 Hep C · ACA:4, 29 PrEP · ACA:8, 30 RA user fee | `ra-calibration`, `hepc-trend`, `prep-acf`, `ra-user-fee` |
| ACA:5, 31–33 IVA sampling · ACA:6, 34 SVA · ACA:7, 35 appeal rerun | `radv-iva-sample`, `radv-iva-exclusion`, `radv-neyman`, `radv-sva`, `radv-appeal-rerun` |
| ACA:9, 36 lead-agent enforcement | Agents & Brokers → agency → *Open Agency Compliance Review* |
| ACA:10, 37 immediate suspension | Agents & Brokers → agent → *Suspend Immediately*; suspended agents are hidden from *Find local help* and rejected on applications |
| ACA:11 consent form and review | Consumer application → *Review & sign* (optional consent section) |
| ACA:12, 38 two-year FTR notice | FTR Notices → *Generate FTR Notices*; consumer dashboard; tool `ftr-notice` |
| ACA:13, 39 60-day resolution | Data Inaccuracy Reports; tool `data-inaccuracy-deadline` |
| ACA:14, 40 payment thresholds | Consumer enrollment payments (issuer policy); tool `premium-threshold` |
| ACA:15, 41 application-filer appeals | Consumer *Appeals*; tool `appeal-standing` |
| ACA:16, 43 reconsideration (7 days, clear and convincing) | Denial → *Request Reconsideration*; tool `reconsideration-check` |
| ACA:17, 44 HHS ECP review | Review workspace → *Essential Community Providers* tab; tool `ecp-review` |
| ACA:18 aggregated QIS reporting | QIS Public Report; `/api/qis-report` |
| ACA:19 exchange user fee | `exchange-user-fee` (reads `enhanced_ptc_extended_2026`) |
| ACA:20, 47 CSR loading · ACA:21 AV calculator | `csr-loading`, `av-calculator` |
| ACA:22, 45 standardized designs · ACA:46 meaningful difference · ACA:23 non-standard limits | `standardized-design`, `meaningful-difference`, `nonstandard-limit` (seeded duplicate and over-limit plans) |
| ACA:24, 48 MLR qualifying issuer | `mlr-qualifying` |

## Database for data tests

- File: `data/aca.db` (SQLite). Connect from UiPath with the Database activities through an SQLite ODBC driver,
  or use the JSON API: `GET /api/db/<table>?column=value`.
- Main tables: `qhp_certifications`, `qhp_assessments`, `qhp_checklist_items`, `qhp_denials`, `qhp_reconsiderations`,
  `plans`, `issuers`, `applications`, `household_members`, `income_sources`, `enrollments`, `premium_payments`, `appeals`,
  `agents`, `agencies`, `compliance_actions`, `ftr_cases`, `notices`, `data_inaccuracy_reports`, `qis_submissions`,
  `reg_parameters`, `audit_log`.
- Schema and seed data: `src/db.js`.

## Code layout

```
src/server.js           HTTP server and request context
src/db.js               schema, seed data, reset
src/rules.js            regulatory rules engine and tool catalog
src/marketplace.js      premiums, SLCSP, APTC/CSR/Medicaid
src/routes/consumer.js  consumer site
src/routes/exchange.js  Exchange portal (certification workflow, operations, tools)
src/routes/api.js       JSON API and traceability map
public/                 CSS and a small client script (dialog, panels, row selection)
test/smoke.js           end-to-end check of ACA:151–160 and the rules
```
