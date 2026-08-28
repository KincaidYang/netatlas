#!/usr/bin/env node
/**
 * Generate data/nodes.json — the "地区 + 运营商" node catalogue.
 *
 * RIPE Atlas has tens of thousands of probes; a probing product only needs a
 * short, legible list. We collapse every connected probe into (country, ASN)
 * groups, keep the ones with enough probes to be worth offering, and label
 * them with the operator's name.
 *
 * Run manually (`npm run nodes:refresh`) and commit the result. Probes going
 * offline never breaks a measurement — it only under-fills it, which the API
 * reports honestly as requested-vs-responded.
 */
const ATLAS = "https://atlas.ripe.net/api/v2";
const RIPESTAT = "https://stat.ripe.net/data/as-overview/data.json";

const MIN_PROBES = Number(process.env.MIN_PROBES ?? 2);
/**
 * Catalogue budget. A picker with 1,600 entries is unusable, so the long tail
 * gets two operators per country for coverage and the countries people
 * actually compare get more. China is uncapped in practice — it only has a
 * handful of qualifying operators and every one of them matters here.
 */
const PER_COUNTRY = Number(process.env.PER_COUNTRY ?? 2);
const PER_COUNTRY_OVERRIDES = {
  CN: 9, HK: 4, TW: 4, US: 4, JP: 4, KR: 3, SG: 3, DE: 3, GB: 3,
  FR: 3, AU: 3, IN: 3, BR: 3, RU: 3, CA: 3, NL: 3,
};
const MAX_NODES = Number(process.env.MAX_NODES ?? 300);

/**
 * The short list a first-time visitor sees. Facing 242 chips before you have
 * even typed a target is paralysing; these ~24 cover the markets people
 * actually compare, plus every Chinese operator (there are only a handful and
 * they are the whole point for this audience). Everything else is one click
 * away, not gone.
 */
const FEATURED_COUNTRIES = {
  // Greater China gets depth — it is the audience, and it has few operators.
  CN: 9, HK: 2, TW: 2,
  // Everywhere people routinely ask "is my site reachable from …", one carrier each.
  JP: 2, KR: 1, SG: 1, MY: 1, TH: 1, VN: 1, ID: 1, PH: 1,
  IN: 1, PK: 1, AE: 1, SA: 1, IL: 1, TR: 1, KZ: 1,
  DE: 1, GB: 1, FR: 1, NL: 1, IT: 1, ES: 1, SE: 1, PL: 1, CH: 1,
  RU: 1, UA: 1, FI: 1, NO: 1, DK: 1, AT: 1, BE: 1, CZ: 1, IE: 1, PT: 1, RO: 1,
  US: 2, CA: 1, MX: 1, BR: 1, AR: 1, CL: 1, CO: 1, PE: 1,
  AU: 1, NZ: 1,
  ZA: 1, EG: 1, NG: 1, KE: 1, MA: 1,
};
/**
 * ASNs that always earn a slot when they clear MIN_PROBES, even if they miss
 * their country's top-N cut. The audience is Chinese, so China Mobile / CERNET
 * / Tencent Cloud matter far more here than their probe counts suggest.
 */
const ALWAYS = new Set([4134, 4837, 9808, 4538, 37963, 45090, 4809, 4812, 9929, 56040]);

