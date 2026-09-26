# EPIC Utility Hub — Agent Orientation

Daily utility-meter reading entry for 6 EPIC Group plants in Bangladesh. Operators sign in with a facility access code, enter present readings, and the app computes consumption + cost (BDT/USD) and **appends** rows to a Google Spreadsheet, which is the only database.

## Layout — no build step, no tests

| File | Role |
| --- | --- |
| `Index.html` (~5.7k lines) | Entire frontend. Sign-in gate + `<style>` + DOM + one `<script>`. Vanilla JS, no framework. Only CDN dep is Lucide (version-pinned with SRI). |
| `server.js` | Express 5 + Sheets API v4. Serves `Index.html` + `/api/*`. `module.exports = app` for Vercel; `app.listen` only when run directly. |
| `config/registers.js` | **Authority** for which registers exist per plant and what each unit costs. |
| `lib/security.js` | Sessions, validation, cell sanitisation, rate limiting, security headers. Built on node `crypto` only. |
| `code.gs` | **Legacy** Apps Script backend, migrated away from in `a4d281a`. Reference only — not deployed, and now well out of step with `server.js` (it predates all authentication and validation). |

`npm start` → :3000. **No build step, no test suite** (`npm test` exits 1).

## Authentication — read this first

Every `/api/*` route except `/api/health` and `/api/auth/login` requires a session.

- `POST /api/auth/login {plant, code}` checks `PLANT_CODE_<PLANT>` or `ADMIN_CODE` env vars, then sets `euh_session` — an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie holding `{plant, role, exp}`, 12-hour TTL. Stateless by design so it survives Vercel's per-invocation processes.
- A plant session may only touch its own plant (`sessionCanAccessPlant`). Admin sessions carry `plant: '*'`.
- **Admin-only:** `/api/export-csv`, `/api/cache/clear`, and the detailed form of `/api/health`.
- `SESSION_SECRET` is mandatory in production — the server throws at startup without it. Locally it generates an ephemeral one and warns.
- Login lockout counts **failures only** (`rateLimit.failuresOnly`), so repeated successful sign-ins during a handover never lock a plant out.

## The `google.script.run` shim

The frontend still uses Apps Script call syntax. `Index.html` fakes `window.google.script.run` and forwards through a shared `apiCall()` helper that sends `credentials: 'same-origin'`, converts 401 into `handleAuthExpiry()` (re-shows the gate), and surfaces the server's own error message.

| Shim method | Endpoint |
| --- | --- |
| `fetchAllPreviousReadings` | `POST /api/previous-readings` |
| `submitBulkData` | `POST /api/submit-data` |
| `submitAdjustmentRequest` | `POST /api/adjustment` |
| `logActivity` | `POST /api/log-activity` |

**Adding a call means editing two places** — a method in `createRunner()` *and* a route in `server.js`.

## Google Sheet contract

ID `1dfY5fkCvrgFTkGxH8ozSUhmct7q5oL6gCSWnpwUV7LY` (env `SPREADSHEET_ID`). Column indexes are hardcoded — inserting a sheet column silently corrupts reads.

Tabs (from `config/registers.js`): `CIPL-Data Sheet`, `EGMCL 1 -Data Sheet`, `EGMCL 7 -Data Sheet`, `GTL -Data Sheet`, `PGCL -Data Sheet`, **`EGMCL 2 -Data Sheet `** (⚠️ trailing space — intentional, verified against the live workbook), plus `Overtime`, `Logs`, `Adjustment/Correction Record`, `01_Records`.

Plant sheet cols (0-idx): `0 Date, 1 Month, 2 Year, 3 Section, 4 Utility, 5 Source, 6 Equip, 7 Unit, 8 Prev, 9 Pres, 10 Diff, 11 kWh, 12 M3, 13 Ltr, 14 Kg, 15 Diff, 16 UnitCost, 17 TotalBDT, 18 TotalUSD`. Overtime is the same but **Plant occupies col 3**, shifting the rest +1, with the row remark at col 20.

