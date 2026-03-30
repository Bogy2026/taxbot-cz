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

// ── Translations ──────────────────────────────────────────────
const T = {
  cs: {
    welcome: (name) => `👋 Ahoj ${name}!\n\nJsem tvůj daňový pomocník 🇨🇿\n\n• Sleduji příjmy a výdaje\n• Spočítám daně a odvody\n• Porovnám paušál vs. paušální daň\n\nJak přidat příjem? Prostě napiš:\n\`25000 faktura Novák s.r.o.\``,
    menu: {
      income:   '💰 Přidat příjem',
      expense:  '🧾 Přidat výdaj',
      summary:  '📊 Přehled',
      tax:      '🧮 Spočítat daně',
      km:       '🚗 Přidat kilometry',
      help:     '❓ Nápověda',
      lang:     '🇬🇧 English',
    },
    addIncomePrompt:  '💰 Napiš: `25000 faktura Novák s.r.o.`',
    addExpensePrompt: '🧾 Napiš: `v 4900 notebook`',
    addKmPrompt:      '🚗 Napiš: `km 150 schůzka Brno`',
    kmError:          '❌ Zkus: `km 120 cesta Praha`',
    kmSaved:          (km, purpose) => `✅ *${km} km* — ${purpose}`,
    kmDefault:        'pracovní cesta',
    expenseError:     '❌ Zkus: `v 3500 telefon`',
    expenseDefault:   'výdaj',
    expenseSaved:     (amount, desc) => `✅ Výdaj: *${czk(amount)}* — ${desc}`,
    incomeSaved:      (amount, desc) => `✅ Příjem: *${czk(amount)}*\n📝 ${desc}`,
    incomeDefault:    'příjem',
    unknown:          'Nerozumím 🤔 Zkus /help',
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
      `*Příjem:*\n\`25000 faktura Novák s.r.o.\`\n\n` +
      `*Výdaj:*\n\`v 4900 notebook\`\n\n` +
      `*Kilometry:*\n\`km 150 schůzka Brno\`\n\n` +
      `*Příkazy:*\n/prehled — přehled\n/dane — daně\n/start — menu\n\n` +
      `📌 Tvá data jsou pouze tvoje. Nesdílíme nic.`,
    months: ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'],
    langChanged: '🇨🇿 Jazyk nastaven na češtinu.',
  },
  en: {
    welcome: (name) => `👋 Hi ${name}!\n\nI'm your Czech tax assistant 🇨🇿\n\n• I track your income & expenses\n• I calculate taxes and levies\n• I compare flat-rate expenses vs. flat-rate tax\n\nTo add income, just write:\n\`25000 invoice Novák s.r.o.\``,
    menu: {
      income:   '💰 Add income',
      expense:  '🧾 Add expense',
      summary:  '📊 Summary',
      tax:      '🧮 Calculate taxes',
      km:       '🚗 Add mileage',
      help:     '❓ Help',
      lang:     '🇨🇿 Čeština',
    },
    addIncomePrompt:  '💰 Write: `25000 invoice Novák s.r.o.`',
    addExpensePrompt: '🧾 Write: `v 4900 laptop`',
    addKmPrompt:      '🚗 Write: `km 150 meeting Brno`',
    kmError:          '❌ Try: `km 120 trip Prague`',
    kmSaved:          (km, purpose) => `✅ *${km} km* — ${purpose}`,
    kmDefault:        'business trip',
    expenseError:     '❌ Try: `v 3500 phone`',
    expenseDefault:   'expense',
    expenseSaved:     (amount, desc) => `✅ Expense: *${czk(amount)}* — ${desc}`,
    incomeSaved:      (amount, desc) => `✅ Income: *${czk(amount)}*\n📝 ${desc}`,
    incomeDefault:    'income',
    unknown:          "I don't understand 🤔 Try /help",
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
      `*Income:*\n\`25000 invoice Novák s.r.o.\`\n\n` +
      `*Expense:*\n\`v 4900 laptop\`\n\n` +
      `*Mileage:*\n\`km 150 meeting Brno\`\n\n` +
      `*Commands:*\n/prehled — summary\n/dane — taxes\n/start — menu\n\n` +
      `📌 Your data is yours only. We share nothing.`,
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
  await query(`INSERT INTO income (user_id, amount, description, date) VALUES ($1,$2,$3,NOW())`, [u.id, amount, desc]);
}

async function addExpense(tgId, amount, desc) {
  const u = await upsertUser({ id: tgId });
  await query(`INSERT INTO expenses (user_id, amount, description, date) VALUES ($1,$2,$3,NOW())`, [u.id, amount, desc]);
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
bot.use(session({ initial: () => ({ lang: 'cs' }) }));

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

bot.command('start', async ctx => {
  await upsertUser(ctx.from);
  const lang = getLang(ctx);
  const t = T[lang];
  await ctx.reply(t.welcome(ctx.from.first_name), { parse_mode: 'Markdown', reply_markup: mainMenu(lang) });
});

bot.command('prehled', showSummary);
bot.command('dane',    showTax);
bot.command('help',    showHelp);

bot.callbackQuery('summary',     ctx => { ctx.answerCallbackQuery(); showSummary(ctx); });
bot.callbackQuery('calc_tax',    ctx => { ctx.answerCallbackQuery(); showTax(ctx); });
bot.callbackQuery('help',        ctx => { ctx.answerCallbackQuery(); showHelp(ctx); });
bot.callbackQuery('add_income',  ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addIncomePrompt,  { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_expense', ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addExpensePrompt, { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_km',      ctx => { ctx.answerCallbackQuery(); ctx.reply(T[getLang(ctx)].addKmPrompt,      { parse_mode: 'Markdown' }); });

bot.callbackQuery('toggle_lang', async ctx => {
  await ctx.answerCallbackQuery();
  const current = getLang(ctx);
  const next = current === 'cs' ? 'en' : 'cs';
  ctx.session.lang = next;
  await ctx.reply(T[next].langChanged, { reply_markup: mainMenu(next) });
});

bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const lower = text.toLowerCase();
  const lang = getLang(ctx);
  const t = T[lang];

  // km 120 purpose
  if (lower.startsWith('km ')) {
    const parts = text.split(' ');
    const km = parseFloat(parts[1]);
    if (isNaN(km)) return ctx.reply(t.kmError, { parse_mode: 'Markdown' });
    const purpose = parts.slice(2).join(' ') || t.kmDefault;
    await addMileage(ctx.from.id, km, purpose);
    return ctx.reply(t.kmSaved(km, purpose), { parse_mode: 'Markdown' });
  }

  // v 3500 expense
  if (lower.startsWith('v ') || lower.startsWith('výdaj ')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1].replace(',', '.'));
    if (isNaN(amount)) return ctx.reply(t.expenseError, { parse_mode: 'Markdown' });
    const desc = parts.slice(2).join(' ') || t.expenseDefault;
    await addExpense(ctx.from.id, amount, desc);
    return ctx.reply(t.expenseSaved(amount, desc), { parse_mode: 'Markdown' });
  }

  // 25000 description
  // Parse amounts like: 40000 / 40 000 / 40,000 / 40.000 (thousands sep) / 40.50 (decimal)
  const numMatch = text.match(/^(\d[\d ]*(?:[,.]\d+)*)\s*(.*)/);
  const match = numMatch; // keep variable name for compat
  if (match) {
    const raw = match[1].replace(/ /g, ''); // remove spaces: "40 000" -> "40000"
    // Detect if comma/dot is thousands separator (followed by exactly 3 digits at end)
    const amount = raw.match(/^\d+[,.]\d{3}$/)
      ? parseFloat(raw.replace(/[,.]/g, ''))          // "40,000" or "40.000" -> 40000
      : parseFloat(raw.replace(',', '.'));              // "40.50" or "40,50" -> 40.5
    const desc = match[2].trim() || t.incomeDefault;
    if (!isNaN(amount) && amount > 0) {
      await addIncome(ctx.from.id, amount, desc);
      return ctx.reply(t.incomeSaved(amount, desc), { parse_mode: 'Markdown' });
    }
  }

  ctx.reply(t.unknown);
});

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