/** Operator names worth showing in Chinese; everything else uses the AS holder. */
const LABELS = {
  4134: "电信", 4809: "电信", 4812: "电信", 23724: "电信",
  4837: "联通", 4808: "联通", 9929: "联通", 17621: "联通",
  9808: "移动", 56040: "移动", 24400: "移动",
  4538: "教育网", 24429: "阿里云", 37963: "阿里云", 45102: "阿里云",
  45090: "腾讯云", 132203: "腾讯云", 55990: "华为云",
  3462: "中华电信", 4780: "数位联合", 9924: "台湾固网",
  4760: "HKT", 9269: "香港宽频", 4515: "星联",
  2497: "IIJ", 2516: "KDDI", 4713: "NTT OCN", 17676: "SoftBank", 2914: "NTT",
  4766: "Korea Telecom", 9318: "SK Broadband", 3786: "LG U+",
  3320: "Deutsche Telekom", 6805: "Telefónica DE", 8881: "1&1",
  3215: "Orange", 12322: "Free", 5410: "Bouygues",
  2856: "BT", 5089: "Virgin Media", 12576: "EE",
  7922: "Comcast", 7018: "AT&T", 701: "Verizon", 20115: "Charter", 22394: "Verizon Wireless",
  3356: "Lumen", 174: "Cogent", 6939: "Hurricane Electric",
  4657: "StarHub", 7473: "Singtel", 9506: "M1",
  1221: "Telstra", 4804: "Optus", 7545: "TPG",
  9498: "Bharti Airtel", 55836: "Jio", 24560: "Airtel",
  8452: "Telecom Egypt", 36992: "Etisalat",
  28573: "Claro BR", 27699: "Vivo", 8167: "Brasil Telecom",
  6057: "ANTEL", 22047: "VTR",
  13335: "Cloudflare", 15169: "Google", 16509: "AWS", 8075: "Microsoft",
  24940: "Hetzner", 16276: "OVH", 14061: "DigitalOcean", 63949: "Akamai/Linode",
};

/** Cloud/hosting ASNs: fine as nodes, wrong as the default face of a country. */
const CLOUD = new Set([
  37963, 45102, 24429, 45090, 132203, 55990, 16509, 15169, 13335, 8075, 14061,
  63949, 24940, 16276, 20473, 51167, 12876, 60068, 9009, 396982, 31898, 7224,
]);

