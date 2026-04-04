import 'dotenv/config';
import pg from 'pg';
import { Bot, session, InlineKeyboard } from 'grammy';

// ═══════════════════════════════════════════════════════════════
// ██  DATABASE  ██
// ═══════════════════════════════════════════════════════════════
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
});
async function query(text, params) { return pool.query(text, params); }

// ═══════════════════════════════════════════════════════════════
// ██  CZECH TAX ENGINE (year-specific, verified Apr 2026)  ██
// ═══════════════════════════════════════════════════════════════
//
// Sources: ČSSZ, VZP, Finanční správa, MPSV
//
// KEY FORMULAS:
//   Social VZ  = 55 % of daňový základ  (changed from 50 % in 2024)
//   Health VZ  = 50 % of daňový základ
//   23 % threshold = 36 × průměrná mzda (changed from 48× in 2024)
//
const TAX_BY_YEAR = {
  2024: {
    PRUMERNA_MZDA: 43967,
    HIGH_RATE_THRESHOLD: 1582812,  // 36 × 43 967
    BASIC_DEDUCTION: 30840,
    SOCIAL_MIN_MONTHLY_VZ: 13191,  // hlavní: 30 % of průměrná mzda (2024 transitional)
    HEALTH_MIN_MONTHLY_VZ: 21984,  // hlavní: 50 % of průměrná mzda
    SOCIAL_MAX_ANNUAL_VZ: 2110416, // 48 × průměrná mzda
    // Vedlejší
    VEDLEJSI_SOCIAL_MIN_MONTHLY_VZ: 5122, // vedlejší min VZ
    VEDLEJSI_ROZHODNA_CASTKA: 105520,     // daňový základ threshold for social
    PAUSALNI_DAN: { band1: { max: 1000000, monthly: 7498 }, band2: { max: 1500000, monthly: 16745 }, band3: { max: 2000000, monthly: 27139 } },
  },
  2025: {
    PRUMERNA_MZDA: 46557,
    HIGH_RATE_THRESHOLD: 1676052,  // 36 × 46 557
    BASIC_DEDUCTION: 30840,
    SOCIAL_MIN_MONTHLY_VZ: 16295,  // hlavní: 35 % of 46 557 (confirmed ČSSZ)
    HEALTH_MIN_MONTHLY_VZ: 23279,  // hlavní: 50 % of 46 557 (confirmed VZP)
    SOCIAL_MAX_ANNUAL_VZ: 2234736, // 48 × 46 557
    // Vedlejší
    VEDLEJSI_SOCIAL_MIN_MONTHLY_VZ: 5122, // vedlejší min VZ (confirmed ČSSZ)
    VEDLEJSI_ROZHODNA_CASTKA: 111736,     // rozhodná částka 2025 (confirmed ČSSZ)
    PAUSALNI_DAN: { band1: { max: 1000000, monthly: 8716 }, band2: { max: 1500000, monthly: 16745 }, band3: { max: 2000000, monthly: 27139 } },
  },
  2026: {
    PRUMERNA_MZDA: 48967,
    HIGH_RATE_THRESHOLD: 1762812,  // 36 × 48 967
    BASIC_DEDUCTION: 30840,
    SOCIAL_MIN_MONTHLY_VZ: 19587,  // hlavní: 40 % of 48 967 (confirmed ČSSZ)
    HEALTH_MIN_MONTHLY_VZ: 24484,  // hlavní: 50 % of 48 967 (confirmed VZP)
    SOCIAL_MAX_ANNUAL_VZ: 2350416, // 48 × 48 967
    // Vedlejší
    VEDLEJSI_SOCIAL_MIN_MONTHLY_VZ: 5387, // vedlejší min VZ (confirmed ČSSZ)
    VEDLEJSI_ROZHODNA_CASTKA: 117521,     // rozhodná částka 2026 (confirmed ČSSZ)
    PAUSALNI_DAN: { band1: { max: 1000000, monthly: 9984 }, band2: { max: 1500000, monthly: 16745 }, band3: { max: 2000000, monthly: 27139 } },
  },
};

// Shared constants (unchanged across years)
const TAX_SHARED = {
  INCOME_TAX_RATE: 0.15,
  HIGH_RATE: 0.23,
  PAUSALNI_VYDAJE_RATE: 0.60, // 60 % for most OSVČ (živnosti)
  SOCIAL_RATE: 0.292,
  SOCIAL_VZ_RATIO: 0.55,     // 55 % of daňový základ since 2024
  HEALTH_RATE: 0.135,
  HEALTH_VZ_RATIO: 0.50,     // 50 % of daňový základ
};

function getTaxParams(year) {
  return TAX_BY_YEAR[year] || TAX_BY_YEAR[2026];
}

/**
 * Calculate taxes under paušální výdaje (flat-rate expenses 60%).
 * @param {number} income - Annual gross income
 * @param {number} year - Tax year
 * @param {'hlavni'|'vedlejsi'} activity - Activity type
 */
function calcPausal(income, year = 2026, activity = 'hlavni') {
  const p = getTaxParams(year);
  const s = TAX_SHARED;
  const isVedlejsi = activity === 'vedlejsi';

  const expenses = income * s.PAUSALNI_VYDAJE_RATE;
  const base = Math.floor(Math.max(0, income - expenses) / 100) * 100; // daňový základ

  // ── Income tax (15 % / 23 %) — same for both types ──
  let tax = base <= p.HIGH_RATE_THRESHOLD
    ? base * s.INCOME_TAX_RATE
    : p.HIGH_RATE_THRESHOLD * s.INCOME_TAX_RATE + (base - p.HIGH_RATE_THRESHOLD) * s.HIGH_RATE;
  tax = Math.max(0, tax - p.BASIC_DEDUCTION);

  // ── Social insurance ──
  let social = 0;
  if (isVedlejsi) {
    // Vedlejší: only pay if daňový základ > rozhodná částka
    if (base > p.VEDLEJSI_ROZHODNA_CASTKA) {
      const socialVZ = base * s.SOCIAL_VZ_RATIO;
      const socialMinAnnualVZ = p.VEDLEJSI_SOCIAL_MIN_MONTHLY_VZ * 12;
      const socialBase = Math.min(p.SOCIAL_MAX_ANNUAL_VZ, Math.max(socialMinAnnualVZ, socialVZ));
      social = socialBase * s.SOCIAL_RATE;
    }
    // else: 0
  } else {
    // Hlavní: always pay, at least from minimum VZ
    const socialVZ = base * s.SOCIAL_VZ_RATIO;
    const socialMinAnnualVZ = p.SOCIAL_MIN_MONTHLY_VZ * 12;
    const socialBase = Math.min(p.SOCIAL_MAX_ANNUAL_VZ, Math.max(socialMinAnnualVZ, socialVZ));
    social = socialBase * s.SOCIAL_RATE;
  }

  // ── Health insurance ──
  let health = 0;
  if (isVedlejsi) {
    // Vedlejší: calculated from actual VZ, NO minimum applies
    // Paid retroactively via přehled, not monthly
    const healthVZ = base * s.HEALTH_VZ_RATIO;
    health = healthVZ * s.HEALTH_RATE;
  } else {
    // Hlavní: must pay at least from minimum VZ
    const healthVZ = base * s.HEALTH_VZ_RATIO;
    const healthMinAnnualVZ = p.HEALTH_MIN_MONTHLY_VZ * 12;
    const healthBase = Math.max(healthMinAnnualVZ, healthVZ);
    health = healthBase * s.HEALTH_RATE;
  }

  const total = tax + social + health;
  return {
    tax: Math.round(tax), social: Math.round(social),
    health: Math.round(health), total: Math.round(total),
    net: Math.round(income - total),
    rate: income > 0 ? (total / income * 100).toFixed(1) : 0,
    base, // expose for display
  };
}

/**
 * Calculate taxes using ACTUAL (real) expenses.
 * Same insurance logic as calcPausal, but uses real expense amount.
 */
function calcActual(income, actualExpenses, year = 2026, activity = 'hlavni') {
  const p = getTaxParams(year);
  const s = TAX_SHARED;
  const isVedlejsi = activity === 'vedlejsi';

  const base = Math.floor(Math.max(0, income - actualExpenses) / 100) * 100;

  let tax = base <= p.HIGH_RATE_THRESHOLD
    ? base * s.INCOME_TAX_RATE
    : p.HIGH_RATE_THRESHOLD * s.INCOME_TAX_RATE + (base - p.HIGH_RATE_THRESHOLD) * s.HIGH_RATE;
  tax = Math.max(0, tax - p.BASIC_DEDUCTION);

  let social = 0;
  if (isVedlejsi) {
    if (base > p.VEDLEJSI_ROZHODNA_CASTKA) {
      const socialVZ = base * s.SOCIAL_VZ_RATIO;
      const socialMinAnnualVZ = p.VEDLEJSI_SOCIAL_MIN_MONTHLY_VZ * 12;
      const socialBase = Math.min(p.SOCIAL_MAX_ANNUAL_VZ, Math.max(socialMinAnnualVZ, socialVZ));
      social = socialBase * s.SOCIAL_RATE;
    }
  } else {
    const socialVZ = base * s.SOCIAL_VZ_RATIO;
    const socialMinAnnualVZ = p.SOCIAL_MIN_MONTHLY_VZ * 12;
    const socialBase = Math.min(p.SOCIAL_MAX_ANNUAL_VZ, Math.max(socialMinAnnualVZ, socialVZ));
    social = socialBase * s.SOCIAL_RATE;
  }

  let health = 0;
  if (isVedlejsi) {
    const healthVZ = base * s.HEALTH_VZ_RATIO;
    health = healthVZ * s.HEALTH_RATE;
  } else {
    const healthVZ = base * s.HEALTH_VZ_RATIO;
    const healthMinAnnualVZ = p.HEALTH_MIN_MONTHLY_VZ * 12;
    const healthBase = Math.max(healthMinAnnualVZ, healthVZ);
    health = healthBase * s.HEALTH_RATE;
  }

  const total = tax + social + health;
  return {
    tax: Math.round(tax), social: Math.round(social),
    health: Math.round(health), total: Math.round(total),
    net: Math.round(income - total),
    rate: income > 0 ? (total / income * 100).toFixed(1) : 0,
    base,
  };
}

