// ============================================================
// 凤姐转运 - Cloudflare Worker v3
//
// 环境变量：
//   GEMINI_API_KEY       Google AI Studio API key
//   ADMIN_TOKEN          admin.html 鉴权 token
//   WECHAT_TOKEN         企业微信验证 Token
//   WECHAT_AES_KEY       企业微信 AES 密钥
//   WECHAT_CORP_ID       企业微信企业ID
//   WECHAT_CORP_SECRET   自建应用 Secret
//   WECHAT_KF_ID         微信客服账号 open_kfid
//
// Bindings：
//   DB   → D1 数据库
//   KV   → KV 命名空间（存用户对话状态 + access token 缓存）
// ============================================================

const STATE_TTL = 60 * 30; // 30分钟无消息自动清空状态

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    function err(msg, status = 400) { return json({ error: msg }, status); }

    // 企业微信域名验证文件
    if (path === '/WW_verify_tBq5D4siarKD8kCW.txt') {
      return new Response('tBq5D4siarKD8kCW', {
        status: 200, headers: { 'Content-Type': 'text/plain' }
      });
    }

    // 微信 Webhook
    if (path === '/wx') {
      if (request.method === 'GET')  return handleWxVerify(request, env);
      if (request.method === 'POST') return handleWxMessage(request, env, ctx);
    }

    // R2 PDF 存储端点
    if (path === '/api/pdfs' && request.method === 'GET') {
      try {
        const list = await env.R2.list({ prefix: '' });
        const files = list.objects.map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded
        }));
        files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
        return json(files);
      } catch(e) { return err('Failed to list PDFs: ' + e.message, 500); }
    }

    if (path === '/api/pdfs/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const filename = formData.get('filename');
        if (!file || !filename) return err('missing file or filename');
        const arrayBuffer = await file.arrayBuffer();
        await env.R2.put(filename, arrayBuffer, {
          httpMetadata: { contentType: 'application/pdf' }
        });
        return json({ ok: true, key: filename });
      } catch(e) { return err('Failed to upload PDF: ' + e.message, 500); }
    }

    if (path.startsWith('/api/pdfs/') && request.method === 'GET') {
      const key = decodeURIComponent(path.replace('/api/pdfs/', ''));
      try {
        const obj = await env.R2.get(key);
        if (!obj) return err('PDF not found', 404);
        return new Response(obj.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${key}"`,
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch(e) { return err('Failed to get PDF: ' + e.message, 500); }
    }

    if (path.startsWith('/api/pdfs/') && request.method === 'DELETE') {
      const key = decodeURIComponent(path.replace('/api/pdfs/', ''));
      try {
        await env.R2.delete(key);
        return json({ ok: true });
      } catch(e) { return err('Failed to delete PDF: ' + e.message, 500); }
    }

    // 客户名字记忆端点
    if (path === '/api/customer_name') {
      if (request.method === 'GET') {
        const uid = url.searchParams.get('external_userid');
        if (!uid) return err('missing external_userid');
        try {
          const row = await env.DB.prepare('SELECT created_by FROM customer_names WHERE external_userid = ?').bind(uid).first();
          return json({ created_by: row?.created_by || null });
        } catch(e) { return json({ created_by: null }); }
      }
      if (request.method === 'POST') {
        try {
          const { external_userid, created_by } = await request.json();
          await env.DB.prepare(
            `INSERT INTO customer_names (external_userid, created_by, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(external_userid) DO UPDATE SET created_by=excluded.created_by, updated_at=excluded.updated_at`
          ).bind(external_userid, created_by, new Date().toISOString()).run();
          return json({ ok: true });
        } catch(e) { return err('Failed to save: ' + e.message, 500); }
      }
    }

    // cursor 端点（Render 服务使用，存取 sync_msg cursor）
    if (path === '/api/cursor') {
      if (request.method === 'GET') {
        const key = url.searchParams.get('key') || 'default';
        try {
          const val = await env.KV.get(`cursor_${key}`);
          return json({ cursor: val || '' });
        } catch(e) { return json({ cursor: '' }); }
      }
      if (request.method === 'POST') {
        try {
          const { key, cursor } = await request.json();
          await env.KV.put(`cursor_${key || 'default'}`, cursor);
          return json({ ok: true });
        } catch(e) { return err('Failed to save cursor', 500); }
      }
    }

    // 公开端点（index.html 使用）
    if (path === '/api/parse' && request.method === 'POST') {
      return handleParse(request, env, json, err);
    }
    if (path === '/api/orders') {
      if (request.method === 'GET')  return getOrders(env, json, err);
      if (request.method === 'POST') return createOrder(request, env, json, err);
    }
    if (path === '/api/orders/by-code' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) return err('missing code');
      return getOrderByCode(code, env, json, err);
    }
    const omPublic = path.match(/^\/api\/orders\/(.+)$/);
    if (omPublic && request.method === 'PUT') {
      return updateOrder(decodeURIComponent(omPublic[1]), request, env, json, err);
    }
    if (path === '/api/products' && request.method === 'GET') {
      return getProducts(env, json, err);
    }

    // 需要鉴权的端点（admin.html 使用）
    if (path.startsWith('/api/')) {
      const authHeader = request.headers.get('Authorization') || '';
      if (authHeader.replace('Bearer ', '') !== env.ADMIN_TOKEN) {
        return err('Unauthorized', 401);
      }
      const om = path.match(/^\/api\/orders\/(.+)$/);
      if (om && request.method === 'DELETE') {
        return deleteOrder(decodeURIComponent(om[1]), env, json, err);
      }
      if (path === '/api/products' && request.method === 'PUT') {
        return saveProducts(request, env, json, err);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ============================================================
// 微信 Webhook 验证 (GET)
// ============================================================

async function handleWxVerify(request, env) {
  const url       = new URL(request.url);
  const signature = url.searchParams.get('msg_signature');
  const timestamp = url.searchParams.get('timestamp');
  const nonce     = url.searchParams.get('nonce');
  const echostr   = url.searchParams.get('echostr');

  if (!echostr) return new Response('Bad Request', { status: 400 });

  const parts = [env.WECHAT_TOKEN, timestamp, nonce, echostr].sort();
  const hash = await sha1(parts.join(''));
  if (hash !== signature) {
    return new Response('Invalid signature', { status: 403 });
  }

  try {
    const aesKeyBytes = base64ToBytes(env.WECHAT_AES_KEY + '=');
    const encBytes    = base64ToBytes(echostr);
    const iv          = encBytes.slice(0, 16);
    const ciphertext  = encBytes.slice(16);
    const key = await crypto.subtle.importKey('raw', aesKeyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
    const bytes = new Uint8Array(dec);
    const msgLen = new DataView(dec).getUint32(0, false);
    const msg = new TextDecoder().decode(bytes.slice(4, 4 + msgLen));
    return new Response(msg, { status: 200 });
  } catch (e) {
    console.error('decrypt error:', e.message);
    return new Response('error', { status: 500 });
  }
}


async function handleWxMessage(request, env, ctx) {
  const url       = new URL(request.url);
  const signature = url.searchParams.get('msg_signature');
  const timestamp = url.searchParams.get('timestamp');
  const nonce     = url.searchParams.get('nonce');
  const body      = await request.text();

  const encryptedContent = extractXmlTag(body, 'Encrypt');
  if (!encryptedContent) return new Response('OK', { status: 200 });

  const valid = await verifySignature(signature, timestamp, nonce, encryptedContent, env);
  if (!valid) return new Response('Invalid signature', { status: 403 });

  let plainXml;
  try {
    plainXml = await decryptMsg(encryptedContent, env);
  } catch (e) {
    console.error('Decrypt failed:', e);
    return new Response('OK', { status: 200 });
  }

  const msgType  = extractXmlTag(plainXml, 'MsgType');
  const event    = extractXmlTag(plainXml, 'Event');
  const openKfId = extractXmlTag(plainXml, 'OpenKfId') || env.WECHAT_KF_ID;

  if (msgType === 'event' && event === 'kf_msg_or_event') {
    const token = extractXmlTag(plainXml, 'Token');
    ctx.waitUntil(syncAndProcessMessages(openKfId, token, env).catch(console.error));
    return new Response('OK', { status: 200 });
  }

  return new Response('OK', { status: 200 });
}

// ============================================================
// 用户消息处理（状态机）
// ============================================================

async function syncAndProcessMessages(openKfId, token, env) {
  const accessToken = await getWxAccessToken(env);
  if (!accessToken) return;

  const cursorKey = `kf_cursor_${openKfId}`;
  const cursor = await env.KV.get(cursorKey) || '';

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${accessToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, token, limit: 20, open_kfid: openKfId })
    }
  );

  const data = await res.json();
  if (data.errcode !== 0) { console.error('sync_msg failed:', data); return; }
  if (data.next_cursor) await env.KV.put(cursorKey, data.next_cursor);

  const msgList = data.msg_list || [];
  if (!msgList.length) return;

  let products = [];
  try {
    const rows = await env.DB.prepare('SELECT id, product_name FROM products ORDER BY rowid').all();
    products = rows.results;
  } catch (e) {}

  let existingCodes = [];
  try {
    const rows = await env.DB.prepare('SELECT incoming FROM orders').all();
    for (const row of rows.results) {
      const incoming = JSON.parse(row.incoming || '[]');
      // FIX: only collect express_code, not pickup_code
      incoming.forEach(inc => {
        if (inc.express_code) existingCodes.push(inc.express_code);
      });
    }
  } catch (e) {}

  const productList = products.map(p => `${p.id}（${p.product_name}）`).join('、');

  for (const msg of msgList) {
    if (msg.msgtype !== 'text') continue;
    if (msg.origin !== 3) continue;

    const text     = msg.text?.content?.trim();
    const userId   = msg.external_userid;
    const kfId     = msg.open_kfid || openKfId;

    if (!text || !userId) continue;

    const done = await env.KV.get(`msg_${msg.msgid}`);
    if (done) continue;
    await env.KV.put(`msg_${msg.msgid}`, '1', { expirationTtl: 86400 * 7 });

    await handleUserMessage(text, userId, kfId, productList, existingCodes, env);
  }
}

async function handleUserMessage(text, userId, openKfId, productList, existingCodes, env) {
  const stateKey = `state_${userId}`;
  let state = null;
  try {
    const raw = await env.KV.get(stateKey);
    if (raw) state = JSON.parse(raw);
  } catch (e) {}

  if (['取消', '重新来', '重置', '算了'].some(w => text.includes(w))) {
    await env.KV.delete(stateKey);
    await sendWechatMsg(userId, openKfId, '已清空当前订单，可以重新开始。', env);
    return;
  }

  const currentData = state?.data || null;

  const result = await parseWithState(text, productList, existingCodes, currentData, env);

  if (!result) {
    await sendWechatMsg(userId, openKfId, '解析出错，请稍后再试。', env);
    return;
  }

  if (!result.valid) {
    if (result.partial_data) {
      await env.KV.put(stateKey, JSON.stringify({
        data: result.partial_data,
        last_updated: Date.now()
      }), { expirationTtl: STATE_TTL });
    }
    await sendWechatMsg(userId, openKfId, result.error_reply, env);
    return;
  }

  if (result.ready_to_submit) {
    const preview = buildConfirmPreview(result.data);
    await sendWechatMsg(userId, openKfId, preview + '\n\n回复"确认"提交，回复"取消"重新来。', env);

    await env.KV.put(stateKey, JSON.stringify({
      data: result.data,
      awaiting_confirm: true,
      last_updated: Date.now()
    }), { expirationTtl: STATE_TTL });
    return;
  }

  if (state?.awaiting_confirm && ['确认', '是', 'yes', '对', '好'].some(w => text.includes(w))) {
    const order = buildOrder(state.data, userId);
    try {
      await env.DB.prepare(
        `INSERT INTO orders (id, created_at, created_by, paid_status, picked_up, shipped, source, incoming, outgoing)
         VALUES (?, ?, ?, 0, 0, 0, 'wechat', ?, ?)`
      ).bind(
        order.id, order.created_at, order.created_by,
        JSON.stringify(order.incoming), JSON.stringify(order.outgoing)
      ).run();
      await env.KV.delete(stateKey);
      await sendWechatMsg(userId, openKfId, `✅ 订单已提交！\n订单号：${order.incoming.map(i => i.express_code).join('、')}`, env);
    } catch (e) {
      await sendWechatMsg(userId, openKfId, '提交失败，请稍后再试。', env);
    }
    return;
  }
}

// ============================================================
// Gemini 状态机 Parse
// ============================================================

async function parseWithState(text, productList, existingCodes, currentData, env) {
  const currentDataStr = currentData
    ? `目前已收集到的信息：\n${JSON.stringify(currentData, null, 2)}`
    : '目前还没有收集到任何信息。';

  const existingCodesStr = existingCodes.length > 0 ? existingCodes.join('、') : '无';

  const prompt = `你是一个转运订单助手，负责通过多轮对话收集订单信息。

可用产品列表（格式：产品ID（产品名称））：
${productList || '暂无产品信息'}

数据库中已有的订单号（不能重复）：
${existingCodesStr}

${currentDataStr}

客户最新消息：
${text}

你的任务是把客户最新消息里的信息合并到已有信息中，判断还缺什么。

请返回以下 JSON，不要有其他文字：
{
  "valid": false,
  "ready_to_submit": false,
  "error_reply": "用口语中文告诉客户还需要提供什么，或者哪里有问题",
  "partial_data": {
    "created_by": "填表人称呼（没有则空字符串）",
    "incoming": [
      {
        "express_code": "订单号",
        "pickup_code": "取货码",
        "products": [
          { "product_id": "产品ID", "product_name": "产品名称", "quantity": 数量 }
        ]
      }
    ],
    "outgoing": [
      {
        "name": "收件人姓名",
        "phone": "电话",
        "address": "地址",
        "products": [
          { "product_id": "产品ID", "product_name": "产品名称", "quantity": 数量 }
        ],
        "notes": ""
      }
    ]
  },
  "data": null
}

规则：
- 把客户新消息里的信息合并进已有信息，不要丢弃之前收集到的内容
- 信息完整（有订单号、取货码、至少一个收件人含姓名/电话/地址）且来件和寄件产品总数匹配时：valid=true，ready_to_submit=true，data 填完整数据，partial_data 可为 null
- 信息不完整时：valid=false，ready_to_submit=false，error_reply 说清楚还缺什么，partial_data 填已收集到的内容
- 产品无法识别先模糊匹配，实在不确定才询问
- 只对照"数据库中已有的订单号"列表检查重复，列表里没有就不算重复，不要自己猜测
- 来件和寄件产品总数不匹配时说明哪个产品数量对不上
- 只能用产品列表里有的产品
- 客户发来的信息可能用①②或数字编号分段，严格按编号分组提取信息，不要跨组混合
- 信息中的 "am"、"AM"、"pm"、"PM" 是产品名称缩写，不是时间
- error_reply 必须简洁，最多两句话，只说缺少什么或哪里不匹配
- 收件人没有写任何产品时，自动把所有来件单的产品合并后全部分配给该收件人（不限来件单数量）
- 只返回 JSON，不要 markdown 代码块`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    }
  );

  if (!res.ok) { console.error('Gemini error:', await res.text()); return null; }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Gemini parse failed:', raw);
    return null;
  }
}