const CN_NAMES = {
  CN: "中国", HK: "香港", TW: "台湾", MO: "澳门", JP: "日本", KR: "韩国",
  SG: "新加坡", MY: "马来西亚", TH: "泰国", VN: "越南", ID: "印尼", PH: "菲律宾",
  IN: "印度", PK: "巴基斯坦", BD: "孟加拉", AE: "阿联酋", SA: "沙特", IL: "以色列",
  TR: "土耳其", RU: "俄罗斯", KZ: "哈萨克", UA: "乌克兰",
  US: "美国", CA: "加拿大", MX: "墨西哥", BR: "巴西", AR: "阿根廷", CL: "智利",
  CO: "哥伦比亚", PE: "秘鲁", UY: "乌拉圭",
  GB: "英国", DE: "德国", FR: "法国", NL: "荷兰", IT: "意大利", ES: "西班牙",
  SE: "瑞典", NO: "挪威", FI: "芬兰", DK: "丹麦", PL: "波兰", CH: "瑞士",
  AT: "奥地利", BE: "比利时", CZ: "捷克", PT: "葡萄牙", IE: "爱尔兰", GR: "希腊",
  RO: "罗马尼亚", HU: "匈牙利", BG: "保加利亚", RS: "塞尔维亚", SK: "斯洛伐克",
  SI: "斯洛文尼亚", HR: "克罗地亚", LT: "立陶宛", LV: "拉脱维亚", EE: "爱沙尼亚",
  LU: "卢森堡", IS: "冰岛", MD: "摩尔多瓦", BY: "白俄罗斯",
  AU: "澳大利亚", NZ: "新西兰",
  ZA: "南非", EG: "埃及", NG: "尼日利亚", KE: "肯尼亚", MA: "摩洛哥", TN: "突尼斯",
  AD: "安道尔", AF: "阿富汗", AL: "阿尔巴尼亚", AM: "亚美尼亚", AO: "安哥拉",
  AZ: "阿塞拜疆", BA: "波黑", BH: "巴林", BJ: "贝宁", BO: "玻利维亚",
  CI: "科特迪瓦", CR: "哥斯达黎加", CV: "佛得角", CY: "塞浦路斯", DJ: "吉布提",
  DO: "多米尼加", EC: "厄瓜多尔", FM: "密克罗尼西亚", GE: "格鲁吉亚", GT: "危地马拉",
  GU: "关岛", HN: "洪都拉斯", IQ: "伊拉克", IR: "伊朗", JM: "牙买加",
  KG: "吉尔吉斯斯坦", KH: "柬埔寨", KI: "基里巴斯", LA: "老挝", LK: "斯里兰卡",
  MG: "马达加斯加", MK: "北马其顿", MN: "蒙古", MT: "马耳他", MU: "毛里求斯",
  MV: "马尔代夫", NA: "纳米比亚", NC: "新喀里多尼亚", NI: "尼加拉瓜", NP: "尼泊尔",
  PA: "巴拿马", PF: "法属波利尼西亚", PS: "巴勒斯坦", PY: "巴拉圭", RE: "留尼汪",
  SV: "萨尔瓦多", SY: "叙利亚", TD: "乍得", TJ: "塔吉克斯坦", TL: "东帝汶",
  TZ: "坦桑尼亚", UG: "乌干达", UZ: "乌兹别克斯坦", VE: "委内瑞拉", VI: "美属维尔京",
  ZM: "赞比亚", BN: "文莱", BT: "不丹", QA: "卡塔尔", KW: "科威特", OM: "阿曼",
  JO: "约旦", LB: "黎巴嫩", TM: "土库曼斯坦", YE: "也门", GH: "加纳", DZ: "阿尔及利亚",
  ET: "埃塞俄比亚", SN: "塞内加尔", CM: "喀麦隆", ZW: "津巴布韦", RW: "卢旺达",
  MZ: "莫桑比克", BW: "博茨瓦纳", LY: "利比亚", SD: "苏丹", SC: "塞舌尔",
  ML: "马里", BF: "布基纳法索", NE: "尼日尔", TG: "多哥", GA: "加蓬", CG: "刚果",
  CD: "刚果金", GN: "几内亚", LR: "利比里亚", SL: "塞拉利昂", GM: "冈比亚",
  FJ: "斐济", PG: "巴布亚新几内亚", WS: "萨摩亚", VU: "瓦努阿图", SB: "所罗门群岛",
  CU: "古巴", HT: "海地", BZ: "伯利兹", BS: "巴哈马", TT: "特立尼达", BB: "巴巴多斯",
  PR: "波多黎各", GL: "格陵兰", BM: "百慕大", KY: "开曼群岛", AW: "阿鲁巴", CW: "库拉索",
  GY: "圭亚那", SR: "苏里南", GF: "法属圭亚那", MC: "摩纳哥", LI: "列支敦士登",
  SM: "圣马力诺", FO: "法罗群岛", GI: "直布罗陀", JE: "泽西岛", IM: "马恩岛",
  GG: "根西岛", AX: "奥兰群岛", ME: "黑山",
};

/**
 * Every ISO 3166-1 alpha-2 code, so nothing Atlas can report falls into "??".
 * Antarctica has no connected probe today and several of these territories
 * never will — a continent with no nodes simply does not render, so listing
 * them costs nothing and stops a surprise from landing nowhere.
 *
 * Atlas's own `?` placeholder for an unplaced probe is deliberately absent: it
 * is not a country and should not be filed as one.
 */
