import 'dotenv/config';
import pg from 'pg';
import { Bot, session, InlineKeyboard } from 'grammy';

// ── Database ──────────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
});
async function query(text, params) { return pool.query(text, params); }

// ── Czech Tax Engine ──────────────────────────────────────────
const TAX = {
  INCOME_TAX_RATE: 0.15,
  HIGH_RATE: 0.23,
  HIGH_RATE_THRESHOLD: 1867728,
  PAUSALNI_VYDAJE_RATE: 0.60,
  BASIC_DEDUCTION: 30840,
  SOCIAL_RATE: 0.292,
  SOCIAL_MIN_BASE: 117048,
  HEALTH_RATE: 0.135,
  HEALTH_MIN_BASE: 268884,
  PAUSALNI_DAN: { band1: { max: 1500000, monthly: 8716 }, band2: { max: 2000000, monthly: 16745 }, band3: { max: 3000000, monthly: 27139 } }
};

function calcPausal(income) {
  const expenses = income * TAX.PAUSALNI_VYDAJE_RATE;
  const base = Math.floor(Math.max(0, income - expenses) / 100) * 100;
  let tax = base <= TAX.HIGH_RATE_THRESHOLD
    ? base * TAX.INCOME_TAX_RATE
    : TAX.HIGH_RATE_THRESHOLD * TAX.INCOME_TAX_RATE + (base - TAX.HIGH_RATE_THRESHOLD) * TAX.HIGH_RATE;
  tax = Math.max(0, tax - TAX.BASIC_DEDUCTION);
  const social = Math.max(TAX.SOCIAL_MIN_BASE, base * 0.5) * TAX.SOCIAL_RATE;
  const health = Math.max(TAX.HEALTH_MIN_BASE, base * 0.5) * TAX.HEALTH_RATE;
  const total = tax + social + health;
  return { tax: Math.round(tax), social: Math.round(social), health: Math.round(health), total: Math.round(total), net: Math.round(income - total), rate: income > 0 ? (total / income * 100).toFixed(1) : 0 };
}

function calcPausalnlDan(income) {
  const d = TAX.PAUSALNI_DAN;
  const band = income <= d.band1.max ? d.band1 : income <= d.band2.max ? d.band2 : income <= d.band3.max ? d.band3 : null;
  if (!band) return null;
  const annual = band.monthly * 12;
  return { monthly: band.monthly, annual, net: Math.round(income - annual), rate: (annual / income * 100).toFixed(1) };
}

function czk(n) { return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(n); }

// ── Date Parser ───────────────────────────────────────────────
const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  led:1, uno:2, bre:3, dub:4, kve:5, cvn:6, cvc:7, srp:8, zar:9, rij:10, lis:11, pro:12,
  leden:1, unor:2, brezen:3, duben:4, kveten:5, cerven:6,
  cervenec:7, srpen:8, zari:9, rijen:10, listopad:11, prosinec:12,
};

/*
 * parseDate(text)
 * Detects optional date anywhere in text.
 * Supported: "jan 2025", "january 2025", "1/2025", "01/2025", "2025-01", "jan25"
 * Returns { month, year, clean } or null
 */