// ============================================================
// 网页端单轮 Parse（/api/parse）
// ============================================================

async function handleParse(request, env, json, err) {
  try {
    const { text } = await request.json();
    if (!text || !text.trim()) return err('缺少文字内容');
    console.log('parse received text:', JSON.stringify(text.substring(0, 200)));

    let products = [];
    try {
      const rows = await env.DB.prepare('SELECT id, product_name FROM products ORDER BY rowid').all();
      products = rows.results;
    } catch (e) {}

    let existingCodes = [];
    try {
      const rows = await env.DB.prepare('SELECT incoming FROM orders').all();
      for (const row of rows.results) {
        const incoming = JSON.parse(row.incoming || '[]');
        // FIX: only collect express_code, not pickup_code
        incoming.forEach(inc => {
          if (inc.express_code) existingCodes.push(inc.express_code);
        });
      }
    } catch (e) {}

    const productList = products.map(p => `${p.id}（${p.product_name}）`).join('、');
    const existingCodesStr = existingCodes.length > 0 ? existingCodes.join('、') : '无';

    const prompt = `你是一个转运订单助手。请从以下文字中提取订单信息，返回 JSON。

可用产品列表（格式：产品ID（产品名称））：
${productList || '暂无产品信息'}

数据库中已有的订单号（不能重复）：
${existingCodesStr}

客户文字：
${text.trim()}

请提取以下信息并以 JSON 格式返回，不要有任何其他文字：
{
  "valid": true,
  "error_reply": "",
  "created_by": "填表人称呼（没有则空字符串）",
  "incoming": [
    {
      "express_code": "订单号，没有则空字符串",
      "pickup_code": "取货码，没有则空字符串",
      "products": [
        { "product_id": "产品ID", "product_name": "产品名称", "quantity": 数量 }
      ]
    }
  ],
  "outgoing": [
    {
      "name": "收件人姓名，没有则空字符串",
      "phone": "电话，没有则空字符串",
      "address": "地址，没有则空字符串",
      "products": [
        { "product_id": "产品ID", "product_name": "产品名称", "quantity": 数量 }
      ],
      "notes": ""
    }
  ]
}

规则：
1. 订单号已存在数据库 → valid=false，error_reply 说明已录入过，不输出其他字段
2. 同一次输入内订单号重复 → valid=false，error_reply 指出哪个重复，不输出其他字段
3. 产品无法识别（模糊匹配也无法确认）→ valid=false，error_reply 说明哪个产品无法识别，但仍然输出已提取到的 incoming 和 outgoing 数据，无法识别的产品从 outgoing 里删除
4. 只能用产品列表里有的产品，用了完全不存在的产品 → valid=false，同样仍然输出已提取的其他数据
5. 其他所有情况一律 valid=true，尽量提取已有信息，缺少的字段留空字符串或空数组
6. 收件人没有写任何产品时，自动把所有来件单的产品合并后全部分配给该收件人
7. 只对照"数据库中已有的订单号"列表检查重复，列表里没有就不算重复
8. 信息中的 "am"、"AM"、"pm"、"PM" 是产品名称缩写，不是时间
9. 客户发来的信息可能用①②或数字编号分段，严格按编号分组提取，不跨组混合
10. 只返回 JSON，不要 markdown 代码块`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );

    if (!res.ok) { console.error('Gemini error:', await res.text()); return err('AI 调用失败', 500); }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      return err('AI 解析失败', 500);
    }

    // Hard stop: duplicate/existing order number
    // Gemini may return empty arrays or null — treat both as no data
    if (!parsed.valid) {
      const hasIncoming = parsed.incoming && parsed.incoming.length > 0;
      const hasOutgoing = parsed.outgoing && parsed.outgoing.length > 0;
      if (!hasIncoming && !hasOutgoing) return json(parsed);
    }

    // Code-side: compute warnings (quantity mismatches + missing fields)
    const warnings = [];
    // If Gemini flagged an error (e.g. unrecognizable product) but still returned partial data,
    // include the error_reply as the first warning
    if (!parsed.valid && parsed.error_reply) {
      warnings.push(parsed.error_reply);
    }

    // 1. Missing fields in incoming
    (parsed.incoming || []).forEach((inc, i) => {
      const label = parsed.incoming.length > 1 ? `来件单 ${i + 1} ` : '';
      if (!inc.express_code) warnings.push(`${label}缺少订单号`);
      if (!inc.pickup_code)  warnings.push(`${label}缺少取货码`);
    });
    if (!parsed.incoming || parsed.incoming.length === 0) {
      warnings.push('缺少来件信息');
    }

    // 2. Missing fields in outgoing
    (parsed.outgoing || []).forEach((r, i) => {
      const label = `收件人 ${i + 1} `;
      if (!r.name)    warnings.push(`${label}缺少姓名`);
      if (!r.phone)   warnings.push(`${label}缺少电话`);
      if (!r.address) warnings.push(`${label}缺少地址`);
    });
    if (!parsed.outgoing || parsed.outgoing.length === 0) {
      warnings.push('缺少收件人信息');
    }

    // 3. Quantity mismatch: sum incoming vs outgoing per product_id
    const incTotals = {};
    (parsed.incoming || []).forEach(inc => {
      (inc.products || []).forEach(p => {
        incTotals[p.product_id] = (incTotals[p.product_id] || { qty: 0, name: p.product_name });
        incTotals[p.product_id].qty += p.quantity;
        incTotals[p.product_id].name = p.product_name;
      });
    });
    const outTotals = {};
    (parsed.outgoing || []).forEach(r => {
      (r.products || []).forEach(p => {
        outTotals[p.product_id] = (outTotals[p.product_id] || { qty: 0, name: p.product_name });
        outTotals[p.product_id].qty += p.quantity;
        outTotals[p.product_id].name = p.product_name;
      });
    });
    const allIds = new Set([...Object.keys(incTotals), ...Object.keys(outTotals)]);
    for (const id of allIds) {
      const inQty  = incTotals[id]?.qty  || 0;
      const outQty = outTotals[id]?.qty  || 0;
      const name   = incTotals[id]?.name || outTotals[id]?.name || id;
      if (inQty !== outQty) warnings.push(`${name} 来件${inQty}，寄件${outQty}`);
    }

    return json({ ...parsed, valid: true, warnings });
  } catch (e) {
    return err('解析出错: ' + e.message, 500);
  }
}