const CONTINENT = {
  "亚洲": "CN HK TW MO JP KR SG MY TH VN ID PH IN PK BD LK NP AE SA IL TR QA KW OM JO LB IQ IR KZ UZ GE AM AZ MN KH LA MM BN BT MV AF BH KG PS SY TJ TL YE TM KP IO",
  "欧洲": "GB DE FR NL IT ES SE NO FI DK PL CH AT BE CZ PT IE GR RO HU BG RS SK SI HR LT LV EE LU IS MD BY UA RU MT CY AL MK BA ME MC LI AD SM FO GI JE IM GG AX VA SJ",
  "北美": "US CA MX GT CR PA CU DO JM HT HN NI SV BZ BS TT BB PR VI GL BM KY AW CW AG AI BL BQ DM GD GP KN LC MF MQ MS PM SX TC VC VG UM",
  "南美": "BR AR CL CO PE UY VE EC BO PY GY SR GF FK GS",
  "非洲": "ZA EG NG KE MA TN GH DZ ET UG TZ SN CI CM ZW ZM MU RW AO MZ BW NA LY SD SC MG BJ ML BF NE TG GA CG CD GN LR SL GM CV DJ RE TD SO SS MW LS SZ ER KM BI CF EH GQ GW SH ST MR YT",
  "大洋洲": "AU NZ FJ PG NC PF GU WS VU SB TO FM KI NR TV PW MH CK AS CC CX MP NF NU PN TK WF",
  "南极洲": "AQ BV HM TF",
};


const continentOf = (cc) => {
  for (const [k, v] of Object.entries(CONTINENT)) if (v.split(" ").includes(cc)) return k;
  return "??";
};

/** "CHINANET-BACKBONE - No.31" → "CHINANET-BACKBONE"; "X - Acme Telecom Ltd" → "Acme Telecom". */
function cleanHolder(raw) {
  const first = raw.split(",")[0].trim().replace(/^AS\d+\s*[-–]?\s*/i, "");
  const dash = first.indexOf(" - ");
  let name = first;
  if (dash > 0) {
    const tail = first.slice(dash + 3).trim();
    // The tail is usually the human name, but sometimes it is junk like "No.31".
    name = tail.length >= 5 && !/^No\.|^\d/.test(tail) ? tail : first.slice(0, dash);
  }
  // Registry handles like "ASN-IBSNAZ Telecom Italia" or "AS-MEGALINE-KG Mega-Line"
  // prefix the real name; drop them when something readable follows.
  name = name.replace(/^(AS[N]?-[A-Z0-9-]+|[A-Z0-9]{4,}-[A-Z0-9-]+)\s+(?=[A-Za-z])/, "");
  // "KPN KPN B.V." and friends: drop an immediately repeated word.
  name = name.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  name = name.replace(/\s+(Ltd|Limited|Inc|Inc\.|LLC|S\.A\.|SA|GmbH|B\.V\.|BV|Co\.?|Corp\.?|Company|PLC|AG|AB|AS|SAS|SRL|Pty|Pte)\.?$/gi, "").trim();
  if (name.length > 26) {
    name = name.slice(0, 25).trimEnd();
    const open = name.lastIndexOf("(");
    if (open > 0 && !name.includes(")", open)) name = name.slice(0, open).trimEnd();
    name += "…";
  }
  return name;
}

/**
 * Named selections, declared as intent (which countries) and resolved against
 * whatever is actually in the catalogue. Hand-written node ids rot the moment
 * an operator's probe count moves; country intent does not.
 */
/**
 * One preset per continent, plus 全球 and 中国. The old 亚太 / 美洲 groupings
 * were a different granularity from the chip sections right below them, which
 * made the two rows disagree about what a region is.
 *
 * 中国 is CN/HK/MO/TW in one preset — there is no separate 大陆 selection.
 */
const PRESET_COUNTRIES = {
  global: ["US", "DE", "GB", "JP", "SG", "CN", "BR", "AU", "IN", "ZA"],
  china: ["CN", "HK", "MO", "TW"],
  asia: ["JP", "KR", "SG", "HK", "TW", "IN", "ID", "TH", "VN", "AE"],
  europe: ["DE", "GB", "FR", "NL", "SE", "IT", "ES", "PL"],
  north_america: ["US", "CA", "MX"],
  south_america: ["BR", "AR", "CL", "CO", "PE"],
  africa: ["ZA", "EG", "NG", "KE", "TN"],
  oceania: ["AU", "NZ"],
};
/**
 * How many nodes to take per country. China gets depth because it is the
 * audience and has few operators; everywhere else one carrier per country is
 * the point of a preset.
 *
 * Three, not more: CN/HK/MO/TW at four apiece is twelve nodes, over the
 * anonymous tier's ceiling of ten, so `preset=china` would 400 for exactly the
 * callers most likely to use it.
 */
