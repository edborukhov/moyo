# Moyo — Personal Test Backend

A small local server for testing whether Moyo's savings-detection mechanism holds up on your own real bank transactions. Internal/personal use only.

## Setup

1. **Install dependencies:**
   ```
   npm install
   ```

2. **Create your real .env file:**
   ```
   cp .env.example .env
   ```
   Then open `.env` and fill in your real values:
   - `PLAID_CLIENT_ID` and `PLAID_SECRET` — from your Plaid dashboard (dashboard.plaid.com)
   - `ANTHROPIC_API_KEY` — from console.anthropic.com (this is a separate developer key, not your claude.ai login)

   **Never commit `.env` or paste these values anywhere else.** `.gitignore` already excludes it.

3. **Start in sandbox mode first** (fake test bank, safe to experiment):
   ```
   PLAID_ENV=sandbox npm start
   ```
   Or just set `PLAID_ENV=sandbox` in your `.env` file.

   When Plaid Link opens in sandbox mode, use Plaid's test credentials:
   - Username: `user_good`
   - Password: `pass_good`

4. **Open the app:** http://localhost:4000

5. **Once sandbox is working, switch to real data:**
   Change `PLAID_ENV` to `development` in `.env` and restart the server. Plaid's Development environment lets you connect your own real bank account for personal testing (no production approval needed for this).

## What this does

- Connects to your bank via Plaid Link
- Pulls your real recurring bills/subscriptions using Plaid's recurring-transactions detection
- Runs each one through the same AI search-and-compare mechanism already validated on car insurance, internet, and cell phone
- Shows potential savings, right in the browser

## Cost note

Once you're using your real `ANTHROPIC_API_KEY` (outside Claude's chat interface), each "Check savings" click is a real, billed API call, including the web search tool. Keep an eye on usage if you run a lot of checks. Plaid's Development environment is free for a small number of connected accounts.

## Security notes

- `access_token.json` is created locally when you connect a bank. It's gitignored, don't share it or commit it.
- This server has no authentication of its own, it's meant to run locally on your machine for personal testing, not to be deployed publicly as-is.
