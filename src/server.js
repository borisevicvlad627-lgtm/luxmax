import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const db = new Database('./data/luxmax.db');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'pending',
  payment_id TEXT,
  telegram_id TEXT,
  telegram_username TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_id);
CREATE INDEX IF NOT EXISTS idx_orders_tg ON orders(telegram_id);
CREATE TABLE IF NOT EXISTS diagnostics (
  telegram_id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  q1 TEXT, q2 TEXT, q3 TEXT, q4 TEXT,
  updated_at TEXT NOT NULL
);
`);

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';

const PRODUCTS = {
  START: { name:'7-Day Glow-Up', amount:'49.00', days:7 },
  TRANSFORM: { name:'30-Day Upgrade', amount:'99.00', days:30 },
  PRO: { name:'Full Looks Audit', amount:'179.00', days:30 }
};

function yookassaHeaders(idempotence) {
  return {
    'Authorization':'Basic ' + Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64'),
    'Content-Type':'application/json',
    'Idempotence-Key': idempotence
  };
}

async function createYooPayment(order) {
  if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY) {
    throw new Error('YooKassa credentials are not configured');
  }
  const r = await fetch('https://api.yookassa.ru/v3/payments', {
    method:'POST',
    headers:yookassaHeaders(crypto.randomUUID()),
    body:JSON.stringify({
      amount:{value:order.amount,currency:'RUB'},
      capture:true,
      confirmation:{type:'redirect',return_url:`${baseUrl}/payment/success?order=${encodeURIComponent(order.id)}`},
      description:`LUXMAX AI — ${PRODUCTS[order.product].name}`,
      metadata:{order_id:order.id, product:order.product}
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.description || 'YooKassa payment creation failed');
  return data;
}

async function getYooPayment(paymentId) {
  const r = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    headers:yookassaHeaders(crypto.randomUUID())
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.description || 'YooKassa payment lookup failed');
  return data;
}

async function tgSend(chatId, text, replyMarkup) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const body={chat_id:chatId,text,parse_mode:'HTML'};
  if(replyMarkup) body.reply_markup=replyMarkup;
  const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  if(!r.ok) console.error('Telegram send failed', await r.text());
}

async function activateOrder(orderId, paymentId) {
  const row=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(!row) return null;
  if(row.status==='paid') return row;
  const payment=await getYooPayment(paymentId || row.payment_id);
  if(payment.status!=='succeeded' || !payment.paid) return row;
  db.prepare(`UPDATE orders SET status='paid', payment_id=?, paid_at=? WHERE id=?`)
    .run(payment.id,new Date().toISOString(),orderId);
  const updated=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if(updated.telegram_id){
   await tgSend(updated.telegram_id, 
  `✅ <b>Оплата прошла!</b>\n\n` +
  `Спасибо за покупку! Твой продукт доступен по ссылке:\n\n` +
  `🔗 <a href="http://magenta-piroshki-ff447d.netlify.app">Открыть продукт</a>`
);
  }
  return updated;
}

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static('public'));

app.post('/api/orders', async (req,res)=>{
  try{
    const product=String(req.body.product||'').toUpperCase();
    if(!PRODUCTS[product]) return res.status(400).json({error:'Unknown product'});
    const id=crypto.randomUUID();
    const p=PRODUCTS[product];
    db.prepare(`INSERT INTO orders(id,product,amount,created_at) VALUES(?,?,?,?)`)
      .run(id,product,p.amount,new Date().toISOString());
    const payment=await createYooPayment({id,product,amount:p.amount});
    db.prepare('UPDATE orders SET payment_id=? WHERE id=?').run(payment.id,id);
    const bot=process.env.TELEGRAM_BOT_USERNAME;
    const telegramUrl=bot ? `https://t.me/${bot}?start=${encodeURIComponent(id)}` : null;
    res.json({
      order_id:id,
      product,
      amount:p.amount,
      payment_url:payment.confirmation?.confirmation_url,
      telegram_url:telegramUrl
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.post('/api/telegram/webhook', async (req,res)=>{
  try{
    const update=req.body;
    const msg=update?.message;
    if(msg?.chat?.id && typeof msg.text==='string' && msg.text.startsWith('/start')){
      const param=msg.text.split(' ')[1] || '';
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(param);
      if(order){
        db.prepare('UPDATE orders SET telegram_id=?, telegram_username=? WHERE id=?')
          .run(String(msg.chat.id),msg.from?.username||null,order.id);
        const keyboard=order.status==='paid'
          ? {inline_keyboard:[[{text:'🔥 Начать план',callback_data:`start:${order.product}`}]]}
          : {inline_keyboard:[[{text:`Оплатить ${order.amount} ₽`,url:`${baseUrl}/pay/${order.id}`}]]};
        await tgSend(msg.chat.id,
          order.status==='paid'
          ? `Ты уже оплатил <b>${PRODUCTS[order.product].name}</b>.`
          : `🔥 <b>LUXMAX AI</b>\n\nЗаказ привязан к этому Telegram.\nТариф: <b>${PRODUCTS[order.product].name}</b>\nСумма: <b>${order.amount} ₽</b>\n\nПосле оплаты доступ активируется автоматически.`,
          keyboard);
      } else {
        await tgSend(msg.chat.id, '👋 <b>Привет! Я — LUXMAX AI.</b>\n\nВыбери тариф на сайте, оплати — и я пришлю тебе ссылку на продукт прямо сюда.\n\n🔗 <a href="https://luxmax.onrender.com">Открыть сайт LUXMAX AI</a>');
      }
    }
    const cb=update?.callback_query;
    if(cb?.message?.chat?.id && cb.data){
      const chatId=String(cb.message.chat.id);
      const parts=cb.data.split(':');
      const action=parts[0];
      const product=parts[1];
      const value=parts[2];
      if(action==='start' && PRODUCTS[product]){
        db.prepare(`INSERT INTO diagnostics(telegram_id,product,updated_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET product=excluded.product, q1=NULL,q2=NULL,q3=NULL,q4=NULL,updated_at=excluded.updated_at`)
          .run(chatId,product,new Date().toISOString());
        await tgSend(chatId,
          `🧠 <b>Диагностика ${PRODUCTS[product].name}</b>\n\nОтветь на несколько вопросов — AI соберёт твой персональный план.\n\n<b>Вопрос 1/4</b>\nЧто хочешь улучшить в первую очередь?`,
          {inline_keyboard:[
            [{text:'Лицо и уход',callback_data:`q1:${product}:face`},{text:'Волосы',callback_data:`q1:${product}:hair`}],
            [{text:'Стиль',callback_data:`q1:${product}:style`},{text:'Форма',callback_data:`q1:${product}:body`}]
          ]});
      } else if(/^q[1-4]$/.test(action) && PRODUCTS[product]){
        const row=db.prepare('SELECT * FROM diagnostics WHERE telegram_id=?').get(chatId);
        if(!row) return res.sendStatus(200);
        db.prepare(`UPDATE diagnostics SET ${action}=?, updated_at=? WHERE telegram_id=?`).run(value,new Date().toISOString(),chatId);
        const next=Number(action.slice(1))+1;
        if(next===2){
          await tgSend(chatId,'<b>Вопрос 2/4</b>\n\nСколько времени готов уделять в день?',{inline_keyboard:[[{text:'5–10 минут',callback_data:`q2:${product}:5`},{text:'15–20 минут',callback_data:`q2:${product}:15`}],[{text:'30+ минут',callback_data:`q2:${product}:30`},{text:'Зависит от задачи',callback_data:`q2:${product}:flex`}]]});
        } else if(next===3){
          await tgSend(chatId,'<b>Вопрос 3/4</b>\n\nКакой результат тебе важнее?',{inline_keyboard:[[{text:'Ухоженность',callback_data:`q3:${product}:clean`},{text:'Выразительность',callback_data:`q3:${product}:sharp`}],[{text:'Стиль',callback_data:`q3:${product}:style`},{text:'Фото / подача',callback_data:`q3:${product}:photo`}]]});
        } else if(next===4){
          await tgSend(chatId,'<b>Вопрос 4/4</b>\n\nЧто тебе ближе по подходу?',{inline_keyboard:[[{text:'Минимум бюджета',callback_data:`q4:${product}:budget`},{text:'Готов вкладываться',callback_data:`q4:${product}:invest`}],[{text:'Максимум практичности',callback_data:`q4:${product}:practical`},{text:'Хочу полный roadmap',callback_data:`q4:${product}:roadmap`}]]});
        } else {
          const d=db.prepare('SELECT * FROM diagnostics WHERE telegram_id=?').get(chatId);
          await tgSend(chatId,'⏳ <b>Собираю твой персональный roadmap…</b>');
          let plan='';
          if(process.env.OPENAI_API_KEY){
            const prompt=`Создай персональный план LUXMAX AI на русском языке. Это wellness/grooming/self-improvement продукт, не медицинская консультация. Не ставь диагнозы, не обещай гарантированное изменение лица или тела, не рекомендуй опасные практики.\n\nТариф: ${PRODUCTS[d.product].name}\nГлавная цель: ${d.q1}\nВремя в день: ${d.q2}\nПриоритет результата: ${d.q3}\nПодход/бюджет: ${d.q4}\n\nСделай: 1) краткий профиль, 2) 3 главных приоритета, 3) план на 7 дней с конкретными действиями, 4) что пока не нужно покупать/делать, 5) как измерять прогресс. Пиши энергично, конкретно и без токсичных оценок внешности.`;
            const rr=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:OPENAI_MODEL,instructions:'Ты — LUXMAX AI coach. Давай безопасные, реалистичные рекомендации по уходу, стилю, волосам, физической форме и подаче.',input:prompt})});
            const data=await rr.json();
            if(rr.ok) plan=data.output_text || data.output?.map(x=>x.content?.map(c=>c.text||'').join('')).join('') || '';
          }
          if(!plan) plan=`🔥 <b>Твой LUXMAX roadmap</b>\n\n<b>Приоритет 1:</b> ${d.q1}\n<b>Приоритет 2:</b> ухоженность и волосы\n<b>Приоритет 3:</b> стиль и подача\n\n<b>День 1:</b> зафиксируй исходные фото и цели.\n<b>День 2:</b> приведи в порядок базовый уход.\n<b>День 3:</b> проработай волосы и укладку.\n<b>День 4:</b> собери 2 образа.\n<b>День 5:</b> работа с осанкой и подачей.\n<b>День 6:</b> сравни результат.\n<b>День 7:</b> собери финальный checklist.`;
          await tgSend(chatId,plan+'\n\n<b>Следующий шаг:</b> выполняй День 1 сегодня.');
        }
      }
    }
    res.sendStatus(200);
  }catch(e){console.error(e);res.sendStatus(200);}
});