function parseDate(text) {
  // Strip diacritics for matching Czech month names
  const stripped = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const patterns = [
    // "jan 2025" / "leden 2025" — word + 4-digit year (with space)
    /\b([a-z]+)\s+(20\d\d)\b/g,
    // "jan25" or "jan2025" — word glued to 2-or-4-digit year
    /\b([a-z]+)(20\d\d|\d{2})\b/g,
    // "2025-01" or "2025/01"
    /\b(20\d\d)[\/\-](0?[1-9]|1[0-2])\b/g,
    // "1/2025" or "01/2025"
    /\b(0?[1-9]|1[0-2])\/(20\d\d)\b/g,
  ];

  for (let pi = 0; pi < patterns.length; pi++) {
    const re = patterns[pi];
    re.lastIndex = 0;
    const m = re.exec(stripped);
    if (!m) continue;

    let month, year;

    if (pi === 0 || pi === 1) {
      // word-based month
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

    // Remove the matched portion from the ORIGINAL text (same index)
    const clean = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { month, year, clean };
  }
  return null;
}

function makeDate(month, year) { return new Date(year, month - 1, 1); }

// ── Smart Intent Parser ───────────────────────────────────────
function parseAmount(raw) {
  const s = String(raw).replace(/\s/g, '');
  return /^\d+[,.]\d{3}$/.test(s)
    ? parseFloat(s.replace(/[,.]/g, ''))
    : parseFloat(s.replace(',', '.'));
}

function detectIntent(text) {
  const dateParsed = parseDate(text);
  const clean = dateParsed ? dateParsed.clean : text;
  const date = dateParsed ? makeDate(dateParsed.month, dateParsed.year) : null;
  const dateLabel = dateParsed ? `${dateParsed.month}/${dateParsed.year}` : null;
  const lower = clean.toLowerCase().trim();

  // 1. KM
  const kmSuffix = clean.match(/^([\d][\d\s,.]*?)\s*km\b\s*(.*)/i);
  if (kmSuffix) {
    const km = parseAmount(kmSuffix[1]);
    if (!isNaN(km) && km > 0) return { type: 'km', km, purpose: kmSuffix[2].trim(), date, dateLabel };
  }
  const kmFirst = clean.match(/^km\s+([\d][\d\s,.]*)\s*(.*)/i);
  if (kmFirst) {
    const km = parseAmount(kmFirst[1]);
    if (!isNaN(km) && km > 0) return { type: 'km', km, purpose: clean.match(/^km\s+[\d][\d\s,.]*\s*(.*)/i)?.[1]?.trim() ?? '', date, dateLabel };
  }

  // 2. Expense keywords
  const expPrefixRe = /^(vydaj|vydaje|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy)\s+/i;
  const vPrefixRe = /^v\s+(\d)/i;
  if (expPrefixRe.test(lower) || vPrefixRe.test(lower)) {
    const withoutPrefix = clean.replace(expPrefixRe, '').replace(/^v\s+/i, '');
    const m = withoutPrefix.match(/^([\d][\d\s,.]*)\s*(.*)/);
    if (m) {
      const amount = parseAmount(m[1]);
      if (!isNaN(amount) && amount > 0) return { type: 'expense', amount, desc: m[2].trim(), date, dateLabel };
    }
    return { type: 'expense_error' };
  }

  // 3. Number-first = income
  const numMatch = clean.match(/^([\d][\d\s]*(?:[,.]\d+)?)\s*(.*)/);
  if (numMatch) {
    const amount = parseAmount(numMatch[1]);
    if (!isNaN(amount) && amount > 0) return { type: 'income', amount, desc: numMatch[2].trim(), date, dateLabel };
  }

  return { type: 'unknown' };
}

// ── Translations ──────────────────────────────────────────────
const T = {
  cs: {
    welcome: (name) =>
      `👋 Ahoj ${name}! Jsem tvůj daňový pomocník 🇨🇿\n\n` +
      `Prostě piš přirozeně:\n\n` +
      `💰 *Příjem:* \`25000 faktura Novák\`\n` +
      `🧾 *Výdaj:* \`vydaj 4900 notebook\` nebo \`zaplatil 800 benzin\`\n` +
      `🚗 *Kilometry:* \`150km Brno\` nebo \`km 150 Brno\`\n\n` +
      `📅 *Jiný měsíc/rok? Připiš datum na konec:*\n` +
      `\`25000 faktura Novák led 2025\`\n` +
      `\`vydaj 800 benzin 3/2025\`\n\n` +
      `Také počítám daně a porovnám paušál vs. paušální daň.`,
    menu: {
      income:   '💰 Přidat příjem',
      expense:  '🧾 Přidat výdaj',
      summary:  '📊 Přehled',
      tax:      '🧮 Spočítat daně',
      km:       '🚗 Přidat kilometry',
      help:     '❓ Nápověda',
      lang:     '🇬🇧 English',
    },
    addIncomePrompt:
      '💰 Napiš částku a popis:\n`25000 faktura Novák s.r.o.`\n`15 000 pronájem`\n\n' +
      '📅 Jiný měsíc?\n`25000 faktura Novák led 2025`\n`15000 pronájem 1/2025`',
    addExpensePrompt:
      '🧾 Začni s vydaj / zaplatil / nakoupil:\n`vydaj 4900 notebook`\n`zaplatil 800 benzin`\n\n' +
      '📅 Jiný měsíc?\n`vydaj 4900 notebook unor 2025`\n`zaplatil 800 benzin 2/2025`',
    addKmPrompt:
      '🚗 Jakýkoliv formát:\n`150km Brno`\n`km 150 schůzka Brno`\n\n' +
      '📅 Jiný měsíc?\n`150km Brno led 2025`',
    kmError:        '❌ Km jsem nenašel. Zkus:\n`150km Brno` nebo `km 150 cesta Praha`',
    kmSaved:        (km, purpose, dl) => `✅ *${km} km* zapsáno${purpose ? ` — ${purpose}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    kmDefault:      'pracovní cesta',
    expenseError:   '❌ Zkus: `vydaj 3500 telefon` nebo `zaplatil 800 benzin`',
    expenseDefault: 'výdaj',
    expenseSaved:   (amount, desc, dl) => `🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeSaved:    (amount, desc, dl) => `💰 Příjem: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'příjem',
    wasExpense:     '↩️ Byl to výdaj?',
    wasIncome:      '↩️ Byl to příjem?',
    correctedToExp: (amount, desc) => `✅ Opraveno → 🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Opraveno → 💰 Příjem: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    unknown:        '🤔 Nerozumím. Zkus:\n`25000 faktura klient`\n`vydaj 800 benzin`\n`150km Brno`\n\nS datem: `25000 faktura klient led 2025`',
    pickYear:       '📅 Vyber rok:',
    summaryTitle:   (year) => `📊 *Přehled ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Příjmy: *${czk(total)}* (${count} faktur)\n`,
    summaryExpenses:(total) => `🧾 Výdaje: *${czk(total)}*\n\n`,
    summaryTaxHdr:  '🧮 *Odhadované odvody:*\n',
    summaryTax:     (tax) => `• Daň: ${czk(tax.tax)}\n• Sociální: ${czk(tax.social)}\n• Zdravotní: ${czk(tax.health)}\n• Celkem: *${czk(tax.total)}*\n• Čistý příjem: *${czk(tax.net)}*`,
    compareMethods: '🧮 Porovnat metody',
    noIncome:       (year) => `📭 Žádné příjmy v ${year}.\nPřidej: \`25000 faktura klient led ${year}\``,
    taxTitle:       (year) => `🧮 *Porovnání daní — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Roční odhad (z ${m} měs.): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Roční příjem: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Paušální výdaje 60%*\n   Odvody: ${czk(pv.total)} | Sazba: ${pv.rate}%\n   💵 Čistý: *${czk(pv.net)}*\n\n`,
    taxFlat:        (pd, better) => `2️⃣ *Paušální daň* ${better}\n   ${czk(pd.monthly)}/měs → ${czk(pd.annual)}/rok\n   💵 Čistý: *${czk(pd.net)}* | Bez daňového přiznání!\n\n`,
    taxBetter:      '✅ Lepší!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Lepší pro tebe: ${method}*\n💡 Rozdíl: *${czk(savings)}* ročně\n\n`,
    taxFlat1:       'Paušální daň',
    taxPausal1:     'Paušální výdaje',
    taxWarning:     '⚠️ Odhad. Poraď se s účetní/m.',
    switchYear:     (y) => `📅 → ${y}`,
    helpText:
      `❓ *Jak mě používat*\n\n` +
      `*Příjem:*\n\`25000 faktura Novák\`\n\`15 000 pronájem\`\n\n` +
      `*Výdaj:*\n\`vydaj 4900 notebook\`\n\`zaplatil 800 benzin\`\n\`nakoupil 300 kancelářské potřeby\`\n\n` +
      `*Kilometry:*\n\`150km Brno\`\n\`km 150 schůzka Praha\`\n\n` +
      `*📅 Jiný měsíc/rok — připiš datum na konec:*\n` +
      `\`25000 faktura Novák led 2025\`\n` +
      `\`vydaj 800 benzin 3/2025\`\n` +
      `\`150km Brno 2025-02\`\n\n` +
      `*Příkazy:*\n/prehled — přehled\n/dane — daně\n/start — menu\n\n` +
      `📌 Tvá data jsou pouze tvoje.`,
    months: ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
    langChanged: '🇨🇿 Jazyk nastaven na češtinu.',
  },
  en: {
    welcome: (name) =>
      `👋 Hi ${name}! I'm your Czech tax assistant 🇨🇿\n\n` +
      `Just write naturally:\n\n` +
      `💰 *Income:* \`25000 invoice Novák\`\n` +
      `🧾 *Expense:* \`expense 4900 laptop\` or \`spent 800 gas\`\n` +
      `🚗 *Mileage:* \`150km Brno\` or \`km 150 Brno\`\n\n` +
      `📅 *Different month/year? Add the date at the end:*\n` +
      `\`25000 invoice Novák jan 2025\`\n` +
      `\`expense 800 gas 3/2025\`\n\n` +
      `I also calculate taxes and compare flat-rate options.`,
    menu: {
      income:   '💰 Add income',
      expense:  '🧾 Add expense',
      summary:  '📊 Summary',
      tax:      '🧮 Calculate taxes',
      km:       '🚗 Add mileage',
      help:     '❓ Help',
      lang:     '🇨🇿 Čeština',
    },
    addIncomePrompt:
      '💰 Write amount and description:\n`25000 invoice Novák s.r.o.`\n`15000 rent`\n\n' +
      '📅 Different month?\n`25000 invoice Novák jan 2025`\n`15000 rent 1/2025`',
    addExpensePrompt:
      '🧾 Start with expense / spent / paid:\n`expense 4900 laptop`\n`spent 800 gas`\n\n' +
      '📅 Different month?\n`expense 4900 laptop feb 2025`\n`spent 800 gas 2/2025`',
    addKmPrompt:
      '🚗 Any of these formats:\n`150km Brno`\n`km 150 meeting Brno`\n\n' +
      '📅 Different month?\n`150km Brno jan 2025`',
    kmError:        '❌ No km found. Try:\n`150km Brno` or `km 150 trip Prague`',
    kmSaved:        (km, purpose, dl) => `✅ *${km} km* logged${purpose ? ` — ${purpose}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    kmDefault:      'business trip',
    expenseError:   '❌ Try: `expense 3500 phone` or `spent 800 gas`',
    expenseDefault: 'expense',
    expenseSaved:   (amount, desc, dl) => `🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeSaved:    (amount, desc, dl) => `💰 Income: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}${dl ? `\n📅 ${dl}` : ''}`,
    incomeDefault:  'income',
    wasExpense:     '↩️ Was this an expense?',
    wasIncome:      '↩️ Was this income?',
    correctedToExp: (amount, desc) => `✅ Fixed → 🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc: (amount, desc) => `✅ Fixed → 💰 Income: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    unknown:        "🤔 I didn't get that. Try:\n`25000 invoice client`\n`expense 800 gas`\n`150km Brno`\n\nWith date: `25000 invoice client jan 2025`",
    pickYear:       '📅 Pick a year:',
    summaryTitle:   (year) => `📊 *Summary ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:  (total, count) => `💰 Income: *${czk(total)}* (${count} invoices)\n`,
    summaryExpenses:(total) => `🧾 Expenses: *${czk(total)}*\n\n`,
    summaryTaxHdr:  '🧮 *Estimated levies:*\n',
    summaryTax:     (tax) => `• Income tax: ${czk(tax.tax)}\n• Social: ${czk(tax.social)}\n• Health: ${czk(tax.health)}\n• Total: *${czk(tax.total)}*\n• Net income: *${czk(tax.net)}*`,
    compareMethods: '🧮 Compare methods',
    noIncome:       (year) => `📭 No income in ${year}.\nAdd: \`25000 invoice client jan ${year}\``,
    taxTitle:       (year) => `🧮 *Tax comparison — ${year}*\n`,
    taxAnnual:      (amount, m) => `📈 Annual projection (${m}-month basis): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxAnnualFull:  (amount) => `📈 Full-year income: *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:      (pv) => `1️⃣ *Flat-rate expenses 60%*\n   Levies: ${czk(pv.total)} | Rate: ${pv.rate}%\n   💵 Net: *${czk(pv.net)}*\n\n`,
    taxFlat:        (pd, better) => `2️⃣ *Flat-rate tax* ${better}\n   ${czk(pd.monthly)}/mo → ${czk(pd.annual)}/yr\n   💵 Net: *${czk(pd.net)}* | No tax return needed!\n\n`,
    taxBetter:      '✅ Better!',
    taxWinner:      (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Better for you: ${method}*\n💡 Difference: *${czk(savings)}* per year\n\n`,
    taxFlat1:       'Flat-rate tax',
    taxPausal1:     'Flat-rate expenses',
    taxWarning:     '⚠️ Estimate only. Consult an accountant.',
    switchYear:     (y) => `📅 → ${y}`,
    helpText:
      `❓ *How to use me*\n\n` +
      `*Income:*\n\`25000 invoice Novák\`\n\`15000 rent\`\n\n` +
      `*Expense:*\n\`expense 4900 laptop\`\n\`spent 800 gas\`\n\`paid 300 stationery\`\n\n` +
      `*Mileage:*\n\`150km Brno\`\n\`km 150 meeting Prague\`\n\n` +
      `*📅 Different month/year — add date at the end:*\n` +
      `\`25000 invoice Novák jan 2025\`\n` +
      `\`expense 800 gas 3/2025\`\n` +
      `\`150km Brno 2025-02\`\n\n` +
      `*Commands:*\n/prehled — summary\n/dane — taxes\n/start — menu\n\n` +
      `📌 Your data is yours only.`,
    months: ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    langChanged: '🇬🇧 Language set to English.',
  }
};

// ── Database helpers ──────────────────────────────────────────
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
  const ts = date ? date.toISOString() : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO income (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, amount, desc, ts]
  );
  return rows[0].id;
}

