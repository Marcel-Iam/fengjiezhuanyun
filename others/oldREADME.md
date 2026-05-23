# 凤姐转运 - 订单管理系统

## 项目概述

前端静态网站托管在 GitHub Pages，后端逻辑和数据库全部在 Cloudflare。没有传统服务器。

| 组件 | 平台 | URL |
|---|---|---|
| 前端（index.html / admin.html） | GitHub Pages | `https://marcel-iam.github.io/fengjiezhuanyun/` |
| API + 业务逻辑 | Cloudflare Worker | `https://fengjiezhuanyun.yamhl12.workers.dev` |
| 数据库 | Cloudflare D1 | 绑定名称：`DB` |

GitHub 仓库：`Marcel-Iam/fengjiezhuanyun`


## 文件结构

```
GitHub repo (fengjiezhuanyun):
├── index.html          客户下单页面（含 AI 聊天窗口）
└── admin.html          管理后台

Cloudflare Worker:
└── worker.js           所有 API 逻辑

Cloudflare D1 (fengjiezhuanyun):
├── orders 表           订单数据
└── products 表         产品列表
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
  incoming TEXT,   -- JSON 字符串
  outgoing TEXT    -- JSON 字符串
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
  "source": "manual",
  "incoming": [
    {
      "express_code": "DD20250508001",
      "pickup_code": "8832",
      "products": [
        { "product_id": "p001", "product_name": "产品A", "quantity": 20 }
      ]
    }
  ],
  "outgoing": [
    {
      "name": "张伟",
      "phone": "13800001111",
      "address": "北京市朝阳区建国路88号",
      "products": [
        { "product_id": "p001", "product_name": "产品A", "quantity": 20 }
      ],
      "notes": ""
    }
  ]
}
```

关键字段：

- `id`：格式 `ORD_{timestamp}_{random4}`
- `created_by`：填表人称呼
- `paid_status`：运费是否已收，boolean（D1 里存 0/1）
- `picked_up`：货物是否已从快递处取回
- `shipped`：货物是否已寄出
- `source`：来源，`manual`（手动填单）
- `incoming`：来件信息数组，一个大订单可包含多张来件单，每张有独立的 `express_code`（内部单号）、`pickup_code`（取货时的确认码）、`products`
- `outgoing`：收件人列表，最终客户信息

### products 表

```sql
CREATE TABLE products (
  uid TEXT PRIMARY KEY,
  id TEXT UNIQUE,
  product_name TEXT
);
```

- `uid`：永久唯一标识符，格式 `uid_{timestamp}_{random4}`，创建后不变，用于追踪产品改名或改 id
- `id`：产品短码，显示在表格和 PDF 表头
- `product_name`：产品全称，显示在下拉选单和数量校验提示


## Worker API 端点

| 方法 | 路径 | 鉴权 | 功能 |
|---|---|---|---|
| POST | `/api/parse` | 无 | AI 解析订单文字，返回 JSON |
| GET | `/api/orders` | 无 | 读取所有订单 |
| POST | `/api/orders` | 无 | 新增订单 |
| PUT | `/api/orders/:id` | 无 | 修改订单 |
| DELETE | `/api/orders/:id` | 需要 | 删除订单 |
| GET | `/api/products` | 无 | 读取产品列表 |
| PUT | `/api/products` | 需要 | 保存产品列表（含订单同步） |

鉴权方式：请求 Header 带 `Authorization: Bearer {ADMIN_TOKEN}`。

index.html 的所有操作（读取、新增、修改订单）均为公开端点，不需要 token。需要 token 的操作只有删除订单和保存产品列表，仅 admin.html 使用。


## Cloudflare Worker 环境变量

在 Worker → Settings → Variables and Secrets 里设置：

| 变量名 | 说明 |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio 的 API key |
| `ADMIN_TOKEN` | 前端鉴权 token，admin.html 使用 |

Bindings：
- `DB` → D1 数据库 `fengjiezhuanyun`

KV 命名空间已不再使用，可以删除。
`WECHAT_*` 相关环境变量也已不再使用，可以删除。


## AI 模型

使用 `gemini-3.1-flash-lite-preview`，通过 Google AI Studio 免费额度调用（RPD 500，RPM 20）。

每次调用 `/api/parse` 前会：
1. 从 D1 实时读取最新产品列表
2. 从 D1 读取所有已有订单号和取货码，用于重复检查


## AI Parse 规则

1. 信息不完整（缺订单号、取货码、收件人、电话、地址）→ 说明缺了什么
2. 产品无法识别 → 先模糊匹配，实在无法确认才询问
3. 同一次输入内订单号或取货码重复 → 指出哪个重复
4. 订单号或取货码已存在数据库 → 说明已录入过
5. 来件产品总数和寄件产品总数不匹配 → 说明哪个产品数量对不上
6. 只能用产品列表里有的产品
7. 回复语气：口语中文，简洁说明问题


## index.html - 客户下单页面

