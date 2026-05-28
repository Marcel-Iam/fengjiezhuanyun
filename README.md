# 凤姐转运 - 订单管理系统

## 项目概述

| 组件 | 平台 | URL |
|---|---|---|
| 前端（index.html / admin.html） | Cloudflare Pages | `https://fengjiezhuanyun.marceliam.com` |
| API + 数据库 | Cloudflare Worker + D1 | `https://api.marceliam.com` |
| 微信消息处理 | Render | `https://fengjiezhuanyun-render.onrender.com` |
| 微信 Webhook 域名 | Cloudflare DNS → Render | `https://wx.marceliam.com` |

GitHub 仓库：`Marcel-Iam/fengjiezhuanyun`（monorepo）


## 文件结构

```
GitHub repo (fengjiezhuanyun) — monorepo：
├── pages/
│   ├── index.html      客户下单页面（含 AI 聊天窗口）
│   └── admin.html      管理后台
└── render/
    ├── index.js        Express 服务，处理微信 Webhook 和多轮对话
    └── package.json

本地（不推送 GitHub，.gitignore 保护）：
└── worker-cloudflare/
    ├── worker.js       所有 API 逻辑
    └── wrangler.toml   binding 配置和环境变量

Cloudflare D1 (fengjiezhuanyun):
├── orders 表           订单数据
├── products 表         产品列表
└── customer_names 表   客户填表人名字记忆
```


## 数据库结构

### orders 表

```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  created_by TEXT,
  paid_status INTEGER DEFAULT 0,
  picked_up INTEGER DEFAULT 0,
  shipped INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual',
  incoming TEXT,
  outgoing TEXT,
  external_userid TEXT
);
```

订单对象结构：

```json
{
  "id": "ORD_1715200000001_a1b2",
  "created_at": "2025-05-08T10:30:00.000Z",
  "created_by": "小陈",
  "paid_status": false,
  "picked_up": false,
  "shipped": false,
  "source": "wechat",
  "external_userid": "wmeoiMTQAAoLj3jAXdTou7Hl6RT1ewyA",
  "incoming": [
    {
      "express_code": "636157",
      "pickup_code": "249247",
      "products": [
        { "product_id": "am", "product_name": "AM丸Cap (瓶)", "quantity": 24 }
      ]
    }
  ],
  "outgoing": [
    {
      "name": "林京子",
      "phone": "13124341581",
      "address": "辽宁省沈阳市沈北新区...",
      "products": [
        { "product_id": "am", "product_name": "AM丸Cap (瓶)", "quantity": 24 }
      ],
      "notes": ""
    }
  ]
}
```

关键字段：

- `id`：格式 `ORD_{timestamp}_{random4}`
- `paid_status`：运费是否已收（D1 里存 0/1）
- `picked_up`：货物是否已从快递处取回
- `shipped`：货物是否已寄出
- `source`：`manual`（手动填单）或 `wechat`（微信客服）
- `external_userid`：微信客户的唯一 ID（`wm` 开头），用于识别哪个账号提交了订单
- `incoming`：来件信息数组，每张来件单有 `express_code`、`pickup_code`、`products`
- `outgoing`：收件人列表，每个收件人有 `name`、`phone`、`address`、`products`、`notes`

### products 表

```sql
CREATE TABLE products (
  uid TEXT PRIMARY KEY,
  id TEXT UNIQUE,
  product_name TEXT
);
```

- `uid`：永久唯一标识符，创建后不变
- `id`：产品短码，显示在表格和 PDF 表头
- `product_name`：产品全称

### customer_names 表

```sql
CREATE TABLE customer_names (
  external_userid TEXT PRIMARY KEY,
  created_by TEXT,
  updated_at TEXT
);
```

存储微信客户的上次填表人称呼，下次聊天自动填入。


## Cloudflare Worker API 端点

| 方法 | 路径 | 鉴权 | 功能 |
|---|---|---|---|
| POST | `/api/parse` | 无 | AI 解析订单文字（网页端） |
| GET | `/api/orders` | 无 | 读取所有订单 |
| POST | `/api/orders` | 无 | 新增订单 |
| PUT | `/api/orders/:id` | 无 | 修改订单 |
| DELETE | `/api/orders/:id` | 需要 | 删除订单 |
| GET | `/api/orders/by-code` | 无 | 按订单号查询（含 external_userid） |
| GET | `/api/products` | 无 | 读取产品列表 |
| PUT | `/api/products` | 需要 | 保存产品列表（含订单同步） |
| GET | `/api/cursor` | 无 | 读取 sync_msg cursor |
| POST | `/api/cursor` | 无 | 保存 sync_msg cursor |
| GET | `/api/customer_name` | 无 | 读取客户填表人名字 |
| POST | `/api/customer_name` | 无 | 保存客户填表人名字 |