async function addExpense(tgId, amount, desc, date = null) {
  const u = await upsertUser({ id: tgId });
  const ts = date ? date.toISOString() : new Date().toISOString();
  const { rows } = await query(
    `INSERT INTO expenses (user_id, amount, description, date) VALUES ($1,$2,$3,$4) RETURNING id`,
    [u.id, amount, desc, ts]
  );
  return rows[0].id;
}

async function deleteIncomeById(id)  { await query(`DELETE FROM income WHERE id=$1`,   [id]); }
async function deleteExpenseById(id) { await query(`DELETE FROM expenses WHERE id=$1`, [id]); }

async function addMileage(tgId, km, purpose, date = null) {
  const u = await upsertUser({ id: tgId });
  const ts = date ? date.toISOString() : new Date().toISOString();
  await query(`INSERT INTO mileage_log (user_id, km, purpose, date) VALUES ($1,$2,$3,$4)`, [u.id, km, purpose, ts]);
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
  const { rows: monthly } = await query(
    `SELECT month, COALESCE(SUM(amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2 GROUP BY month ORDER BY month`,
    [tgId, year]
  );
  return { income: parseFloat(inc[0].total), count: parseInt(inc[0].cnt), expenses: parseFloat(exp[0].total), monthly };
}

// ── Bot setup ─────────────────────────────────────────────────
const bot = new Bot(process.env.BOT_TOKEN);
const THIS_YEAR = new Date().getFullYear();
bot.use(session({ initial: () => ({ lang: 'cs', year: THIS_YEAR, lastEntry: null }) }));

