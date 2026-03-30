-- ============================================================
-- TaxBot CZ — Czech Freelancer Tax Tracker
-- ============================================================

-- Users (Telegram freelancers)
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  telegram_id     BIGINT UNIQUE NOT NULL,
  first_name      VARCHAR(100),
  username        VARCHAR(100),
  tax_method      VARCHAR(20) DEFAULT 'pausalni_vydaje'
                  CHECK (tax_method IN ('pausalni_vydaje','skutecne_vydaje','pausalni_dan')),
  -- paušální výdaje = 60% flat deduction (most common)
  -- skutečné výdaje = real tracked expenses
  -- paušální daň   = flat monthly tax regime
  monthly_advance NUMERIC(10,2),        -- their current quarterly advance amount
  ic              VARCHAR(20),           -- IČO (business ID) - optional
  vat_payer       BOOLEAN DEFAULT false, -- are they a VAT payer (plátce DPH)?
  year_started    INTEGER DEFAULT 2024,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Income entries
CREATE TABLE income (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL,
  currency    VARCHAR(5) DEFAULT 'CZK',
  description TEXT,
  category    VARCHAR(50) DEFAULT 'invoice',  -- invoice, cash, other
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  year        INTEGER GENERATED ALWAYS AS (EXTRACT(YEAR FROM date)::INTEGER) STORED,
  month       INTEGER GENERATED ALWAYS AS (EXTRACT(MONTH FROM date)::INTEGER) STORED,
  quarter     INTEGER GENERATED ALWAYS AS (CEIL(EXTRACT(MONTH FROM date)/3.0)::INTEGER) STORED,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Expense entries (only relevant for skutečné výdaje users)
CREATE TABLE expenses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL,
  currency    VARCHAR(5) DEFAULT 'CZK',
  description TEXT,
  category    VARCHAR(50) DEFAULT 'other',
  -- Categories: office, equipment, phone, internet, car, travel, software, other
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  year        INTEGER GENERATED ALWAYS AS (EXTRACT(YEAR FROM date)::INTEGER) STORED,
  month       INTEGER GENERATED ALWAYS AS (EXTRACT(MONTH FROM date)::INTEGER) STORED,
  quarter     INTEGER GENERATED ALWAYS AS (CEIL(EXTRACT(MONTH FROM date)/3.0)::INTEGER) STORED,
  deductible  BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Fleet mileage log (bonus feature for fleet users)
CREATE TABLE mileage_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  km          NUMERIC(8,1) NOT NULL,
  purpose     TEXT,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---- Indexes ----
CREATE INDEX idx_income_user_year   ON income(user_id, year);
CREATE INDEX idx_income_user_month  ON income(user_id, year, month);
CREATE INDEX idx_expenses_user_year ON expenses(user_id, year);