const PRESET_PER_COUNTRY = { china: 3 };

function buildPresets(nodes) {
  const byCc = new Map();
  for (const n of nodes) {
    if (!byCc.has(n.cc)) byCc.set(n.cc, []);
    byCc.get(n.cc).push(n);
  }
  // Prefer curated eyeball carriers over whatever has the most probes: a
  // preset that picks "韩国 · Oracle" instead of Korea Telecom is useless for
  // a probing product, and cloud ASNs always out-number consumer ISPs here.
  for (const list of byCc.values()) {
    const rank = (n) => (CLOUD.has(n.asn) ? 2 : LABELS[n.asn] ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || b.probes - a.probes);
  }

  const out = {};
  for (const [name, countries] of Object.entries(PRESET_COUNTRIES)) {
    const per = PRESET_PER_COUNTRY[name] ?? 1;
    const ids = countries.flatMap((cc) => (byCc.get(cc) ?? []).slice(0, per).map((n) => n.id));
    out[name] = ids;
    const missing = countries.filter((cc) => !byCc.has(cc));
    if (missing.length) process.stderr.write(`  preset ${name}: no nodes for ${missing.join(", ")}\n`);
  }
  return out;
}

async function json(url) {
  const res = await fetch(url, { headers: { "User-Agent": "netatlas-node-builder" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function fetchConnectedProbes() {
  const out = [];
  let url =
    `${ATLAS}/probes/?status=1&is_public=true&page_size=500` +
    `&fields=id,country_code,asn_v4,asn_v6,status`;
  let page = 0;
  while (url) {
    const data = await json(url);
    out.push(...(data.results ?? []));
    url = data.next;
    if (++page % 5 === 0) process.stderr.write(`  …${out.length} probes\n`);
  }
  return out;
}

/** Resolve AS holder names with a small concurrency pool. */
async function holders(asns) {
  const names = new Map();
  const queue = [...asns];
  const worker = async () => {
    while (queue.length) {
      const asn = queue.pop();
      try {
        const d = await json(`${RIPESTAT}?resource=AS${asn}`);
        const holder = d?.data?.holder ?? null;
        if (holder) names.set(asn, cleanHolder(holder));
      } catch {
        /* a missing name is cosmetic; the ASN still works */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return names;
}

const main = async () => {
  process.stderr.write("fetching connected probes…\n");
  const probes = await fetchConnectedProbes();
  process.stderr.write(`${probes.length} connected probes\n`);

  const groups = new Map();
  for (const p of probes) {
    const cc = p.country_code;
    // Keyed by the v4 ASN only: a node id is `cc-<v4 ASN>`, so an IPv6-only
    // probe (188 of them are) cannot be addressed by one. Falling back to the
    // v6 ASN invented groups that resolve to nothing and inflated the IPv4
    // count of any node that happens to share the number.
    const asn = p.asn_v4;
    if (!cc || !asn) continue;
    const id = `${cc.toLowerCase()}-${asn}`;
    let g = groups.get(id);
    if (!g) {
      g = { id, cc, asn, probes: 0, probesV6: 0, asnV6: new Map() };
      groups.set(id, g);
    }
    g.probes++;
    if (p.asn_v6) {
      g.probesV6++;
      g.asnV6.set(p.asn_v6, (g.asnV6.get(p.asn_v6) ?? 0) + 1);
    }
  }

  const byCountry = new Map();
  for (const g of groups.values()) {
    if (g.probes < MIN_PROBES) continue;
    if (!byCountry.has(g.cc)) byCountry.set(g.cc, []);
    byCountry.get(g.cc).push(g);
  }

  const picked = [];
  for (const [cc, list] of byCountry) {
    const rank = (g) => (CLOUD.has(g.asn) ? 2 : LABELS[g.asn] ? 0 : 1);
    list.sort((a, b) => rank(a) - rank(b) || b.probes - a.probes);
    const quota = PER_COUNTRY_OVERRIDES[cc] ?? PER_COUNTRY;
    const top = list.slice(0, quota);
    const extra = list.slice(quota).filter((g) => ALWAYS.has(g.asn));
    picked.push(...top, ...extra);
  }
  if (picked.length > MAX_NODES) {
    // Safety net only; trim the least interesting tail first.
    const keep = (g) => PER_COUNTRY_OVERRIDES[g.cc] || ALWAYS.has(g.asn) || LABELS[g.asn];
    picked.sort((a, b) => Number(!!keep(b)) - Number(!!keep(a)) || b.probes - a.probes);
    picked.length = MAX_NODES;
  }

  process.stderr.write(`resolving ${picked.length} AS names…\n`);
  const names = await holders(picked.map((g) => g.asn));

  const nodes = picked
    .map((g) => {
      const holder = names.get(g.asn) ?? null;
      const operator = LABELS[g.asn] ?? holder ?? `AS${g.asn}`;
      const country = CN_NAMES[g.cc] ?? g.cc;
      // Dominant v6 ASN inside the group; usually identical to the v4 one.
      const asnV6 = [...g.asnV6.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        id: g.id,
        cc: g.cc,
        asn: g.asn,
        asnV6,
        label: `${country} · ${operator}`,
        holder,
        continent: continentOf(g.cc),
        probes: g.probes,
        probesV6: g.probesV6,
      };
    })
    .sort((a, b) => a.continent.localeCompare(b.continent) || a.cc.localeCompare(b.cc) || b.probes - a.probes);

  // Mark the default short list.
  const featured = new Set();
  const featureRank = (n) => (CLOUD.has(n.asn) ? 2 : LABELS[n.asn] ? 0 : 1);
  for (const [cc, take] of Object.entries(FEATURED_COUNTRIES)) {
    const slice = nodes
      .filter((x) => x.cc === cc)
      .sort((a, b) => featureRank(a) - featureRank(b) || b.probes - a.probes);
    for (const n of slice.slice(0, take)) featured.add(n.id);
  }
  for (const n of nodes) n.featured = featured.has(n.id);

  // Two ASNs of the same carrier in one country would otherwise render as two
  // identical chips (China Unicom has both AS4837 and AS4808).
  const seen = new Map();
  for (const n of nodes) {
    const hits = (seen.get(n.label) ?? 0) + 1;
    seen.set(n.label, hits);
    if (hits > 1) n.label = `${n.label} AS${n.asn}`;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    // The runtime re-applies this policy when it refreshes the catalogue
    // itself, so the two stay consistent without sharing code.
    policy: {
      minProbes: MIN_PROBES,
      perCountry: PER_COUNTRY,
      perCountryOverrides: PER_COUNTRY_OVERRIDES,
      maxNodes: MAX_NODES,
      featuredCountries: FEATURED_COUNTRIES,
      always: [...ALWAYS],
      cloud: [...CLOUD],
    },
    countries: CN_NAMES,
    // The runtime catalogue sweep discovers (cc, ASN) pairs this build never
    // saw, and it has no continent table of its own — without this map every
    // newly-found node renders under "??".
    continents: Object.fromEntries(
      Object.entries(CONTINENT).flatMap(([name, ccs]) => ccs.split(" ").map((cc) => [cc, name])),
    ),
    operators: LABELS,
    presets: buildPresets(nodes),
    nodes,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.stderr.write(`wrote ${nodes.length} nodes across ${byCountry.size} countries\n`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
