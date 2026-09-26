# EPIC Utility Hub — Smart Energy & Utility Consumption Hub

> **Central Engineering &bull; EPIC Group**  
> **Developed by:** Raisul Islam Ratul | MTO | Central Engineering  
> **Standard:** ISO 50001 Calibrated Energy Monitoring & Audit System

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

1. **High-Performance Hybrid Caching (Redis & In-Memory):**
   - Built-in Redis support (`ioredis`) with seamless fallback to high-speed in-memory TTL caching.
   - Reduces Google Sheets API quota usage by up to 90% and accelerates response times to sub-millisecond latencies.
   - Configurable via `REDIS_URL`, `KV_URL`, or `UPSTASH_REDIS_URL` environment variables.
   - Automatic cache invalidation on new entries or adjustment requests.
2. **System Health & Cache Telemetry (`/api/health`):**
   - Real-time diagnostic endpoint and interactive UI modal showing uptime, active caching provider, cached key counts, latency, and Google Sheets connectivity.
   - Manual cache flush endpoint (`POST /api/cache/clear`).
3. **Consolidated ISO 50001 Audit CSV Export (`/api/export-csv`):**
   - Instant one-click CSV export consolidating historical utility consumption data across all 6 manufacturing plants.
4. **Live Register Search & Category Filters:**
   - Instant search across meter equipment, source, utility type, and section.
   - Category filter pills for rapid isolation of `⚡ Electricity`, `💧 Water`, `🔥 Gas & Fuel`, and `💨 Steam`.
5. **Offline Draft Auto-Save & Recovery:**
   - Real-time background auto-saving of unsubmitted readings into `localStorage`.
   - Automatic draft restore prompt if a technician accidentally closes or reloads the tab before submitting.
6. **Consumption Spike & Rollover Anomaly Detection:**
   - Instant visual alerts for decreasing meter readings (meter rollover) and abnormal consumption spikes (>2.5x historical average).
7. **Automatic Chronological Previous Reading Inheritance:**
   - Previous reading is dynamically inherited from the most recent prior recorded date.
   - When entering readings for a new date, operators only need to input the **Present Reading**.
   - Consumption difference (`Present - Previous`) and estimated costs (BDT & USD) compute instantly in real-time.
8. **Single-Entry Policy & Daily Lock:**
   - Enforces one submission per meter register per date.
   - If only partial registers are submitted, remaining unlocked meters can still be filled out on that day without overwriting saved registers.
9. **Overtime Shift Mode & Theme:**
   - Dedicated overtime toggle shifts the UI into a calibrated warm reddish/crimson theme.
   - Includes shift justification tracking with quick-chips (`+ Emergency Dyeing`, `+ Finishing Overtime`, etc.) recorded in dedicated `Overtime` sheets.
10. **Adjustment / Correction Request Workflow:**
    - Operators can request corrections for erroneous entries by clicking **Request Adjustment**.
    - Submissions are logged into the dedicated `Adjustment/Correction Record` Google Sheet with unique tracking IDs (`REQ-YYYYMMDD-XXXX`).
11. **Activity & Audit Logging:**
    - Submissions, adjustments, and navigation events are logged in the `Logs` sheet with timestamp, plant, IP, and duration metrics.
12. **Touch-Optimized Mobile View:**
    - On screens under 768px, transforms into individual register cards with a sticky bottom action bar, 48px touch targets, and safe-area padding.

---

## 📁 Repository Structure

```text
├── Index.html                  # Responsive Single-Page Application (HTML5 / Vanilla CSS / Modern JS)
├── server.js                   # Node.js Express backend with Redis caching & Google Sheets API v4
├── vercel.json                 # Vercel serverless deployment configuration
├── credentials.json            # Google Cloud Service Account credentials (git-ignored)
├── package.json                # Project dependencies (express, googleapis, ioredis, cors, etc.)
├── code.gs                     # Legacy Google Apps Script backend controller
├── Utility Budget Automation.xlsx # Reference engineering utility budget & register master workbook
├── .gitignore
└── README.md
```

---

## 🚀 Deployment & Running

### 1. Local Development
```bash
npm install
node server.js
```
Open [http://localhost:3000](http://localhost:3000) in any modern browser.

### 2. Vercel Cloud Deployment
1. Import the GitHub repository (`IzayaRais/epic-utility-hub`) into **Vercel**.
2. Under **Project Settings > Environment Variables**, add:
   - `GOOGLE_CREDENTIALS`: Paste the complete JSON contents of your `credentials.json`.
   - *(Optional)* `SPREADSHEET_ID`: `1dfY5fkCvrgFTkGxH8ozSUhmct7q5oL6gCSWnpwUV7LY`
   - *(Optional)* `REDIS_URL` or `KV_URL`: Upstash or Redis connection URI for cluster caching (if omitted, falls back seamlessly to in-memory caching).
3. Click **Deploy**. Vercel will host the web app and route all API calls through the serverless `server.js` functions.
