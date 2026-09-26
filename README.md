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

1. **Smart Meter Data Entry & Single-Entry Daily Lock:**
   - Enforces a single-entry policy per register per date.
   - If partial data is entered, unlocked meters can still be logged on the same day without overwriting existing records.
2. **Dual Currency Conversion (BDT & USD):**
   - Automatically computes total utility costs in **BDT (৳)** and **USD ($)** at the enterprise standard conversion rate (`1 USD = 123 BDT`).
3. **Overtime Shift Mode & Theme:**
   - Dedicated overtime toggle shifts the UI into a calibrated warm reddish/crimson theme.
   - Includes an executive shift justification card with one-click quick-chips (`+ Emergency Dyeing`, `+ Finishing Overtime`, `+ Boiler Run`, etc.).
4. **Adjustment / Correction Request Workflow:**
   - Operators can request corrections for erroneous entries by clicking **Request Adjustment**.
   - Submissions are logged into the dedicated `Adjustment/Correction Record` Google Sheet with unique tracking IDs (`REQ-YYYYMMDD-XXXX`).
5. **Full Mobile Responsiveness:**
   - Desktop features a multi-column data table; mobile view transforms dynamically into touch-optimized register cards with floating sticky action bars.
6. **Activity & Audit Logging:**
   - Submissions and actions are tracked in the `Logs` sheet with timestamp, plant, IP, and duration metrics.
7. **Enhanced Corporate UI/UX:**
   - Updated design system with official EPIC corporate colors (EPIC Blue, Deep Navy).
   - Modern typography (`Inter` font) for improved readability of data tables and dashboards.

---

## 📁 Repository Structure

```text
├── Index.html                  # Responsive Single-Page Application (HTML5 / Vanilla CSS / Modern JS)
├── code.gs                     # Google Apps Script backend controller & spreadsheet integration
├── server.js                   # Local Node.js development server with adjustment endpoints
├── adjustment_records.json     # Local simulation ledger for adjustment & correction requests
├── Utility Budget Automation.xlsx # Reference engineering utility budget & register master workbook
├── .gitignore
└── README.md
```

---

## 🚀 Getting Started

### Local Development
To run the application locally without any dependencies:
```bash
node server.js
```
Open [http://localhost:3000](http://localhost:3000) in any modern browser.

### Google Apps Script Deployment
1. Open Google Sheets and go to **Extensions > Apps Script**.
2. Copy the contents of `code.gs` into `code.gs`.
3. Create an HTML file named `Index.html` and paste the contents of `Index.html`.
4. Deploy as a Web App with access set to your organization or authorized users.