### 页面结构

**上方（可折叠）：查找 / 修改已提交订单**
- 输入任意一个来件单号搜寻整个大订单
- 载入后填入表单，底部切换为"发送修改"和"取消修改"

**下方（金色边框）：提交新订单**
- 填表人称呼
- 来件信息：每张来件单一张卡片（可增删），每张卡有订单号、取货码、产品列表
- 收件人信息：每个收件人一张卡片（可增删）

**右下角浮动按钮：AI 智能填单**
- 聊天窗口，粘贴订单文字后 AI 自动解析
- 解析成功显示预览，点"确认填入表单"自动填入
- 解析失败显示错误原因，提示补充信息

### 功能

- 来件和寄件产品数量校验（跨所有来件单合并计算），不匹配时弹确认框
- 修改订单时不改动 `paid_status`
- 所有 API 调用经 Cloudflare Worker，无敏感信息暴露在前端

### 安全

`esc()` 对所有用户输入做 HTML 实体转义，防止 XSS。


## admin.html - 管理后台

### 密码

硬编码在 `CONFIG.password`，当前是 `456456`。

### 四个主分页

1. **来件管理**
2. **寄件管理**
3. **历史档案**
4. **产品管理**

### 来件管理

子视图：未取货 / 已取货，标签页实时显示数量 `未取货 (n)`

表格列：checkbox | 填表人 | 订单号 | 取货码 | [产品列（显示短码）] | 日期 | 已付运费

- 每张来件单占一行，同一大订单的填表人和日期用 rowspan 合并
- 产品列按来件单分行显示，底部合计行统计所有来件单产品总数
- 动态产品列表头显示产品短码（ID），PDF 取件单同样使用短码
- 数量校验提示显示产品全名
- 已付运费列：checkbox，勾选和取消都弹确认框，取消弹窗时 checkbox 恢复原状，数据不变
- 工具栏：生成取件单（PDF）、已取货、编辑、刷新
- "未取货"子标签页实时显示未取货订单数量，格式为 `未取货 (n)`

### 寄件管理

子视图：未寄出 / 已寄出，标签页实时显示数量 `未寄出 (n)`

表格列：checkbox | 填表人 | 订单号 | 收件人 | 地址 | 电话 | [产品列] | 备注 | 已付运费

- 订单号列显示所有来件单号，换行排列，未取货时附红色 `(未取货)` 标签
- 已取货订单排前面，未取货排后面
- 底部合计行

### 修改订单 Overlay

- 来件信息卡片（可增删）
- 收件人列表（可增删）
- 保存前做数量校验，不匹配弹确认框
- 不含 `paid_status` 字段，只能从表格 checkbox 修改

### 历史档案

PDF 直接在浏览器生成并打开，不再存档到云端。历史档案分页目前无存档功能。

### 产品管理

- 表格显示产品短码（ID）和全称
- 每个产品有 `uid`（永久不变），用于追踪改名或改 id
- 保存前检查重复 id 和 id 冲突，有冲突直接报错阻断
- 有变更时先同步 D1 里所有订单的 `product_id` 和 `product_name`，再保存产品列表
- 首次保存会给没有 `uid` 的产品补上，建议部署后先不改产品，直接点一次保存

### PDF 生成

使用 html2pdf.js（CDN）。取件单 portrait，寄件单 landscape。产品列表头显示短码，PDF 同样使用短码。


## z-index 层级

| 层级 | 元素 |
|---|---|
| 960 | 确认弹窗、导出弹窗、数量校验弹窗、删除确认 |
| 950 | 修改订单 overlay |
| 900 | AI 聊天窗口、浮动按钮 |
| 998 | 加载遮罩 |
| 999 | Toast 提示 |


## 设计规范

- 字体：Noto Sans SC（Google Fonts CDN）
- 主色：`#b8860b`（暗金色）
- 背景：`#f5f0eb`（暖灰）
- 卡片：白色，1px `#d4cdc4` 边框，8px 圆角
- 危险操作：`#c0392b`
- 成功操作：`#27ae60`
- 移动端响应式：700px 以下 form-row 堆叠
- index.html 新订单区域用金色边框与查找区域视觉区分


## 注意事项

1. `ADMIN_TOKEN` 和 `GEMINI_API_KEY` 只存在 Cloudflare Worker 环境变量里，不在前端代码中
2. `incoming` 是数组，不是对象，旧格式不兼容
3. D1 里 boolean 值存为 0/1，Worker 读取时自动转换为 true/false
4. `products` 表的 `uid` 字段是主键，`id` 字段有 UNIQUE 约束
5. `/api/parse` 每次调用都实时读取 D1 里的产品列表和已有订单号，不缓存
6. PDF 生成是纯前端，不存档，需要手动保存
7. admin.html 的 `CONFIG.adminToken` 是 `fj_2025_xK9mP3`
8. index.html 的 `CONFIG.adminToken` 保持空字符串即可，所有 index.html 需要的端点都是公开的