app.post('/api/yookassa/webhook', async (req,res)=>{
  try{
    const event=req.body;
    if(event?.event==='payment.succeeded' && event.object?.id){
      const orderId=event.object?.metadata?.order_id;
      if(orderId) await activateOrder(orderId,event.object.id);
    }
    res.sendStatus(200);
  }catch(e){console.error(e);res.sendStatus(200);}
});

app.get('/pay/:orderId', async (req,res)=>{
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.orderId);
  if(!order) return res.status(404).send('Заказ не найден');
  if(order.status==='paid') return res.redirect(`/payment/success?order=${encodeURIComponent(order.id)}`);
  if(order.payment_id){
    const p=await getYooPayment(order.payment_id);
    if(p.confirmation?.confirmation_url) return res.redirect(p.confirmation.confirmation_url);
  }
  res.status(500).send('Платёжная ссылка недоступна');
});

app.get('/payment/success',(req,res)=>{
  res.sendFile(process.cwd()+'/public/payment-success.html');
});
app.get('/payment/fail',(req,res)=>{
  res.sendFile(process.cwd()+'/public/payment-fail.html');
});

app.get('/api/orders/:id', async (req,res)=>{
  const order=db.prepare('SELECT id,product,amount,status,telegram_id,created_at,paid_at FROM orders WHERE id=?').get(req.params.id);
  if(!order) return res.status(404).json({error:'Not found'});
  res.json(order);
});

app.listen(port,()=>console.log(`LUXMAX running on ${baseUrl}`));
