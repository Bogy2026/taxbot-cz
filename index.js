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
// FLAT-RATE EXPENSE RATES (§ 7 odst. 7 ZDP):
//   80 % — agriculture, forestry, crafts (řemeslné živnosti)
//   60 % — other trade licenses (živnosti) ← THIS BOT USES THIS RATE
//   40 % — regulated professions (e.g. lawyers, consultants, authors)
//   30 % — rental income (§ 9)
//
// ⚠️  LEGISLATIVE NOTE (Apr 2026):
//   Czech parliament (Poslanecká sněmovna) approved a reduction of the
//   2026 minimum social insurance base from 40% to 35% of avg wage
//   (min advance: 5 005 Kč instead of 5 720 Kč for hlavní).
//   Pending Senate & presidential signature. If enacted, affects hlavní
//   activity minimums only. This bot currently uses the ENACTED law
//   values (40% / 5 720 Kč). Update when amendment is signed into law.
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
  // ⚠️ 60% applies to živnosti (trade licenses) ONLY.
  // Other rates: 80% agriculture/crafts, 40% regulated professions, 30% rental.
  // This bot does NOT support other rates — users with non-živnost income
  // should consult a tax advisor.
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
// ██  INPUT VALIDATION  ██
// ═══════════════════════════════════════════════════════════════
const MAX_AMOUNT = 99_999_999;  // 99.9M CZK — sanity cap
const MAX_DESC_LENGTH = 200;    // Telegram has 4096 char message limit anyway