鉴权方式：`Authorization: Bearer {ADMIN_TOKEN}`。


## Cloudflare Worker 环境变量

| 变量名 | 说明 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `ADMIN_TOKEN` | admin.html 鉴权 token，当前值：`fj_2025_xK9mP3` |

Bindings：
- `DB` → D1 数据库 `fengjiezhuanyun`
- `KV` → KV 命名空间（存 cursor）

Worker Placement 设为 **Smart**（避免 Gemini 地区限制错误）。


## 微信客服接入

### 配置信息

- 企业ID：`ww38686c7fe12538c0`
- 自建应用 AgentId：`1000002`
- 微信客服账号：凤姐转运客服，open_kfid：`kfc29e3bd6ee29fe5b4`
- 接收消息 URL：`https://wx.marceliam.com/wx`
- Token：`D11Cqix3`
- EncodingAESKey：`paOpwHEomR9pee1V5JQGOWEUCpgXUxcAQryg5XuFDpX`
- 接待人员：`RenKaiLing`（需处于"正在接待"状态）
- 企业可信IP：`74.220.50.240`（Render 出口 IP，如变化需更新）

### 消息流程

```
客户发微信消息
    ↓
企业微信 POST → wx.marceliam.com/wx（Render）
    ↓
Render 解密 kf_msg_or_event 事件
    ↓
调用 sync_msg API 拉取实际消息
    ↓
检查会话状态（state 0→1，state 2→3）
    ↓
检查重复订单号（代码层面，仅比对 express_code，并验证 by-code API 确认匹配类型）
    ↓ 同一账号重复 → 修改模式
    ↓ 不同账号重复 → 拒绝
    ↓ 无重复 → 正常流程
    ↓
先发"收到你的信息，系统正在分析，请稍等…"（取消/确认等简单指令跳过）
    ↓
Gemini 提取数据（只负责提取，不判断完整性）
    ↓
硬编码 validateOrder 校验（缺字段、产品数量不匹配、无法识别产品）
    ↓ 有问题 → 发三条消息：标题、已提取内容预览、问题列表
    ↓ 无问题 → 发三条消息：标题、确认预览内容、操作提示
    ↓
客户回复"确认" → 写入 D1
    ↓
回复成功
```

### 多轮对话状态机

状态存在 Render 内存，30分钟无消息自动清空。

**正常流程：**
1. 客户发消息 → Gemini 提取数据 → 硬编码校验缺什么
2. 有问题 → 发三条消息：`📋 已提取到的信息：` / 已提取内容 / `⚠️ 以下信息有问题：...`
3. 无问题 → 发三条消息：`📋 订单确认` / 预览内容（可直接复制修改后重发）/ 操作提示
4. 客户回复"确认" → POST 新建订单（含 `external_userid`）
5. 客户回复"取消" → 清空状态

**修改模式（edit_mode）：**
1. 客户发含已存在订单号的消息
2. 查 `/api/orders/by-code`，判断 `external_userid`
3. 同一账号 → 发三条消息（提示切换修改模式、现有订单预览、操作说明）
4. 不同账号 → 拒绝，提示安全原因
5. 修改模式下，用户复制修改后重发 → Gemini 解析（不检查重复）→ 确认预览
6. 确认 → PUT 更新订单

**确认触发词：** 只接受精确的 `"确认"` 或 `"yes"`

**取消触发词：** `"取消"`、`"重新来"`、`"重置"`、`"算了"`


### Gemini Prompt 规则（微信端）

Gemini **只负责提取和合并数据**，不判断完整性，不生成报错文字。返回格式：

```json
{
  "created_by": "",
  "incoming": [...],
  "outgoing": [...],
  "unrecognized_products": ["无法匹配的产品名"]
}
```

提取规则：
1. 把客户新消息的信息合并进已有信息，不丢弃之前收集到的内容
2. 所有字段尽量提取，缺少的留空字符串或空数组
3. 产品先模糊匹配产品列表，实在无法确认才放入 `unrecognized_products`
4. 只能使用产品列表里有的产品ID（`product_id` 必须严格使用产品列表里的 ID 字段）
5. 收件人没有写产品时，自动把所有来件单的产品合并后全部分配给该收件人
6. 客户发来的新消息包含不同订单号时，用新信息完全替换旧信息
7. 信息可能用①②分段，严格按编号分组提取，不跨组混合
8. `"am"`、`"AM"`、`"pm"`、`"PM"` 是产品名称缩写，不是时间

**硬编码 `validateOrder` 负责校验（Render index.js）：**
- 缺来件单、缺订单号、缺取货码、缺来件产品
- 缺收件人、缺姓名/电话/地址
- 来件和寄件各产品总数不一致（逐产品对比）
- `unrecognized_products` 不为空

