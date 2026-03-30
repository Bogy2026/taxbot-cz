import 'dotenv/config';
import pg from 'pg';
import { Bot, session, InlineKeyboard } from 'grammy';

// ── Database ──────────────────────────────────────────────────
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
bot.use(session({ initial: () => ({}) }));

const mainMenu = () => new InlineKeyboard()
  .text('💰 Přidat příjem',    'add_income').row()
  .text('🧾 Přidat výdaj',     'add_expense').row()
  .text('📊 Přehled',          'summary').row()
  .text('🧮 Spočítat daně',    'calc_tax').row()
  .text('🚗 Přidat kilometry', 'add_km').row()
  .text('❓ Nápověda',         'help');

bot.command('start', async ctx => {
  await upsertUser(ctx.from);
  await ctx.reply(
    `👋 Ahoj ${ctx.from.first_name}!\n\n` +
    `Jsem tvůj daňový pomocník 🇨🇿\n\n` +
    `• Sleduji příjmy a výdaje\n` +
    `• Spočítám daně a odvody\n` +
    `• Porovnám paušál vs. paušální daň\n\n` +
    `Jak přidat příjem? Prostě napiš:\n` +
    `\`25000 faktura Novák s.r.o.\``,
    { parse_mode: 'Markdown', reply_markup: mainMenu() }
  );
});

bot.command('prehled', showSummary);
bot.command('dane',    showTax);
bot.command('help',    showHelp);

