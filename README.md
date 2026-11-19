# CoverWell Marketplace — ACA test application

A local test target for the UiPath Test Manager projects **ACA** ("CCIIO ACA healthcare.gov") and **BCA**
(2025 edition changes to 45 CFR Parts 155 and 156), and the `JOSGroupACA` Studio project. It has:

- **Consumer marketplace** (healthcare.gov-style): savings screener, plan browsing and comparison, accounts,
  a multi-step 2026 or 2027 application, eligibility (APTC / CSR / Medicaid, lawful presence, income verification, FTR),
  open enrollment, special enrollment periods, binder and monthly payments, appeals, and "find local help".
- **Exchange QHP Certification Portal** (`/exchange`): the certification-denial workflow exercised by test cases
  ACA:151–160, plus reconsideration, agents and brokers, FTR notices, data-inaccuracy reports, the QIS report and rule tools.
- **Enrollment & eligibility (2025 CFR)** (`/exchange/redetermination` and others): annual redetermination and passive
  re-enrollment with the $5 minimum premium exercised by test cases BCA:40–49, 834 files, inconsistencies, special enrollment,
  plan data validation and a **simulated system clock** used by every date rule.
- **SQLite database** (`data/aca.db`) with seeded, fictional data, a reset button, and a JSON API for data tests.

All names, issuers, plans and people are fictional. No npm packages are needed.

## Install and run

### Prerequisites

| Requirement | Version | Install (Windows) |
|---|---|---|
| Node.js | 22.13 or later (24 LTS recommended) | `winget install OpenJS.NodeJS.LTS` or https://nodejs.org |
| Git | any recent version | `winget install --id Git.Git -e` or https://git-scm.com/download/win |
| GitHub access | read access to this private repo | Ask the repo owner to add you as a collaborator |

No `npm install` step is needed: the app has no package dependencies, and the database uses SQLite built into Node.
Open a **new** terminal after installing Node or Git so they are on your PATH, then check:

```
node --version      # must be v22.13.0 or higher
git --version
```

### 1. Get the code

```
git clone https://github.com/UiPathBratlien/aca-marketplace-sim.git
cd aca-marketplace-sim
```

The first clone opens a browser window to sign in to GitHub, because the repo is private.
If you don't have Git, use **Code → Download ZIP** on the GitHub page and extract it instead.

### 2. Start the app

```
start.cmd            # or: npm start
```

On first start the app creates `data\aca.db` and fills it with the sample data. The console prints the URLs and the database path.
The system date starts at **2025-11-15** (simulated, shown in the top banner); change it on http://localhost:3000/exchange/clock.
Leave the window open while you test. Press **Ctrl+C** to stop.

### 3. Check it works

- Open http://localhost:3000 in a browser, or http://localhost:3000/api/health for a JSON status.
- Optionally run the self-tests against a throwaway database:
  ```
  npm run smoke      # ACA:151–160            expect: "178 checks passed, 0 failed"
  npm run smoke:bca  # BCA:40–49 + BCA rules  expect: "246 checks passed, 0 failed"
  npm test           # both
  ```

### 4. (Optional) Let robots on other machines reach it

By default the app accepts connections from the local machine only. To serve other machines:

```
set HOST=0.0.0.0
start.cmd
```

Allow the port through Windows Firewall (run as administrator):

```
netsh advfirewall firewall add rule name="ACA test app" dir=in action=allow protocol=TCP localport=3000
```

Tests then use `http://<app-machine-name>:3000` instead of `localhost`.

### Configuration

Set these in the terminal before running `start.cmd`, e.g. `set PORT=8080`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to accept connections from other machines |
| `ACA_DB_PATH` | `data\aca.db` | Database location; move it out of OneDrive or a network share if file locking causes trouble |
| `ACA_RESET_ON_START` | off | `1` reloads the sample data every time the app starts |

### Updating

```
git pull
```

