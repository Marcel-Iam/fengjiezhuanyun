// ============================================================
// 凤姐转运 - 微信消息处理服务（部署在 Render）
//
// 环境变量：
//   WECHAT_TOKEN         企业微信验证 Token
//   WECHAT_AES_KEY       企业微信 AES 密钥（43字节base64）
//   WECHAT_CORP_ID       企业微信企业ID
//   WECHAT_CORP_SECRET   自建应用 Secret
//   WECHAT_KF_ID         微信客服账号 open_kfid
//   GEMINI_API_KEY       Gemini API key
//   WORKER_URL           Cloudflare Worker URL
//   ADMIN_TOKEN          Cloudflare Worker 的管理员 token
//   PORT                 端口（Render 自动设置）
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));

const STATE_TTL = 30 * 60 * 1000; // 30分钟

// 内存状态存储（简单版，单实例够用）
const userStates = new Map();

// ============================================================
// 路由
// ============================================================

// 企业微信域名验证文件
app.get('/WW_verify_tBq5D4siarKD8kCW.txt', (req, res) => {
  res.type('text/plain').send('tBq5D4siarKD8kCW');
});

// 健康检查
app.get('/', (req, res) => res.send('OK'));

// 微信 Webhook GET 验证
app.get('/wx', async (req, res) => {
  const { msg_signature, signature, timestamp, nonce, echostr } = req.query;
  const sig = msg_signature || signature;
  if (!echostr) return res.status(400).send('Bad Request');

  const parts = [process.env.WECHAT_TOKEN, timestamp, nonce, echostr].sort();
  const hash  = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  if (hash !== sig) return res.status(403).send('Invalid signature');

  try {
    const msg = decryptEchostr(echostr);
    res.type('text/plain').send(msg);
  } catch (e) {
    res.type('text/plain').send(echostr);
  }
});

// 微信 Webhook POST 消息
app.post('/wx', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  const body = req.body;

  const encryptedContent = extractXmlTag(body, 'Encrypt');
  if (!encryptedContent) return res.send('OK');

  const valid = verifySignature(msg_signature, timestamp, nonce, encryptedContent);
  if (!valid) return res.status(403).send('Invalid signature');

  let plainXml;
  try {
    plainXml = decryptMsg(encryptedContent);
  } catch (e) {
    console.error('Decrypt failed:', e.message);
    return res.send('OK');
  }

  res.send('OK'); // 立即返回，异步处理

  const msgType = extractXmlTag(plainXml, 'MsgType');
  const event   = extractXmlTag(plainXml, 'Event');
  const openKfId = extractXmlTag(plainXml, 'OpenKfId') || process.env.WECHAT_KF_ID;

  if (msgType === 'event' && event === 'kf_msg_or_event') {
    const token = extractXmlTag(plainXml, 'Token');
    syncAndProcessMessages(openKfId, token).catch(console.error);
  }
});

// ============================================================
// 微信消息同步
// ============================================================

