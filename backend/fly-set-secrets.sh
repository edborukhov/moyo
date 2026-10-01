#!/usr/bin/env bash
# Run this from ~/moyo/backend on your own machine (where flyctl is installed and logged in).
# Reads values from your local .env and pushes them to Fly as secrets — nothing is printed
# or sent anywhere except to Fly's API.
set -euo pipefail

if [ ! -f .env ]; then
  echo "No .env found in this directory. Run this from ~/moyo/backend."
  exit 1
fi

set -a
source .env
set +a

APP_NAME="${1:-moyo-backend}"

echo "Setting secrets on Fly app: $APP_NAME"

fly secrets set --app "$APP_NAME" \
  PLAID_ENV="$PLAID_ENV" \
  PLAID_CLIENT_ID="$PLAID_CLIENT_ID" \
  PLAID_SECRET="$PLAID_SECRET" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  JWT_SECRET="$JWT_SECRET" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  DB_FILE="/data/moyo.db"

echo "Done. Note: PLAID_REDIRECT_URI is NOT set by this script — set it manually once you know your app's real https://<app>.fly.dev URL (see deploy steps)."
