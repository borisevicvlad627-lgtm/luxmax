# LUXMAX AI — production-ready MVP skeleton

В проекте есть:
- новый premium лендинг;
- ваш логотип `public/logo.jpg`;
- анимированный логотип на hero;
- 3 тарифа: 99 ₽ / 890 ₽ / 1 790 ₽;
- backend на Node.js + Express;
- SQLite для заказов;
- создание платежа через YooKassa API;
- redirect checkout;
- webhook `payment.succeeded`;
- повторная проверка платежа через API;
- Telegram deep-link `/start=<order_id>`;
- привязка Telegram ID к заказу;
- автоматическое сообщение после успешной оплаты;
- success/fail страницы;
- структура для дальнейшего AI-coach.

## Важно
Это не содержит твоих секретных ключей. Перед запуском скопируй `.env.example` в `.env` и заполни:
- YOOKASSA_SHOP_ID
- YOOKASSA_SECRET_KEY
- TELEGRAM_BOT_TOKEN
- TELEGRAM_BOT_USERNAME
- BASE_URL

## Запуск
Нужен Node.js 18+.

```bash
npm install
cp .env.example .env
npm start
```

Открой `http://localhost:3000`.

## Telegram
1. Создай бота через BotFather.
2. Получи token.
3. В `TELEGRAM_BOT_USERNAME` укажи username без @.
4. Для production установи webhook:
   `POST https://api.telegram.org/bot<TOKEN>/setWebhook`
   JSON:
   `{"url":"https://YOUR_DOMAIN/api/telegram/webhook"}`

## YooKassa
1. Создай магазин/аккаунт.
2. Получи shop ID и secret key.
3. Заполни `.env`.
4. Создай webhook на:
   `https://YOUR_DOMAIN/api/yookassa/webhook`
   для события `payment.succeeded`.

Для API-запросов к YooKassa ключи должны находиться только на сервере.

## Архитектура оплаты
Сайт -> POST /api/orders -> YooKassa -> confirmation_url -> оплата -> webhook -> проверка payment -> order=paid -> Telegram message.

Возврат пользователя на `return_url` НЕ используется как доказательство оплаты.

## Что ещё нужно перед боевым запуском
- HTTPS и домен;
- политика конфиденциальности;
- оферта и условия возврата;
- реальные тексты продукта;
- корректная схема чеков/НПД для твоего статуса;
- резервные копии БД;
- логирование;
- rate limiting / защита API;
- полноценная обработка Telegram callback-вопросов;
- реальный AI API;
- выдача контента/прогресса по дням;
- аналитика (UTM + purchase events).

## Примечание по платежам
Интеграция использует официальный REST API YooKassa: сервер создаёт платёж с redirect confirmation, клиент переходит на confirmation_url, а webhook сообщает об успешном платеже. Перед продакшеном сверяй актуальные требования YooKassa и ФНС для твоего статуса самозанятого.

## AI coach
После 4 ответов Telegram-бот вызывает OpenAI Responses API, если задан `OPENAI_API_KEY`, и отправляет персональный roadmap. Новые интеграции OpenAI следует строить на Responses API; Assistants API был выведен из эксплуатации 26 августа 2026 года.
