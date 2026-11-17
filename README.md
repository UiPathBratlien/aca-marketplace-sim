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
Leave the window open while you test. Press **Ctrl+C** to stop.

### 3. Check it works

- Open http://localhost:3000 in a browser, or http://localhost:3000/api/health for a JSON status.
- Optionally run the self-test, which walks every step of ACA:151–160 against a throwaway database:
  ```
  npm run smoke      # expect: "178 checks passed, 0 failed"
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

Then restart the app. If the database schema changed, reset the data: click **Reset Test Data** on `/exchange/admin`, run `npm run reset` while the app is stopped, or delete `data\aca.db`.

### Troubleshooting

| Problem | Fix |
|---|---|
| `'node' is not recognized` | Install Node.js, then open a new terminal |
| `No such built-in module: node:sqlite` or a `--disable-warning` error | Node is too old; install 22.13 or later |
| `EADDRINUSE` | Port 3000 is taken; `set PORT=3001` or stop the other process |
| Another machine can't connect | Start with `HOST=0.0.0.0` and add the firewall rule above |
| `database is locked` | Move the DB with `ACA_DB_PATH` to a local, non-synced folder |
| Reconsideration and data-inaccuracy deadlines look wrong | They count from today's date; check the machine's clock |

## URLs

| URL | What |
|---|---|
| http://localhost:3000/ | Consumer site |
| http://localhost:3000/exchange | Exchange certification portal |
| http://localhost:3000/exchange/admin | Reset test data, table counts, seeded accounts |
| http://localhost:3000/api | JSON API index |

Seeded logins (password `Password123!` for all): `jane.consumer@example.com`, `sam.filer@example.com`, `reviewer@exchange.test`.

**Reset between test runs:** each denial changes plan status. Lists are keyed on a fixed queue, so the tests can be rerun,
but for a clean baseline click **Reset Test Data** or call `POST /api/admin/reset` (for example from an HTTP Request
activity in a test's setup).

Self-test: `npm run smoke` runs every ACA:151–160 step over HTTP against a throwaway database (178 checks).

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