Then restart the app. When the schema version changes (as it did for the BCA update) the app resets the data on start by itself.
To reset at any other time: click **Reset Test Data** on `/exchange/admin`, run `npm run reset` while the app is stopped, or delete `data\aca.db`.

### Troubleshooting

| Problem | Fix |
|---|---|
| `'node' is not recognized` | Install Node.js, then open a new terminal |
| `No such built-in module: node:sqlite` or a `--disable-warning` error | Node is too old; install 22.13 or later |
| `EADDRINUSE` | Port 3000 is taken; `set PORT=3001` or stop the other process |
| Another machine can't connect | Start with `HOST=0.0.0.0` and add the firewall rule above |
| `database is locked` | Move the DB with `ACA_DB_PATH` to a local, non-synced folder |
| Dates, deadlines or "Open Enrollment is closed" look wrong | Every date rule uses the simulated system date (banner). Set it on `/exchange/clock`, or blank the `system_date` parameter for the real date |

## URLs

| URL | What |
|---|---|
| http://localhost:3000/ | Consumer site |
| http://localhost:3000/exchange | Exchange certification portal |
| http://localhost:3000/exchange/admin | Reset test data, table counts, seeded accounts |
| http://localhost:3000/exchange/redetermination | Annual redetermination and passive re-enrollment (BCA:40–49) |
| http://localhost:3000/exchange/clock | Simulated system date |
| http://localhost:3000/sep/new | Consumer special enrollment (after logging in and submitting an application) |
| http://localhost:3000/api | JSON API index |

Seeded logins (password `Password123!` for all): `jane.consumer@example.com`, `sam.filer@example.com`, `reviewer@exchange.test`.