function sanitizeDesc(desc) {
  if (!desc) return '';
  // Truncate, strip Markdown special chars that could break formatting
  return desc
    .slice(0, MAX_DESC_LENGTH)
    .replace(/[*_`\[\]]/g, '')  // strip Markdown formatting chars
    .trim();
}

function validateAmount(amount) {
  if (typeof amount !== 'number' || isNaN(amount)) return null;
  if (amount <= 0) return null;
  if (amount > MAX_AMOUNT) return null;
  return Math.round(amount * 100) / 100; // max 2 decimal places
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

function detectIntent(text) {
  const dateParsed = parseDate(text);
  const clean = dateParsed ? dateParsed.clean : text;
  const date = dateParsed ? makeDate(dateParsed.day, dateParsed.month, dateParsed.year) : null;
  const dateLabel = dateParsed ? formatDateLabel(dateParsed) : null;
  const lower = clean.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

  // ═══ STEP 1: Detect type by keyword ANYWHERE in text ═══

  const EXP_WORDS = /\b(vydaj[e]?|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy|utraceno|utratil[a]?|naklad)\b/i;
  const INC_WORDS = /\b(income|prijem|prijmy|faktura|invoice)\b/i;

  const hasExp = EXP_WORDS.test(lower);
  const hasInc = INC_WORDS.test(lower);

  // ═══ STEP 2: Strip ALL keywords from text to isolate amount + description ═══

  function stripKeywords(txt) {
    return txt
      .replace(/\b(vydaj[e]?|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy|utraceno|utratil[a]?|naklad)\b/gi, '')
      .replace(/\b(income|prijem|prijmy|faktura|invoice)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ═══ STEP 3: Expense mode — expense keyword found anywhere ═══

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
      `Sleduj příjmy a výdaje — a já ti spočítám daně.\n\n` +
      `⚡ *Rychlý start:*\n` +
      `💰 \`25000 faktura Novák\`\n` +
      `🧾 \`vydaj 4900 notebook\`\n\n` +
      `📅 *S datem:* \`25000 faktura 15.11.2025\`\n\n` +
      `💡 _Tip: Čím víc záznamů přidáš, tím přesnější bude tvůj daňový odhad!_`,
    menu: {
      income:   '💰 Příjem',
      expense:  '🧾 Výdaj',
      summary:  '📊 Přehled',
      tax:      '🧮 Daně',
      entries:  '📝 Záznamy',
      feedback: '💬 Napsat',
      help:     '❓ Nápověda',
      lang:     '🇬🇧 English',
    },

    // ── Wizard prompts ──
    wizAmount:      (type) => type === 'income'
      ? '💰 *Kolik?*\nZadej částku (a volitelně popis):\n\n`25000`\n`25000 faktura Novák`'
      : '🧾 *Kolik?*\nZadej částku (a volitelně popis):\n\n`4900`\n`4900 notebook`',
    wizPickDate:    '📅 *Vyber měsíc a den:*',
    wizConfirm:     (type, amount, desc, dateStr) => {
      const icon = type === 'income' ? '💰' : '🧾';
      const label = type === 'income' ? 'Příjem' : 'Výdaj';
      return `${icon} *Potvrď záznam:*\n\n` +
        `• Typ: *${label}*\n` +
        `• Částka: *${czk(amount)}*\n` +
        (desc ? `• Popis: ${desc}\n` : '') +
        `• Datum: *${dateStr}*\n\n` +
        `Je to správně?`;
    },
    wizSaved:       '✅ Uloženo!',
    wizCancelled:   '❌ Zrušeno.',

    // ── Inline saves (quick text input) ──
    incomeSaved:    (amount, desc, dl) => `✅ 💰 Příjem uložen: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    expenseSaved:   (amount, desc, dl) => `✅ 🧾 Výdaj uložen: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'příjem',
    expenseDefault: 'výdaj',
    expenseError:   '❌ Zkus: `vydaj 3500 telefon` nebo použij tlačítko 🧾',

    wasExpense:     '↩️ Měl to být výdaj',
    wasIncome:      '↩️ Měl to být příjem',
    correctedToExp: (amount, desc) => `✅ Opraveno → 🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Opraveno → 💰 Příjem: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,

    unknown:        '🤔 Nerozumím.\n\n' +
                    'Použij tlačítka v menu, nebo napiš:\n' +
                    '`25000 faktura klient`\n' +
                    '`vydaj 800 benzin`',

    // ── Entries ──
    entriesTitle:   '📝 *Záznamy:*',
    entriesEmpty:   '📭 Žádné záznamy.\nPřidej první přes menu!',
    entriesFooter:  '\n_✏️ Chceš upravit? Smaž záznam (🗑️) a přidej znovu._',
    entryIncome:    (e) => `💰 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryExpense:   (e) => `🧾 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    deleteConfirm:  '🗑️ Smazáno.',
    deleteBtn:      '🗑️',
    moreEntries:    '📋 Další',
    backToMenu:     '↩️ Menu',

    // ── Summary ──
    pickYear:       '📅 Vyber rok:',
    summaryTitle:   (year) => `📊 *Přehled ${year}*\n━━━━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Příjmy: *${czk(total)}* (${count} ${count === 1 ? 'faktura' : count < 5 ? 'faktury' : 'faktur'})\n`,
    summaryExpenses:(total) => `🧾 Výdaje: *${czk(total)}*\n`,
    summaryNet:     (net) => net >= 0
      ? `📈 Hrubý zisk: *${czk(net)}*\n\n`
      : `📉 Ztráta: *${czk(net)}* 😬\n\n`,
    compareMethods: '🧮 Porovnat',

    // ── Tax ──
    noIncome:       (year) => `📭 Žádné příjmy v ${year}.\nPřidej přes menu nebo napiš: \`25000 faktura\``,
    taxTitle:       (year) => `🧮 *Porovnání daní — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Roční odhad (z ${m} měs.): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Roční příjem: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Paušální výdaje 60 %*\n   📋 Základ daně: ${czk(pv.base)}\n   🏦 Daň: ${czk(pv.tax)} | Soc: ${czk(pv.social)} | Zdrav: ${czk(pv.health)}\n   💳 Odvody: *${czk(pv.total)}* (${pv.rate} %)\n\n`,
    taxActual:      (av, expenses) => `2️⃣ *Skutečné výdaje*\n   🧾 Výdaje: ${czk(expenses)} (${av.expPct})\n   📋 Základ daně: ${czk(av.base)}\n   🏦 Daň: ${czk(av.tax)} | Soc: ${czk(av.social)} | Zdrav: ${czk(av.health)}\n   💳 Odvody: *${czk(av.total)}* (${av.rate} %)\n\n`,
    taxFlat:        (pd, better) => `3️⃣ *Paušální daň* ${better}\n   📅 ${czk(pd.monthly)}/měs → *${czk(pd.annual)}*/rok\n   ✨ Bez daňového přiznání!\n\n`,
    taxProfit:      (income, expenses, levies, profit) =>
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Příjmy: ${czk(income)}\n` +
      `🧾 Výdaje: −${czk(expenses)}\n` +
      `📋 Odvody: −${czk(levies)}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💵 *Čistý zisk: ${czk(profit)}*\n\n`,
    taxBetter:      '✅ Lepší!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Lepší: ${method}*\n💡 Rozdíl: *${czk(savings)}* / rok\n💰 To je ${czk(Math.round(savings / 12))} / měsíc navíc!\n\n`,
    taxFlat1:       'Paušální daň',
    taxPausal1:     'Paušální výdaje 60 %',
    taxActual1:     'Skutečné výdaje',
    taxWarning:     '━━━━━━━━━━━━━━━━\n' +
                    '⚠️ *Důležité upozornění*\n' +
                    '• Výpočet je *orientační* a slouží pouze k informativním účelům.\n' +
                    '• Použita sazba paušálních výdajů *60 %* (živnosti). Pro zemědělství/řemesla platí 80 %, pro regulované profese 40 %, pro pronájem 30 %.\n' +
                    '• Nenahrazuje individuální daňové poradenství.\n' +
                    '• Pro přesný výpočet se obraťte na *daňového poradce nebo účetní*.\n' +
                    '• Autor nenese odpovědnost za případné škody vzniklé použitím tohoto nástroje.\n',
    vedlejsiInfo:   (base, limit, paysSocial) => {
      const pct = Math.min(100, Math.round(base / limit * 100));
      const filled = Math.round(pct / 10);
      const barColor = paysSocial ? '🟥' : '🟩';
      const bar = barColor.repeat(filled) + '⬜'.repeat(10 - filled);
      return paysSocial
        ? `📋 Základ daně: *${czk(base)}* > limit ${czk(limit)}\n${bar} ${pct} %\n→ ⚠️ Sociální pojištění se *platí*\n\n`
        : `📋 Základ daně: *${czk(base)}* < limit ${czk(limit)}\n${bar} ${pct} %\n→ ✅ Sociální pojištění: *0 Kč*\n\n`;
    },
    switchYear:     (y) => `${y}`,

    addAnother:     (type) => type === 'income' ? '💰 Další příjem' : '🧾 Další výdaj',

    months: ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
    langChanged: '🇨🇿 Jazyk: čeština',
    resetConfirm:  '⚠️ *Opravdu smazat VŠECHNA data?*\nPříjmy, výdaje — vše bude nenávratně odstraněno.',
    resetDone:     (n) => `🗑️ Hotovo — smazáno *${n}* záznamů.\nMůžeš začít znovu.`,
    resetEmpty:    '📭 Žádná data k smazání.',
    resetCancelled:'✅ Zrušeno, data zůstávají.',
    resetYes:      '🗑️ Ano, smazat vše',
    resetNo:       '↩️ Ne, ponechat',
    actHlavni:     'Hlavní činnost',
    actVedlejsi:   'Vedlejší činnost',
    actSwitchToVedlejsi: '⚙️ → Vedlejší činnost',
    actSwitchToHlavni:   '⚙️ → Hlavní činnost',
    actChanged:    (act) => act === 'vedlejsi'
      ? '✅ Nastaveno: *vedlejší činnost*\n\n' +
        '🔹 Vedlejší = máš zaměstnání, jsi student/ka, na rodičovské nebo v důchodu\n\n' +
        'Sociální pojištění se platí jen při zisku nad rozhodnou částku. Zdravotní z reálných příjmů.'
      : '✅ Nastaveno: *hlavní činnost*\n\n' +
        '🔹 Hlavní = podnikání je tvůj jediný/hlavní zdroj příjmů\n\n' +
        'Minimální odvody se platí i při nulovém příjmu.',
    actNote:       (act) => act === 'vedlejsi' ? '_(vedlejší činnost)_' : '_(hlavní činnost)_',
    helpText:
      `❓ *Jak mě používat*\n\n` +
      `*Rychlý vstup (napiš zprávu):*\n` +
      `💰 \`25000 faktura Novák\` → příjem\n` +
      `🧾 \`vydaj 4900 notebook\` → výdaj\n\n` +
      `*S datem:*\n` +
      `\`25000 faktura 15.11.2025\`\n` +
      `\`vydaj 800 benzin nov 2025\`\n\n` +
      `*Nebo použij tlačítka* — povedou tě krok za krokem s kalendářem.\n\n` +
      `*Příkazy:*\n` +
      `/start — hlavní menu\n` +
      `/prehled — přehled\n` +
      `/dane — daně\n` +
      `/info — právní upozornění\n` +
      `/reset — smazat všechna data\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📌 *Důležité:*\n` +
      `• Výpočty používají *paušální výdaje 60 %* (živnosti).\n` +
      `• Jiné sazby: 80 % zemědělství/řemesla, 40 % regulované profese (lékaři, právníci, konzultanti, autoři), 30 % pronájem.\n` +
      `• Pokud máš jinou sazbu, poraď se s daňovým poradcem.\n` +
      `• Bot slouží jako *orientační pomůcka*, nenahrazuje odborné poradenství.`,
    feedbackPrompt: '💬 *Napsat nám*\n\nVyber typ zprávy:',
    feedbackQuestion: '❓ Dotaz / problém',
    feedbackSuggestion: '💡 Návrh / nápad',
    feedbackAsk:    '❓ *Dotaz nebo problém*\n\nPopiš svůj dotaz nebo problém — předáme ho vývojáři.',
    feedbackIdea:   '💡 *Návrh nebo nápad*\n\nCo by se dalo vylepšit? Napiš svůj nápad.',
    feedbackSent:   '✅ Odesláno! Díky za zprávu, vývojář ji obdrží.',
    feedbackEmpty:  '❌ Napiš zprávu se zpětnou vazbou.',
  },

  en: {
    welcome: (name) =>
      `👋 Hi ${name}! I'm your *Czech tax assistant* 🇨🇿\n\n` +
      `Track income & expenses — I'll calculate your taxes.\n\n` +
      `⚡ *Quick start:*\n` +
      `💰 \`25000 invoice Novák\`\n` +
      `🧾 \`expense 4900 laptop\`\n\n` +
      `📅 *With date:* \`25000 invoice 15.11.2025\`\n\n` +
      `💡 _Tip: The more entries you add, the more accurate your tax estimate!_`,
    menu: {
      income:   '💰 Income',
      expense:  '🧾 Expense',
      summary:  '📊 Summary',
      tax:      '🧮 Taxes',
      entries:  '📝 Manage',
      feedback: '💬 Contact',
      help:     '❓ Help',
      lang:     '🇨🇿 Čeština',
    },

    wizAmount:      (type) => type === 'income'
      ? '💰 *How much?*\nEnter amount (and optional description):\n\n`25000`\n`25000 invoice Novák`'
      : '🧾 *How much?*\nEnter amount (and optional description):\n\n`4900`\n`4900 laptop`',
    wizPickDate:    '📅 *Pick a month and day:*',
    wizConfirm:     (type, amount, desc, dateStr) => {
      const icon = type === 'income' ? '💰' : '🧾';
      const label = type === 'income' ? 'Income' : 'Expense';
      return `${icon} *Confirm entry:*\n\n` +
        `• Type: *${label}*\n` +
        `• Amount: *${czk(amount)}*\n` +
        (desc ? `• Description: ${desc}\n` : '') +
        `• Date: *${dateStr}*\n\n` +
        `Is this correct?`;
    },
    wizSaved:       '✅ Saved!',
    wizCancelled:   '❌ Cancelled.',

    incomeSaved:    (amount, desc, dl) => `✅ 💰 Income saved: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    expenseSaved:   (amount, desc, dl) => `✅ 🧾 Expense saved: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'income',
    expenseDefault: 'expense',
    expenseError:   '❌ Try: `expense 3500 phone` or use the 🧾 button',

    wasExpense:     '↩️ Should be expense',
    wasIncome:      '↩️ Should be income',
    correctedToExp: (amount, desc) => `✅ Fixed → 🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Fixed → 💰 Income: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,

    unknown:        "🤔 I didn't get that.\n\n" +
                    "Use the menu buttons, or type:\n" +
                    "`25000 invoice client`\n" +
                    "`expense 800 gas`",

    entriesTitle:   '📝 *Entries:*',
    entriesEmpty:   '📭 No entries yet.\nAdd your first via the menu!',
    entriesFooter:  '\n_✏️ To edit, delete (🗑️) and re-add._',
    entryIncome:    (e) => `💰 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    entryExpense:   (e) => `🧾 ${czk(e.amount)} — ${e.description} (${fmtDate(e.date)})`,
    deleteConfirm:  '🗑️ Deleted.',
    deleteBtn:      '🗑️',
    moreEntries:    '📋 More',
    backToMenu:     '↩️ Menu',

    pickYear:       '📅 Pick a year:',
    summaryTitle:   (year) => `📊 *Summary ${year}*\n━━━━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Income: *${czk(total)}* (${count} ${count === 1 ? 'invoice' : 'invoices'})\n`,
    summaryExpenses:(total) => `🧾 Expenses: *${czk(total)}*\n`,
    summaryNet:     (net) => net >= 0
      ? `📈 Gross profit: *${czk(net)}*\n\n`
      : `📉 Loss: *${czk(net)}* 😬\n\n`,
    compareMethods: '🧮 Compare',

    noIncome:       (year) => `📭 No income in ${year}.\nAdd via menu or type: \`25000 invoice\``,
    taxTitle:       (year) => `🧮 *Tax comparison — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Annual projection (${m}-month basis): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Full-year income: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Flat-rate expenses 60 %*\n   📋 Tax base: ${czk(pv.base)}\n   🏦 Tax: ${czk(pv.tax)} | Social: ${czk(pv.social)} | Health: ${czk(pv.health)}\n   💳 Total: *${czk(pv.total)}* (${pv.rate} %)\n\n`,
    taxActual:      (av, expenses) => `2️⃣ *Actual expenses*\n   🧾 Expenses: ${czk(expenses)} (${av.expPct})\n   📋 Tax base: ${czk(av.base)}\n   🏦 Tax: ${czk(av.tax)} | Social: ${czk(av.social)} | Health: ${czk(av.health)}\n   💳 Total: *${czk(av.total)}* (${av.rate} %)\n\n`,
    taxFlat:        (pd, better) => `3️⃣ *Flat-rate tax* ${better}\n   📅 ${czk(pd.monthly)}/mo → *${czk(pd.annual)}*/yr\n   ✨ No tax return needed!\n\n`,
    taxProfit:      (income, expenses, levies, profit) =>
      `━━━━━━━━━━━━━━━━\n` +
      `💰 Income: ${czk(income)}\n` +
      `🧾 Expenses: −${czk(expenses)}\n` +
      `📋 Tax & insurance: −${czk(levies)}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💵 *Take-home profit: ${czk(profit)}*\n\n`,
    taxBetter:      '✅ Better!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Better for you: ${method}*\n💡 Difference: *${czk(savings)}* / year\n💰 That's ${czk(Math.round(savings / 12))} / month extra!\n\n`,
    taxFlat1:       'Flat-rate tax',
    taxPausal1:     'Flat-rate expenses 60 %',
    taxActual1:     'Actual expenses',
    taxWarning:     '━━━━━━━━━━━━━━━━\n' +
                    '⚠️ *Important notice*\n' +
                    '• This is an *estimate* for informational purposes only.\n' +
                    '• Uses *60 % flat-rate expenses* (trade licenses/živnosti). Agriculture/crafts use 80 %, regulated professions 40 %, rental 30 %.\n' +
                    '• This does not replace individual tax advice.\n' +
                    '• For accurate calculations, consult a *tax advisor or accountant*.\n' +
                    '• The author assumes no liability for any damages arising from use of this tool.\n',
    vedlejsiInfo:   (base, limit, paysSocial) => {
      const pct = Math.min(100, Math.round(base / limit * 100));
      const filled = Math.round(pct / 10);
      const barColor = paysSocial ? '🟥' : '🟩';
      const bar = barColor.repeat(filled) + '⬜'.repeat(10 - filled);
      return paysSocial
        ? `📋 Tax base: *${czk(base)}* > threshold ${czk(limit)}\n${bar} ${pct} %\n→ ⚠️ Social insurance *applies*\n\n`
        : `📋 Tax base: *${czk(base)}* < threshold ${czk(limit)}\n${bar} ${pct} %\n→ ✅ Social insurance: *0 Kč*\n\n`;
    },
    switchYear:     (y) => `${y}`,

    addAnother:     (type) => type === 'income' ? '💰 Another income' : '🧾 Another expense',

    months: ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    langChanged: '🇬🇧 Language: English',
    resetConfirm:  '⚠️ *Delete ALL your data?*\nIncome, expenses — everything will be permanently removed.',
    resetDone:     (n) => `🗑️ Done — deleted *${n}* entries.\nYou can start fresh.`,
    resetEmpty:    '📭 No data to delete.',
    resetCancelled:'✅ Cancelled, your data is safe.',
    resetYes:      '🗑️ Yes, delete all',
    resetNo:       '↩️ No, keep it',
    actHlavni:     'Primary activity',
    actVedlejsi:   'Secondary activity',
    actSwitchToVedlejsi: '⚙️ → Secondary activity',
    actSwitchToHlavni:   '⚙️ → Primary activity',
    actChanged:    (act) => act === 'vedlejsi'
      ? '✅ Set to: *secondary activity*\n\n' +
        '🔹 Secondary = you also have a job, are a student, on parental leave, or retired\n\n' +
        'Social insurance only above income threshold. Health from actual income.'
      : '✅ Set to: *primary activity*\n\n' +
        '🔹 Primary = self-employment is your only/main income source\n\n' +
        'Minimum levies apply even with zero income.',
    actNote:       (act) => act === 'vedlejsi' ? '_(secondary activity)_' : '_(primary activity)_',
    helpText:
      `❓ *How to use me*\n\n` +
      `*Quick input (just type):*\n` +
      `💰 \`25000 invoice Novák\` → income\n` +
      `🧾 \`expense 4900 laptop\` → expense\n\n` +
      `*With date:*\n` +
      `\`25000 invoice 15.11.2025\`\n` +
      `\`expense 800 gas nov 2025\`\n\n` +
      `*Or use the buttons* — step by step with calendar.\n\n` +
      `*Commands:*\n` +
      `/start — main menu\n` +
      `/prehled — summary\n` +
      `/dane — taxes\n` +
      `/info — legal disclaimer\n` +
      `/reset — delete all data\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📌 *Important:*\n` +
      `• Calculations use *60 % flat-rate expenses* (trade licenses/živnosti).\n` +
      `• Other rates: 80 % agriculture/crafts, 40 % regulated professions (doctors, lawyers, consultants, authors), 30 % rental.\n` +
      `• If your rate is different, consult a tax advisor.\n` +
      `• This bot is an *informational tool*, not professional tax advice.`,
    feedbackPrompt: '💬 *Contact us*\n\nChoose message type:',
    feedbackQuestion: '❓ Question / issue',
    feedbackSuggestion: '💡 Suggestion / idea',
    feedbackAsk:    '❓ *Question or issue*\n\nDescribe your question or problem — we\'ll forward it to the developer.',
    feedbackIdea:   '💡 *Suggestion or idea*\n\nWhat could be improved? Share your idea.',
    feedbackSent:   '✅ Sent! Thanks for your message, the developer will receive it.',
    feedbackEmpty:  '❌ Please type a message with your feedback.',
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
// ██  GAMIFICATION  ██
// ═══════════════════════════════════════════════════════════════
const MILESTONES_CS = [
  { count: 1,   emoji: '🎉', msg: 'První záznam! Dobrý start!' },
  { count: 5,   emoji: '⭐', msg: '5 záznamů! Jsi na dobré cestě.' },
  { count: 10,  emoji: '🔥', msg: '10 záznamů! Skvělá práce!' },
  { count: 25,  emoji: '💎', msg: '25 záznamů! Máš přehled jako profík!' },
  { count: 50,  emoji: '🏆', msg: '50 záznamů! Účetní by záviděla!' },
  { count: 100, emoji: '👑', msg: '100 záznamů! Jsi daňový/á šampion/ka!' },
];

const MILESTONES_EN = [
  { count: 1,   emoji: '🎉', msg: 'First entry! Great start!' },
  { count: 5,   emoji: '⭐', msg: '5 entries! You\'re on track.' },
  { count: 10,  emoji: '🔥', msg: '10 entries! Awesome work!' },
  { count: 25,  emoji: '💎', msg: '25 entries! Pro-level tracking!' },
  { count: 50,  emoji: '🏆', msg: '50 entries! Your accountant would be proud!' },
  { count: 100, emoji: '👑', msg: '100 entries! Tax tracking champion!' },
];

async function getMilestone(tgId, lang) {
  const { rows } = await query(
    `SELECT (
      (SELECT COUNT(*) FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1) +
      (SELECT COUNT(*) FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1)
    ) AS total`,
    [tgId]
  );
  const total = parseInt(rows[0].total);
  const milestones = lang === 'cs' ? MILESTONES_CS : MILESTONES_EN;
  const hit = milestones.find(m => m.count === total);
  return hit ? `\n\n${hit.emoji} *${hit.msg}* (${total})` : '';
}

// ═══════════════════════════════════════════════════════════════
// ██  DATABASE HELPERS  ██
// ═══════════════════════════════════════════════════════════════
async function upsertUser(tg) {
  const safeName = sanitizeDesc(tg.first_name || 'User');
  const safeUsername = tg.username ? sanitizeDesc(tg.username) : null;
  const { rows } = await query(
    `INSERT INTO users (telegram_id, first_name, username) VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username
     RETURNING *`,
    [tg.id, safeName, safeUsername]
  );
  return rows[0];
}

async function addIncome(tgId, amount, desc, date = null) {
  const validAmount = validateAmount(amount);
  if (!validAmount) throw new Error('Invalid amount');
  const safeDesc = sanitizeDesc(desc);
  const u = await upsertUser({ id: tgId });
  const ts = date ? (date instanceof Date ? date.toISOString() : date) : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO income (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, validAmount, safeDesc, ts]
  );
  return rows[0].id;
}

async function addExpense(tgId, amount, desc, date = null) {
  const validAmount = validateAmount(amount);
  if (!validAmount) throw new Error('Invalid amount');
  const safeDesc = sanitizeDesc(desc);
  const u = await upsertUser({ id: tgId });
  const ts = date ? (date instanceof Date ? date.toISOString() : date) : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO expenses (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, validAmount, safeDesc, ts]
  );
  return rows[0].id;
}

async function deleteIncomeById(id, tgId)  {
  await query(
    `DELETE FROM income WHERE id=$1 AND user_id=(SELECT id FROM users WHERE telegram_id=$2)`,
    [id, tgId]
  );
}
async function deleteExpenseById(id, tgId) {
  await query(
    `DELETE FROM expenses WHERE id=$1 AND user_id=(SELECT id FROM users WHERE telegram_id=$2)`,
    [id, tgId]
  );
}

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
    `(SELECT 'income' AS type, i.id, i.amount, i.description, i.date
      FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1)
     UNION ALL
     (SELECT 'expense' AS type, e.id, e.amount, e.description, e.date
      FROM expenses e JOIN users u ON u.id=e.user_id WHERE u.telegram_id=$1)
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
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID; // Your Telegram user ID for receiving feedback
const THIS_YEAR = new Date().getFullYear();

bot.use(session({
  initial: () => ({
    lang: 'cs',
    year: THIS_YEAR,
    lastEntry: null,
    activity: 'hlavni', // 'hlavni' or 'vedlejsi'
    // Wizard state
    wizard: null, // { step: 'amount'|'date'|'confirm', type: 'income'|'expense', amount, desc, date, calYear, calMonth }
    awaitingFeedback: false,
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
    .text(m.summary, 'summary').text(m.tax, 'calc_tax').row()
    .text(m.entries, 'entries').row()
    .text(actLabel, 'toggle_activity').row()
    .text(m.help, 'help').text(m.feedback, 'feedback').row()
    .text(m.lang, 'toggle_lang').row();
};

const yearPicker = (action) =>
  new InlineKeyboard()
    .text('2024', `${action}_2024`)
    .text('2025', `${action}_2025`)
    .text('2026', `${action}_2026`);

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
  ctx.session.awaitingFeedback = false;
  const lang = getLang(ctx);
  await ctx.reply(T[lang].welcome(sanitizeDesc(ctx.from.first_name || 'User')), { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
});

bot.command('prehled', ctx => askYear(ctx, 'sum'));
bot.command('dane',    ctx => askYear(ctx, 'tax'));
bot.command('help',    showHelp);
bot.command('info',    async ctx => {
  const lang = getLang(ctx);
  const disclaimer = lang === 'cs'
    ? `⚖️ *Právní upozornění*\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `📋 *Účel:* Tento bot je *informativní nástroj* pro orientační výpočet daní a odvodů OSVČ v České republice.\n\n` +
      `🏦 *Sazba paušálních výdajů:*\n` +
      `Bot používá sazbu *60 %* (volné a vázané živnosti).\n` +
      `Jiné sazby dle § 7 odst. 7 ZDP:\n` +
      `• 🌾 *80 %* — zemědělství, lesnictví, řemeslné živnosti\n` +
      `• 📐 *40 %* — regulované profese (lékaři, právníci, daňoví poradci, architekti, autoři, konzultanti)\n` +
      `• 🏠 *30 %* — příjmy z pronájmu (§ 9)\n\n` +
      `⚠️ *Omezení odpovědnosti:*\n` +
      `• Výpočty jsou *orientační* a mohou se lišit od skutečné daňové povinnosti.\n` +
      `• Bot nezohledňuje všechny slevy na dani, nezdanitelné části základu daně, ani specifické situace (kombinace hlavní/vedlejší činnosti v jednom roce, přerušení živnosti apod.).\n` +
      `• Autor *nenese žádnou odpovědnost* za škody vzniklé použitím tohoto nástroje.\n` +
      `• Pro závazný výpočet se obraťte na *kvalifikovaného daňového poradce nebo účetní*.\n\n` +
      `📅 *Legislativa:* Údaje odpovídají zákonům platným k dubnu 2026.\n` +
      `🔄 Změny legislativy (např. novely sociálního pojištění) mohou ovlivnit přesnost výpočtů.`
    : `⚖️ *Legal Disclaimer*\n` +
      `━━━━━━━━━━━━━━━━━━━\n\n` +
      `📋 *Purpose:* This bot is an *informational tool* for estimating Czech OSVČ taxes and insurance contributions.\n\n` +
      `🏦 *Flat-rate expense rate:*\n` +
      `This bot uses *60 %* (trade licenses/živnosti).\n` +
      `Other rates per § 7(7) of the Income Tax Act:\n` +
      `• 🌾 *80 %* — agriculture, forestry, craft trades\n` +
      `• 📐 *40 %* — regulated professions (doctors, lawyers, tax advisors, architects, authors, consultants)\n` +
      `• 🏠 *30 %* — rental income (§ 9)\n\n` +
      `⚠️ *Limitation of liability:*\n` +
      `• Calculations are *estimates* and may differ from actual tax obligations.\n` +
      `• The bot does not account for all tax credits, deductions, or specific scenarios (e.g. mixed primary/secondary activity in one year, suspended trade license, etc.).\n` +
      `• The author assumes *no liability* for any damages arising from the use of this tool.\n` +
      `• For binding calculations, consult a *qualified tax advisor or accountant*.\n\n` +
      `📅 *Legislation:* Data reflects laws in effect as of April 2026.\n` +
      `🔄 Legislative changes (e.g. social insurance amendments) may affect accuracy.`;
  await ctx.reply(disclaimer, { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
});
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
  ctx.session.awaitingFeedback = false;
  await ctx.reply('📋', { reply_markup: mainMenu(getLang(ctx), getActivity(ctx)) });
});

