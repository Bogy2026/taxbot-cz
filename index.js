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

// ── Czech Tax Engine 2025 ─────────────────────────────────────
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

// ── Smart Parser ──────────────────────────────────────────────
// Handles: "40000", "40 000", "40,000", "40.000" (thousands) and "40.50", "40,50" (decimals)
function parseAmount(raw) {
  const s = String(raw).replace(/\s/g, '');
  return /^\d+[,.]\d{3}$/.test(s)
    ? parseFloat(s.replace(/[,.]/g, ''))   // thousands sep → 40000
    : parseFloat(s.replace(',', '.'));      // decimal → 40.50
}

/*
 * detectIntent(text)
 * Returns one of:
 *   { type: 'km',      km, purpose }
 *   { type: 'expense', amount, desc }
 *   { type: 'income',  amount, desc }
 *   { type: 'unknown' }
 *
 * Priority: km > expense keyword > number-first (income)
 */
function detectIntent(text) {
  const lower = text.toLowerCase().trim();

  // ── 1. KM detection ─────────────────────────────────────────
  // Accepts: "150km", "150 km Brno", "km 150 Brno", "150km schůzka"
  // Number-first with km suffix (the previously broken case!)
  const kmSuffix = text.match(/^([\d][\d\s,.]*?)\s*km\b\s*(.*)/i);
  if (kmSuffix) {
    const km = parseAmount(kmSuffix[1]);
    if (!isNaN(km) && km > 0) return { type: 'km', km, purpose: kmSuffix[2].trim() };
  }
  // km-first: "km 150 Brno"
  const kmFirst = lower.match(/^km\s+([\d][\d\s,.]*)\s*(.*)/i);
  if (kmFirst) {
    const km = parseAmount(kmFirst[1]);
    if (!isNaN(km) && km > 0) return { type: 'km', km, purpose: text.match(/^km\s+[\d][\d\s,.]*\s*(.*)/i)?.[1]?.trim() ?? '' };
  }

  // ── 2. EXPENSE keywords ──────────────────────────────────────
  // Czech:   v, výdaj, vydaj, zaplatil/a, nakoupil/a
  // English: expense, exp, e, spent, paid, cost, buy, bought
  const expPrefixRe = /^(výdaj|vydaj|zaplatil[a]?|nakoupil[a]?|expense|exp|spent|paid|cost|bought|buy)\s+/i;
  // Also catch "v " (single letter) only if followed by a digit (avoids matching "v pohodě")
  const vPrefixRe = /^v\s+(\d)/i;

  if (expPrefixRe.test(lower) || vPrefixRe.test(lower)) {
    const withoutPrefix = text.replace(expPrefixRe, '').replace(/^v\s+/i, '');
    const m = withoutPrefix.match(/^([\d][\d\s,.]*)\s*(.*)/);
    if (m) {
      const amount = parseAmount(m[1]);
      const desc = m[2].trim();
      if (!isNaN(amount) && amount > 0) return { type: 'expense', amount, desc };
    }
    return { type: 'expense_error' };
  }

  // ── 3. NUMBER-FIRST = income (default) ──────────────────────
  // Handles: "25000 faktura Novák", "25,000 invoice Bol", "15 000 pronájem"
  const numMatch = text.match(/^([\d][\d\s]*(?:[,.]\d+)?)\s*(.*)/);
  if (numMatch) {
    const amount = parseAmount(numMatch[1]);
    const desc = numMatch[2].trim();
    if (!isNaN(amount) && amount > 0) return { type: 'income', amount, desc };
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
      `🧾 *Výdaj:* \`výdaj 4900 notebook\` nebo \`zaplatil 4900 notebook\`\n` +
      `🚗 *Kilometry:* \`150km Brno\` nebo \`km 150 Brno\`\n\n` +
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
    addIncomePrompt:  '💰 Napiš částku a popis:\n`25000 faktura Novák s.r.o.`\n`15 000 pronájem`',
    addExpensePrompt: '🧾 Začni s výdaj / zaplatil / nakoupil:\n`výdaj 4900 notebook`\n`zaplatil 800 benzin`',
    addKmPrompt:      '🚗 Jakýkoliv z těchto formátů:\n`150km Brno`\n`km 150 schůzka Brno`',
    kmError:          '❌ Km jsem nenašel. Zkus:\n`150km Brno` nebo `km 150 cesta Praha`',
    kmSaved:          (km, purpose) => `✅ *${km} km* zapsáno${purpose ? ` — ${purpose}` : ''}`,
    kmDefault:        'pracovní cesta',
    expenseError:     '❌ Zkus: `výdaj 3500 telefon` nebo `zaplatil 800 benzin`',
    expenseDefault:   'výdaj',
    expenseSaved:     (amount, desc) => `🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    incomeSaved:      (amount, desc) => `💰 Příjem: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}`,
    incomeDefault:    'příjem',
    wasExpense:       '↩️ Byl to výdaj?',
    wasIncome:        '↩️ Byl to příjem?',
    correctedToExp:   (amount, desc) => `✅ Opraveno → 🧾 Výdaj: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc:   (amount, desc) => `✅ Opraveno → 💰 Příjem: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    unknown:
      '🤔 Nerozumím. Zkus:\n`25000 faktura klient`\n`výdaj 800 benzin`\n`150km Brno`',
    summaryTitle:     (year) => `📊 *Přehled ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:    (total, count) => `💰 Příjmy: *${czk(total)}* (${count} faktur)\n`,
    summaryExpenses:  (total) => `🧾 Výdaje: *${czk(total)}*\n\n`,
    summaryTaxHdr:    '🧮 *Odhadované odvody:*\n',
    summaryTax:       (tax) => `• Daň: ${czk(tax.tax)}\n• Sociální: ${czk(tax.social)}\n• Zdravotní: ${czk(tax.health)}\n• Celkem: *${czk(tax.total)}*\n• Čistý příjem: *${czk(tax.net)}*`,
    compareMethods:   '🧮 Porovnat metody',
    noIncome:         '📭 Zatím žádné příjmy. Přidej: `25000 faktura klient`',
    taxTitle:         (year) => `🧮 *Porovnání daní — odhad ${year}*\n`,
    taxAnnual:        (amount, m) => `📈 Roční odhad (z ${m} měs.): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:        (pv) => `1️⃣ *Paušální výdaje 60%*\n   Odvody: ${czk(pv.total)} | Sazba: ${pv.rate}%\n   💵 Čistý: *${czk(pv.net)}*\n\n`,
    taxFlat:          (pd, better) => `2️⃣ *Paušální daň* ${better}\n   ${czk(pd.monthly)}/měs → ${czk(pd.annual)}/rok\n   💵 Čistý: *${czk(pd.net)}* | Bez daňového přiznání!\n\n`,
    taxBetter:        '✅ Lepší!',
    taxWinner:        (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Lepší pro tebe: ${method}*\n💡 Rozdíl: *${czk(savings)}* ročně\n\n`,
    taxFlat1:         'Paušální daň',
    taxPausal1:       'Paušální výdaje',
    taxWarning:       '⚠️ Odhad. Poraď se s účetní/m.',
    helpText:
      `❓ *Jak mě používat*\n\n` +
      `*Příjem* — číslo a popis:\n\`25000 faktura Novák s.r.o.\`\n\`15 000 pronájem\`\n\n` +
      `*Výdaj* — začni klíčovým slovem:\n\`výdaj 4900 notebook\`\n\`zaplatil 800 benzin\`\n\`nakoupil 300 kancelářské potřeby\`\n\n` +
      `*Kilometry* — číslo+km nebo km+číslo:\n\`150km Brno\`\n\`km 150 schůzka Praha\`\n\n` +
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
    addIncomePrompt:  '💰 Write amount and description:\n`25000 invoice Novák s.r.o.`\n`15000 rent`',
    addExpensePrompt: '🧾 Start with expense / spent / paid:\n`expense 4900 laptop`\n`spent 800 gas`',
    addKmPrompt:      '🚗 Any of these formats:\n`150km Brno`\n`km 150 meeting Brno`',
    kmError:          '❌ No km found. Try:\n`150km Brno` or `km 150 trip Prague`',
    kmSaved:          (km, purpose) => `✅ *${km} km* logged${purpose ? ` — ${purpose}` : ''}`,
    kmDefault:        'business trip',
    expenseError:     '❌ Try: `expense 3500 phone` or `spent 800 gas`',
    expenseDefault:   'expense',
    expenseSaved:     (amount, desc) => `🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    incomeSaved:      (amount, desc) => `💰 Income: *${czk(amount)}*${desc ? `\n📝 ${desc}` : ''}`,
    incomeDefault:    'income',
    wasExpense:       '↩️ Was this an expense?',
    wasIncome:        '↩️ Was this income?',
    correctedToExp:   (amount, desc) => `✅ Fixed → 🧾 Expense: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    correctedToInc:   (amount, desc) => `✅ Fixed → 💰 Income: *${czk(amount)}*${desc ? ` — ${desc}` : ''}`,
    unknown:
      "🤔 I didn't get that. Try:\n`25000 invoice client`\n`expense 800 gas`\n`150km Brno`",
    summaryTitle:     (year) => `📊 *Summary ${year}*\n━━━━━━━━━━━━━━━━\n`,
    summaryIncome:    (total, count) => `💰 Income: *${czk(total)}* (${count} invoices)\n`,
    summaryExpenses:  (total) => `🧾 Expenses: *${czk(total)}*\n\n`,
    summaryTaxHdr:    '🧮 *Estimated levies:*\n',
    summaryTax:       (tax) => `• Income tax: ${czk(tax.tax)}\n• Social: ${czk(tax.social)}\n• Health: ${czk(tax.health)}\n• Total: *${czk(tax.total)}*\n• Net income: *${czk(tax.net)}*`,
    compareMethods:   '🧮 Compare methods',
    noIncome:         '📭 No income yet. Add: `25000 invoice client`',
    taxTitle:         (year) => `🧮 *Tax comparison — estimate ${year}*\n`,
    taxAnnual:        (amount, m) => `📈 Annual projection (${m}-month basis): *${czk(amount)}*\n━━━━━━━━━━━━━━━━\n\n`,
    taxPausal:        (pv) => `1️⃣ *Flat-rate expenses 60%*\n   Levies: ${czk(pv.total)} | Rate: ${pv.rate}%\n   💵 Net: *${czk(pv.net)}*\n\n`,
    taxFlat:          (pd, better) => `2️⃣ *Flat-rate tax* ${better}\n   ${czk(pd.monthly)}/mo → ${czk(pd.annual)}/yr\n   💵 Net: *${czk(pd.net)}* | No tax return needed!\n\n`,
    taxBetter:        '✅ Better!',
    taxWinner:        (method, savings) => `━━━━━━━━━━━━━━━━\n🏆 *Better for you: ${method}*\n💡 Difference: *${czk(savings)}* per year\n\n`,
    taxFlat1:         'Flat-rate tax',
    taxPausal1:       'Flat-rate expenses',
    taxWarning:       '⚠️ Estimate only. Consult an accountant.',
    helpText:
      `❓ *How to use me*\n\n` +
      `*Income* — number and description:\n\`25000 invoice Novák s.r.o.\`\n\`15000 rent\`\n\n` +
      `*Expense* — start with a keyword:\n\`expense 4900 laptop\`\n\`spent 800 gas\`\n\`paid 300 stationery\`\n\n` +
      `*Mileage* — number+km or km+number:\n\`150km Brno\`\n\`km 150 meeting Prague\`\n\n` +
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

async function addIncome(tgId, amount, desc) {
  const u = await upsertUser({ id: tgId });
  const { rows } = await query(
    `INSERT INTO income (user_id, amount, description, date) VALUES ($1,$2,$3,NOW()) RETURNING id`,
    [u.id, amount, desc]
  );
  return rows[0].id;
}

async function addExpense(tgId, amount, desc) {
  const u = await upsertUser({ id: tgId });
  const { rows } = await query(
    `INSERT INTO expenses (user_id, amount, description, date) VALUES ($1,$2,$3,NOW()) RETURNING id`,
    [u.id, amount, desc]
  );
  return rows[0].id;
}

async function deleteIncomeById(id) {
  await query(`DELETE FROM income WHERE id=$1`, [id]);
}

async function deleteExpenseById(id) {
  await query(`DELETE FROM expenses WHERE id=$1`, [id]);
}

async function addMileage(tgId, km, purpose) {
  const u = await upsertUser({ id: tgId });
  await query(`INSERT INTO mileage_log (user_id, km, purpose, date) VALUES ($1,$2,$3,NOW())`, [u.id, km, purpose]);
}

async function getSummary(tgId) {
  const year = new Date().getFullYear();
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

// ── Bot ───────────────────────────────────────────────────────
const bot = new Bot(process.env.BOT_TOKEN);
// Session stores: lang, lastEntry { type, id, amount, desc }
bot.use(session({ initial: () => ({ lang: 'cs', lastEntry: null }) }));

const getLang = (ctx) => ctx.session?.lang || 'cs';

const mainMenu = (lang) => {
  const m = T[lang].menu;
  return new InlineKeyboard()
    .text(m.income,   'add_income').row()
    .text(m.expense,  'add_expense').row()
    .text(m.summary,  'summary').row()
    .text(m.tax,      'calc_tax').row()
    .text(m.km,       'add_km').row()
    .text(m.help,     'help').row()
    .text(m.lang,     'toggle_lang');
};

// Inline keyboard shown after saving income (quick-fix button)
const incomeKeyboard = (lang) =>
  new InlineKeyboard().text(T[lang].wasExpense, 'fix_to_expense');

// Inline keyboard shown after saving expense (quick-fix button)
const expenseKeyboard = (lang) =>
  new InlineKeyboard().text(T[lang].wasIncome, 'fix_to_income');

// ── Commands ──────────────────────────────────────────────────
bot.command('start', async ctx => {
  await upsertUser(ctx.from);
  const lang = getLang(ctx);
  await ctx.reply(T[lang].welcome(ctx.from.first_name), { parse_mode: 'Markdown', reply_markup: mainMenu(lang) });
});

bot.command('prehled', showSummary);
bot.command('dane',    showTax);
bot.command('help',    showHelp);

// ── Callback queries ──────────────────────────────────────────
bot.callbackQuery('summary',     ctx => { ctx.answerCallbackQuery(); showSummary(ctx); });
bot.callbackQuery('calc_tax',    ctx => { ctx.answerCallbackQuery(); showTax(ctx); });
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

// Quick-fix: user said "↩️ Was this an expense?" after income was saved
bot.callbackQuery('fix_to_expense', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'income') return ctx.reply('❌ Nothing to fix.');
  // Delete the income row, add expense row
  await deleteIncomeById(last.id);
  const newId = await addExpense(ctx.from.id, last.amount, last.desc);
  ctx.session.lastEntry = { type: 'expense', id: newId, amount: last.amount, desc: last.desc };
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); // remove the button
  await ctx.reply(t.correctedToExp(last.amount, last.desc), { parse_mode: 'Markdown' });
});