async function syncAndProcessMessages(openKfId, token) {
  const accessToken = await getWxAccessToken();
  if (!accessToken) return;

  // 从 Worker API 读取 cursor（持久化，重启不丢）
  let cursor = '';
  try {
    const cr = await fetch(`${process.env.WORKER_URL}/api/cursor?key=${openKfId}`);
    if (cr.ok) { const cd = await cr.json(); cursor = cd.cursor || ''; }
  } catch(e) {}

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
  if (data.next_cursor) {
    try {
      await fetch(`${process.env.WORKER_URL}/api/cursor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: openKfId, cursor: data.next_cursor })
      });
    } catch(e) {}
  }

  const msgList = data.msg_list || [];
  if (!msgList.length) return;

  // 加载产品列表
  let products = [];
  try {
    const r = await fetch(`${process.env.WORKER_URL}/api/products`);
    products = await r.json();
  } catch (e) { console.error('Failed to load products:', e); }

  // 加载已有订单号
  let existingCodes = [];
  try {
    const r = await fetch(`${process.env.WORKER_URL}/api/orders`);
    const orders = await r.json();
    for (const o of orders) {
      for (const inc of (o.incoming || [])) {
        if (inc.express_code) existingCodes.push(inc.express_code);
      }
    }
  } catch (e) { console.error('Failed to load orders:', e); }

  const productList = products.map(p => `${p.id}（${p.product_name}）`).join('、');

  for (const msg of msgList) {
    if (msg.msgtype !== 'text' || msg.origin !== 3) continue;
    const text   = msg.text?.content?.trim();
    const userId = msg.external_userid;
    const kfId   = msg.open_kfid || openKfId;
    if (!text || !userId) continue;

    // 防重
    const doneKey = `msg_${msg.msgid}`;
    if (userStates.get(doneKey)) continue;
    userStates.set(doneKey, true);
    setTimeout(() => userStates.delete(doneKey), 7 * 24 * 60 * 60 * 1000);

    await handleUserMessage(text, userId, kfId, productList, existingCodes);
  }
}

// ============================================================
// 用户消息处理（状态机）
// ============================================================

async function handleUserMessage(text, userId, openKfId, productList, existingCodes) {
  const stateKey = `state_${userId}`;

  // 确保会话处于服务中状态
  await ensureSessionActive(userId, openKfId);

  // 读取客户上次使用的填表人名字
  let savedName = null;
  try {
    const nr = await fetch(`${process.env.WORKER_URL}/api/customer_name?external_userid=${userId}`);
    if (nr.ok) {
      const nd = await nr.json();
      savedName = nd.created_by || null;
    }
  } catch(e) {}

  // 取消指令
  if (['取消', '重新来', '重置', '算了'].some(w => text.includes(w))) {
    userStates.delete(stateKey);
    await sendWechatMsg(userId, openKfId, '已清空当前订单，可以重新开始。');
    return;
  }

  const stateEntry = userStates.get(stateKey);
  const state = stateEntry?.data || null;

  // 修改模式下收到新信息
  if (stateEntry?.edit_mode) {
    if (text.trim() === '取消') {
      userStates.delete(stateKey);
      await sendWechatMsg(userId, openKfId, '已取消修改，可以重新开始。');
      return;
    }
    // 把新信息当成完整订单处理，解析后进入确认流程（edit_data）
    const editResult = await parseWithState(text, productList, [], null, savedName);
    if (!editResult || !editResult.valid || !editResult.ready_to_submit) {
      const errMsg = editResult?.error_reply || '无法识别修改内容，请重新复制原始信息并修改后发送。';
      await sendWechatMsg(userId, openKfId, errMsg);
      return;
    }
    const editData = editResult.data || editResult.partial_data;
    const preview = buildConfirmPreview(editData);
    await sendWechatMsg(userId, openKfId, preview);
    await sendWechatMsg(userId, openKfId, '回复"确认"提交修改，回复"取消"重新开始。如需再次修改，请复制上面内容修改后重发。');
    userStates.set(stateKey, {
      awaiting_confirm: true,
      edit_mode: true,
      edit_order_id: stateEntry.edit_order_id,
      data: editData,
      last_updated: Date.now()
    });
    setTimeout(() => userStates.delete(stateKey), STATE_TTL);
    return;
  }

  // 待确认状态下用户回复"确认"
  if (stateEntry?.awaiting_confirm && (text.trim() === '确认' || text.trim() === 'yes')) {
    if (stateEntry?.edit_mode && stateEntry?.edit_order_id) {
      // 修改模式：UPDATE 现有订单
      const updatedOrder = { ...state, external_userid: userId };
      try {
        const r = await fetch(`${process.env.WORKER_URL}/api/orders/${encodeURIComponent(stateEntry.edit_order_id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatedOrder)
        });
        if (!r.ok) throw new Error(`API error ${r.status}`);
        userStates.delete(stateKey);
        await sendWechatMsg(userId, openKfId, `✅ 订单已修改！\n订单号：${(state.incoming || []).map(i => i.express_code).join('、')}`);
      } catch (e) {
        await sendWechatMsg(userId, openKfId, '修改失败，请稍后再试。');
      }
      return;
    }

    const order = buildOrder(state, userId);
    try {
      const r = await fetch(`${process.env.WORKER_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });
      if (!r.ok) throw new Error(`API error ${r.status}`);
      userStates.delete(stateKey);
      // 保存客户填表人名字
      if (order.created_by && order.created_by !== '微信客户') {
        try {
          const res = await fetch(`${process.env.WORKER_URL}/api/customer_name`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ external_userid: userId, created_by: order.created_by })
          });
        } catch(e) {}
      }
      await sendWechatMsg(userId, openKfId, `✅ 订单已提交！\n订单号：${order.incoming.map(i => i.express_code).join('、')}`);
    } catch (e) {
      await sendWechatMsg(userId, openKfId, '提交失败，请稍后再试。');
    }
    return;
  }

  // 代码层面检查重复订单号（只检查 existingCodes 里的 express_code，不用正则抓取货码）
  const codePattern = /\b(\d{5,10})\b/g;
  const mentionedCodes = [...new Set(text.match(codePattern) || [])];
  const duplicateCodes = mentionedCodes.filter(code => existingCodes.includes(code));
  if (duplicateCodes.length > 0) {
    for (const code of duplicateCodes) {
      try {
        const r = await fetch(`${process.env.WORKER_URL}/api/orders/by-code?code=${code}`);
        const d = await r.json();
        // only treat as duplicate if matched as express_code (not pickup_code)
        if (d.found && d.order.incoming.some(inc => inc.express_code === code)) {
          if (d.order.external_userid === userId) {
            const existingOrder = d.order;
            const preview = buildConfirmPreview(existingOrder);
            await sendWechatMsg(userId, openKfId, `检测到订单号 ${code} 已存在，切换为修改模式。\n\n以下是当前系统记录的原有订单信息：`);
            await sendWechatMsg(userId, openKfId, preview);
            await sendWechatMsg(userId, openKfId, '请复制上面整个信息，手动修改需要调整的内容，然后发送给我。\n回复"取消"退出修改模式。');
            userStates.set(stateKey, {
              edit_mode: true,
              edit_order_id: existingOrder.id,
              last_updated: Date.now()
            });
            setTimeout(() => userStates.delete(stateKey), STATE_TTL);
          } else {
            await sendWechatMsg(userId, openKfId, `发现重复订单号 ${code}，但该订单为其他微信账号提交。为确保用户信息安全，请切换至该微信账号提交修改。`);
          }
          return;
        }
      } catch(e) {}
    }
  }

  const result = await parseWithState(text, productList, existingCodes, state, savedName);

  if (!result) {
    await sendWechatMsg(userId, openKfId, '解析出错，请稍后再试。');
    return;
  }

  if (!result.valid) {
    if (result.partial_data) {
      // 保护：如果 Gemini 把已有的 incoming 丢掉了，用旧状态补回
      const merged = result.partial_data;
      if (state && state.incoming && state.incoming.length > 0) {
        if (!merged.incoming || merged.incoming.length === 0) {
          merged.incoming = state.incoming;
        }
      }
      if (state && state.created_by && !merged.created_by) {
        merged.created_by = state.created_by;
      }
      userStates.set(stateKey, { data: merged, last_updated: Date.now() });
      setTimeout(() => userStates.delete(stateKey), STATE_TTL);
    }
    await sendWechatMsg(userId, openKfId, result.error_reply);
    return;
  }

  if (result.ready_to_submit) {
    const finalData = result.data || result.partial_data;
    const preview = buildConfirmPreview(finalData);
    await sendWechatMsg(userId, openKfId, preview);
    await sendWechatMsg(userId, openKfId, '回复"确认"提交，回复"取消"重新来。如需修改，请复制上面的内容手动修改后重新发送。');
    userStates.set(stateKey, { data: finalData, awaiting_confirm: true, last_updated: Date.now() });
    setTimeout(() => userStates.delete(stateKey), STATE_TTL);
  }
}

// ============================================================
// Gemini 状态机 Parse
// ============================================================

async function parseWithState(text, productList, existingCodes, currentData, savedName) {
  const currentDataStr = currentData
    ? `目前已收集到的信息：\n${JSON.stringify(currentData, null, 2)}`
    : '目前还没有收集到任何信息。';
  const savedNameStr = savedName ? `客户上次使用的填表人称呼是：${savedName}，如果本次没有提供填表人称呼，自动使用这个名字。` : '';

  const existingCodesStr = existingCodes.length > 0 ? existingCodes.join('、') : '无';

  const prompt = `你是一个转运订单助手，负责通过多轮对话收集订单信息。

可用产品列表（格式：产品ID（产品名称））：
${productList || '暂无产品信息'}

数据库中已有的订单号和取货码（不能重复）：
${existingCodesStr}

${currentDataStr}

${savedNameStr}

信息格式说明：客户发来的信息可能用①②或数字编号分段，①②等编号用于区分不同的来件单或收件人，请严格按编号分组提取信息，不要跨组混合。

客户最新消息：
${text}

严格按以下 JSON 格式返回，不要有任何其他文字或 markdown：
{
  "valid": false,
  "ready_to_submit": false,
  "error_reply": "用口语中文说明缺少什么或哪里有问题，信息完整时留空",
  "partial_data": {
    "created_by": "填表人称呼，没有则空字符串",
    "incoming": [
      {
        "express_code": "订单号，必填",
        "pickup_code": "取货码，必填",
        "products": [
          { "product_id": "产品ID（来自产品列表）", "product_name": "产品名称", "quantity": 数量 }
        ]
      }
    ],
    "outgoing": [
      {
        "name": "收件人姓名",
        "phone": "联系电话",
        "address": "收件地址",
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
1. 把客户新消息里的信息合并进已有信息，不要丢弃之前收集到的内容。如果客户一条消息里包含了所有必要信息，直接判断为完整并提交，不要再追问其他内容
2. partial_data 始终填入已收集到的所有内容（即使信息不完整）
3. 信息完整条件：有订单号、取货码、至少一个收件人（含姓名/电话/地址）、来件和寄件产品总数匹配（不强制要求填表人称呼）
4. 信息完整时：valid=true，ready_to_submit=true，data 填与 partial_data 相同的完整数据，error_reply 留空
5. 信息不完整时：valid=false，ready_to_submit=false，data=null，error_reply 说清楚还缺什么
6. 产品先模糊匹配产品列表，实在无法确认才询问
7. 订单号或取货码重复检查：只对照"数据库中已有的订单号和取货码"那个列表，列表里有才算重复。列表里没有就不算重复，不要自己猜测或质疑
8. 来件和寄件产品总数不匹配时：valid=false，说明哪个产品数量对不上
9. 只能使用产品列表里有的产品ID
10. 只返回 JSON，不要 markdown 代码块
10.5. 信息中的 "am"、"AM"、"pm"、"PM" 是产品名称缩写，不是时间。例如 "6am" 表示 AM 产品 6个，"pm18瓶" 表示 PM 产品 18瓶
10.6. error_reply 必须简洁，最多两句话，只说缺少什么或哪里不匹配，不要解释计算过程
11. 如果收件人没有写任何产品，自动把所有来件单的产品合并后全部分配给该收件人，不需要客户再填寄件产品（不限来件单数量）
12. 如果客户说要修改、更改、变更已有订单，不要尝试处理，直接回复：修改订单请通过以下链接操作：https://marcel-iam.github.io/fengjiezhuanyun/ ，在页面上方输入订单号即可查找和修改
13. 如果客户发来的新消息里包含订单号，且与已有 partial_data 里的订单号不同，用新消息的信息完全替换旧信息，不要合并`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
// 辅助函数
// ============================================================

function buildOrder(data, userId) {
  return {
    id: 'ORD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    created_at: new Date().toISOString(),
    created_by: data.created_by && data.created_by !== '系统助手' ? data.created_by : '微信客户',
    source: 'wechat',
    incoming: data.incoming || [],
    outgoing: data.outgoing || [],
    external_userid: userId || null,
  };
}

function buildConfirmPreview(data) {
  const lines = ['📋 订单确认', ''];
  lines.push(`填表人：${data.created_by || '未填写'}`);
  lines.push('');
  (data.incoming || []).forEach((inc, i) => {
    lines.push(`来件单 ${i + 1}：${inc.express_code}（取货码：${inc.pickup_code}）`);
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
// 微信 API
// ============================================================

let cachedToken = null;
let tokenExpiry = 0;

async function getWxAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${process.env.WECHAT_CORP_ID}&corpsecret=${process.env.WECHAT_CORP_SECRET}`
  );
  const data = await res.json();
  if (data.errcode !== 0) { console.error('gettoken failed:', data); return null; }
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 7000 * 1000;
  return cachedToken;
}

async function ensureSessionActive(userId, openKfId) {
  const token = await getWxAccessToken();
  if (!token) return;
  try {
    // 查询当前会话状态
    const stateRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/get?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ open_kfid: openKfId, external_userid: userId })
      }
    );
    const stateData = await stateRes.json();
    console.log('service_state:', stateData);

    const state = stateData.service_state;
    let targetState = null;
    let body = { open_kfid: openKfId, external_userid: userId };

    if (state === 0) {
      // 未处理 → 智能助手接待
      targetState = 1;
      body.service_state = 1;
    } else if (state === 2) {
      // 待接入池 → 人工接待
      targetState = 3;
      body.service_state = 3;
      body.servicer_userid = 'RenKaiLing';
    }

    if (targetState !== null) {
      const transRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/trans?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      const transData = await transRes.json();
      console.log('trans_state:', transData);
    }
  } catch(e) {
    console.log('ensureSessionActive error (ignored):', e.message);
  }
}

async function sendWechatMsg(toUser, openKfId, content) {
  const token = await getWxAccessToken();
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

// ============================================================
// 微信加解密
// ============================================================

function decryptEchostr(echostr) {
  const aesKey = Buffer.from(process.env.WECHAT_AES_KEY + '=', 'base64');
  const enc    = Buffer.from(echostr, 'base64');
  const iv     = enc.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(enc.slice(16)), decipher.final()]);
  const msgLen = dec.readUInt32BE(0);
  return dec.slice(4, 4 + msgLen).toString('utf-8');
}

function decryptMsg(encryptedB64) {
  const aesKey = Buffer.from(process.env.WECHAT_AES_KEY + '=', 'base64');
  const enc    = Buffer.from(encryptedB64, 'base64');
  const iv     = enc.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  const dec = Buffer.concat([decipher.update(enc.slice(16)), decipher.final()]);
  const text = dec.toString('utf-8');
  const xmlStart = text.indexOf('<xml>');
  const xmlEnd   = text.indexOf('</xml>') + 6;
  if (xmlStart >= 0) return text.slice(xmlStart, xmlEnd);
  return text;
}

function verifySignature(signature, timestamp, nonce, encrypt) {
  const parts = [process.env.WECHAT_TOKEN, timestamp, nonce, encrypt].sort();
  const hash  = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  return hash === signature;
}

function extractXmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

// ============================================================
// 启动
// ============================================================

app.get('/setup', async (req, res) => {
  try {
    const token = await getWxAccessToken();
    const result = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/kf/servicer/add?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          open_kfid: process.env.WECHAT_KF_ID,
          userid_list: ['RenKaiLing']
        })
      }
    );
    const text = await result.text();
    res.send(text);
  } catch(e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));