bot.callbackQuery('summary', ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'sum'); });
bot.callbackQuery('calc_tax', ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'tax'); });
bot.callbackQuery('help', ctx => { ctx.answerCallbackQuery(); showHelp(ctx); });

// ── Feedback ──
bot.callbackQuery('feedback', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  const t = T[lang];
  ctx.session.wizard = null;
  const kb = new InlineKeyboard()
    .text(t.feedbackQuestion, 'feedback_question').row()
    .text(t.feedbackSuggestion, 'feedback_suggestion').row()
    .text(t.backToMenu, 'back_menu');
  await ctx.reply(t.feedbackPrompt, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.callbackQuery('feedback_question', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  ctx.session.awaitingFeedback = 'question';
  ctx.session.wizard = null;
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  await ctx.reply(T[lang].feedbackAsk, { parse_mode: 'Markdown' });
});

bot.callbackQuery('feedback_suggestion', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  ctx.session.awaitingFeedback = 'suggestion';
  ctx.session.wizard = null;
  try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}
  await ctx.reply(T[lang].feedbackIdea, { parse_mode: 'Markdown' });
});

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
    }

    const savedType = wiz.type;
    ctx.session.wizard = null;

    try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch (e) {}

    const milestone = await getMilestone(ctx.from.id, lang);
    await ctx.reply(T[lang].wizSaved + milestone, { parse_mode: 'Markdown', reply_markup: afterSaveKeyboard(lang, savedType) });
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
  await deleteIncomeById(last.id, ctx.from.id);
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
  await deleteExpenseById(last.id, ctx.from.id);
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
  const offset = Math.max(0, parseInt(ctx.callbackQuery.data.replace('entries_page_', '')) || 0);
  await showEntries(ctx, offset);
});