// Quick-fix: user said "↩️ Was this income?" after expense was saved
bot.callbackQuery('fix_to_income', async ctx => {
  await ctx.answerCallbackQuery();
  const lang = getLang(ctx);
  const t = T[lang];
  const last = ctx.session.lastEntry;
  if (!last || last.type !== 'expense') return ctx.reply('❌ Nothing to fix.');
  await deleteExpenseById(last.id);
  const newId = await addIncome(ctx.from.id, last.amount, last.desc);
  ctx.session.lastEntry = { type: 'income', id: newId, amount: last.amount, desc: last.desc };
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  await ctx.reply(t.correctedToInc(last.amount, last.desc), { parse_mode: 'Markdown' });
});

// ── Main message handler ───────────────────────────────────────
bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const lang = getLang(ctx);
  const t = T[lang];
  const intent = detectIntent(text);

  if (intent.type === 'km') {
    const purpose = intent.purpose || t.kmDefault;
    await addMileage(ctx.from.id, intent.km, purpose);
    return ctx.reply(t.kmSaved(intent.km, purpose), { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense_error') {
    return ctx.reply(t.expenseError, { parse_mode: 'Markdown' });
  }

  if (intent.type === 'expense') {
    const desc = intent.desc || t.expenseDefault;
    const id = await addExpense(ctx.from.id, intent.amount, desc);
    ctx.session.lastEntry = { type: 'expense', id, amount: intent.amount, desc };
    return ctx.reply(
      t.expenseSaved(intent.amount, desc),
      { parse_mode: 'Markdown', reply_markup: expenseKeyboard(lang) }
    );
  }

  if (intent.type === 'income') {
    const desc = intent.desc || t.incomeDefault;
    const id = await addIncome(ctx.from.id, intent.amount, desc);
    ctx.session.lastEntry = { type: 'income', id, amount: intent.amount, desc };
    return ctx.reply(
      t.incomeSaved(intent.amount, desc),
      { parse_mode: 'Markdown', reply_markup: incomeKeyboard(lang) }
    );
  }

  ctx.reply(t.unknown, { parse_mode: 'Markdown' });
});