**产品列表传给 Gemini 的格式：**
```
产品ID: AM丸Cap (瓶) | 名称: AM丸Cap (瓶)
产品ID: 沛泉 | 名称: 沛泉(白藜芦醇) Reserve
```
ID 和名称明确分开，防止 Gemini 把格式字符串写成 product_id。


### Gemini Prompt 规则（网页端 /api/parse）

网页端为单轮解析，两阶段处理：

**第一阶段：Gemini 只负责提取**，不做任何数量计算或缺字段判断。只有以下情况返回 `valid=false`：
- 订单号已存在数据库
- 同一次输入内订单号重复
- 产品完全无法识别（模糊匹配也无法确认）

其他所有情况（包括缺字段）一律 `valid=true`，尽量提取已有信息，缺少的字段留空。

**第二阶段：代码计算 warnings**，Gemini 返回后由 Worker 代码处理：
- 缺来件字段 → `"缺少订单号"`、`"缺少取货码"`
- 缺收件人字段 → `"收件人 1 缺少姓名"`、`"收件人 1 缺少电话"`、`"收件人 1 缺少地址"`
- 来件和寄件产品总数不匹配 → `"产品名 来件X，寄件Y"`（只列数量不同的）
- 如果 Gemini 返回了 `error_reply`（如产品无法识别）但仍有部分数据，`error_reply` 作为第一条 warning，继续计算其他 warnings，最终以 `valid=true` 返回

硬拒绝（`valid=false`，不返回任何数据）：订单号重复或已存在数据库，且 Gemini 没有返回任何 `incoming`/`outgoing` 数据。

只对照"数据库中已有的订单号"列表检查重复（不含取货码）。


## Render 环境变量

| 变量名 | 值 |
|---|---|
| `WECHAT_TOKEN` | `D11Cqix3` |
| `WECHAT_AES_KEY` | `paOpwHEomR9pee1V5JQGOWEUCpgXUxcAQryg5XuFDpX` |
| `WECHAT_CORP_ID` | `ww38686c7fe12538c0` |
| `WECHAT_CORP_SECRET` | 自建应用 Secret |
| `WECHAT_KF_ID` | `kfc29e3bd6ee29fe5b4` |
| `GEMINI_API_KEY` | Gemini API key |
| `WORKER_URL` | `https://api.marceliam.com` |
| `ADMIN_TOKEN` | `fj_2025_xK9mP3` |


## AI 模型

使用 `gemini-3.1-flash-lite`，Google AI Studio 免费额度（RPD 500，RPM 15）。

网页端和微信端分别调用，每次实时读取最新产品列表和已有订单号（仅 `express_code`，不含 `pickup_code`）。

Worker Placement 必须设为 Smart，否则某些 Cloudflare 边缘节点会触发 Gemini 地区限制错误。


## index.html - 客户下单页面

托管在 `fengjiezhuanyun.marceliam.com`（Cloudflare Pages）。

**上方（可折叠）：** 查找 / 修改已提交订单，输入任意来件单号搜寻。

**下方（金色边框）：** 提交新订单，填表人、来件信息（可增删）、收件人（可增删）。

**右下角浮动按钮：** AI 智能填单，粘贴文字后 AI 解析，确认后填入表单。

AI 解析行为：
- 缺必填字段、订单号重复、无法识别产品 → 显示红色错误，不提供填入选项
- 产品数量不匹配 → 显示解析结果，预览下方附橙色警告，仍可填入表单；填入后 toast 提示在收件人备注写明特殊情况
- 收件人备注：如客户原始信息有备注，AI 正常填入；不自动追加数量警告文字

来件和寄件产品数量校验（不匹配时弹确认框）。修改订单不改动 `paid_status`。


## admin.html - 管理后台

密码：`456456`，五个分页：来件管理、寄件管理、历史档案、产品管理、搜索。

顶部分页栏右侧有「+ 添加订单」按钮，弹出 overlay 直接在后台新建订单。

**来件管理：** 未取货 / 已取货子视图。产品列显示短码，已付运费 checkbox 勾选/取消都弹确认框。支持生成取件单 PDF、批量标记已取货。

**寄件管理：** 未寄出 / 已寄出子视图。订单号列显示所有来件单号，未取货时订单号下方换行显示红色"(未取货)"标注。

**修改订单 Overlay：** 来件和收件人卡片可增删，保存前做数量校验。`paid_status` 只能从表格 checkbox 修改。

**历史档案：** PDF 用 pdfmake 在浏览器生成（真实文字，可复制），开新分页显示，同时存档到 R2。字体 `NotoSansSC-Regular.ttf` 存在 R2 bucket，首次生成时下载并缓存，后续无需重新加载。