bot.callbackQuery(/^del_(income|expense)_(\d+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const [, type, idStr] = ctx.callbackQuery.data.match(/^del_(income|expense)_(\d+)$/);
  const id = parseInt(idStr);

  try {
    if (type === 'income') await deleteIncomeById(id, ctx.from.id);
    else if (type === 'expense') await deleteExpenseById(id, ctx.from.id);

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

  // ── Feedback mode: forward message to admin ──
  if (ctx.session.awaitingFeedback) {
    const feedbackType = ctx.session.awaitingFeedback; // 'question' or 'suggestion'
    ctx.session.awaitingFeedback = false;
    const typeLabel = feedbackType === 'question' ? '❓ Question/Issue' : '💡 Suggestion/Idea';
    if (ADMIN_ID) {
      try {
        const from = ctx.from;
        const header = `${typeLabel}\n` +
          `👤 ${sanitizeDesc(from.first_name || '')} (@${sanitizeDesc(from.username || 'no-username')})\n` +
          `🆔 ${from.id}\n` +
          `━━━━━━━━━━━━━━━━\n`;
        await bot.api.sendMessage(Number(ADMIN_ID), header + text);
        console.log(`📬 Feedback forwarded to admin ${ADMIN_ID} from user ${from.id}`);
      } catch (err) {
        console.error('Feedback forward error:', err);
      }
    } else {
      console.warn('⚠️ ADMIN_TELEGRAM_ID not set — feedback not forwarded');
    }
    return ctx.reply(t.feedbackSent, { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }

  const wiz = ctx.session.wizard;

  // ── Wizard: awaiting amount ──
  if (wiz && wiz.step === 'amount') {
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

  try {
    const entries = await getRecentEntries(ctx.from.id, 10, offset);

    if (entries.length === 0 && offset === 0) {
      return ctx.reply(t.entriesEmpty, { reply_markup: mainMenu(lang, getActivity(ctx)) });
    }

    let text = t.entriesTitle + '\n';
    const kb = new InlineKeyboard();
    let currentMonth = '';

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.description) e.description = sanitizeDesc(e.description);

      // Group by month header
      const dt = e.date ? new Date(e.date) : new Date();
      const monthKey = `${dt.getMonth() + 1}/${dt.getFullYear()}`;
      const monthLabel = `${MONTH_NAMES[lang][dt.getMonth() + 1]} ${dt.getFullYear()}`;
      if (monthKey !== currentMonth) {
        currentMonth = monthKey;
        text += `\n📅 *${monthLabel}*\n`;
      }

      const num = offset + i + 1;
      const day = dt.getDate();
      const icon = e.type === 'income' ? '💰' : '🧾';
      const amount = czk(parseFloat(e.amount));
      const desc = e.description ? ` ${e.description}` : '';
      text += `${num}. ${icon} ${amount} —${desc} (${day}.)\n`;
    }

    text += t.entriesFooter;

    // Compact delete buttons — fit 5 per row
    let btnCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const num = offset + i + 1;
      const delAction = e.type === 'income' ? `del_income_${e.id}` : `del_expense_${e.id}`;
      kb.text(`🗑️ ${num}`, delAction);
      btnCount++;
      if (btnCount % 5 === 0) kb.row();
    }
    if (btnCount % 5 !== 0) kb.row();

    // Pagination
    if (offset > 0) {
      kb.text('◀', `entries_page_${Math.max(0, offset - 10)}`);
    }
    if (entries.length === 10) {
      kb.text((lang === 'cs' ? 'Další' : 'More') + ' ▶', `entries_page_${offset + 10}`);
    }
    kb.row();
    kb.text(t.backToMenu, 'back_menu');

    try {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    } catch (mdErr) {
      await ctx.reply(text, { reply_markup: kb });
    }
  } catch (err) {
    console.error('Entries error:', err);
    await ctx.reply('❌ ' + (lang === 'cs' ? 'Chyba při načítání záznamů.' : 'Error loading entries.'),
      { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }
}

// ═══════════════════════════════════════════════════════════════
// ██  SUMMARY & TAX VIEWS  ██
// ═══════════════════════════════════════════════════════════════
async function showSummary(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];

  try {
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

    const mLabel = t.months[m];

    if (inc === 0 && exp === 0) {
      chart += `${mLabel}  ⬜⬜⬜⬜⬜⬜⬜\n`;
    } else {
      const incBars = inc > 0 ? Math.max(1, Math.round((inc / maxVal) * 7)) : 0;
      const expBars = exp > 0 ? Math.max(1, Math.round((exp / maxVal) * 7)) : 0;
      if (inc > 0) {
        chart += `${mLabel}  ${'🟩'.repeat(incBars)}${'⬜'.repeat(7 - incBars)} ${czk(inc)}\n`;
      }
      if (exp > 0) {
        const prefix = inc > 0 ? '        ' : mLabel + '  ';
        chart += `${prefix}${'🟥'.repeat(expBars)}${'⬜'.repeat(7 - expBars)} ${czk(exp)}\n`;
      }
    }
  }

  const activity = getActivity(ctx);
  const actNote = t.actNote(activity);

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
    chart + '\n' +
    (lang === 'cs' ? '🟩 příjmy  🟥 výdaje\n\n' : '🟩 income  🟥 expenses\n\n') +
    (lang === 'cs' ? '💡 _Klikni na „Porovnat metody" pro odhad daní a odvodů._' : '💡 _Tap "Compare methods" to see your tax estimate._'),
    { parse_mode: 'Markdown', reply_markup: kb }
  );
  } catch (err) {
    console.error('Summary error:', err);
    await ctx.reply('❌ ' + (lang === 'cs' ? 'Chyba při načítání přehledu.' : 'Error loading summary.'),
      { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }
}

async function showTax(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];

  try {
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
  } catch (err) {
    console.error('Tax calc error:', err);
    await ctx.reply('❌ ' + (lang === 'cs' ? 'Chyba při výpočtu daní.' : 'Error calculating taxes.'),
      { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }
}

async function showHelp(ctx) {
  const lang = getLang(ctx);
  try {
    await ctx.reply(T[lang].helpText, { parse_mode: 'Markdown', reply_markup: mainMenu(lang, getActivity(ctx)) });
  } catch (err) {
    await ctx.reply(T[lang].helpText, { reply_markup: mainMenu(lang, getActivity(ctx)) });
  }
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