// ── Show functions ────────────────────────────────────────────
async function showSummary(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const s = await getSummary(ctx.from.id);
  const month = new Date().getMonth() + 1;
  const year = new Date().getFullYear();
  let chart = '';
  const max = Math.max(...s.monthly.map(m => parseFloat(m.total)), 1);
  for (let m = 1; m <= month; m++) {
    const row = s.monthly.find(r => parseInt(r.month) === m);
    const total = row ? parseFloat(row.total) : 0;
    const bars = total > 0 ? Math.max(1, Math.round((total / max) * 8)) : 0;
    chart += `${t.months[m].padEnd(4)} ${'█'.repeat(bars)}${'░'.repeat(8-bars)} ${czk(total)}\n`;
  }
  const tax = calcPausal(s.income);
  await ctx.reply(
    t.summaryTitle(year) +
    t.summaryIncome(s.income, s.count) +
    t.summaryExpenses(s.expenses) +
    `\`\`\`\n${chart}\`\`\`\n` +
    t.summaryTaxHdr +
    t.summaryTax(tax),
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text(t.compareMethods, 'calc_tax') }
  );
}

async function showTax(ctx) {
  const lang = getLang(ctx);
  const t = T[lang];
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  const { rows } = await query(
    `SELECT COALESCE(SUM(i.amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2`,
    [ctx.from.id, year]
  );
  const ytd = parseFloat(rows[0].total);
  if (ytd === 0) return ctx.reply(t.noIncome, { parse_mode: 'Markdown' });

  const annual = (ytd / month) * 12;
  const pv = calcPausal(annual);
  const pd = calcPausalnlDan(annual);

  let text = t.taxTitle(year) + t.taxAnnual(Math.round(annual), month) + t.taxPausal(pv);
  if (pd) {
    const better = pd.net > pv.net ? t.taxBetter : '';
    text += t.taxFlat(pd, better);
    const savings = Math.abs(pd.net - pv.net);
    const bestMethod = pd.net > pv.net ? t.taxFlat1 : t.taxPausal1;
    text += t.taxWinner(bestMethod, savings);
  }
  text += t.taxWarning;
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function showHelp(ctx) {
  const t = T[getLang(ctx)];
  await ctx.reply(t.helpText, { parse_mode: 'Markdown' });
}

bot.catch(err => console.error('Chyba:', err));
console.log('🇨🇿 TaxBot CZ spouštím...');
bot.start();