Row identity is **`section_utility_source`** everywhere. `readSheetState()` in `server.js` is the single place that derives both previous readings and the daily lock — `/api/previous-readings` and `/api/submit-data` both use it so they cannot disagree.

## Business rules

- **Previous reading inherits chronologically** — the latest entry *strictly before* the target date, not the last appended row.
- **Daily lock is per-register.** Partial submits supported; the server re-filters duplicates against fresh (uncached) sheet state.
- **Append-only.** No update/delete path exists. Mistakes are fixed via an **adjustment request** (`REQ-YYYYMMDD-NNNN`) that an admin actions by hand.
- **The server owns the money columns.** `unit` and `cost` come from `config/registers.js`; `prev` is re-derived from the sheet. `rec.cost`/`rec.prev` from the browser are discarded. A register not on the plant's list is rejected outright.
- **Anomaly badges** (`onReadingInput`): `diff < 0` → Rollover; `diff > 50000` or (`prev ≥ 50` and `diff > prev × 2.5`) → Spike. Warnings only.
- **Overtime** writes to the shared `Overtime` tab and requires a remark.
- **Drafts** autosave to `localStorage` (`epic_draft_v2_<plant>_<reg|ot>_<date>`) and auto-restore into empty unlocked fields.
- Logs are timestamped in **Bangladesh Standard Time** via `getBDTime()` and record the **server-observed** `req.ip` — never a client-supplied value.

## Security invariants — do not regress these

1. **Never add `express.static`** on `__dirname`. It previously served `credentials.json` (the live service-account private key) over HTTP. Only `Index.html` is served, and paths with a file extension 404.
2. **Every free-text field written to Sheets or CSV goes through `sanitizeCell()`** — it prefixes `'` to values starting with `= + - @`, so a remark cannot become a live formula. `valueInputOption` stays `USER_ENTERED` deliberately: `RAW` would store dates as text and break the workbook's existing sorting.
3. **Every sheet-sourced value rendered into HTML goes through `escapeHtml()`.** Remarks previously landed unescaped in a `value="..."` attribute — stored XSS. Numeric fields are `Number()`-coerced instead.
4. **Validate the plant before branching on `isOvertime`.** The old order let `isOvertime:true` skip validation entirely.
5. The in-memory cache is **bounded** (500 entries, oldest evicted) because cache keys embed request-supplied values.

## Known limitations (deliberate, documented)

- The CSP includes `'unsafe-inline'` for `script-src`: the page is one inline `<script>` plus dozens of `onclick=` handlers. Removing it means converting every handler to an event listener first. XSS is fixed at the source by escaping; CSP is defence in depth here.
- Access codes are compared against plaintext env vars (constant-time), not hashes.
- The rate-limit counter is read-modify-write, not atomic — a simultaneous burst can slip a few over. It is a flood brake on Sheets quota, not a billing meter.
- Tariffs live in **two** places: `config/registers.js` (authoritative) and `configData` in `Index.html` (on-screen estimates only). Change both together. The USD rate 123 is in `config/registers.js`, `Index.html`, and `code.gs`.

## Stale artifacts — verify before trusting

- `README.md` and `Index.html` **disagree on plant locations** (README: EGMCL 1 = Bhaluka; code: AEPZ, Narayanganj). The UI uses the code values.
- `adjustment_records.json` is tracked but **read by nothing**, and contains phone numbers. A leftover test artifact.
- `Utility Budget Automation.xlsx` is the source workbook — reference only, unused at runtime.
- As of the last check the plant data sheets were nearly empty (only `EGMCL 7 -Data Sheet` had rows, and `Logs` had ~350). The system is early in its rollout.

## Conventions

Users are plant operators on phones (mobile card view, 48 px targets, sticky action bar). Keep the stack dependency-light — the security layer deliberately uses only node built-ins. BDT (৳) primary, USD secondary.
