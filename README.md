# EPIC Utility Hub — Smart Energy & Utility Consumption Hub

> **Central Engineering &bull; EPIC Group**  
> **Developed by:** Raisul Islam Ratul | MTO | Central Engineering  
> **System:** Enterprise Energy & Utility Consumption Monitoring Platform

---

## ⚡ Overview

**EPIC Utility Hub** is an enterprise-grade digital utility monitoring and data entry application built for manufacturing facilities across the EPIC Group. It centralizes electricity, fuel, water, and steam consumption tracking across plants, prevents duplicate daily entries, enables overtime shift auditing with a dedicated industrial theme, converts dual currencies (BDT & USD), and provides a formal workflow for adjustment/correction requests.

---

## 🏭 Facilities Covered

| Plant Code | Facility Full Name | Location | Primary Utilities |
| :--- | :--- | :--- | :--- |
| **CIPL** | Cosmopolitan Industries Pvt. Ltd. | Ashulia, Dhaka | REB, Gas, Diesel, Water |
| **EGMCL 1** | Epic Garments Manufacturing Co. Ltd. (Plant 1) | Bhaluka, Mymensingh | REB, Diesel, Water |
| **EGMCL 2** | Epic Garments Manufacturing Co. Ltd. (Plant 2) | Bhaluka, Mymensingh | REB, Diesel, Water |
| **PGCL** | Pearl Garments Company Ltd. | Gorai, Tangail | REB, Gas, Diesel, Water |
| **EGMCL 7** | Epic Garments Manufacturing Co. Ltd. (Plant 7) | Baroipara, Gazipur | REB, Gas, Diesel, Water |
| **GTL** | Green Textile Ltd. | Bhaluka, Mymensingh | REB, Gas, Diesel, Water |

---

## ✨ Key Features

1. **Facility Access Control:**
   - Operators sign in with a per-facility access code and may only read and write that facility's registers; the server enforces the scope on every request.
   - Sessions are signed, `HttpOnly`, `SameSite=Strict` cookies valid for 12 hours, with a brute-force lockout on repeated failures.
   - A Central Engineering administrator code opens all six facilities plus the audit export and diagnostics.
2. **High-Performance Hybrid Caching (Redis & In-Memory):**
   - Built-in Redis support (`ioredis`) with seamless fallback to high-speed in-memory TTL caching.
   - Reduces Google Sheets API quota usage by up to 90% and accelerates response times to sub-millisecond latencies.
   - Configurable via `REDIS_URL`, `KV_URL`, or `UPSTASH_REDIS_URL` environment variables.
   - Automatic cache invalidation on new entries or adjustment requests.
3. **System Health & Cache Telemetry (`/api/health`) — administrator only:**
   - Diagnostic endpoint and UI modal showing uptime, active caching provider, cached key counts, latency, and Google Sheets connectivity in Bangladesh Standard Time (BST, UTC+6).
   - Manual cache flush endpoint (`POST /api/cache/clear`).
   - Signed-in operators receive only a liveness response; the spreadsheet id and cache internals are not exposed to them.
4. **Consolidated Utility Audit CSV Export (`/api/export-csv`) — administrator only:**
   - One-click CSV consolidating historical consumption across all 6 plants, with cells neutralised against spreadsheet formula injection.
5. **Live Register Search & Category Filters:**
   - Instant search across meter equipment, source, utility type, and section.
   - Category filter pills for rapid isolation of Electricity, Water, Gas & Fuel, and Steam with responsive mobile touch layout.
6. **Offline Draft Auto-Save & Recovery:**
   - Real-time background auto-saving of unsubmitted readings into `localStorage`.
   - Automatic draft restore prompt if a technician accidentally closes or reloads the tab before submitting.
7. **Consumption Spike & Rollover Anomaly Detection:**
   - Instant visual alerts for decreasing meter readings (meter rollover) and abnormal consumption spikes (>2.5x historical average).
8. **Automatic Chronological Previous Reading Inheritance:**
   - Previous reading is dynamically inherited from the most recent prior recorded date.
   - When entering readings for a new date, operators only need to input the **Present Reading**.
   - Consumption difference (`Present - Previous`) and estimated costs (BDT & USD) compute instantly in real-time.
9. **Single-Entry Policy & Daily Lock:**
   - Enforces one submission per meter register per date.
   - If only partial registers are submitted, remaining unlocked meters can still be filled out on that day without overwriting saved registers.
10. **Overtime Shift Mode & Theme:**
   - Dedicated overtime toggle shifts the UI into a calibrated warm reddish/crimson theme.
   - Includes shift justification tracking with quick-chips (`+ Emergency Dyeing`, `+ Finishing Overtime`, etc.) recorded in dedicated `Overtime` sheets.