const getLang = (ctx) => ctx.session?.lang || 'cs';
const getYear = (ctx) => ctx.session?.year || THIS_YEAR;

const mainMenu = (lang) => {
  const m = T[lang].menu;
  return new InlineKeyboard()
    .text(m.income,  'add_income').row()
    .text(m.expense, 'add_expense').row()
    .text(m.summary, 'summary').row()
    .text(m.tax,     'calc_tax').row()
    .text(m.km,      'add_km').row()
    .text(m.help,    'help').row()
    .text(m.lang,    'toggle_lang');
};

const yearPicker = (action) =>
  new InlineKeyboard()
    .text('📅 2025', `${action}_2025`)
    .text('📅 2026', `${action}_2026`);

const incomeKeyboard  = (lang) => new InlineKeyboard().text(T[lang].wasExpense, 'fix_to_expense');
const expenseKeyboard = (lang) => new InlineKeyboard().text(T[lang].wasIncome,  'fix_to_income');

// ── Commands ──────────────────────────────────────────────────
bot.command('start', async ctx => {
  await upsertUser(ctx.from);
  const lang = getLang(ctx);
  await ctx.reply(T[lang].welcome(ctx.from.first_name), { parse_mode: 'Markdown', reply_markup: mainMenu(lang) });
});

bot.command('prehled', ctx => askYear(ctx, 'sum'));
bot.command('dane',    ctx => askYear(ctx, 'tax'));
bot.command('help',    showHelp);