// ============================================================
// 辅助函数
// ============================================================

function buildOrder(data, userId) {
  return {
    id: 'ORD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    created_at: new Date().toISOString(),
    created_by: data.created_by || userId || '微信客户',
    source: 'wechat',
    incoming: data.incoming || [],
    outgoing: data.outgoing || [],
  };
}

function buildConfirmPreview(data) {
  const codes = (data.incoming || []).map(i => i.express_code).join('、');
  const lines = ['📋 订单确认', '', `订单号：${codes}`];
  (data.incoming || []).forEach((inc, i) => {
    if (data.incoming.length > 1) lines.push(`\n来件单 ${i + 1}：${inc.express_code}（取货码：${inc.pickup_code}）`);
    else lines.push(`取货码：${inc.pickup_code}`);
    (inc.products || []).forEach(p => lines.push(`  ${p.product_name} × ${p.quantity}`));
  });
  if ((data.outgoing || []).length > 0) {
    lines.push('\n收件人：');
    data.outgoing.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name}  ${r.phone}`);
      lines.push(`   ${r.address}`);
      (r.products || []).forEach(p => lines.push(`   ${p.product_name} × ${p.quantity}`));
      if (r.notes) lines.push(`   备注：${r.notes}`);
    });
  }
  return lines.join('\n');
}

// ============================================================
// 微信 Crypto
// ============================================================

async function verifySignature(signature, timestamp, nonce, encrypt, env) {
  const parts = [env.WECHAT_TOKEN, timestamp, nonce, encrypt].sort();
  const hash = await sha1(parts.join(''));
  return hash === signature;
}

async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function decryptMsg(encryptedB64, env) {
  const cleaned     = encryptedB64.replace(/\s/g, '');
  const aesKeyBytes = base64ToBytes(env.WECHAT_AES_KEY + '=');
  const encBytes    = base64ToBytes(cleaned);
  const iv          = encBytes.slice(0, 16);
  const ciphertext  = encBytes.slice(16);

  const key = await crypto.subtle.importKey(
    'raw', aesKeyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']
  );

  const lastCipherBlock = ciphertext.slice(-16);
  const desiredPad = new Uint8Array(16).fill(0x10);

  const dummyEncrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: lastCipherBlock },
      key,
      desiredPad
    )
  );
  const dummyBlock = dummyEncrypted.slice(0, 16);

  const extended = new Uint8Array(ciphertext.length + 16);
  extended.set(ciphertext, 0);
  extended.set(dummyBlock, ciphertext.length);

  const dec = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, extended)
  );

  const withoutDummy = dec.slice(0, dec.length - 16);
  const padLen = withoutDummy[withoutDummy.length - 1];
  const unpadded = (padLen > 0 && padLen <= 16)
    ? withoutDummy.slice(0, withoutDummy.length - padLen)
    : withoutDummy;

  const text = new TextDecoder('utf-8', { fatal: false }).decode(unpadded);
  const xmlStart = text.indexOf('<xml>');
  const xmlEnd   = text.indexOf('</xml>') + 6;
  if (xmlStart >= 0) return text.slice(xmlStart, xmlEnd);
  return text;
}

function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

// ============================================================
// 微信发送消息
// ============================================================

async function sendWechatMsg(toUser, openKfId, content, env) {
  const token = await getWxAccessToken(env);
  if (!token) return;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: toUser, open_kfid: openKfId, msgtype: 'text', text: { content } })
    }
  );
  const data = await res.json();
  if (data.errcode !== 0) console.error('WeChat send failed:', data);
}

async function getWxAccessToken(env) {
  const cached = await env.KV.get('wx_access_token');
  if (cached) return cached;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${env.WECHAT_CORP_ID}&corpsecret=${env.WECHAT_CORP_SECRET}`
  );
  const data = await res.json();
  if (data.errcode !== 0) { console.error('gettoken failed:', data); return null; }
  await env.KV.put('wx_access_token', data.access_token, { expirationTtl: 7000 });
  return data.access_token;
}

