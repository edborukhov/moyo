// Moyo backend — multi-user version.
// Reads all secrets from environment variables. Never hardcode real keys here.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const { router: authRouter, requireAuth } = require('./auth');
const { saveAccessToken, loadAccessToken, hasConnectedBank } = require('./plaidTokens');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4000;

// ---------- Plaid setup ----------
const requiredEnvVars = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'ANTHROPIC_API_KEY', 'JWT_SECRET', 'ENCRYPTION_KEY'];
const missing = requiredEnvVars.filter(key => !process.env[key]);
if (missing.length) {
  console.warn(`⚠️  Missing environment variables: ${missing.join(', ')}`);
  console.warn('   Set these in your .env file before connecting a real bank or running an analysis.');
}

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// ---------- Auth routes (signup / login / me) ----------
app.use('/api/auth', authRouter);

// ---------- Rate limiting on the AI-calling endpoints ----------
// Keeps Anthropic API cost exposure bounded per beta tester. Adjust as real usage patterns emerge.
const analysisLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 30, // 30 analysis calls/day/user is generous for a single person testing Moyo's 5 features
  keyGenerator: (req) => (req.userId ? `user:${req.userId}` : ipKeyGenerator(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Daily analysis limit reached. This resets in 24 hours — it exists to keep AI costs predictable during beta.' },
});

// ---------- Plaid Link: create a link token (per user) ----------
app.post('/api/create_link_token', requireAuth, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(req.userId) },
      client_name: 'Moyo',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      redirect_uri: process.env.PLAID_REDIRECT_URI,
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token. Check your Plaid credentials in .env.' });
  }
});

// ---------- Plaid Link: exchange public_token for access_token (stored encrypted, scoped to this user) ----------
app.post('/api/exchange_public_token', requireAuth, async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    saveAccessToken(req.userId, response.data.access_token, response.data.item_id);
    res.json({ success: true });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token.' });
  }
});

// ---------- Fetch recurring transactions (Plaid auto-detects subscriptions/bills) ----------
app.get('/api/recurring', requireAuth, async (req, res) => {
  try {
    const saved = loadAccessToken(req.userId);
    if (!saved) return res.status(400).json({ error: 'No bank connected yet. Connect via Plaid Link first.' });

    const response = await plaidClient.transactionsRecurringGet({
      access_token: saved.access_token,
    });

    const bills = (response.data.outflow_streams || []).map(stream => ({
      merchant: stream.merchant_name || stream.description || 'Unknown',
      average_amount: stream.average_amount?.amount || 0,
      frequency: stream.frequency,
      last_date: stream.last_date,
      is_active: stream.is_active,
    }));

    res.json({ bills });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch recurring transactions. Note: this Plaid product may need to be enabled on your account.' });
  }
});

// ---------- Shared helper: call Anthropic with a prompt, parse the JSON response safely ----------
async function runAnalysis(prompt, fallbackObject) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error(data);
    throw new Error('Anthropic API request failed. Check ANTHROPIC_API_KEY in .env.');
  }

  const textBlocks = (data.content || []).filter(item => item.type === 'text').map(item => item.text);
  const rawText = textBlocks.join('\n').trim();
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  if (!rawText) {
    console.error('⚠️  No text block in response. stop_reason:', data.stop_reason, '| content block types:', (data.content || []).map(c => c.type));
  }

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        result = JSON.parse(match[0]);
      } catch {
        result = null;
      }
    }
    if (!result) {
      result = {
        ...fallbackObject,
        summary: rawText.slice(0, 400) || 'The response could not be fully parsed. Try again, it usually works on retry.',
      };
    }
  }
  return result;
}