**Reset between test runs:** each denial changes plan status. Lists are keyed on a fixed queue, so the tests can be rerun,
but for a clean baseline click **Reset Test Data** or call `POST /api/admin/reset` (for example from an HTTP Request
activity in a test's setup).

Self-tests: `npm run smoke` runs every ACA:151–160 step (178 checks); `npm run smoke:bca` runs every BCA:40–49 step plus the other BCA rules (246 checks).

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
| ACA:22, 45 standardized designs · ACA:46 meaningful difference · ACA:23 non-standard limits | `standardized-design`, `meaningful-difference`, `standardized-plan-compliance` (both rules), `nonstandard-limit` (seeded duplicate and over-limit plans) |
| ACA:24, 48 MLR qualifying issuer | `mlr-qualifying` |

### Standardized plan options by plan year (ACA:22, 45, 46)

| Plan year | Source | Standard silver (deductible / OOP limit) | Expanded bronze (deductible / OOP limit) | Meaningful difference |
|---|---|---|---|---|
| 2025 | 2025 Payment Notice, 89 FR 26358–59 (PDF pp.141–42) | $5,000 / $8,000 | $7,500 / $9,200 (50% coinsurance) | No explicit rule |
| 2026 | 2026 Payment Notice, 90 FR 4493–4500 (PDF pp.70–77) | $6,000 / $8,900 | $7,500 / $10,000 (50% coinsurance) | 45 CFR 156.201(c), 90 FR 4541 (PDF p.118): standardized plans from one issuer with the same network type, metal level and service area must differ by product, network, drug list or benefits |

A PY2026 standardized plan must pass both rules; `standardized-plan-compliance` checks a plan's cost sharing against its
year's table and compares it with the issuer's other standardized plans. Seeded examples: `10101TX0070001` (PY2026
duplicate, fails 156.201(c)), `10101TX0080001` (different network, passes), and PY2025 plans `10101TX0032025`,
`10101TX0072025` (identical but allowed in 2025) and `10101TX0022025` (expanded bronze).

## 2025 CFR changes — Test Manager project BCA

Project **BCA** holds 38 requirements (BCA:2–BCA:39) from the 2024 → 2025 editions of 45 CFR Parts 155 and 156.
They are implemented in `src/bca.js` (rules), `src/routes/redetermination.js` and `src/routes/bca.js` (flows).
Self-test: `npm run smoke:bca` (246 checks), or `npm test` for both suites.

### System clock

Every date rule uses a **simulated system date**, seeded as **2025-11-15** (inside the 2026 open enrollment). It is shown in the
banner and on the Exchange header. Change it on **System Clock** (`/exchange/clock`, field `#system-date`, button **Set System Date**),
with `POST /api/clock {"date":"2025-12-16"}`, or set the `system_date` parameter blank for the real date. Dates may be typed as
`2025-12-15`, `12/15/2025` or `December 15, 2025`.

### Test case → navigation map (requirement BCA:12, test cases BCA:40–49)

All steps are on **Exchange › Enrollment & Eligibility (2025 CFR) › Annual Redetermination** (`/exchange/redetermination`).

| Test step | Where | Selector |
|---|---|---|
| Set / advance system date | System Clock | `#system-date` → **Set System Date** (`#btn-set-system-date`) |
| Create enrollee record (ID, Federal platform or State-based Exchange) | Annual Redetermination → *Create enrollee record* | `#enrollee-id`, `#enrollee-platform`, `#enrollee-state`, `#enrollee-benefit-year` → **Create Enrollee** |
| Set prior-year coverage status, plan premium, issuer ID | Enrollee page → *Enrollee & plan* | `#prior-coverage-status`, `#plan-premium`, `#issuer-id` → **Save Enrollee** |
| Set plan selection deadline (§ 155.410(f)) | Annual Redetermination → *Plan selection deadlines* | `#deadline-2026`, `#deadline-2027` → **Save Deadlines** |
| Run annual redetermination | Enrollee page | **Run Annual Redetermination** (`#btn-run-redetermination`) |
| Set calculated APTC; check net premium after APTC | Enrollee page | `#calculated-aptc` → **Save APTC**; read `#net-premium-after-aptc` |
| Verify no updated application exists | Enrollee page | `#updated-application-status` |
| Submit updated eligibility application at a timestamp | Enrollee page | `#application-timestamp` (`2025-12-10 14:30:00`) → **Submit Updated Application** |
| Execute passive re-enrollment | Enrollee page | **Execute Passive Re-enrollment** (`#btn-execute-reenrollment`); result `#redetermination-result` |
| Apply $5 minimum premium adjustment | Enrollee page | **Apply $5 Minimum Premium Adjustment** (already applied by re-enrollment when the rule is met) |
| Retrieve final APTC and net monthly premium | Enrollee page | `#final-aptc`, `#enrollee-net-premium`, `#minimum-premium-applied` |
| Premium record display | **View Premium Record** | `#premium-record-aptc`, `#premium-record-net-premium` |
| Generate 834 for issuer; read APTC and net premium | **834 Transactions** (`/exchange/834`) | `#edi-issuer-id` → **Generate 834 Transaction**; `#edi-aptc-<enrollee>`, `#edi-net-premium-<enrollee>`, raw file `#edi-content` |

Rule: the $5 minimum applies only for benefit year 2026, on the Federal platform (FFE or SBE-FP), when the net premium after
APTC is $0 and no updated application was submitted on or before the deadline. Passive re-enrollment runs only after the deadline.
API equivalents: `/api/redetermination/enrollees[/:id[/redetermine|/aptc|/applications|/reenroll|/minimum-premium|/premium-record]]`, `/api/834`.

### Other BCA requirements (no test cases yet)

| Requirement(s) | Where in the app | Rule tool |
|---|---|---|
| BCA:2 lawful presence (DACA excluded) | Application › Household: *Citizenship or immigration status*; Eligibility results | `lawful-presence` |
| BCA:4–6 FTR by plan year | Eligibility results (*Tax filing (FTR) check*); FTR Notices (plan year select) | `ftr-eligibility` |
| BCA:7 90-day inconsistency, no 60-day income extension | Inconsistencies: **Run Deadline Check**, good-faith extension | `inconsistency-deadline` |
| BCA:8–10 income checks, no tax data | Application › Income: *Data hub results* (blank tax data = none returned) | `income-increase-check`, `no-tax-data` |
| BCA:33 preponderance of the evidence | Inconsistency › *Resolve with documents* | `preponderance` |
| BCA:11 CSR bronze crosswalk | Annual Redetermination (re-enrolled metal level) | `reenrollment-crosswalk` |
| BCA:13 payment thresholds by plan year | Consumer payments; issuer configuration | `premium-threshold` (plan year), `threshold-config` |
| BCA:14–17 open enrollment and effective dates | Application › Choose a plan (window and effective date); Regulatory Parameters `oep_*` (validated) | `oep-window`, `oep-effective-date` |
| BCA:18–22 SEPs, d(16), 2026 verification | My account › **Report a life change (SEP)** (`/sep/new`); Exchange › Special Enrollment (75% rate) | `sep-d16`, `sep-plan-change`, `sep-verification`, `sep-verification-rate` |
| BCA:23 EHB-benchmark scope | — | `ehb-benchmark` |
| BCA:24, 30 EHB prohibited benefits | Plan Data Validation (seeded violations on `10101TX0010001`, `10202TX0050001`) | `ehb-prohibited` |
| BCA:25–27 AV de minimis | Plan Data Validation | `av-de-minimis` |
| BCA:29 silver plan variation AV | — (band in parameters `csr_variation_de_minimis_*`; **confirm against 90 FR 27223**) | `csr-variation-av` |
| BCA:28, 38, 39 plan options | Plan Data Validation | `meaningful-difference`, `nonstandard-limit`, `chronic-exception-cell` |
| BCA:3, 34 agents and brokers | Agent page: suspension needs a remediation basis to lift; **Terminate for Cause** needs an evidentiary basis | `agent-suspension`, `termination-for-cause` |
| BCA:31, 32, 35–37 | CSR loading; reconsideration instructions; overdue data-inaccuracy flag; appeals; RADV threshold | existing tools |

Behaviour changes from the 2024 rules: a single FTR year now denies APTC for plan year 2026; enrollment outside open enrollment
needs an SEP; the gross-premium and fixed-dollar payment thresholds apply only from 2027. Plan year 2027 applications use the
2026 plan designs (no 2027 plan data is seeded). The schema version changed, so the database resets on first start.

## Database for data tests

- File: `data/aca.db` (SQLite). Connect from UiPath with the Database activities through an SQLite ODBC driver,
  or use the JSON API: `GET /api/db/<table>?column=value`.
- Main tables: `qhp_certifications`, `qhp_assessments`, `qhp_checklist_items`, `qhp_denials`, `qhp_reconsiderations`,
  `plans`, `issuers`, `applications`, `household_members`, `income_sources`, `enrollments`, `premium_payments`, `appeals`,
  `agents`, `agencies`, `compliance_actions`, `ftr_cases`, `notices`, `data_inaccuracy_reports`, `qis_submissions`,
  `reg_parameters`, `audit_log`, and for BCA: `redetermination_enrollees`, `updated_applications`, `edi_834_files`,
  `inconsistencies`, `sep_requests`, `plan_benefits`.
- Schema and seed data: `src/db.js`.

## Code layout

```
src/server.js           HTTP server and request context
src/db.js               schema, seed data, reset
src/rules.js            regulatory rules engine and tool catalog
src/bca.js              2025 CFR rules (project BCA) and their rule tools
src/marketplace.js      premiums, SLCSP, APTC/CSR/Medicaid
src/routes/consumer.js  consumer site
src/routes/exchange.js  Exchange portal (certification workflow, operations, tools)
src/routes/redetermination.js  annual redetermination, passive re-enrollment, 834 files, system clock (BCA:11, 12)
src/routes/bca.js       BCA flows: application eligibility, inconsistencies, SEPs, plan data validation, agent termination
src/routes/api.js       JSON API and traceability map
public/                 CSS and a small client script (dialog, panels, row selection)
test/smoke.js           end-to-end check of ACA:151–160 and the rules
test/bca.js             end-to-end check of BCA:40–49 and the other BCA requirements
```