function calcPausalnlDan(income, year = 2026) {
  const p = getTaxParams(year);
  const d = p.PAUSALNI_DAN;
  // Paušální daň eligibility: income ≤ 2 000 000 and specific band rules
  const band = income <= d.band1.max ? d.band1
    : income <= d.band2.max ? d.band2
    : income <= d.band3.max ? d.band3 : null;
  if (!band) return null;
  const annual = band.monthly * 12;
  return { monthly: band.monthly, annual, net: Math.round(income - annual), rate: (annual / income * 100).toFixed(1) };
}

function czk(n) {
  const hasDecimals = n % 1 !== 0;
  return new Intl.NumberFormat('cs-CZ', {
    style: 'currency',
    currency: 'CZK',
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  }).format(n);
}

// ═══════════════════════════════════════════════════════════════
// ██  DATE PARSER (improved)  ██
// ═══════════════════════════════════════════════════════════════
const MONTH_MAP = {
  // English full
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  // English short
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  // Czech short (no diacritics)
  led:1, uno:2, bre:3, dub:4, kve:5, cvn:6, cvc:7, srp:8, zar:9, rij:10, lis:11, pro:12,
  // Czech full (no diacritics)
  leden:1, unor:2, brezen:3, duben:4, kveten:5, cerven:6,
  cervenec:7, srpen:8, zari:9, rijen:10, listopad:11, prosinec:12,
};

/**
 * parseDate(text)
 * Detects optional date anywhere in text.
 * Now supports day-specific: "15.11.2025", "15 nov 2025", "15/11/2025"
 * And month-level: "nov 2025", "11/2025", "2025-11", "nov25"
 * Returns { day, month, year, clean } or null
 */
function parseDate(text) {
  const stripped = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // ── Day-specific patterns (check first) ──
  const dayPatterns = [
    // "15.11.2025" or "15/11/2025" or "15-11-2025" (European day.month.year)
    /\b(\d{1,2})[.\/\-](0?[1-9]|1[0-2])[.\/\-](20\d\d)\b/g,
    // "15 nov 2025" or "15 november 2025"
    /\b(\d{1,2})\s+([a-z]+)\s+(20\d\d)\b/g,
    // "nov 15 2025" (American-ish)
    /\b([a-z]+)\s+(\d{1,2})\s+(20\d\d)\b/g,
    // "15.11." or "15/11" (day.month, no year — assume current year)
    /\b(\d{1,2})[.\/](0?[1-9]|1[0-2])[.\/]?\b/g,
  ];

  for (let pi = 0; pi < dayPatterns.length; pi++) {
    const re = dayPatterns[pi];
    re.lastIndex = 0;
    const m = re.exec(stripped);
    if (!m) continue;

    let day, month, year;

    if (pi === 0) {
      day = parseInt(m[1]); month = parseInt(m[2]); year = parseInt(m[3]);
    } else if (pi === 1) {
      day = parseInt(m[1]);
      month = MONTH_MAP[m[2]];
      if (!month) continue;
      year = parseInt(m[3]);
    } else if (pi === 2) {
      month = MONTH_MAP[m[1]];
      if (!month) continue;
      day = parseInt(m[2]);
      year = parseInt(m[3]);
    } else if (pi === 3) {
      day = parseInt(m[1]); month = parseInt(m[2]);
      year = new Date().getFullYear();
      // Validate this isn't part of a longer number (like an amount "1.500")
      if (day > 31) continue;
    }

    if (day < 1 || day > 31) continue;
    if (month < 1 || month > 12) continue;
    if (year < 2020 || year > 2030) continue;

    // Validate actual day in month
    const maxDay = new Date(year, month, 0).getDate();
    if (day > maxDay) continue;

    const clean = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { day, month, year, clean };
  }

  // ── Month-level patterns (fallback) ──
  const monthPatterns = [
    // "jan 2025" / "leden 2025"
    /\b([a-z]+)\s+(20\d\d)\b/g,
    // "jan25" or "jan2025"
    /\b([a-z]+)(20\d\d|\d{2})\b/g,
    // "2025-01" or "2025/01"
    /\b(20\d\d)[\/\-](0?[1-9]|1[0-2])\b/g,
    // "1/2025" or "01/2025"
    /\b(0?[1-9]|1[0-2])\/(20\d\d)\b/g,
  ];

  for (let pi = 0; pi < monthPatterns.length; pi++) {
    const re = monthPatterns[pi];
    re.lastIndex = 0;
    const m = re.exec(stripped);
    if (!m) continue;

    let month, year;

    if (pi === 0 || pi === 1) {
      const name = m[1];
      const yearRaw = m[2];
      month = MONTH_MAP[name];
      if (!month) continue;
      year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw) : parseInt(yearRaw);
    } else if (pi === 2) {
      year = parseInt(m[1]); month = parseInt(m[2]);
    } else {
      month = parseInt(m[1]); year = parseInt(m[2]);
    }

    if (year < 2020 || year > 2030) continue;

    const clean = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { day: null, month, year, clean };
  }

  return null;
}

function makeDate(day, month, year) {
  return new Date(year, month - 1, day || 1);
}

function formatDateLabel(parsed) {
  if (!parsed) return null;
  if (parsed.day) return `${parsed.day}.${parsed.month}.${parsed.year}`;
  return `${parsed.month}/${parsed.year}`;
}

// ═══════════════════════════════════════════════════════════════
// ██  SMART INTENT PARSER (improved)  ██
// ═══════════════════════════════════════════════════════════════
function parseAmount(raw) {
  const s = String(raw).replace(/\s/g, '');
  // "1.500" or "1,500" = thousands separator (no decimals for CZK)
  return /^\d+[,.]\d{3}$/.test(s)
    ? parseFloat(s.replace(/[,.]/g, ''))
    : parseFloat(s.replace(',', '.'));
}

/**
 * extractAmountAndDesc(text)
 * Flexibly finds a number ANYWHERE in the text.
 * "15000 Wolt payment"  → { amount: 15000, desc: "Wolt payment" }
 * "Wolt payment 15000"  → { amount: 15000, desc: "Wolt payment" }
 * "laptop 4900 Dell"    → { amount: 4900, desc: "laptop Dell" }
 * "25000"               → { amount: 25000, desc: "" }
 * Returns { amount, desc } or null
 */
function extractAmountAndDesc(text) {
  // Strip common prefixes that aren't part of the description
  const stripped = text.replace(/^(vydaj[e]?|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy|income|prijem|invoice|faktura)\s+/i, '');

  // Try 1: number at the start
  const startMatch = stripped.match(/^([\d][\d\s]*(?:[,.]\d+)?)\s*(.*)/);
  if (startMatch) {
    const amount = parseAmount(startMatch[1]);
    if (!isNaN(amount) && amount > 0) {
      return { amount, desc: startMatch[2].trim() };
    }
  }

  // Try 2: number at the end
  const endMatch = stripped.match(/^(.*?)\s+([\d][\d\s]*(?:[,.]\d+)?)\s*$/);
  if (endMatch) {
    const amount = parseAmount(endMatch[2]);
    if (!isNaN(amount) && amount > 0) {
      return { amount, desc: endMatch[1].trim() };
    }
  }

  // Try 3: number in the middle (grab the largest number-looking token)
  const allNums = [...stripped.matchAll(/([\d][\d\s,.]*\d|\d+)/g)];
  if (allNums.length > 0) {
    // Pick the match that looks most like an amount (largest value)
    let bestAmount = 0, bestMatch = null;
    for (const m of allNums) {
      const val = parseAmount(m[1]);
      if (!isNaN(val) && val > bestAmount) {
        bestAmount = val;
        bestMatch = m;
      }
    }
    if (bestMatch && bestAmount > 0) {
      const desc = (stripped.slice(0, bestMatch.index) + ' ' + stripped.slice(bestMatch.index + bestMatch[0].length))
        .replace(/\s+/g, ' ').trim();
      return { amount: bestAmount, desc };
    }
  }

  return null;
}

/**
 * extractKmAndDesc(text)
 * Flexibly finds km value from text like:
 * "150 Brno", "150km Brno", "Brno 150", "schůzka 150 km"
 */