bot.callbackQuery('summary',     ctx => { ctx.answerCallbackQuery(); showSummary(ctx); });
bot.callbackQuery('calc_tax',    ctx => { ctx.answerCallbackQuery(); showTax(ctx); });
bot.callbackQuery('help',        ctx => { ctx.answerCallbackQuery(); showHelp(ctx); });
bot.callbackQuery('add_income',  ctx => { ctx.answerCallbackQuery(); ctx.reply('💰 Napiš: `25000 faktura Novák s.r.o.`', { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_expense', ctx => { ctx.answerCallbackQuery(); ctx.reply('🧾 Napiš: `v 4900 notebook`', { parse_mode: 'Markdown' }); });
bot.callbackQuery('add_km',      ctx => { ctx.answerCallbackQuery(); ctx.reply('🚗 Napiš: `km 150 schůzka Brno`', { parse_mode: 'Markdown' }); });

bot.on('message:text', async ctx => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  const lower = text.toLowerCase();

  // km 120 účel
  if (lower.startsWith('km ')) {
    const parts = text.split(' ');
    const km = parseFloat(parts[1]);
    if (isNaN(km)) return ctx.reply('❌ Zkus: `km 120 cesta Praha`', { parse_mode: 'Markdown' });
    const purpose = parts.slice(2).join(' ') || 'pracovní cesta';
    await addMileage(ctx.from.id, km, purpose);
    return ctx.reply(`✅ *${km} km* — ${purpose}`, { parse_mode: 'Markdown' });
  }

  // v 3500 výdaj
  if (lower.startsWith('v ') || lower.startsWith('výdaj ')) {
    const parts = text.split(' ');
    const amount = parseFloat(parts[1].replace(',', '.'));
    if (isNaN(amount)) return ctx.reply('❌ Zkus: `v 3500 telefon`', { parse_mode: 'Markdown' });
    const desc = parts.slice(2).join(' ') || 'výdaj';
    await addExpense(ctx.from.id, amount, desc);
    return ctx.reply(`✅ Výdaj: *${czk(amount)}* — ${desc}`, { parse_mode: 'Markdown' });
  }

  // 25000 faktura popis
  const match = text.match(/^(\d[\d\s,.]*)(.*)/);
  if (match) {
    const amount = parseFloat(match[1].replace(/\s/g, '').replace(',', '.'));
    const desc = match[2].trim() || 'příjem';
    if (!isNaN(amount) && amount > 0) {
      await addIncome(ctx.from.id, amount, desc);
      return ctx.reply(`✅ Příjem: *${czk(amount)}*\n📝 ${desc}`, { parse_mode: 'Markdown' });
    }
  }

  ctx.reply('Nerozumím 🤔 Zkus /help');
});

async function showSummary(ctx) {
  const s = await getSummary(ctx.from.id);
  const month = new Date().getMonth() + 1;
  const months = ['','Led','Úno','Bře','Dub','Kvě','Čvn','Čvc','Srp','Zář','Říj','Lis','Pro'];
  let chart = '';
  const max = Math.max(...s.monthly.map(m => parseFloat(m.total)), 1);
  for (let m = 1; m <= month; m++) {
    const row = s.monthly.find(r => parseInt(r.month) === m);
    const total = row ? parseFloat(row.total) : 0;
    const bars = Math.round((total / max) * 8);
    chart += `${months[m].padEnd(4)} ${'█'.repeat(bars)}${'░'.repeat(8-bars)} ${czk(total)}\n`;
  }
  const tax = calcPausal(s.income);
  await ctx.reply(
    `📊 *Přehled ${new Date().getFullYear()}*\n━━━━━━━━━━━━━━━━\n` +
    `💰 Příjmy: *${czk(s.income)}* (${s.count} faktur)\n` +
    `🧾 Výdaje: *${czk(s.expenses)}*\n\n` +
    `\`\`\`\n${chart}\`\`\`\n` +
    `🧮 *Odhadované odvody:*\n` +
    `• Daň: ${czk(tax.tax)}\n• Sociální: ${czk(tax.social)}\n• Zdravotní: ${czk(tax.health)}\n` +
    `• Celkem: *${czk(tax.total)}*\n• Čistý příjem: *${czk(tax.net)}*`,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().text('🧮 Porovnat metody', 'calc_tax') }
  );
}

async function showTax(ctx) {
  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;
  const { rows } = await query(
    `SELECT COALESCE(SUM(i.amount),0) AS total FROM income i JOIN users u ON u.id=i.user_id WHERE u.telegram_id=$1 AND i.year=$2`,
    [ctx.from.id, year]
  );
  const ytd = parseFloat(rows[0].total);
  if (ytd === 0) return ctx.reply('📭 Zatím žádné příjmy. Přidej: `25000 faktura klient`', { parse_mode: 'Markdown' });

  const annual = (ytd / month) * 12;
  const pv = calcPausal(annual);
  const pd = calcPausalnlDan(annual);

  let text =
    `🧮 *Porovnání daní — odhad ${year}*\n` +
    `📈 Roční odhad: *${czk(Math.round(annual))}*\n━━━━━━━━━━━━━━━━\n\n` +
    `1️⃣ *Paušální výdaje 60%*\n` +
    `   Odvody: ${czk(pv.total)} | Sazba: ${pv.rate}%\n` +
    `   💵 Čistý: *${czk(pv.net)}*\n\n`;

  if (pd) {
    const better = pd.net > pv.net ? '✅ Lepší!' : '';
    text +=
      `2️⃣ *Paušální daň* ${better}\n` +
      `   ${czk(pd.monthly)}/měs → ${czk(pd.annual)}/rok\n` +
      `   💵 Čistý: *${czk(pd.net)}* | Bez daňového přiznání!\n\n`;
    const savings = Math.abs(pd.net - pv.net);
    const bestMethod = pd.net > pv.net ? 'Paušální daň' : 'Paušální výdaje';
    text += `━━━━━━━━━━━━━━━━\n🏆 *Lepší pro tebe: ${bestMethod}*\n💡 Rozdíl: *${czk(savings)}* ročně\n\n`;
  }
  text += `⚠️ Odhad. Poraď se s účetní/m.`;

  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function showHelp(ctx) {
  await ctx.reply(
    `❓ *Jak mě používat*\n\n` +
    `*Příjem:*\n\`25000 faktura Novák s.r.o.\`\n\n` +
    `*Výdaj:*\n\`v 4900 notebook\`\n\n` +
    `*Kilometry:*\n\`km 150 schůzka Brno\`\n\n` +
    `*Příkazy:*\n/prehled — přehled\n/dane — daně\n/start — menu\n\n` +
    `📌 Tvá data jsou pouze tvoje. Nesdílíme nic.`,
    { parse_mode: 'Markdown' }
  );
}

bot.catch(err => console.error('Chyba:', err));
console.log('🇨🇿 TaxBot CZ spouštím...');
bot.start();