11. **Adjustment / Correction Request Workflow:**
    - Operators can request corrections for erroneous entries by clicking **Request Adjustment**.
    - Submissions are logged into the dedicated `Adjustment/Correction Record` Google Sheet with unique tracking IDs (`REQ-YYYYMMDD-XXXX`).
12. **Activity & Audit Logging:**
    - Submissions, adjustments, and navigation events are logged in the `Logs` sheet with timestamp, plant, IP, and duration metrics.
13. **Touch-Optimized Mobile View:**
    - On screens under 768px, transforms into individual register cards with a sticky bottom action bar, 48px touch targets, and safe-area padding.

---

## 📁 Repository Structure

```text
├── Index.html                  # Responsive Single-Page Application (HTML5 / Vanilla CSS / Modern JS)
├── server.js                   # Node.js Express backend with Redis caching & Google Sheets API v4
├── config/registers.js         # Server-side authority for registers and unit tariffs
├── lib/security.js             # Sessions, validation, sanitisation, rate limiting, headers
├── vercel.json                 # Vercel serverless deployment configuration
├── .env.example                # Environment variable template
├── .vercelignore               # Files never uploaded to the deployment
├── credentials.json            # Google Cloud Service Account credentials (git-ignored)
├── package.json                # Project dependencies (express, googleapis, ioredis, cors, etc.)
├── code.gs                     # Legacy Google Apps Script backend controller
├── Utility Budget Automation.xlsx # Reference engineering utility budget & register master workbook
├── .gitignore
└── README.md
```

---

## 🔐 Security & Access Control

Every `/api/*` endpoint requires an authenticated session. Operators sign in with
their **facility access code**; the session is a signed, `HttpOnly`,
`SameSite=Strict` cookie valid for 12 hours.

- A **facility code** can only read and write that facility's registers. The
  server enforces this on every request, not just in the UI.
- The **administrator code** (`ADMIN_CODE`) opens every facility and is the only
  way to reach the audit CSV export, the diagnostics modal and the cache flush.
- Ten failed sign-ins from one IP in 15 minutes trips a lockout. Successful
  sign-ins never count toward it, so a busy shift handover is never locked out.

Other protections in place:

| Area | Protection |
| :--- | :--- |
| Static files | Only `Index.html` is served. `credentials.json`, `server.js` and `code.gs` are not reachable over HTTP. |
| Spreadsheet writes | All free text is neutralised before it is written, so a remark beginning `=`, `+`, `-` or `@` is stored as text rather than executed as a formula. |
| Stored XSS | Every sheet-sourced value is HTML-escaped before it is rendered. |
| Cost integrity | Unit tariffs and previous readings are taken from the server's own register table and the sheet — never from the browser. |
| Payloads | 256 KB body limit, at most 100 records per submission, readings range-checked. |
| Rate limits | Submissions 30/hour, adjustments 10/hour, reads 120/hour, CSV export 5/hour. |
| Headers | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS. |
| CORS | Same-origin only unless `ALLOWED_ORIGIN` is set. |
| Audit trail | The `Logs` sheet records the server-observed IP and the authenticated facility, not values supplied by the client. |

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and fill it in. The required variables:

| Variable | Purpose |
| :--- | :--- |
| `SESSION_SECRET` | Signs session cookies. **Required in production** — the server refuses to start without it. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `PLANT_CODE_CIPL`, `PLANT_CODE_EGMCL_1`, `PLANT_CODE_EGMCL_2`, `PLANT_CODE_EGMCL_7`, `PLANT_CODE_PGCL`, `PLANT_CODE_GTL` | One access code per facility. |
| `ADMIN_CODE` | Central Engineering code; opens all facilities and admin-only endpoints. |
| `GOOGLE_CREDENTIALS` | Service-account JSON. Falls back to `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`, then to a local `credentials.json`. |
| `SPREADSHEET_ID` | Optional; defaults to the production workbook. |
| `REDIS_URL` / `KV_URL` / `UPSTASH_REDIS_URL` | Optional; without it a bounded in-memory cache is used. |
| `ALLOWED_ORIGIN` | Optional; only if a different origin must call the API. |

---

## 🚀 Deployment & Running

### 1. Local Development
```bash
npm install
cp .env.example .env        # then fill in SESSION_SECRET and the access codes
npm start
```
Open [http://localhost:3000](http://localhost:3000) and sign in with a facility code.

### 2. Vercel Cloud Deployment
1. Import the GitHub repository (`IzayaRais/epic-utility-hub`) into **Vercel**.
2. Under **Project Settings > Environment Variables**, add everything listed in
   the Configuration table above. `SESSION_SECRET` and at least one access code
   are mandatory — without them nobody can sign in.
3. Click **Deploy**. Vercel routes every request through `server.js`.