// ============================================================
// Orders API
// ============================================================

async function getOrders(env, json, err) {
  try {
    const rows = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    return json(rows.results.map(deserializeOrder));
  } catch (e) { return err('Failed to fetch orders: ' + e.message, 500); }
}

async function getOrderByCode(code, env, json, err) {
  try {
    const rows = await env.DB.prepare('SELECT * FROM orders').all();
    const order = rows.results.find(o => {
      const incoming = JSON.parse(o.incoming || '[]');
      return incoming.some(inc => inc.express_code === code || inc.pickup_code === code);
    });
    if (!order) return json({ found: false });
    return json({ found: true, order: deserializeOrder(order) });
  } catch (e) { return err('Failed to fetch order: ' + e.message, 500); }
}

async function createOrder(request, env, json, err) {
  try {
    const order = await request.json();
    if (!order.id || !order.incoming || !order.outgoing) return err('Missing required fields');
    await env.DB.prepare(
      `INSERT INTO orders (id, created_at, created_by, paid_status, picked_up, shipped, source, incoming, outgoing, external_userid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      order.id,
      order.created_at || new Date().toISOString(),
      order.created_by || '',
      order.paid_status ? 1 : 0,
      order.picked_up ? 1 : 0,
      order.shipped ? 1 : 0,
      order.source || 'manual',
      JSON.stringify(order.incoming),
      JSON.stringify(order.outgoing),
      order.external_userid || null
    ).run();
    return json({ ok: true, id: order.id });
  } catch (e) { return err('Failed to create order: ' + e.message, 500); }
}

async function updateOrder(id, request, env, json, err) {
  try {
    const order = await request.json();
    await env.DB.prepare(
      `UPDATE orders SET created_by=?, paid_status=?, picked_up=?, shipped=?, incoming=?, outgoing=? WHERE id=?`
    ).bind(
      order.created_by || '',
      order.paid_status ? 1 : 0,
      order.picked_up ? 1 : 0,
      order.shipped ? 1 : 0,
      JSON.stringify(order.incoming),
      JSON.stringify(order.outgoing),
      id
    ).run();
    return json({ ok: true });
  } catch (e) { return err('Failed to update order: ' + e.message, 500); }
}

async function deleteOrder(id, env, json, err) {
  try {
    await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(id).run();
    return json({ ok: true });
  } catch (e) { return err('Failed to delete order: ' + e.message, 500); }
}

function deserializeOrder(row) {
  return {
    ...row,
    paid_status: row.paid_status === 1,
    picked_up:   row.picked_up === 1,
    shipped:     row.shipped === 1,
    incoming:    JSON.parse(row.incoming || '[]'),
    outgoing:    JSON.parse(row.outgoing || '[]'),
  };
}

// ============================================================
// Products API
// ============================================================

async function getProducts(env, json, err) {
  try {
    const rows = await env.DB.prepare('SELECT uid, id, product_name FROM products ORDER BY rowid').all();
    return json(rows.results.map(r => ({ _uid: r.uid, id: r.id, product_name: r.product_name })));
  } catch (e) { return err('Failed to fetch products: ' + e.message, 500); }
}

async function saveProducts(request, env, json, err) {
  try {
    const { newList, changeMap } = await request.json();

    if (changeMap && Object.keys(changeMap).length > 0) {
      const changes = Object.values(changeMap);
      const rows = await env.DB.prepare('SELECT id, incoming, outgoing FROM orders').all();
      for (const row of rows.results) {
        const incoming = JSON.parse(row.incoming || '[]');
        const outgoing = JSON.parse(row.outgoing || '[]');
        let dirty = false;
        const updIncoming = incoming.map(inc => ({
          ...inc,
          products: inc.products.map(p => {
            const ch = changes.find(c => c.old_id === p.product_id);
            if (!ch) return p;
            dirty = true;
            return { ...p, product_id: ch.new_id, product_name: ch.new_name };
          })
        }));
        const updOutgoing = outgoing.map(r => ({
          ...r,
          products: r.products.map(p => {
            const ch = changes.find(c => c.old_id === p.product_id);
            if (!ch) return p;
            dirty = true;
            return { ...p, product_id: ch.new_id, product_name: ch.new_name };
          })
        }));
        if (dirty) {
          await env.DB.prepare('UPDATE orders SET incoming=?, outgoing=? WHERE id=?')
            .bind(JSON.stringify(updIncoming), JSON.stringify(updOutgoing), row.id).run();
        }
      }
    }

    for (const p of newList) {
      await env.DB.prepare(
        `INSERT INTO products (uid, id, product_name) VALUES (?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET id=excluded.id, product_name=excluded.product_name`
      ).bind(p._uid, p.id, p.product_name).run();
    }

    if (newList.length > 0) {
      const placeholders = newList.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM products WHERE uid NOT IN (${placeholders})`)
        .bind(...newList.map(p => p._uid)).run();
    }

    return json({ ok: true });
  } catch (e) { return err('Failed to save products: ' + e.message, 500); }
}