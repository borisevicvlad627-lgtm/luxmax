#!/usr/bin/env bash
set -e
source .env
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${BASE_URL}/api/telegram/webhook\"}"
echo