**产品管理：** 每个产品有永久 `uid`，改名或改 id 时自动同步所有订单里的引用。

**搜索：** 输入关键字实时过滤所有订单，结果分四个区块：未取货、已取货、未寄出、已寄出，每个区块标题显示匹配数量。支持按订单号、取货码、收件人姓名、电话、地址、填表人搜索。切换到搜索 tab 或订单数据刷新后自动更新结果。每个区块都有修改和删除操作按钮。

**添加订单 Overlay：** 与修改 overlay 结构相同，内嵌 AI 填单助手（含 warnings 提示），提交后自动刷新订单列表。

**表格通用行为：**
- 所有表格表头 sticky，纵向滚动时保持可见
- 已付运费列 sticky 固定右侧，横向滚动时保持可见，来件和寄件管理都有
- 产品数量列水平和垂直居中
- 合并收件人弹窗有 X 关闭按钮，点击取消整个导出流程


## Cloudflare Worker 部署

Worker 通过本地 `wrangler deploy` 部署，**不连接 GitHub**（自动部署会清空环境变量）。

Worker 文件存放在本地 `worker-cloudflare/` 目录，已加入 `.gitignore`，不推送到 GitHub。

所有变量（包括 `GEMINI_API_KEY`、`WECHAT_CORP_SECRET`）存在本地 `wrangler.toml` 的 `[vars]` 里，不推送到 GitHub。

每次更新 Worker：
```bash
cd ~/Documents/fengjiezhuanyun/worker-cloudflare
wrangler deploy
```

## 各平台部署方式

| 组件 | 触发方式 |
|---|---|
| Cloudflare Pages（`pages/`） | push 到 GitHub main 自动部署 |
| Render（`render/`） | push 到 GitHub main 自动部署（监听 `render/` 路径）|
| Cloudflare Worker | 本地 `wrangler deploy`，不走 GitHub |

## 注意事项

1. `ADMIN_TOKEN` 和 `GEMINI_API_KEY` 只存在环境变量里，不在前端代码中
2. `incoming` 是数组，不是对象
3. D1 里 boolean 值存为 0/1，Worker 读取时自动转换
4. Render 免费版会休眠，用 cron-job.org 每10分钟 ping 根目录保持唤醒（`https://fengjiezhuanyun-render.onrender.com`）
5. Render 重启后内存里的对话状态清空（30分钟超时也会清空）
6. Render 出口 IP 如果变化，需要更新企业微信自建应用的"企业可信IP"
7. Cloudflare Worker 里保留了微信 Webhook 相关代码，实际处理在 Render
8. `external_userid` 是微信用户的唯一 ID，格式 `wm` 开头，用于修改模式的账号验证
9. 修改模式下 Gemini 不检查订单号重复（`existingCodes` 传空数组）
10. admin.html 的 `CONFIG.adminToken` 是 `fj_2025_xK9mP3`
11. `existingCodes` 只收集 `express_code`，不含 `pickup_code`，避免取货码被误判为重复订单号
12. 代码层面重复检查：正则提取数字后，还要通过 `/api/orders/by-code` 验证匹配的是 `express_code` 而非 `pickup_code`
13. 微信端预览消息拆成三条发送：标题单独一条、内容单独一条（方便客户复制修改后重发）、操作提示单独一条
14. 网页端 `/api/parse` 的 warnings 由 Worker 代码计算，不依赖 Gemini，数量计算100%准确
15. 微信端 `validateOrder` 由 Render 代码计算，不依赖 Gemini，数量计算100%准确
15. 网页端 AI 填单 Enter 键换行，发送必须点按钮
16. AI 解析预览气泡：有 warnings 时显示黄色背景，正常时白色
17. 微信端 Gemini 响应约 20 秒（免费模型 + Render Ohio 节点延迟），收到消息后先发确认提示改善体感
18. 产品改名时 Worker `saveProducts` 的 `changeMap` 同步逻辑曾产生格式错误的 product_id（格式：`旧ID（新名称）`），已通过 SQL REPLACE 修正两个受影响订单（ORD_1779632382743_irqd、ORD_1779980370001_1hf6）。如再次改产品名后发现表头出现重复列，在 D1 Console 运行 DISTINCT 查询排查
19. PDF 生成用 pdfmake 浏览器版（cdnjs CDN），字体 `NotoSansSC-Regular.ttf` 存 R2，不打包进 HTML。首次生成约 5-10 秒（下载字体），之后页面内缓存
20. 生成 PDF 后：新分页直接导航到 R2 URL（与历史档案“查看”方式相同），同时在当前页触发下载。安卓 Chrome 新分页可正常预览，下载提示出现在管理后台页不影响预览
21. 寄件单合并收件人时，所有被合并行的备注用“；”连接保留，不会因取第一行而丢失备注
