/**
 * EPIC UTILITY HUB - SERVER-SIDE REGISTER & TARIFF AUTHORITY
 *
 * This file is the single source of truth for which meter registers exist at
 * each plant and what each utility unit costs. The browser keeps its own copy
 * (configData in Index.html) purely to render live on-screen estimates while an
 * operator types -- the server never trusts the client's cost or unit values and
 * always looks them up here before writing money columns to the spreadsheet.
 *
 * Central Engineering - EPIC Group
 */

const USD_CONVERSION_RATE = 123;

// Plant -> Google Sheet tab name.
// NOTE: 'EGMCL 2 -Data Sheet ' ends with a trailing space. That matches the real
// tab name in the spreadsheet -- do not "clean up" the spacing here.
const PLANT_SHEET_MAP = {
  'CIPL': 'CIPL-Data Sheet',
  'EGMCL 1': 'EGMCL 1 -Data Sheet',
  'EGMCL 7': 'EGMCL 7 -Data Sheet',
  'GTL': 'GTL -Data Sheet',
  'PGCL': 'PGCL -Data Sheet',
  'EGMCL 2': 'EGMCL 2 -Data Sheet '
};

const PLANTS = ['CIPL', 'EGMCL 1', 'EGMCL 2', 'PGCL', 'EGMCL 7', 'GTL'];

// Mirrors configData in Index.html. Keep both in step when tariffs change.
const REGISTERS = {
  'EGMCL 1': [
    { section: 'Apparel', utility: 'Electricity', source: 'REB(BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'NG', equip: 'Generator- Model', unit: 'M3', cost: 26.9 },
    { section: 'Apparel', utility: 'Steam', source: 'NG', equip: 'Boiler - Model', unit: 'M3', cost: 26.9 },
    { section: 'Apparel', utility: 'Water', source: 'Ground Water', equip: 'Flow Meter', unit: 'M3', cost: 35.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'Service/Others', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Washing', utility: 'Electricity', source: 'REB(BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Washing', utility: 'Electricity', source: 'Service/Others', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Washing', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Oven', source: 'Diesel', equip: 'Burner - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Electricity', source: 'NG', equip: 'Generator- Model', unit: 'M3', cost: 26.9 },
    { section: 'Washing', utility: 'Steam', source: 'NG', equip: 'Boiler - Model', unit: 'M3', cost: 26.9 },
    { section: 'Washing', utility: 'Steam', source: 'Thermo', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Steam', source: 'Jhute', equip: 'Boiler - Model', unit: 'Kg', cost: 15.0 },
    { section: 'Washing', utility: 'Water', source: 'BEPZA Water', equip: 'Flow Meter', unit: 'M3', cost: 47.1 },
    { section: 'Washing', utility: 'ETP Chemical', source: 'Service/Others', equip: 'ETP Unit', unit: 'Kg', cost: 0.0 }
  ],
  'EGMCL 7': [
    { section: 'Apparel', utility: 'Electricity', source: 'REB(BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Water', source: 'BEPZA Water', equip: 'Flow Meter', unit: 'M3', cost: 47.1 },
    { section: 'Apparel', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 }
  ],
  'GTL': [
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'REB(Non BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.56 },
    { section: 'Apparel', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Steam', source: 'Jhute', equip: 'Boiler - Model', unit: 'Kg', cost: 15.0 },
    { section: 'Washing', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Electricity', source: 'REB(Non BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.56 },
    { section: 'Washing', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Steam', source: 'Jhute', equip: 'Boiler - Model', unit: 'Kg', cost: 15.0 }
  ],
  'PGCL': [
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'REB(Non BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.56 },
    { section: 'Apparel', utility: 'Steam', source: 'Canteen NG', equip: 'Flow Meter', unit: 'M3', cost: 26.9 },
    { section: 'Apparel', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Steam', source: 'LPG', equip: 'Boiler - Model', unit: 'Kg', cost: 185.0 }
  ],
  'CIPL': [
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'REB(Non BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.56 },
    { section: 'Apparel', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Steam', source: 'NG', equip: 'Boiler - Model', unit: 'M3', cost: 26.9 },
    { section: 'Washing', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Electricity', source: 'REB(Non BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.56 },
    { section: 'Washing', utility: 'Steam', source: 'Diesel', equip: 'Boiler - Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Washing', utility: 'Steam', source: 'NG', equip: 'Boiler - Model', unit: 'M3', cost: 26.9 },
    { section: 'Apparel', utility: 'Electricity', source: 'NG', equip: 'Generator- Model', unit: 'M3', cost: 26.9 },
    { section: 'Washing', utility: 'Electricity', source: 'NG', equip: 'Generator- Model', unit: 'M3', cost: 26.9 }
  ],
  'EGMCL 2': [
    { section: 'Apparel', utility: 'Water', source: 'BEPZA Water', equip: 'Flow Meter', unit: 'M3', cost: 47.1 },
    { section: 'Apparel', utility: 'Waste Water BEPZA', source: 'Toilet Flash Water', equip: 'Flow Meter', unit: 'M3', cost: 47.1 },
    { section: 'Apparel', utility: 'Electricity', source: 'Diesel', equip: 'Generator- Model', unit: 'Ltr', cost: 41.0 },
    { section: 'Apparel', utility: 'Electricity', source: 'REB(BEPZA)', equip: 'Meter', unit: 'kWh', cost: 14.14 },
    { section: 'Apparel', utility: 'Steam', source: 'NG', equip: 'Boiler - Model', unit: 'M3', cost: 26.9 }
  ]
};

// Pre-index by the same section_utility_source key the rest of the app uses.
const REGISTER_INDEX = {};
for (const plant in REGISTERS) {
  REGISTER_INDEX[plant] = {};
  REGISTERS[plant].forEach(r => {
    REGISTER_INDEX[plant][`${r.section}_${r.utility}_${r.source}`] = r;
  });
}

function isKnownPlant(plant) {
  return typeof plant === 'string' && Object.prototype.hasOwnProperty.call(REGISTER_INDEX, plant);
}

function getSheetName(plant) {
  if (!isKnownPlant(plant)) return null;
  return PLANT_SHEET_MAP[plant];
}

/**
 * Look up the authoritative register definition for a plant.
 * Returns null when the register is not on that plant's list, which callers
 * treat as a rejected record rather than a fallback.
 */
function getRegister(plant, section, utility, source) {
  if (!isKnownPlant(plant)) return null;
  const key = `${section}_${utility}_${source}`;
  return Object.prototype.hasOwnProperty.call(REGISTER_INDEX[plant], key)
    ? REGISTER_INDEX[plant][key]
    : null;
}

function getRegisters(plant) {
  return isKnownPlant(plant) ? REGISTERS[plant] : [];
}

module.exports = {
  USD_CONVERSION_RATE,
  PLANTS,
  PLANT_SHEET_MAP,
  isKnownPlant,
  getSheetName,
  getRegister,
  getRegisters
};
