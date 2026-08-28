# netatlas

按需的**多地区网络拨测**服务,跑在 Cloudflare Worker 上,探针来自
[RIPE Atlas](https://atlas.ripe.net/)。选几个「地区 × 运营商」的节点,对一个域名或
IP 发起一次性测量,结果按节点分组返回。

**公开、无需登录、无数据库。** 线上:<https://probe.ddnsip.cn>

六种测量类型:**ping · dns · traceroute · sslcert · http · ntp**

---

## 两个约束决定了其余一切

**1. Atlas 的测量是异步的。** 创建不会返回结果,探针在 30 秒到几分钟内陆续上报。
所以 `POST /probe` 立刻返回测量 id,`GET /m/:id` 拉取并聚合已经到达的部分,控制台
每 3 秒轮询,服务端从不阻塞。

**2. Credits 是真金白银。** 每个探针按类型计费(ping 3、dns 10、sslcert 10、
http 20、ntp 20、traceroute 30)。匿名调用记在平台账号上,有全局日预算;自带 Key
的调用花自己的 credits,不计入预算。

## 节点模型:地区 × 运营商

一个节点 id 是 `cc-asn`(`cn-4134` = 中国·电信),**自描述**——只要格式合法就能测,
不依赖目录是否收录过它。

目录收录约 250 个精选节点,而 Atlas 实际有连接探针的组合约 **5,200 个**,其余通过
`GET /nodes?q=` 搜索到达(按 id、纯 ASN、国家名/代码、运营商名)。

**不要用 Atlas 的 `{type:"asn"}` 选择**:ASN 选择是全球性的,AS16509(AWS)的探针
分布在 25 个国家,只有 8% 在香港——「香港 · AWS」会悄悄从弗吉尼亚发起测量。
`resolveNodes()` 在请求时把节点解析成**明确的探针 id**。

## API

基址 `/api/v1`。

### `POST /probe` — 创建测量

```jsonc
{
  "type": "ping",              // ping | dns | traceroute | sslcert | http | ntp
  "target": "example.com",
  "nodes": ["cn-4134", "hk-4760"],  // 或用 preset
  "preset": "china",           // global | china | asia | europe |
                               // north_america | south_america | africa | oceania
  "perNode": 2,                // 每节点探针数
  "af": 4,                     // 4 | 6
  "queryType": "A"             // 仅 dns
}
```

→ `{ measurementId, requested, available, unavailable, estimatedCredits, shareUrl }`

`available` 是解析时该节点的**完整**在线探针池,`unavailable` 是当下一个探针都没有
的节点——**请求了几个、回来几个都如实标出**,不要把一个探针当成整个地区的结论。

### `GET /m/:id` — 拉取并聚合结果

```jsonc
{
  "measurementId": 205688400,
  "type": "dns", "target": "r2wind.cn", "queryType": "A",
  "status": "Stopped",
  "totalRequested": 18, "totalResponded": 17,
  "groups": [{
    "key": "cn-4134", "label": "中国 · 电信",
    "requested": 2, "responded": 2,
    "summary": { "rttMs": { "min": 10.6, "avg": 14.4, "max": 18.2 },
                 "distinctAnswers": ["A 115.231.230.141"], "ttl": { "min": 30, "max": 602 } },
    "probes": [{ "probeId": 53274, "asn": 4134, "country": "CN", "city": "合肥",
                 "from": "36.5.152.201", "rttMs": 18.2, "ok": true, "detail": { } }]
  }]
}
```

**测量 id 就是永久链接。** 结果、探针选择、测量元数据全部在 Atlas 侧公开可读,不需要
任何 Key,所以 `/m/<id>` 对任何人都能渲染——包括用调用方自己的 Key 创建的测量。

### `POST /probe/sync` — 创建后短轮询

同样的请求体,在有限窗口内(≤25 秒)等待结果,给 CLI 用。

### 其他

| | |
|---|---|
| `GET /nodes` | 常用节点;`?all=1` 全部目录;`?q=<关键词>` 搜索全部约 5,200 个组合 |
| `GET /presets` | 命名选择 |
| `GET /types` | 六种类型及每探针 credits |
| `GET /quota` | 当前身份的限额与余量 |
| `GET /anchors` | http 类型的可用目标(只能打 anchor) |

## 配额

两档:**匿名**(计入平台全局预算)和 **BYOK**(请求头 `X-Atlas-Key`,花自己的
credits,不计预算)。只存 Key 或 IP 的**哈希**,从不存原值。

`maxProbes` 才是真正生效的限制,不是 `maxNodes`——节点数本身不决定成本,50 个节点
每个 2 探针就是 100 个探针。匿名档 50 节点 / 50 探针,BYOK 同样宽度、三倍深度。

## 开发

```bash
npm install
cp .dev.vars.example .dev.vars     # 填 ATLAS_API_KEY
npm run dev

npm test           # vitest,只测纯函数,不联网、不花 credits
npm run typecheck
npm run deploy
```

| | |
|---|---|
| `npm run nodes:refresh` | 重新生成 `data/nodes.json`(节点目录),然后提交 |
| `npm run cities:refresh` | 重新生成 `data/cities.json`(坐标→城市名),然后提交 |

### ⚠️ `ATLAS_API_KEY` 必须是运行时 Worker Secret

两种常见的错法,都会在运行时得到 `401 "key does not exist"`:

- **Dashboard 里的明文 Variable** —— 下一次 CI `wrangler deploy` 会把它**抹掉**
  (配置里没有 `vars`,wrangler 以配置为准)。
- **Workers Builds 的 *build* variable** —— 只在构建期存在,运行时
  `c.env.ATLAS_API_KEY` 永远是空的。

正确做法,而且能在 CI 重建中保留:

```bash
npx wrangler secret put ATLAS_API_KEY
```

## 数据来源与署名

- 探针、测量、结果:[RIPE Atlas](https://atlas.ripe.net/)。
- 境外城市名派生自 [GeoNames](https://www.geonames.org/),依
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用并已修改
  (按人口筛选、并入都市圈、改名);署名同时写在 `data/cities.json` 内部和控制台页脚。
- **中国的城市名是手写的**,在 `scripts/build-cities.mjs` 里,逐行可审;构建时会剔除
  GeoNames 中 `CN/HK/MO/TW` 的全部行,第三方地名库不参与中国的地名。

## 更多

架构决定、Atlas 的各种未文档化限制、以及每一处「为什么是这样」都在
[`CLAUDE.md`](./CLAUDE.md) —— 那份文档是持续维护的,改代码前先读它。