async function askYear(ctx, action) {
  const lang = getLang(ctx);
  await ctx.reply(T[lang].pickYear, { reply_markup: yearPicker(action) });
}

// Year callbacks for summary
bot.callbackQuery('sum_2025', async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = 2025; await showSummary(ctx); });
bot.callbackQuery('sum_2026', async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = 2026; await showSummary(ctx); });
// Year callbacks for tax
bot.callbackQuery('tax_2025', async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = 2025; await showTax(ctx); });
bot.callbackQuery('tax_2026', async ctx => { await ctx.answerCallbackQuery(); ctx.session.year = 2026; await showTax(ctx); });

// ── Callback queries ──────────────────────────────────────────
bot.callbackQuery('summary',     ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'sum'); });
bot.callbackQuery('calc_tax',    ctx => { ctx.answerCallbackQuery(); askYear(ctx, 'tax'); });
bot.callbackQuery('help',        ctx => { ctx.answerCallbackQuery(); showHelp(ctx); });
bot.callbackQuery('add_income',  ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addIncomePrompt,  { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_expense', ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addExpensePrompt, { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_km',      ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addKmPrompt,      { parse_mode: 'Markdown' }); });

bot.callbackQuery('toggle_lang', async ctx => {
  await ctx.answerCallbackQuery();
  const next = getLang(ctx) === 'cs' ? 'en' : 'cs';
  ctx.session.lang = next;
  await ctx.reply(T[next].langChanged, { reply_markup: mainMenu(next) });
});