// ---------- Run a savings check on a detected bill, using the same mechanism already validated ----------
app.post('/api/analyze', requireAuth, analysisLimiter, async (req, res) => {
  try {
    const { merchant, amount, frequency, context } = req.body;
    if (!merchant || !amount) {
      return res.status(400).json({ error: 'merchant and amount are required.' });
    }

    const annualEstimate = frequency === 'MONTHLY' ? Math.round(amount * 12) : Math.round(amount);

    const prompt = `Search the web for current pricing alternatives comparable to this recurring bill.

Bill:
- Merchant/provider: ${merchant}
- Amount: $${amount} (${frequency || 'unknown frequency'})
- Estimated annual cost: $${annualEstimate}
${context ? `- Additional context: ${context}` : ''}

Respond with ONLY valid JSON, no markdown, no code fences, no commentary outside the JSON. Use exactly this structure:
{
  "summary": "one or two sentence plain-language summary",
  "current_annual": ${annualEstimate},
  "estimated_savings_low": <number>,
  "estimated_savings_high": <number>,
  "alternatives": [
    {"provider": "name", "estimated_annual": <number>, "note": "short reason or caveat"}
  ],
  "next_steps": ["short actionable step", "short actionable step"]
}

Be honest: if you can't find a meaningfully better option, say so and set savings to 0 rather than inventing a gap.`;

    const result = await runAnalysis(prompt, {
      current_annual: annualEstimate,
      estimated_savings_low: 0,
      estimated_savings_high: 0,
      alternatives: [],
      next_steps: ['Try again.'],
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ---------- Fetch account balances (for idle cash detection) ----------
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const saved = loadAccessToken(req.userId);
    if (!saved) return res.status(400).json({ error: 'No bank connected yet. Connect via Plaid Link first.' });

    const response = await plaidClient.accountsBalanceGet({
      access_token: saved.access_token,
    });

    const accounts = (response.data.accounts || [])
      .filter(acct => acct.type === 'depository')
      .map(acct => ({
        name: acct.official_name || acct.name,
        subtype: acct.subtype,
        balance: acct.balances.available ?? acct.balances.current ?? 0,
      }));

    res.json({ accounts });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch account balances.' });
  }
});

// ---------- Analyze idle cash: compare against current high-yield savings rates ----------
app.post('/api/analyze-idle-cash', requireAuth, analysisLimiter, async (req, res) => {
  try {
    const { accounts } = req.body;
    if (!accounts || !accounts.length) {
      return res.status(400).json({ error: 'accounts array is required.' });
    }

    const totalBalance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
    const accountsList = accounts.map(a => `- ${a.name} (${a.subtype}): $${a.balance.toLocaleString()}`).join('\n');

    const prompt = `A person has the following cash sitting in standard checking/savings accounts, which typically earn close to 0% APY (checking) or the US national average savings rate (currently under 0.5% APY) unless the account is specifically a high-yield product:

${accountsList}

Total idle cash: $${totalBalance.toLocaleString()}

Search the web ONCE for current top high-yield savings account (HYSA) rates from 2-3 well-known providers (e.g. Ally, Marcus, SoFi, Discover, or similar). Do not research the CD, HSA, or money market accounts individually, just note their type briefly. Estimate the annual earnings this person is missing out on by leaving low-rate cash (checking, standard savings) in place instead of a current top HYSA.

Assume standard checking accounts earn approximately 0% and standard/unspecified savings accounts earn approximately the national average (well under 1%) unless told otherwise. Treat the CD and HSA as serving a different purpose, don't recommend moving those unless the rate is clearly poor, just mention briefly. If an account already has a competitive rate (roughly 4%+, like the money market here), say so briefly rather than suggesting a move.

Keep your entire response short: 2 alternatives maximum, one brief sentence per note, one sentence summary. This must fit in a strict length limit, prioritize the numbers.

Respond with ONLY valid JSON, no markdown, no code fences, no commentary outside the JSON. Use exactly this structure:
{
  "summary": "one or two sentence plain-language summary",
  "current_annual": <number, estimated current annual interest earned at ~0%>,
  "estimated_savings_low": <number, low end of additional annual earnings possible>,
  "estimated_savings_high": <number, high end of additional annual earnings possible>,
  "alternatives": [
    {"provider": "name", "estimated_annual": <number, projected annual earnings at this provider's current rate>, "note": "current APY and any relevant caveat"}
  ],
  "next_steps": ["short actionable step", "short actionable step"]
}

Be honest: if the balance is too small to matter meaningfully (e.g. under a few hundred dollars) or already in a decent-rate account, say so and keep estimates modest rather than overstating the opportunity.`;

    const result = await runAnalysis(prompt, {
      current_annual: 0,
      estimated_savings_low: 0,
      estimated_savings_high: 0,
      alternatives: [],
      next_steps: ['Try again.'],
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ---------- Fetch transactions and detect bank fees (overdraft, ATM, maintenance, etc.) ----------
app.get('/api/fees', requireAuth, async (req, res) => {
  try {
    const saved = loadAccessToken(req.userId);
    if (!saved) return res.status(400).json({ error: 'No bank connected yet. Connect via Plaid Link first.' });

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);
    const fmt = d => d.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token: saved.access_token,
      start_date: fmt(startDate),
      end_date: fmt(endDate),
      options: { count: 500, offset: 0 },
    });

    const feeKeywords = /overdraft|insufficient|nsf\b|atm fee|maintenance fee|service charge|service fee|monthly fee|foreign transaction|wire fee|late fee|annual fee|non-?sufficient/i;

    const feeTransactions = (response.data.transactions || []).filter(t => {
      const isFeeCategory = t.personal_finance_category?.primary === 'BANK_FEES';
      const nameMatches = feeKeywords.test(t.name || '') || feeKeywords.test(t.merchant_name || '');
      return isFeeCategory || nameMatches;
    }).map(t => ({
      name: t.merchant_name || t.name,
      amount: t.amount,
      date: t.date,
      category: t.personal_finance_category?.detailed || (t.category || []).join(' > '),
    }));

    const totalFees = feeTransactions.reduce((sum, t) => sum + (t.amount > 0 ? t.amount : 0), 0);

    res.json({ fees: feeTransactions, totalFees, periodDays: 365 });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions for fee detection.' });
  }
});

// ---------- Analyze detected fees: summarize pattern and suggest fee-free alternatives ----------
app.post('/api/analyze-fees', requireAuth, analysisLimiter, async (req, res) => {
  try {
    const { fees, totalFees, periodDays } = req.body;
    if (!fees || !fees.length) {
      return res.status(400).json({ error: 'fees array is required.' });
    }

    const feesList = fees.slice(0, 20).map(f => `- ${f.date}: ${f.name} — $${f.amount.toFixed(2)} (${f.category || 'uncategorized'})`).join('\n');
    const annualizedEstimate = Math.round(totalFees * (365 / (periodDays || 365)));

    const prompt = `A person's bank transaction history over the past ${periodDays || 365} days shows these bank fee charges:

${feesList}
${fees.length > 20 ? `\n(and ${fees.length - 20} more not listed here)` : ''}

Total fees paid in this period: $${totalFees.toFixed(2)}
Annualized estimate: $${annualizedEstimate}

Search the web ONCE briefly for 1-2 well-known banks or accounts with no overdraft fees or no monthly maintenance fees (e.g. Ally, Chime, Capital One 360, SoFi, or similar). Summarize the pattern of fees found (are they mostly overdraft, maintenance, ATM, something else?) and whether they look avoidable.

Keep your entire response short and concrete: 2 alternatives maximum, one brief sentence per note, one to two sentence summary.

Respond with ONLY valid JSON, no markdown, no code fences, no commentary outside the JSON. Use exactly this structure:
{
  "summary": "one or two sentence plain-language summary of the fee pattern",
  "current_annual": ${annualizedEstimate},
  "estimated_savings_low": <number, low end of annual fees that could realistically be eliminated>,
  "estimated_savings_high": <number, high end>,
  "alternatives": [
    {"provider": "name", "estimated_annual": 0, "note": "why this avoids the fee pattern found, brief"}
  ],
  "next_steps": ["short actionable step", "short actionable step"]
}

Be honest: if fees are minor, occasional, or already reasonable, say so rather than dramatizing a small amount. If it looks like most fees could be eliminated just by setting up low-balance alerts or linking overdraft protection rather than switching banks, say that instead of always recommending a switch.`;

    const result = await runAnalysis(prompt, {
      current_annual: annualizedEstimate,
      estimated_savings_low: 0,
      estimated_savings_high: 0,
      alternatives: [],
      next_steps: ['Try again.'],
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ---------- Analyze all recurring bills together for overlap/redundancy ----------
function annualizeAmount(amount, frequency) {
  const multipliers = { WEEKLY: 52, BIWEEKLY: 26, SEMI_MONTHLY: 24, MONTHLY: 12, ANNUALLY: 1 };
  return Math.round((amount || 0) * (multipliers[frequency] || 12));
}

app.post('/api/analyze-overlap', requireAuth, analysisLimiter, async (req, res) => {
  try {
    const { bills } = req.body;
    if (!bills || !bills.length) {
      return res.status(400).json({ error: 'bills array is required.' });
    }

    const billsWithAnnual = bills.map(b => ({ ...b, annual: annualizeAmount(b.average_amount, b.frequency) }));
    const totalAnnual = billsWithAnnual.reduce((sum, b) => sum + b.annual, 0);
    const billsList = billsWithAnnual.map(b => `- ${b.merchant}: $${b.average_amount.toFixed(2)} (${b.frequency}, ~$${b.annual}/yr)`).join('\n');

    const prompt = `A person has these recurring bills/subscriptions detected from their bank transactions:

${billsList}

Total annualized recurring spend: $${totalAnnual}

Look for likely overlap or redundancy: multiple services in the same category (e.g. two streaming services, duplicate cloud storage, more than one music subscription), or anything that looks like it might be forgotten/unused based on the name alone. You may do at most one brief web search if a merchant name is ambiguous and you need to identify what category of service it is.

Do not assume redundancy that isn't clearly there just from generic or unclear merchant names, if you can't tell what something is, say so rather than guessing it overlaps with something.

Keep your entire response concise: a few items in alternatives at most, one brief sentence per note.

Respond with ONLY valid JSON, no markdown, no code fences, no commentary outside the JSON. Use exactly this structure:
{
  "summary": "one or two sentence plain-language summary of any overlap found",
  "current_annual": ${totalAnnual},
  "estimated_savings_low": <number, low end of annual savings if overlapping items were cut>,
  "estimated_savings_high": <number, high end>,
  "alternatives": [
    {"provider": "merchant name from the list", "estimated_annual": <number, annual cost of this specific item, i.e. the savings if cancelled>, "note": "why this looks redundant or worth reconsidering"}
  ],
  "next_steps": ["short actionable step", "short actionable step"]
}

Be honest: if nothing looks clearly redundant, say so plainly and set savings to 0 rather than forcing a finding.`;

    const result = await runAnalysis(prompt, {
      current_annual: totalAnnual,
      estimated_savings_low: 0,
      estimated_savings_high: 0,
      alternatives: [],
      next_steps: ['Try again.'],
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ---------- List credit card accounts (so the user can pick which one to analyze) ----------
app.get('/api/credit-accounts', requireAuth, async (req, res) => {
  try {
    const saved = loadAccessToken(req.userId);
    if (!saved) return res.status(400).json({ error: 'No bank connected yet. Connect via Plaid Link first.' });

    const response = await plaidClient.accountsBalanceGet({
      access_token: saved.access_token,
    });

    const accounts = (response.data.accounts || [])
      .filter(acct => acct.type === 'credit')
      .map(acct => ({
        account_id: acct.account_id,
        name: acct.official_name || acct.name,
        mask: acct.mask,
      }));

    res.json({ accounts });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch credit accounts.' });
  }
});

// ---------- Pull and categorize a year of spend on a specific card ----------
app.get('/api/card-spend', requireAuth, async (req, res) => {
  try {
    const saved = loadAccessToken(req.userId);
    if (!saved) return res.status(400).json({ error: 'No bank connected yet. Connect via Plaid Link first.' });

    const { account_id } = req.query;
    if (!account_id) return res.status(400).json({ error: 'account_id query param is required.' });

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 365);
    const fmt = d => d.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token: saved.access_token,
      start_date: fmt(startDate),
      end_date: fmt(endDate),
      options: { count: 500, offset: 0, account_ids: [account_id] },
    });

    const txns = response.data.transactions || [];
    let travel = 0, dining = 0, other = 0;
    txns.forEach(t => {
      const cat = t.personal_finance_category?.primary;
      const amt = t.amount > 0 ? t.amount : 0;
      if (cat === 'TRAVEL') travel += amt;
      else if (cat === 'FOOD_AND_DRINK') dining += amt;
      else other += amt;
    });

    const total = travel + dining + other;
    res.json({ travel, dining, other, total, transactionCount: txns.length });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch card spend.' });
  }
});

// ---------- Analyze whether the annual fee is justified, combining real spend + self-reported benefit usage ----------
app.post('/api/analyze-card-value', requireAuth, analysisLimiter, async (req, res) => {
  try {
    const { cardName, annualFee, spend, selfReport } = req.body;
    if (!cardName || !annualFee || !spend) {
      return res.status(400).json({ error: 'cardName, annualFee, and spend are required.' });
    }

    const prompt = `Analyze whether this credit card's annual fee is worth it, using a mix of real spend data and self-reported benefit usage. Be clear about which parts are calculated from real data versus estimated from self-report.

Card: ${cardName}
Annual fee (this account, including any authorized user fees): $${annualFee}

Actual spend on this card over the past 12 months, by category:
- Travel: $${spend.travel.toFixed(2)}
- Dining: $${spend.dining.toFixed(2)}
- Other/everything else: $${spend.other.toFixed(2)}
- Total: $${spend.total.toFixed(2)}

Self-reported benefit usage this year:
- Global Entry/TSA PreCheck credit used: ${selfReport.globalEntry}
- Approximate airport lounge visits: ${selfReport.loungeVisits}
- Food delivery/rideshare monthly credits used: ${selfReport.doordashLyft}
- How points are typically redeemed: ${selfReport.redemptionStyle}

Search the web ONCE for this card's current point-earning multipliers and current key benefit terms (annual travel credit amount, Global Entry credit frequency). Keep the search brief, one query.

Calculate concisely:
1. Estimated points earned value from the category spend, using real current multipliers. Value conservatively based on redemption style.
2. Whether the annual travel credit was likely captured, based on travel spend.
3. A conservative dollar estimate for self-reported benefits (lounge visits, delivery/rideshare credits, Global Entry credit amortized over its validity period).

Give a direct, honest verdict. Don't inflate value to make the card look better.

Keep your entire response short: at most 2 items in verified_value, at most 2 items in estimated_value, one brief sentence per note, 2 next_steps max. This must fit a strict length limit, prioritize the numbers over explanation.

Respond with ONLY valid JSON, no markdown, no code fences, no commentary outside the JSON. Use exactly this structure:
{
  "summary": "one or two sentence direct verdict in plain language",
  "verdict": "worth it" or "not worth it" or "close call",
  "annual_fee": ${annualFee},
  "verified_value": [
    {"item": "short label, e.g. Points earned (travel/dining spend)", "estimated_value": <number>, "note": "brief, based on real spend data"}
  ],
  "estimated_value": [
    {"item": "short label, e.g. Lounge visits (self-reported)", "estimated_value": <number>, "note": "brief, clearly an estimate"}
  ],
  "total_value_low": <number, conservative total of all value above>,
  "total_value_high": <number, optimistic total>,
  "next_steps": ["short actionable step", "short actionable step"]
}`;

    const result = await runAnalysis(prompt, {
      verdict: 'unknown',
      annual_fee: annualFee,
      verified_value: [],
      estimated_value: [],
      total_value_low: 0,
      total_value_high: 0,
      next_steps: ['Try again, this one occasionally runs long and gets cut off.'],
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// Plain HTTP locally — for OAuth institutions (Chase, etc.) we tunnel through ngrok,
// which terminates HTTPS externally and forwards to this local HTTP port. Access the
// app via the ngrok https URL (see PLAID_REDIRECT_URI in .env), not localhost directly,
// when testing OAuth bank connections.
http.createServer(app).listen(PORT, () => {
  console.log(`Moyo backend running at http://localhost:${PORT}`);
  if (process.env.PLAID_REDIRECT_URI) {
    console.log(`   OAuth redirect URI configured: ${process.env.PLAID_REDIRECT_URI}`);
    console.log('   For OAuth banks (Chase, etc.), access the app through your ngrok URL, not localhost directly.');
  }
  if (missing.length) {
    console.log(`⚠️  Remember to fill in: ${missing.join(', ')} in your .env file`);
  }
});