function extractKmAndDesc(text) {
  // Try: number + optional "km" anywhere
  const kmMatch = text.match(/([\d][\d\s,.]*?)\s*(?:km)?\b/i);
  if (kmMatch) {
    const km = parseAmount(kmMatch[1]);
    if (!isNaN(km) && km > 0 && km < 100000) { // sanity check on km
      const desc = (text.slice(0, kmMatch.index) + ' ' + text.slice(kmMatch.index + kmMatch[0].length))
        .replace(/\s*(km)\s*/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      return { km, desc };
    }
  }
  return null;
}

function detectIntent(text) {
  const dateParsed = parseDate(text);
  const clean = dateParsed ? dateParsed.clean : text;
  const date = dateParsed ? makeDate(dateParsed.day, dateParsed.month, dateParsed.year) : null;
  const dateLabel = dateParsed ? formatDateLabel(dateParsed) : null;
  const lower = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // ═══ STEP 1: Detect type by keyword ANYWHERE in text ═══

  const KM_WORDS = /\bkm\b/i;
  const KM_GLUED = /\d\s*km\b/i;  // "150km" or "150 km" — digit followed by km
  const EXP_WORDS = /\b(vydaj[e]?|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy|utraceno|utratil[a]?|naklad)\b/i;
  const INC_WORDS = /\b(income|prijem|prijmy|faktura|invoice)\b/i;

  const hasKm  = KM_WORDS.test(lower) || KM_GLUED.test(lower);
  const hasExp = EXP_WORDS.test(lower);
  const hasInc = INC_WORDS.test(lower);

  // ═══ STEP 2: Strip ALL keywords from text to isolate amount + description ═══

  function stripKeywords(txt) {
    return txt
      .replace(/\b(vydaj[e]?|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy|utraceno|utratil[a]?|naklad)\b/gi, '')
      .replace(/\b(income|prijem|prijmy|faktura|invoice)\b/gi, '')
      .replace(/(\d)\s*km\b/gi, '$1')  // "150km" → "150", "150 km" → "150"
      .replace(/\bkm\s+/gi, '')        // standalone "km 150" → "150"
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ═══ STEP 3: KM mode — "km" found anywhere ═══

  if (hasKm) {
    // Strip "km" and keywords, then find number + desc
    const stripped = stripKeywords(clean);
    const extracted = extractAmountAndDesc(stripped);
    if (extracted && extracted.amount > 0 && extracted.amount < 100000) {
      return { type: 'km', km: extracted.amount, purpose: extracted.desc, date, dateLabel };
    }
    // Also try: bare "150km" glued together
    const gluedMatch = clean.match(/([\d][\d\s,.]*?)\s*km/i);
    if (gluedMatch) {
      const km = parseAmount(gluedMatch[1]);
      if (!isNaN(km) && km > 0) {
        const rest = clean.replace(gluedMatch[0], '').replace(/\s+/g, ' ').trim();
        return { type: 'km', km, purpose: rest, date, dateLabel };
      }
    }
    return { type: 'km_error' };
  }

  // ═══ STEP 4: Expense mode — expense keyword found anywhere ═══

  if (hasExp && !hasInc) {
    const stripped = stripKeywords(clean);
    const extracted = extractAmountAndDesc(stripped);
    if (extracted && extracted.amount > 0) {
      return { type: 'expense', amount: extracted.amount, desc: extracted.desc, date, dateLabel };
    }
    return { type: 'expense_error' };
  }

  // ═══ STEP 5: Income mode — income keyword found anywhere ═══

  if (hasInc && !hasExp) {
    const stripped = stripKeywords(clean);
    const extracted = extractAmountAndDesc(stripped);
    if (extracted && extracted.amount > 0) {
      return { type: 'income', amount: extracted.amount, desc: extracted.desc, date, dateLabel };
    }
  }

  // ═══ STEP 6: "v" shortcut — only if it's a standalone prefix "v 800 benzin" ═══
  //  (can't use "v" as a keyword-anywhere because it appears in Czech words)

  const vPrefixRe = /^v\s+(\d)/i;
  if (vPrefixRe.test(lower)) {
    const withoutV = clean.replace(/^v\s+/i, '');
    const extracted = extractAmountAndDesc(withoutV);
    if (extracted && extracted.amount > 0) {
      return { type: 'expense', amount: extracted.amount, desc: extracted.desc, date, dateLabel };
    }
  }

  // ═══ STEP 7: No keyword — find amount anywhere, default to income ═══
  //  (user gets "Was this an expense?" button to flip)

  const extracted = extractAmountAndDesc(clean);
  if (extracted && extracted.amount > 0) {
    return { type: 'income', amount: extracted.amount, desc: extracted.desc, date, dateLabel };
  }

  return { type: 'unknown' };
}

// ═══════════════════════════════════════════════════════════════
// ██  CALENDAR KEYBOARD BUILDER  ██
// ═══════════════════════════════════════════════════════════════
const DAY_HEADERS = {
  cs: ['Po','Út','St','Čt','Pá','So','Ne'],
  en: ['Mo','Tu','We','Th','Fr','Sa','Su'],
};

const MONTH_NAMES = {
  cs: ['','Leden','Únor','Březen','Duben','Květen','Červen','Červenec','Srpen','Září','Říjen','Listopad','Prosinec'],
  en: ['','January','February','March','April','May','June','July','August','September','October','November','December'],
};

const MONTH_SHORT = {
  cs: ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
  en: ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
};

/**
 * Day grid — the main calendar view.
 * ◀  [Month ▾]  [Year ▾]  ▶
 * Tapping Month → month picker. Tapping Year → year picker.
 */
function buildCalendar(year, month, lang = 'cs') {
  const kb = new InlineKeyboard();

  // ── Header: ◀  [Month ▾]  [Year ▾]  ▶ ──
  kb.text('◀', `cal_nav_${year}_${month - 1}`)
    .text(`${MONTH_NAMES[lang][month]} ▾`, `cal_months_${year}`)
    .text(`${year} ▾`, `cal_years_${month}`)
    .text('▶', `cal_nav_${year}_${month + 1}`)
    .row();

  // ── Day-of-week headers ──
  for (const h of DAY_HEADERS[lang]) {
    kb.text(h, 'cal_noop');
  }
  kb.row();

  // ── Day grid ──
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const startOffset = firstDay === 0 ? 6 : firstDay - 1; // Monday-based
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;

  let col = 0;

  for (let i = 0; i < startOffset; i++) {
    kb.text(' ', 'cal_noop');
    col++;
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = isCurrentMonth && today.getDate() === d;
    const label = isToday ? `•${d}•` : `${d}`;
    const pad = d < 10 ? '0' + d : '' + d;
    const pm = month < 10 ? '0' + month : '' + month;
    kb.text(label, `cal_day_${year}${pm}${pad}`);
    col++;
    if (col % 7 === 0) kb.row();
  }

  while (col % 7 !== 0) {
    kb.text(' ', 'cal_noop');
    col++;
  }
  kb.row();

  // ── Quick actions ──
  kb.text(lang === 'cs' ? '📌 Dnes' : '📌 Today', 'cal_today')
    .text(lang === 'cs' ? '↩️ Měsíce' : '↩️ Months', `cal_months_${year}`)
    .text(lang === 'cs' ? '❌ Zrušit' : '❌ Cancel', 'wiz_cancel');

  return kb;
}

/**
 * Month picker — 4 rows × 3 columns grid.
 * This is the FIRST view users see when picking a date.
 * Tapping a month drills into the day grid for that month.
 */
function buildMonthPicker(year, lang = 'cs') {
  const kb = new InlineKeyboard();

  // ── Year navigation header ──
  kb.text('◀', `cal_monthpick_${year - 1}`)
    .text(`── ${year} ──`, 'cal_noop')
    .text('▶', `cal_monthpick_${year + 1}`)
    .row();

  const now = new Date();
  const curMonth = now.getFullYear() === year ? now.getMonth() + 1 : -1;

  // ── 4 rows × 3 months ──
  for (let row = 0; row < 4; row++) {
    for (let c = 0; c < 3; c++) {
      const m = row * 3 + c + 1;
      const label = curMonth === m ? `• ${MONTH_SHORT[lang][m]} •` : MONTH_SHORT[lang][m];
      kb.text(label, `cal_set_${year}_${m}`);
    }
    kb.row();
  }

  // ── Bottom actions ──
  kb.text(lang === 'cs' ? '📌 Dnes' : '📌 Today', 'cal_today')
    .text(lang === 'cs' ? '❌ Zrušit' : '❌ Cancel', 'wiz_cancel');

  return kb;
}

/**
 * Year picker — row of year buttons.
 * Tapping a year jumps to the day grid for that year + remembered month.
 */
function buildYearPicker(month, lang = 'cs') {
  const kb = new InlineKeyboard();
  const curYear = new Date().getFullYear();

  for (let y = curYear - 2; y <= curYear + 1; y++) {
    if (y < 2020 || y > 2030) continue;
    const label = y === curYear ? `•${y}•` : `${y}`;
    kb.text(label, `cal_set_${y}_${month}`);
  }
  kb.row();
  kb.text(lang === 'cs' ? '❌ Zrušit' : '❌ Cancel', 'wiz_cancel');
  return kb;
}

// ═══════════════════════════════════════════════════════════════
// ██  TRANSLATIONS (expanded)  ██
// ═══════════════════════════════════════════════════════════════
const T = {
  cs: {
    welcome: (name) =>
      `👋 Ahoj ${name}! Jsem tvůj *daňový pomocník* 🇨🇿\n\n` +
      `Můžeš psát přirozeně nebo použít tlačítka níže.\n\n` +
      `*Příklady:*\n` +
      `💰 \`25000 faktura Novák\`\n` +
      `🧾 \`vydaj 4900 notebook\`\n` +
      `🚗 \`150km Brno\`\n\n` +
      `📅 *S datem:* \`25000 faktura 15.11.2025\`\n` +
      `Nebo si datum vyber z kalendáře přes tlačítka.`,
    menu: {
      income:   '💰 Přidat příjem',
      expense:  '🧾 Přidat výdaj',
      km:       '🚗 Kilometry',
      summary:  '📊 Přehled',
      tax:      '🧮 Spočítat daně',
      entries:  '📋 Poslední záznamy',
      help:     '❓ Nápověda',
      lang:     '🇬🇧 English',
    },

    // ── Wizard prompts ──
    wizAmount:      (type) => type === 'income'
      ? '💰 *Kolik?*\nZadej částku (a volitelně popis):\n\n`25000`\n`25000 faktura Novák`'
      : type === 'expense'
      ? '🧾 *Kolik?*\nZadej částku (a volitelně popis):\n\n`4900`\n`4900 notebook`'
      : '🚗 *Kolik km a kam?*\n\n`150 Brno`\n`150km schůzka Praha`',
    wizPickDate:    '📅 *Vyber měsíc a den:*',
    wizConfirm:     (type, amount, desc, dateStr) => {
      const icon = type === 'income' ? '💰' : type === 'expense' ? '🧾' : '🚗';
      const label = type === 'income' ? 'Příjem' : type === 'expense' ? 'Výdaj' : 'Kilometry';
      const amountStr = type === 'km' ? `${amount} km` : czk(amount);
      return `${icon} *Potvrď záznam:*\n\n` +
        `• Typ: *${label}*\n` +
        `• Částka: *${amountStr}*\n` +
        (desc ? `• Popis: ${desc}\n` : '') +
        `• Datum: *${dateStr}*\n\n` +
        `Je to správně?`;
    },
    wizSaved:       '✅ Uloženo!',
    wizCancelled:   '❌ Zrušeno.',

    // ── Inline saves (quick text input) ──
    incomeSaved:    (amount, desc, dl) => `💰 Příjem: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    expenseSaved:   (amount, desc, dl) => `🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    kmSaved:        (km, purpose, dl) => `✅ *${km} km* zapsáno${purpose ? ` — ${purpose}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'příjem',
    expenseDefault: 'výdaj',
    kmDefault:      'pracovní cesta',
    expenseError:   '❌ Zkus: `vydaj 3500 telefon` nebo použij tlačítko 🧾',
    kmError:        '❌ Nerozpoznal jsem km. Zkus:\n`150km Brno` nebo `150 km schůzka Praha`',

    wasExpense:     '↩️ Měl to být výdaj',
    wasIncome:      '↩️ Měl to být příjem',
    correctedToExp: (amount, desc) => `✅ Opraveno → 🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Opraveno → 💰 Příjem: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,

    unknown:        '🤔 Nerozumím.\n\n' +
                    'Použij tlačítka v menu, nebo napiš:\n' +
                    '`25000 faktura klient`\n' +
                    '`vydaj 800 benzin`\n' +
                    '`150km Brno`',

    // ── Entries ──
    entriesTitle:   '📋 *Poslední záznamy:*\n',
    entriesEmpty:   '📭 Žádné záznamy.\nPřidej první přes menu!',
    entryIncome:    (e) => `💰 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryExpense:   (e) => `🧾 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryKm:        (e) => `🚗 ${e.km} km — ${e.purpose} (${fmtDate(e.date)})`,
    deleteConfirm:  '🗑️ Smazáno.',
    deleteBtn:      '🗑️',
    moreEntries:    '📋 Další',
    backToMenu:     '↩️ Menu',

    // ── Summary ──
    pickYear:       '📅 Vyber rok:',
    summaryTitle:   (year) => `📊 *Přehled ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Příjmy: *${czk(total)}* (${count} faktur)\n`,
    summaryExpenses:(total) => `🧾 Výdaje: *${czk(total)}*\n`,
    summaryNet:     (net) => net >= 0
      ? `📈 Zisk: *${czk(net)}*\n\n`
      : `📉 Ztráta: *${czk(net)}*\n\n`,
    summaryTaxHdr:  '🧮 *Odhadované odvody:*\n',
    summaryTax:     (tax) => `• Daň: ${czk(tax.tax)}\n• Sociální: ${czk(tax.social)}\n• Zdravotní: ${czk(tax.health)}\n• *Celkem odvody: ${czk(tax.total)}*`,
    compareMethods: '🧮 Porovnat metody',

    // ── Tax ──
    noIncome:       (year) => `📭 Žádné příjmy v ${year}.\nPřidej přes menu nebo napiš: \`25000 faktura\``,
    taxTitle:       (year) => `🧮 *Porovnání daní — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Roční odhad (z ${m} měs.): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Roční příjem: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Paušální výdaje 60 %*\n   Základ daně: ${czk(pv.base)}\n   Odvody: *${czk(pv.total)}*\n\n`,
    taxActual:      (av, expenses) => `2️⃣ *Skutečné výdaje*\n   Výdaje: ${czk(expenses)} (${av.expPct})\n   Základ daně: ${czk(av.base)}\n   Odvody: *${czk(av.total)}*\n\n`,
    taxFlat:        (pd, better) => `3️⃣ *Paušální daň* ${better}\n   ${czk(pd.monthly)}/měs → *${czk(pd.annual)}*/rok | Bez přiznání!\n\n`,
    taxProfit:      (income, expenses, levies, profit) =>
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Příjmy: ${czk(income)}\n` +
      `🧾 Výdaje: −${czk(expenses)}\n` +
      `📋 Odvody: −${czk(levies)}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💵 *Čistý zisk: ${czk(profit)}*\n\n`,
    taxBetter:      '✅ Lepší!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Lepší: ${method}*\n💡 Rozdíl: *${czk(savings)}* / rok\n\n`,
    taxFlat1:       'Paušální daň',
    taxPausal1:     'Paušální výdaje 60 %',
    taxActual1:     'Skutečné výdaje',
    taxWarning:     '⚠️ Odhad. Poraď se s účetní/m.',
    vedlejsiInfo:   (base, limit, paysSocial) => paysSocial
      ? `📋 Základ daně: *${czk(base)}* > rozhodná částka ${czk(limit)}\n→ Sociální pojištění se *platí*\n\n`
      : `📋 Základ daně: *${czk(base)}* < rozhodná částka ${czk(limit)}\n→ Sociální pojištění: *0 Kč* ✅\n\n`,
    switchYear:     (y) => `📅 → ${y}`,

    addAnother:     (type) => type === 'income' ? '💰 Další příjem' : type === 'expense' ? '🧾 Další výdaj' : '🚗 Další km',

    months: ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
    langChanged: '🇨🇿 Jazyk: čeština',
    resetConfirm:  '⚠️ *Opravdu smazat VŠECHNA data?*\nPříjmy, výdaje, kilometry — vše bude nenávratně odstraněno.',
    resetDone:     (n) => `🗑️ Hotovo — smazáno *${n}* záznamů.\nMůžeš začít znovu.`,
    resetEmpty:    '📭 Žádná data k smazání.',
    resetCancelled:'✅ Zrušeno, data zůstávají.',
    resetYes:      '🗑️ Ano, smazat vše',
    resetNo:       '↩️ Ne, ponechat',
    actHlavni:     'Hlavní činnost',
    actVedlejsi:   'Vedlejší činnost',
    actSwitchToVedlejsi: '⚙️ Činnost: Hlavní → Přepnout na vedlejší',
    actSwitchToHlavni:   '⚙️ Činnost: Vedlejší → Přepnout na hlavní',
    actChanged:    (act) => act === 'vedlejsi'
      ? '✅ Nastaveno: *vedlejší činnost*\nSociální pojištění se platí jen při zisku nad rozhodnou částku. Zdravotní z reálných příjmů.'
      : '✅ Nastaveno: *hlavní činnost*\nMinimální odvody se platí i při nulovém příjmu.',
    actNote:       (act) => act === 'vedlejsi' ? '_(vedlejší činnost)_' : '_(hlavní činnost)_',
    helpText:
      `❓ *Jak mě používat*\n\n` +
      `*Rychlý vstup (napiš zprávu):*\n` +
      `💰 \`25000 faktura Novák\` → příjem\n` +
      `🧾 \`vydaj 4900 notebook\` → výdaj\n` +
      `🚗 \`150km Brno\` → kilometry\n\n` +
      `*S datem:*\n` +
      `\`25000 faktura 15.11.2025\`\n` +
      `\`vydaj 800 benzin nov 2025\`\n` +
      `\`150km Brno 3/2025\`\n\n` +
      `*Nebo použij tlačítka* — povedou tě krok za krokem s kalendářem pro výběr data.\n\n` +
      `*Příkazy:*\n/start — hlavní menu\n/prehled — přehled\n/dane — daně\n/reset — smazat všechna data`,
  },

  en: {
    welcome: (name) =>
      `👋 Hi ${name}! I'm your *Czech tax assistant* 🇨🇿\n\n` +
      `Type naturally or use the buttons below.\n\n` +
      `*Examples:*\n` +
      `💰 \`25000 invoice Novák\`\n` +
      `🧾 \`expense 4900 laptop\`\n` +
      `🚗 \`150km Brno\`\n\n` +
      `📅 *With date:* \`25000 invoice 15.11.2025\`\n` +
      `Or pick a date from the calendar via buttons.`,
    menu: {
      income:   '💰 Add income',
      expense:  '🧾 Add expense',
      km:       '🚗 Mileage',
      summary:  '📊 Summary',
      tax:      '🧮 Calculate taxes',
      entries:  '📋 Recent entries',
      help:     '❓ Help',
      lang:     '🇨🇿 Čeština',
    },

    wizAmount:      (type) => type === 'income'
      ? '💰 *How much?*\nEnter amount (and optional description):\n\n`25000`\n`25000 invoice Novák`'
      : type === 'expense'
      ? '🧾 *How much?*\nEnter amount (and optional description):\n\n`4900`\n`4900 laptop`'
      : '🚗 *How many km and where?*\n\n`150 Brno`\n`150km meeting Prague`',
    wizPickDate:    '📅 *Pick a month and day:*',
    wizConfirm:     (type, amount, desc, dateStr) => {
      const icon = type === 'income' ? '💰' : type === 'expense' ? '🧾' : '🚗';
      const label = type === 'income' ? 'Income' : type === 'expense' ? 'Expense' : 'Mileage';
      const amountStr = type === 'km' ? `${amount} km` : czk(amount);
      return `${icon} *Confirm entry:*\n\n` +
        `• Type: *${label}*\n` +
        `• Amount: *${amountStr}*\n` +
        (desc ? `• Description: ${desc}\n` : '') +
        `• Date: *${dateStr}*\n\n` +
        `Is this correct?`;
    },
    wizSaved:       '✅ Saved!',
    wizCancelled:   '❌ Cancelled.',

    incomeSaved:    (amount, desc, dl) => `💰 Income: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    expenseSaved:   (amount, desc, dl) => `🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    kmSaved:        (km, purpose, dl) => `✅ *${km} km* logged${purpose ? ` — ${purpose}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'income',
    expenseDefault: 'expense',
    kmDefault:      'business trip',
    expenseError:   '❌ Try: `expense 3500 phone` or use the 🧾 button',
    kmError:        '❌ Couldn\'t parse km. Try:\n`150km Brno` or `150 km meeting Prague`',

    wasExpense:     '↩️ Should be expense',
    wasIncome:      '↩️ Should be income',
    correctedToExp: (amount, desc) => `✅ Fixed → 🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Fixed → 💰 Income: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,

    unknown:        "🤔 I didn't get that.\n\n" +
                    "Use the menu buttons, or type:\n" +
                    "`25000 invoice client`\n" +
                    "`expense 800 gas`\n" +
                    "`150km Brno`",

    entriesTitle:   '📋 *Recent entries:*\n',
    entriesEmpty:   '📭 No entries yet.\nAdd your first via the menu!',
    entryIncome:    (e) => `💰 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryExpense:   (e) => `🧾 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryKm:        (e) => `🚗 ${e.km} km — ${e.purpose} (${fmtDate(e.date)})`,
    deleteConfirm:  '🗑️ Deleted.',
    deleteBtn:      '🗑️',
    moreEntries:    '📋 More',
    backToMenu:     '↩️ Menu',

    pickYear:       '📅 Pick a year:',
    summaryTitle:   (year) => `📊 *Summary ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Income: *${czk(total)}* (${count} invoices)\n`,
    summaryExpenses:(total) => `🧾 Expenses: *${czk(total)}*\n`,
    summaryNet:     (net) => net >= 0
      ? `📈 Profit: *${czk(net)}*\n\n`
      : `📉 Loss: *${czk(net)}*\n\n`,
    summaryTaxHdr:  '🧮 *Estimated tax & insurance:*\n',
    summaryTax:     (tax) => `• Income tax: ${czk(tax.tax)}\n• Social: ${czk(tax.social)}\n• Health: ${czk(tax.health)}\n• *Total: ${czk(tax.total)}*`,
    compareMethods: '🧮 Compare methods',

    noIncome:       (year) => `📭 No income in ${year}.\nAdd via menu or type: \`25000 invoice\``,
    taxTitle:       (year) => `🧮 *Tax comparison — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Annual projection (${m}-month basis): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Full-year income: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Flat-rate expenses 60 %*\n   Tax base: ${czk(pv.base)}\n   Tax & insurance: *${czk(pv.total)}*\n\n`,
    taxActual:      (av, expenses) => `2️⃣ *Actual expenses*\n   Expenses: ${czk(expenses)} (${av.expPct})\n   Tax base: ${czk(av.base)}\n   Tax & insurance: *${czk(av.total)}*\n\n`,
    taxFlat:        (pd, better) => `3️⃣ *Flat-rate tax* ${better}\n   ${czk(pd.monthly)}/mo → *${czk(pd.annual)}*/yr | No tax return!\n\n`,
    taxProfit:      (income, expenses, levies, profit) =>
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Income: ${czk(income)}\n` +
      `🧾 Expenses: −${czk(expenses)}\n` +
      `📋 Tax & insurance: −${czk(levies)}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💵 *Take-home profit: ${czk(profit)}*\n\n`,
    taxBetter:      '✅ Better!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Better for you: ${method}*\n💡 Difference: *${czk(savings)}* / year\n\n`,
    taxFlat1:       'Flat-rate tax',
    taxPausal1:     'Flat-rate expenses 60 %',
    taxActual1:     'Actual expenses',
    taxWarning:     '⚠️ Estimate only. Consult an accountant.',
    vedlejsiInfo:   (base, limit, paysSocial) => paysSocial
      ? `📋 Tax base: *${czk(base)}* > threshold ${czk(limit)}\n→ Social insurance *applies*\n\n`
      : `📋 Tax base: *${czk(base)}* < threshold ${czk(limit)}\n→ Social insurance: *0 Kč* ✅\n\n`,
    switchYear:     (y) => `📅 → ${y}`,

    addAnother:     (type) => type === 'income' ? '💰 Another income' : type === 'expense' ? '🧾 Another expense' : '🚗 Another trip',

    months: ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    langChanged: '🇬🇧 Language: English',
    resetConfirm:  '⚠️ *Delete ALL your data?*\nIncome, expenses, mileage — everything will be permanently removed.',
    resetDone:     (n) => `🗑️ Done — deleted *${n}* entries.\nYou can start fresh.`,
    resetEmpty:    '📭 No data to delete.',
    resetCancelled:'✅ Cancelled, your data is safe.',
    resetYes:      '🗑️ Yes, delete all',
    resetNo:       '↩️ No, keep it',
    actHlavni:     'Primary activity',
    actVedlejsi:   'Secondary activity',
    actSwitchToVedlejsi: '⚙️ Activity: Primary → Switch to secondary',
    actSwitchToHlavni:   '⚙️ Activity: Secondary → Switch to primary',
    actChanged:    (act) => act === 'vedlejsi'
      ? '✅ Set to: *secondary activity*\nSocial insurance only above income threshold. Health from actual income.'
      : '✅ Set to: *primary activity*\nMinimum levies apply even with zero income.',
    actNote:       (act) => act === 'vedlejsi' ? '_(secondary activity)_' : '_(primary activity)_',
    helpText:
      `❓ *How to use me*\n\n` +
      `*Quick input (just type):*\n` +
      `💰 \`25000 invoice Novák\` → income\n` +
      `🧾 \`expense 4900 laptop\` → expense\n` +
      `🚗 \`150km Brno\` → mileage\n\n` +
      `*With date:*\n` +
      `\`25000 invoice 15.11.2025\`\n` +
      `\`expense 800 gas nov 2025\`\n` +
      `\`150km Brno 3/2025\`\n\n` +
      `*Or use the buttons* — they guide you step by step with a calendar for date selection.\n\n` +
      `*Commands:*\n/start — main menu\n/prehled — summary\n/dane — taxes\n/reset — delete all data`,
  },
};

// ═══════════════════════════════════════════════════════════════
// ██  HELPERS  ██
// ═══════════════════════════════════════════════════════════════
function fmtDate(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getDate()}.${dt.getMonth() + 1}.${dt.getFullYear()}`;
}

// ═══════════════════════════════════════════════════════════════
// ██  DATABASE HELPERS  ██
// ═══════════════════════════════════════════════════════════════
async function upsertUser(tg) {
  const { rows } = await query(
    `INSERT INTO users (telegram_id, first_name, username) VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username
     RETURNING *`,
    [tg.id, tg.first_name, tg.username]
  );
  return rows[0];
}

async function addIncome(tgId, amount, desc, date = null) {
  const u = await upsertUser({ id: tgId });
  const ts = date ? (date instanceof Date ? date.toISOString() : date) : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO income (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, amount, desc, ts]
  );
  return rows[0].id;
}

async function addExpense(tgId, amount, desc, date = null) {
  const u = await upsertUser({ id: tgId });
  const ts = date ? (date instanceof Date ? date.toISOString() : date) : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO expenses (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, amount, desc, ts]
  );
  return rows[0].id;
}

async function addMileage(tgId, km, purpose, date = null) {
  const u = await upsertUser({ id: tgId });
  const ts = date ? (date instanceof Date ? date.toISOString() : date) : new Date().toISOString();
  await query(`INSERT INTO mileage_log (user_id, km, purpose, date) VALUES ($1,$2,$3,$4)`, [u.id, km, purpose, ts]);
}

async function deleteIncomeById(id)  { await query(`DELETE FROM income WHERE id=$1`, [id]); }
async function deleteExpenseById(id) { await query(`DELETE FROM expenses WHERE id=$1`, [id]); }
async function deleteMileageById(id) { await query(`DELETE FROM mileage_log WHERE id=$1`, [id]); }

async function deleteAllUserData(tgId) {
  const { rows } = await query(`SELECT id FROM users WHERE telegram_id=$1`, [tgId]);
  if (rows.length === 0) return 0;
  const userId = rows[0].id;
  const r1 = await query(`DELETE FROM income WHERE user_id=$1`, [userId]);
  const r2 = await query(`DELETE FROM expenses WHERE user_id=$1`, [userId]);
  const r3 = await query(`DELETE FROM mileage_log WHERE user_id=$1`, [userId]);
  return (r1.rowCount || 0) + (r2.rowCount || 0) + (r3.rowCount || 0);
}

async function getRecentEntries(tgId, limit = 10, offset = 0) {
  const { rows } = await query(
    `(SELECT 'income' AS type, i.id, i.amount, i.description, NULL AS km, NULL AS purpose, i.date
      FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1)
     UNION ALL
     (SELECT 'expense' AS type, e.id, e.amount, e.description, NULL AS km, NULL AS purpose, e.date
      FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1)
     UNION ALL
     (SELECT 'km' AS type, m.id, NULL AS amount, NULL AS description, m.km, m.purpose, m.date
      FROM mileage_log m JOIN users u ON u.id=m.user_id WHERE u.telegram_id=$1)
     ORDER BY date DESC
     LIMIT $2 OFFSET $3`,
    [tgId, limit, offset]
  );
  return rows;
}

async function getSummary(tgId, year) {
  const { rows: inc } = await query(
    `SELECT COALESCE(SUM(i.amount),0) AS total, COUNT(*) AS cnt FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2`,
    [tgId, year]
  );
  const { rows: exp } = await query(
    `SELECT COALESCE(SUM(e.amount),0) AS total FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1 AND e.year=$2`,
    [tgId, year]
  );
  const { rows: monthlyInc } = await query(
    `SELECT month, COALESCE(SUM(amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2 GROUP BY month ORDER BY month`,
    [tgId, year]
  );
  const { rows: monthlyExp } = await query(
    `SELECT month, COALESCE(SUM(amount),0) AS total FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1 AND e.year=$2 GROUP BY month ORDER BY month`,
    [tgId, year]
  );
  return {
    income: parseFloat(inc[0].total), count: parseInt(inc[0].cnt),
    expenses: parseFloat(exp[0].total),
    monthlyInc, monthlyExp,
  };
}

// ═══════════════════════════════════════════════════════════════
// ██  BOT SETUP  ██
// ═══════════════════════════════════════════════════════════════
const bot = new Bot(process.env.BOT_TOKEN);
const THIS_YEAR = new Date().getFullYear();

bot.use(session({
  initial: () => ({
    lang: 'cs',
    year: THIS_YEAR,
    lastEntry: null,
    activity: 'hlavni', // 'hlavni' or 'vedlejsi'
    // Wizard state
    wizard: null, // { step: 'amount'|'date'|'confirm', type: 'income'|'expense'|'km', amount, desc, date, calYear, calMonth }
  }),
}));

const getLang = (ctx) => ctx.session?.lang || 'cs';
const getYear = (ctx) => ctx.session?.year || THIS_YEAR;
const getActivity = (ctx) => ctx.session?.activity || 'hlavni';

// ═══════════════════════════════════════════════════════════════
// ██  KEYBOARDS  ██
// ═══════════════════════════════════════════════════════════════
const mainMenu = (lang, activity = 'hlavni') => {
  const m = T[lang].menu;
  // Show what tapping SWITCHES TO, not current state
  const actLabel = activity === 'hlavni'
    ? T[lang].actSwitchToVedlejsi   // currently hlavní → button says "switch to vedlejší"
    : T[lang].actSwitchToHlavni;    // currently vedlejší → button says "switch to hlavní"
  return new InlineKeyboard()
    .text(m.income,  'add_income').text(m.expense, 'add_expense').row()
    .text(m.km,      'add_km').row()
    .text(m.summary, 'summary').text(m.tax, 'calc_tax').row()
    .text(m.entries, 'entries').row()
    .text(actLabel, 'toggle_activity').row()
    .text(m.help,    'help').text(m.lang, 'toggle_lang').row();
};

const yearPicker = (action) =>
  new InlineKeyboard()
    .text('📅 2024', `${action}_2024`)
    .text('📅 2025', `${action}_2025`)
    .text('📅 2026', `${action}_2026`);

const confirmKeyboard = (lang) =>
  new InlineKeyboard()
    .text(lang === 'cs' ? '✅ Uložit' : '✅ Save', 'wiz_save')
    .text(lang === 'cs' ? '📅 Změnit datum' : '📅 Change date', 'wiz_redate')
    .row()
    .text(lang === 'cs' ? '❌ Zrušit' : '❌ Cancel', 'wiz_cancel');

const incomeKeyboard  = (lang) => new InlineKeyboard()
  .text(T[lang].wasExpense, 'fix_to_expense')
  .text(T[lang].addAnother('income'), 'add_income');
const expenseKeyboard = (lang) => new InlineKeyboard()
  .text(T[lang].wasIncome, 'fix_to_income')
  .text(T[lang].addAnother('expense'), 'add_expense');

function afterSaveKeyboard(lang, type) {
  const t = T[lang];
  return new InlineKeyboard()
    .text(t.addAnother(type), `add_${type}`)
    .text(t.backToMenu, 'back_menu');
}

// ═══════════════════════════════════════════════════════════════
// ██  COMMANDS  ██
// ═══════════════════════════════════════════════════════════════
bot.command('start', async ctx => {
  await upsertUser(ctx.from);
  ctx.session.wizard = null;
  const lang = getLang(ctx);
  await ctx.reply(T[lang].welcome(ctx.from.first_name), { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
});

bot.command('prehled', ctx => askYear(ctx, 'sum'));
bot.command('dane',    ctx => askYear(ctx, 'tax'));
bot.command('help',    showHelp);
bot.command('reset',   async ctx => {
  const lang = getLang(ctx);
  const t = T[lang];
  const kb = new InlineKeyboard()
    .text(t.resetYes, 'reset_yes')
    .text(t.resetNo,  'reset_no');
  await ctx.reply(t.resetConfirm, { parse_mode: 'Markdown', reply_markup: kb });
});
bot.command('menu',    async ctx => {
  ctx.session.wizard = null;
  await ctx.reply('📋', { reply_markup: mainMenu(getLang(ctx), getActivity(ctx)) });
});

async function askYear(ctx, action) {
  const lang = getLang(ctx);
  await ctx.reply(T[lang].pickYear, { reply_markup: yearPicker(action) });
}

// ═══════════════════════════════════════════════════════════════
// ██  CALLBACK QUERIES  ██
// ═══════════════════════════════════════════════════════════════

// ── Menu actions ──
bot.callbackQuery('back_menu', async ctx => {
  await ctx.answerCallbackQuery();
  ctx.session.wizard = null;
  await ctx.reply('📋', { reply_markup: mainMenu(getLang(ctx), getActivity(ctx)) });
});

bot.callbackQuery('summary', ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'sum'); });
bot.callbackQuery('calc_tax', ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'tax'); });
bot.callbackQuery('help', ctx => { ctx.answerCallbackQuery(); showHelp(ctx); });

// ── Year pickers ──
for (const y of [2024, 2025, 2026]) {
  bot.callbackQuery(`sum_${y}`, async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = y; await showSummary(ctx); });
  bot.callbackQuery(`tax_${y}`, async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = y; await showTax(ctx); });
}

// ── Language toggle ──
bot.callbackQuery('toggle_lang', async ctx => {
  await ctx.answerCallbackQuery();
  const next = getLang(ctx) === 'cs' ? 'en' : 'cs';
  ctx.session.lang = next;
  await ctx.reply(T[next].langChanged, { reply_markup: mainMenu(next, getActivity(ctx)) });
});

// ── Activity toggle (hlavní ↔ vedlejší) ──
bot.callbackQuery('toggle_activity', async ctx => {
  await ctx.answerCallbackQuery();
  const next = getActivity(ctx) === 'hlavni' ? 'vedlejsi' : 'hlavni';
  ctx.session.activity = next;
  const lang = getLang(ctx);
  await ctx.reply(T[lang].actChanged(next), { parse_mode: 'Markdown', reply_markup: mainMenu(lang, next) });
});

// ── Reset data ──
bot.callbackQuery('reset_yes', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  const t = T[lang];
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  try {
    const count = await deleteAllUserData(ctx.from.id);
    if (count > 0) {
      await ctx.reply(t.resetDone(count), { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
    } else {
      await ctx.reply(t.resetEmpty, { reply_markup: mainMenu(lang, getActivity(ctx)) });
    }
  } catch (err) {
    console.error('Reset error:', err);
    await ctx.reply('❌ Error resetting data.');
  }
});

bot.callbackQuery('reset_no', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  await ctx.reply(T[lang].resetCancelled, { reply_markup: mainMenu(lang, getActivity(ctx)) });
});

// ── Wizard: start flows ──
bot.callbackQuery('add_income', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  ctx.session.wizard = { step: 'amount', type: 'income' };
  await ctx.reply(T[lang].wizAmount('income'), { parse_mode: 'Markdown' });
});

bot.callbackQuery('add_expense', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  ctx.session.wizard = { step: 'amount', type: 'expense' };
  await ctx.reply(T[lang].wizAmount('expense'), { parse_mode: 'Markdown' });
});

bot.callbackQuery('add_km', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  ctx.session.wizard = { step: 'amount', type: 'km' };
  await ctx.reply(T[lang].wizAmount('km'), { parse_mode: 'Markdown' });
});

// ── Wizard: calendar navigation ──
bot.callbackQuery(/^cal_nav_/, async ctx => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split('_');
  let year = parseInt(parts[2]);
  let month = parseInt(parts[3]);

  // Handle month overflow
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }

  // Clamp year
  if (year < 2020) year = 2020;
  if (year > 2030) year = 2030;

  if (ctx.session.wizard) {
    ctx.session.wizard.calYear = year;
    ctx.session.wizard.calMonth = month;
  }

  const lang = getLang(ctx);
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildCalendar(year, month, lang) });
  } catch (e) {
    // If editing fails (message too old), send new calendar
    await ctx.reply(T[lang].wizPickDate, { parse_mode: 'Markdown', reply_markup: buildCalendar(year, month, lang) });
  }
});

// ── Wizard: day selected ──
bot.callbackQuery(/^cal_day_/, async ctx => {
  await ctx.answerCallbackQuery();
  const dateStr = ctx.callbackQuery.data.replace('cal_day_', '');
  const year = parseInt(dateStr.slice(0, 4));
  const month = parseInt(dateStr.slice(4, 6));
  const day = parseInt(dateStr.slice(6, 8));

  const wiz = ctx.session.wizard;
  if (!wiz) return;

  wiz.date = new Date(year, month - 1, day);
  wiz.step = 'confirm';

  const lang = getLang(ctx);
  const dateLabel = `${day}.${month}.${year}`;

  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

  await ctx.reply(
    T[lang].wizConfirm(wiz.type, wiz.amount, wiz.desc, dateLabel),
    { parse_mode: 'Markdown', reply_markup: confirmKeyboard(lang) }
  );
});

// ── Wizard: today shortcut ──
bot.callbackQuery('cal_today', async ctx => {
  await ctx.answerCallbackQuery();
  const wiz = ctx.session.wizard;
  if (!wiz) return;

  const now = new Date();
  wiz.date = now;
  wiz.step = 'confirm';

  const lang = getLang(ctx);
  const dateLabel = fmtDate(now);

  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

  await ctx.reply(
    T[lang].wizConfirm(wiz.type, wiz.amount, wiz.desc, dateLabel),
    { parse_mode: 'Markdown', reply_markup: confirmKeyboard(lang) }
  );
});

// ── Wizard: noop (calendar headers, empty cells) ──
bot.callbackQuery('cal_noop', ctx => ctx.answerCallbackQuery());

// ── Wizard: month picker (tap month name in calendar header) ──
bot.callbackQuery(/^cal_months_/, async ctx => {
  await ctx.answerCallbackQuery();
  const year = parseInt(ctx.callbackQuery.data.split('_')[2]);
  const lang = getLang(ctx);
  if (ctx.session.wizard) ctx.session.wizard.calYear = year;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildMonthPicker(year, lang) });
  } catch (e) {
    await ctx.reply(lang === 'cs' ? '📅 Vyber měsíc:' : '📅 Pick a month:', { reply_markup: buildMonthPicker(year, lang) });
  }
});

// ── Wizard: navigate year within month picker ──
bot.callbackQuery(/^cal_monthpick_/, async ctx => {
  await ctx.answerCallbackQuery();
  let year = parseInt(ctx.callbackQuery.data.split('_')[2]);
  if (year < 2020) year = 2020;
  if (year > 2030) year = 2030;
  const lang = getLang(ctx);
  if (ctx.session.wizard) ctx.session.wizard.calYear = year;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildMonthPicker(year, lang) });
  } catch (e) {}
});

// ── Wizard: year picker (tap year in calendar header) ──
bot.callbackQuery(/^cal_years_/, async ctx => {
  await ctx.answerCallbackQuery();
  const month = parseInt(ctx.callbackQuery.data.split('_')[2]);
  const lang = getLang(ctx);
  if (ctx.session.wizard) ctx.session.wizard.calMonth = month;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildYearPicker(month, lang) });
  } catch (e) {
    await ctx.reply(lang === 'cs' ? '📅 Vyber rok:' : '📅 Pick a year:', { reply_markup: buildYearPicker(month, lang) });
  }
});

// ── Wizard: jump to specific month/year (from month or year picker) ──
bot.callbackQuery(/^cal_set_/, async ctx => {
  await ctx.answerCallbackQuery();
  const parts = ctx.callbackQuery.data.split('_');
  let year = parseInt(parts[2]);
  let month = parseInt(parts[3]);
  if (year < 2020) year = 2020;
  if (year > 2030) year = 2030;
  if (month < 1) month = 1;
  if (month > 12) month = 12;

  const lang = getLang(ctx);
  if (ctx.session.wizard) {
    ctx.session.wizard.calYear = year;
    ctx.session.wizard.calMonth = month;
  }
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: buildCalendar(year, month, lang) });
  } catch (e) {
    await ctx.reply(T[lang].wizPickDate, { parse_mode: 'Markdown', reply_markup: buildCalendar(year, month, lang) });
  }
});

// ── Wizard: save ──
bot.callbackQuery('wiz_save', async ctx => {
  await ctx.answerCallbackQuery();
  const wiz = ctx.session.wizard;
  if (!wiz || wiz.step !== 'confirm') return;

  const lang = getLang(ctx);

  try {
    if (wiz.type === 'income') {
      await addIncome(ctx.from.id, wiz.amount, wiz.desc || T[lang].incomeDefault, wiz.date);
    } else if (wiz.type === 'expense') {
      await addExpense(ctx.from.id, wiz.amount, wiz.desc || T[lang].expenseDefault, wiz.date);
    } else if (wiz.type === 'km') {
      await addMileage(ctx.from.id, wiz.amount, wiz.desc || T[lang].kmDefault, wiz.date);
    }

    const savedType = wiz.type;
    ctx.session.wizard = null;

    try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

    await ctx.reply(T[lang].wizSaved, { reply_markup: afterSaveKeyboard(lang, savedType) });
  } catch (err) {
    console.error('Save error:', err);
    await ctx.reply('❌ Error saving. Please try again.');
  }
});

// ── Wizard: go back to date picker ──
bot.callbackQuery('wiz_redate', async ctx => {
  await ctx.answerCallbackQuery();
  const wiz = ctx.session.wizard;
  if (!wiz) return;

  wiz.step = 'date';
  const lang = getLang(ctx);
  const now = new Date();
  const calYear = wiz.calYear || now.getFullYear();

  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

  await ctx.reply(T[lang].wizPickDate, {
    parse_mode: 'Markdown',
    reply_markup: buildMonthPicker(calYear, lang),
  });
});

// ── Wizard: cancel ──
bot.callbackQuery('wiz_cancel', async ctx => {
  await ctx.answerCallbackQuery();
  ctx.session.wizard = null;
  const lang = getLang(ctx);

  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

  await ctx.reply(T[lang].wizCancelled, { reply_markup: mainMenu(lang, getActivity(ctx)) });
});

// ── Fix type (income ↔ expense) ──
bot.callbackQuery('fix_to_expense', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx); const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'income') return ctx.reply('❌');
  await deleteIncomeById(last.id);
  const newId = await addExpense(ctx.from.id, last.amount, last.desc, last.date);
  ctx.session.lastEntry = { ...last, type: 'expense', id: newId };
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  await ctx.reply(t.correctedToExp(last.amount, last.desc), { parse_mode: 'Markdown' });
});

bot.callbackQuery('fix_to_income', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx); const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'expense') return ctx.reply('❌');
  await deleteExpenseById(last.id);
  const newId = await addIncome(ctx.from.id, last.amount, last.desc, last.date);
  ctx.session.lastEntry = { ...last, type: 'income', id: newId };
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  await ctx.reply(t.correctedToInc(last.amount, last.desc), { parse_mode: 'Markdown' });
});

// ── Entries list ──
bot.callbackQuery('entries', async ctx => {
  await ctx.answerCallbackQuery();
  await showEntries(ctx, 0);
});

bot.callbackQuery(/^entries_page_/, async ctx => {
  await ctx.answerCallbackQuery();
  const offset = parseInt(ctx.callbackQuery.data.replace('entries_page_', ''));
  await showEntries(ctx, offset);
});

bot.callbackQuery(/^del_(income|expense|km)_(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const [, type, idStr] = ctx.callbackQuery.data.match(/^del_(income|expense|km)_(\d+)$/);
  const id = parseInt(idStr);

  try {
    if (type === 'income') await deleteIncomeById(id);
    else if (type === 'expense') await deleteExpenseById(id);
    else if (type === 'km') await deleteMileageById(id);

    const lang = getLang(ctx);
    try { await ctx.editMessageText(T[lang].deleteConfirm); } catch (e) {}
  } catch (err) {
    console.error('Delete error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════
// ██  MAIN MESSAGE HANDLER  ██
// ═══════════════════════════════════════════════════════════════
bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const lang = getLang(ctx);
  const t = T[lang];
  const wiz = ctx.session.wizard;

  // ── Wizard: awaiting amount ──
  if (wiz && wiz.step === 'amount') {
    if (wiz.type === 'km') {
      // Parse km amount + purpose (flexible: "150 Brno", "Brno 150km", "150km Brno")
      const kmExtracted = extractKmAndDesc(text);
      if (kmExtracted) {
        wiz.amount = kmExtracted.km;
        wiz.desc = kmExtracted.desc;
        wiz.step = 'date';

        const now = new Date();
        wiz.calYear = now.getFullYear();
        wiz.calMonth = now.getMonth() + 1;

        return ctx.reply(t.wizPickDate, {
          parse_mode: 'Markdown',
          reply_markup: buildMonthPicker(wiz.calYear, lang),
        });
      }
      return ctx.reply(t.wizAmount('km'), { parse_mode: 'Markdown' });
    }

    // Parse amount + optional description (flexible: number can be anywhere)
    const extracted = extractAmountAndDesc(text);
    if (extracted) {
      wiz.amount = extracted.amount;
      wiz.desc = extracted.desc;
      wiz.step = 'date';

      const now = new Date();
      wiz.calYear = now.getFullYear();
      wiz.calMonth = now.getMonth() + 1;

      return ctx.reply(t.wizPickDate, {
        parse_mode: 'Markdown',
        reply_markup: buildMonthPicker(wiz.calYear, lang),
      });
    }

    return ctx.reply(t.wizAmount(wiz.type), { parse_mode: 'Markdown' });
  }

  // ── Wizard active but in date/confirm step → cancel wizard and parse normally ──
  if (wiz && (wiz.step === 'date' || wiz.step === 'confirm')) {
    // If user types something while calendar is showing, treat it as a new natural input
    ctx.session.wizard = null;
  }

  // ── Natural text parsing (existing behavior, improved) ──
  const intent = detectIntent(text);

  if (intent.type === 'km') {
    const purpose = intent.purpose || t.kmDefault;
    if (intent.date) {
      // Date in text → save directly
      await addMileage(ctx.from.id, intent.km, purpose, intent.date);
      return ctx.reply(t.kmSaved(intent.km, purpose, intent.dateLabel), { parse_mode: 'Markdown' });
    }
    // No date → wizard for date
    const now = new Date();
    ctx.session.wizard = { step: 'date', type: 'km', amount: intent.km, desc: purpose, calYear: now.getFullYear(), calMonth: now.getMonth() + 1 };
    return ctx.reply(t.wizPickDate, { parse_mode: 'Markdown', reply_markup: buildMonthPicker(now.getFullYear(), lang) });
  }

  if (intent.type === 'km_error') {
    return ctx.reply(t.kmError, { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense_error') {
    return ctx.reply(t.expenseError, { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense') {
    const desc = intent.desc || t.expenseDefault;
    if (intent.date) {
      // Date in text → save directly
      const id = await addExpense(ctx.from.id, intent.amount, desc, intent.date);
      ctx.session.lastEntry = { type: 'expense', id, amount: intent.amount, desc, date: intent.date };
      return ctx.reply(
        t.expenseSaved(intent.amount, desc, intent.dateLabel),
        { parse_mode: 'Markdown', reply_markup: expenseKeyboard(lang) }
      );
    }
    // No date → wizard for date
    const now = new Date();
    ctx.session.wizard = { step: 'date', type: 'expense', amount: intent.amount, desc, calYear: now.getFullYear(), calMonth: now.getMonth() + 1 };
    return ctx.reply(t.wizPickDate, { parse_mode: 'Markdown', reply_markup: buildMonthPicker(now.getFullYear(), lang) });
  }

  if (intent.type === 'income') {
    const desc = intent.desc || t.incomeDefault;
    if (intent.date) {
      // Date in text → save directly
      const id = await addIncome(ctx.from.id, intent.amount, desc, intent.date);
      ctx.session.lastEntry = { type: 'income', id, amount: intent.amount, desc, date: intent.date };
      return ctx.reply(
        t.incomeSaved(intent.amount, desc, intent.dateLabel),
        { parse_mode: 'Markdown', reply_markup: incomeKeyboard(lang) }
      );
    }
    // No date → wizard for date
    const now = new Date();
    ctx.session.wizard = { step: 'date', type: 'income', amount: intent.amount, desc, calYear: now.getFullYear(), calMonth: now.getMonth() + 1 };
    return ctx.reply(t.wizPickDate, { parse_mode: 'Markdown', reply_markup: buildMonthPicker(now.getFullYear(), lang) });
  }

  // ── Unknown → show menu ──
  ctx.reply(t.unknown, { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
});

// ═══════════════════════════════════════════════════════════════
// ██  ENTRIES VIEW  ██
// ═══════════════════════════════════════════════════════════════
async function showEntries(ctx, offset = 0) {
  const lang = getLang(ctx);
  const t = T[lang];
  const entries = await getRecentEntries(ctx.from.id, 5, offset);

  if (entries.length === 0 && offset === 0) {
    return ctx.reply(t.entriesEmpty, { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }

  let text = t.entriesTitle + '\n';
  const kb = new InlineKeyboard();

  for (const e of entries) {
    if (e.type === 'income') {
      text += t.entryIncome(e) + '\n';
      kb.text(t.deleteBtn + ' ' + czk(parseFloat(e.amount)), `del_income_${e.id}`).row();
    } else if (e.type === 'expense') {
      text += t.entryExpense(e) + '\n';
      kb.text(t.deleteBtn + ' ' + czk(parseFloat(e.amount)), `del_expense_${e.id}`).row();
    } else if (e.type === 'km') {
      text += t.entryKm(e) + '\n';
      kb.text(t.deleteBtn + ' ' + parseFloat(e.km) + ' km', `del_km_${e.id}`).row();
    }
  }

  // Pagination
  const navRow = [];
  if (offset > 0) {
    kb.text('◀', `entries_page_${Math.max(0, offset - 5)}`);
  }
  if (entries.length === 5) {
    kb.text(t.moreEntries + ' ▶', `entries_page_${offset + 5}`);
  }
  kb.row();
  kb.text(t.backToMenu, 'back_menu');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

// ═══════════════════════════════════════════════════════════════
// ██  SUMMARY & TAX VIEWS  ██
// ═══════════════════════════════════════════════════════════════
async function showSummary(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const year = getYear(ctx);
  const s = await getSummary(ctx.from.id, year);

  const currentYear = new Date().getFullYear();
  const maxMonth = year < currentYear ? 12 : year === currentYear ? new Date().getMonth() + 1 : 12;

  let chart = '';
  const allInc = s.monthlyInc.map(m => parseFloat(m.total));
  const allExp = s.monthlyExp.map(m => parseFloat(m.total));
  const maxVal = Math.max(...allInc, ...allExp, 1);

  for (let m = 1; m <= maxMonth; m++) {
    const incRow = s.monthlyInc.find(r => parseInt(r.month) === m);
    const expRow = s.monthlyExp.find(r => parseInt(r.month) === m);
    const inc = incRow ? parseFloat(incRow.total) : 0;
    const exp = expRow ? parseFloat(expRow.total) : 0;
    const net = inc - exp;

    const mLabel = String(t.months[m]).padEnd(4);

    if (inc === 0 && exp === 0) {
      chart += `${mLabel} ░░░░░░░░\n`;
    } else {
      const incBars = inc > 0 ? Math.max(1, Math.round((inc / maxVal) * 7)) : 0;
      const expBars = exp > 0 ? Math.max(1, Math.round((exp / maxVal) * 7)) : 0;
      if (inc > 0) {
        chart += `${mLabel} +${'▓'.repeat(incBars)}${'░'.repeat(7 - incBars)} ${czk(inc)}\n`;
      }
      if (exp > 0) {
        // If no income line, use month label; otherwise indent
        const prefix = inc > 0 ? '     ' : mLabel + ' ';
        chart += `${prefix}-${'▒'.repeat(expBars)}${'░'.repeat(7 - expBars)} ${czk(exp)}\n`;
      }
    }
  }

  const activity = getActivity(ctx);
  const actNote = t.actNote(activity);

  // Calculate both methods, pick the best for summary display
  const pvTax = calcPausal(s.income, year, activity);
  let bestTax = pvTax;
  let bestMethodName = t.taxPausal1;
  if (s.expenses > 0) {
    const avTax = calcActual(s.income, s.expenses, year, activity);
    if (avTax.net > pvTax.net) {
      bestTax = avTax;
      bestMethodName = t.taxActual1;
    }
  }

  const kb = new InlineKeyboard()
    .text(t.compareMethods, 'calc_tax');

  // Add year switchers
  for (const y of [2024, 2025, 2026]) {
    if (y !== year) kb.text(t.switchYear(y), `sum_${y}`);
  }
  kb.row().text(t.backToMenu, 'back_menu');

  const netProfit = s.income - s.expenses;

  await ctx.reply(
    t.summaryTitle(year) + actNote + '\n' +
    t.summaryIncome(s.income, s.count) +
    t.summaryExpenses(s.expenses) +
    t.summaryNet(netProfit) +
    `\`\`\`\n${chart}\`\`\`\n` +
    (lang === 'cs' ? '▓ příjmy  ▒ výdaje\n\n' : '▓ income  ▒ expenses\n\n') +
    t.summaryTaxHdr +
    (lang === 'cs' ? `_Metoda: ${bestMethodName}_\n` : `_Method: ${bestMethodName}_\n`) +
    t.summaryTax(bestTax),
    { parse_mode: 'Markdown', reply_markup: kb }
  );
}

async function showTax(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const year = getYear(ctx);
  const currentYear = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  // ── Fetch income ──
  const { rows: incRows } = await query(
    `SELECT COALESCE(SUM(i.amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2`,
    [ctx.from.id, year]
  );
  const ytd = parseFloat(incRows[0].total);
  if (ytd === 0) return ctx.reply(t.noIncome(year), { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });

  // ── Fetch actual expenses ──
  const { rows: expRows } = await query(
    `SELECT COALESCE(SUM(e.amount),0) AS total FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1 AND e.year=$2`,
    [ctx.from.id, year]
  );
  const actualExp = parseFloat(expRows[0].total);

  const isPast = year < currentYear;
  const annualIncome = isPast ? ytd : (ytd / month) * 12;
  const annualExpenses = isPast ? actualExp : (actualExp / month) * 12;
  const annualLine = isPast ? t.taxAnnualFull(Math.round(annualIncome)) : t.taxAnnual(Math.round(annualIncome), month);

  const activity = getActivity(ctx);
  const actNote = t.actNote(activity);

  // ── Calculate all methods ──
  const pv = calcPausal(annualIncome, year, activity);
  const av = calcActual(annualIncome, annualExpenses, year, activity);
  av.expPct = annualIncome > 0 ? `${(annualExpenses / annualIncome * 100).toFixed(0)} %` : '0 %';
  const pd = activity === 'vedlejsi' ? null : calcPausalnlDan(annualIncome, year);

  // ── Build comparison text ──
  let text = t.taxTitle(year) + actNote + '\n' + annualLine;

  // Vedlejší social threshold note
  if (activity === 'vedlejsi') {
    const p = getTaxParams(year);
    text += t.vedlejsiInfo(pv.base, p.VEDLEJSI_ROZHODNA_CASTKA, pv.social > 0);
  }

  // Method 1: Flat-rate 60 %
  text += t.taxPausal(pv);

  // Method 2: Actual expenses (only show if user has tracked expenses)
  if (actualExp > 0) {
    text += t.taxActual(av, Math.round(annualExpenses));
  }

  // Method 3: Paušální daň (hlavní only)
  if (pd) {
    text += t.taxFlat(pd, '');
  }

  // ── Find the winner ──
  const methods = [
    { name: t.taxPausal1, net: pv.net, total: pv.total },
  ];
  if (actualExp > 0) {
    methods.push({ name: t.taxActual1, net: av.net, total: av.total });
  }
  if (pd) {
    methods.push({ name: t.taxFlat1, net: pd.net, total: pd.annual });
  }

  // Sort by highest net (= lowest levies = best for user)
  methods.sort((a, b) => b.net - a.net);
  const best = methods[0];
  const worst = methods[methods.length - 1];
  const savings = Math.abs(best.net - worst.net);

  if (methods.length > 1 && savings > 0) {
    text += t.taxWinner(best.name, savings);
  }

  // ── Show real profit breakdown using ACTUAL (not projected) numbers ──
  // For the best method, calculate levies on actual YTD income/expenses
  let ytdLevies;
  if (best.name === t.taxActual1 && actualExp > 0) {
    ytdLevies = calcActual(ytd, actualExp, year, activity).total;
  } else if (best.name === t.taxFlat1 && pd) {
    // Paušální daň: proportional to months elapsed
    const monthsActive = isPast ? 12 : month;
    ytdLevies = Math.round(pd.monthly * monthsActive);
  } else {
    ytdLevies = calcPausal(ytd, year, activity).total;
  }
  const ytdProfit = Math.round(ytd) - Math.round(actualExp) - ytdLevies;
  text += t.taxProfit(Math.round(ytd), Math.round(actualExp), ytdLevies, ytdProfit);

  text += t.taxWarning;

  const kb = new InlineKeyboard();
  for (const y of [2024, 2025, 2026]) {
    if (y !== year) kb.text(t.switchYear(y), `tax_${y}`);
  }
  kb.row().text(t.backToMenu, 'back_menu');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function showHelp(ctx) {
  const lang = getLang(ctx);
  await ctx.reply(T[lang].helpText, { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
}

// ═══════════════════════════════════════════════════════════════
// ██  BOOT  ██
// ═══════════════════════════════════════════════════════════════
bot.catch(err => console.error('Bot error:', err));

async function startWithRetry(retries = 5, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`🇨🇿 Daňový Pomocník v2.0 starting... (attempt ${i + 1}/${retries})`);
      // drop_pending_updates avoids processing stale messages after redeploy
      await bot.start({ drop_pending_updates: true });
      return; // success
    } catch (err) {
      if (err?.error_code === 409 && i < retries - 1) {
        // 409 = old instance still polling — wait and retry
        console.log(`⏳ Conflict (old instance still running), retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 1.5; // back off
      } else {
        throw err;
      }
    }
  }
}

startWithRetry().catch(err => {
  console.error('💀 Failed to start bot after retries:', err);
  process.exit(1);
});