bot.callbackQuery('fix_to_expense', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx); const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'income') return ctx.reply('❌ Nothing to fix.');
  await deleteIncomeById(last.id);
  const newId = await addExpense(ctx.from.id, last.amount, last.desc, last.date);
  ctx.session.lastEntry = { ...last, type: 'expense', id: newId };
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await ctx.reply(t.correctedToExp(last.amount, last.desc), { parse_mode: 'Markdown' });
});

bot.callbackQuery('fix_to_income', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx); const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'expense') return ctx.reply('❌ Nothing to fix.');
  await deleteExpenseById(last.id);
  const newId = await addIncome(ctx.from.id, last.amount, last.desc, last.date);
  ctx.session.lastEntry = { ...last, type: 'income', id: newId };
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await ctx.reply(t.correctedToInc(last.amount, last.desc), { parse_mode: 'Markdown' });
});

// ── Main message handler ──────────────────────────────────────
bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const lang = getLang(ctx);
  const t = T[lang];
  const intent = detectIntent(text);

  if (intent.type === 'km') {
    const purpose = intent.purpose || t.kmDefault;
    await addMileage(ctx.from.id, intent.km, purpose, intent.date);
    return ctx.reply(t.kmSaved(intent.km, purpose, intent.dateLabel), { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense_error') {
    return ctx.reply(t.expenseError, { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense') {
    const desc = intent.desc || t.expenseDefault;
    const id = await addExpense(ctx.from.id, intent.amount, desc, intent.date);
    ctx.session.lastEntry = { type: 'expense', id, amount: intent.amount, desc, date: intent.date };
    return ctx.reply(
      t.expenseSaved(intent.amount, desc, intent.dateLabel),
      { parse_mode: 'Markdown', reply_markup: expenseKeyboard(lang) }
    );
  }

  if (intent.type === 'income') {
    const desc = intent.desc || t.incomeDefault;
    const id = await addIncome(ctx.from.id, intent.amount, desc, intent.date);
    ctx.session.lastEntry = { type: 'income', id, amount: intent.amount, desc, date: intent.date };
    return ctx.reply(
      t.incomeSaved(intent.amount, desc, intent.dateLabel),
      { parse_mode: 'Markdown', reply_markup: incomeKeyboard(lang) }
    );
  }

  ctx.reply(t.unknown, { parse_mode: 'Markdown' });
});

// ── Show functions ────────────────────────────────────────────
async function showSummary(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const year = getYear(ctx);
  const s = await getSummary(ctx.from.id, year);

  const currentYear = new Date().getFullYear();
  const maxMonth = year < currentYear ? 12 : new Date().getMonth() + 1;

  let chart = '';
  const max = Math.max(...s.monthly.map(m => parseFloat(m.total)), 1);
  for (let m = 1; m <= maxMonth; m++) {
    const row = s.monthly.find(r => parseInt(r.month) === m);
    const total = row ? parseFloat(row.total) : 0;
    const bars = total > 0 ? Math.max(1, Math.round((total / max) * 8)) : 0;
    chart += `${t.months[m].padEnd(4)} ${'█'.repeat(bars)}${'░'.repeat(8-bars)} ${czk(total)}\n`;
  }

  const tax = calcPausal(s.income);
  const otherYear = year === 2025 ? 2026 : 2025;
  const kb = new InlineKeyboard()
    .text(t.compareMethods, 'calc_tax')
    .text(t.switchYear(otherYear), `sum_${otherYear}`);

  await ctx.reply(
    t.summaryTitle(year) +
    t.summaryIncome(s.income, s.count) +
    t.summaryExpenses(s.expenses) +
    `\`\`\`\n${chart}\`\`\`\n` +
    t.summaryTaxHdr +
    t.summaryTax(tax),
    { parse_mode: 'Markdown', reply_markup: kb }
  );
}

async function showTax(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const year = getYear(ctx);
  const currentYear = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  const { rows } = await query(
    `SELECT COALESCE(SUM(i.amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2`,
    [ctx.from.id, year]
  );
  const ytd = parseFloat(rows[0].total);
  if (ytd === 0) return ctx.reply(t.noIncome(year), { parse_mode: 'Markdown' });

  // Past year: use actual total as full year; current year: project forward
  const isPast = year < currentYear;
  const annual = isPast ? ytd : (ytd / month) * 12;
  const annualLine = isPast ? t.taxAnnualFull(Math.round(annual)) : t.taxAnnual(Math.round(annual), month);

  const pv = calcPausal(annual);
  const pd = calcPausalnlDan(annual);

  let text = t.taxTitle(year) + annualLine + t.taxPausal(pv);
  if (pd) {
    const better = pd.net > pv.net ? t.taxBetter : '';
    text += t.taxFlat(pd, better);
    const savings = Math.abs(pd.net - pv.net);
    text += t.taxWinner(pd.net > pv.net ? t.taxFlat1 : t.taxPausal1, savings);
  }
  text += t.taxWarning;

  const otherYear = year === 2025 ? 2026 : 2025;
  const kb = new InlineKeyboard().text(t.switchYear(otherYear), `tax_${otherYear}`);

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function showHelp(ctx) {
  await ctx.reply(T[getLang(ctx)].helpText, { parse_mode: 'Markdown' });
}

bot.catch(err => console.error('Chyba:', err));
console.log('🇨🇿 TaxBot CZ spouštím...');
bot.start();
