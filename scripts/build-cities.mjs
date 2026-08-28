#!/usr/bin/env node
/**
 * Generate data/cities.json — the coordinate → city-name table.
 *
 * RIPE Atlas probes carry no city, only `geometry`. The full probe object is
 * exactly: address_v4/v6, asn_v4/v6, country_code, description,
 * firmware_version, first/last_connected, geometry, id, is_anchor, is_public,
 * prefix_v4/v6, status, total_uptime, tags. Nothing else. And `?city=` is not
 * a filter — Atlas silently ignores unknown filters and hands back all 60k
 * probes, so asking for one is worse than not asking.
 *
 * So the city name has to come from us. This table is how.
 *
 * Two sources, deliberately kept apart:
 *
 *   1. China — hand-written below, in this file, in git. Every coordinate and
 *      every name is ours, reviewable line by line. No third-party gazetteer
 *      contributes a single Chinese place name.
 *   2. Everywhere else — GeoNames cities15000, from which we take only
 *      `name` + latitude/longitude + the ISO code. Its `country` column is a
 *      join key for the same-country tie-break and is *never displayed*; the
 *      country/region label a reader sees always comes from CN_NAMES in
 *      build-nodes.mjs.
 *
 * Run manually (`npm run cities:refresh`) and commit the result.
 */
import { inflateRawSync } from "node:zlib";

const GEONAMES = "https://download.geonames.org/export/dump/cities15000.zip";
const ATLAS = "https://atlas.ripe.net/api/v2";

/**
 * Population floor for the GeoNames half of the table.
 *
 * Tuned against the real probe population, not by feel. At 150k the table
 * names 82% of probes and misses Luxembourg (76k), Bern (121k), Malé (103k)
 * and Ashburn (43k) — the last of which is the single densest probe cluster in
 * the United States, 80 of them, and was being called 阿灵顿 38 km away.
 * 30k names 96.7% and costs 157 KB gzipped, which the Worker will not notice.
 */
const MIN_POP = Number(process.env.MIN_POP ?? 30000);

/**
 * How far a probe may sit from a table entry and still be called by its name.
 * 50 km is the 地级市 / metro scale: 宁海 belongs to 宁波 (18 km) but 深圳 and
 * 广州 are 110 km apart and never blur together. Anything further away gets no
 * city at all — see `cityFor` in src/geo.ts.
 */
const MATCH_KM = Number(process.env.MATCH_KM ?? 50);

/** Handled entirely by CHINA below; GeoNames rows for these are dropped. */
const CHINA_CODES = new Set(["CN", "HK", "MO", "TW"]);

/**
 * 中国城市表 —— 手写,一张表,不分层级。
 *
 * 覆盖直辖市、省会、计划单列市,加上当前确实有探针落点的地级市。坐标是市中心。
 *
 * 四条按地级市归并的县级落点(探针实际在县里,显示地级市名),单独标出来:
 *   淅川 → 南阳    石柱 → 重庆    宁海 → 宁波    恒春 → 屏东
 * 它们各自只有 1 个探针,county 名字对读者没有意义,地级市才有。
 */
const CHINA = [
  [39.9042, 116.4074, "CN", "北京"],
  [31.2304, 121.4737, "CN", "上海"],
  [39.3434, 117.3616, "CN", "天津"],
  [29.5630, 106.5516, "CN", "重庆"],
  [30.0006, 108.1146, "CN", "重庆"], // 石柱,重庆东部唯一探针落点
  [38.0428, 114.5149, "CN", "石家庄"],
  [37.8706, 112.5489, "CN", "太原"],
  [40.8414, 111.7519, "CN", "呼和浩特"],
  [41.8057, 123.4315, "CN", "沈阳"],
  [38.9140, 121.6147, "CN", "大连"],
  [43.8171, 125.3235, "CN", "长春"],
  [45.8038, 126.5349, "CN", "哈尔滨"],
  [32.0603, 118.7969, "CN", "南京"],
  [31.2989, 120.5853, "CN", "苏州"],
  [31.4912, 120.3119, "CN", "无锡"],
  [34.2059, 117.2848, "CN", "徐州"],
  [33.3775, 120.1256, "CN", "盐城"],
  [30.2741, 120.1551, "CN", "杭州"],
  [29.8683, 121.5440, "CN", "宁波"],
  [29.2887, 121.4295, "CN", "宁波"], // 宁海,距市中心 65km,单列一行才够得着
  [27.9938, 120.6994, "CN", "温州"],
  [31.8206, 117.2272, "CN", "合肥"],
  [26.0745, 119.2965, "CN", "福州"],
  [24.4798, 118.0894, "CN", "厦门"],
  [24.8741, 118.6757, "CN", "泉州"],
  [28.6820, 115.8579, "CN", "南昌"],
  [36.6512, 117.1201, "CN", "济南"],
  [36.0671, 120.3826, "CN", "青岛"],
  [37.4346, 118.6747, "CN", "东营"],
  [34.7466, 113.6254, "CN", "郑州"],
  [34.6197, 112.4540, "CN", "洛阳"],
  [32.9908, 112.5283, "CN", "南阳"],
  [33.1375, 111.4886, "CN", "南阳"], // 淅川,距市中心 97km
  [30.5928, 114.3055, "CN", "武汉"],
  [28.2282, 112.9388, "CN", "长沙"],
  [23.1291, 113.2644, "CN", "广州"],
  [22.5431, 114.0579, "CN", "深圳"],
  [22.2707, 113.5767, "CN", "珠海"],
  [23.0207, 113.7518, "CN", "东莞"],
  [23.0219, 113.1214, "CN", "佛山"],
  [22.8170, 108.3665, "CN", "南宁"],
  [20.0444, 110.1999, "CN", "海口"],
  [18.2528, 109.5119, "CN", "三亚"],
  [30.5728, 104.0668, "CN", "成都"],
  [26.6470, 106.6302, "CN", "贵阳"],
  [25.0389, 102.7183, "CN", "昆明"],
  [29.6520, 91.1721, "CN", "拉萨"],
  [34.3416, 108.9398, "CN", "西安"],
  [36.0611, 103.8343, "CN", "兰州"],
  [36.6171, 101.7782, "CN", "西宁"],
  [38.4872, 106.2309, "CN", "银川"],
  [43.8256, 87.6168, "CN", "乌鲁木齐"],
  [39.6304, 118.1804, "CN", "唐山"],
  [22.3193, 114.1694, "HK", "香港"],
  [22.1987, 113.5439, "MO", "澳门"],
  [25.0330, 121.5654, "TW", "台北"],
  [25.0169, 121.4628, "TW", "新北"],
  [25.1276, 121.7392, "TW", "基隆"],
  [24.9937, 121.3010, "TW", "桃园"],
  [24.8138, 120.9675, "TW", "新竹"],
  [24.5602, 120.8214, "TW", "苗栗"],
  [24.1477, 120.6736, "TW", "台中"],
  [24.0518, 120.5161, "TW", "彰化"],
  [23.9609, 120.9719, "TW", "南投"],
  [23.7092, 120.5434, "TW", "云林"],
  [23.4801, 120.4491, "TW", "嘉义"],
  [22.9999, 120.2270, "TW", "台南"],
  [22.6273, 120.3014, "TW", "高雄"],
  [22.6761, 120.4880, "TW", "屏东"],
  [22.0027, 120.7449, "TW", "屏东"], // 恒春,距屏东市 75km
  [23.9871, 121.6015, "TW", "花莲"],
  [22.7583, 121.1444, "TW", "台东"],
  [23.5711, 119.5794, "TW", "澎湖"],
];

/**
 * 境外都市圈的中文名。
 *
 * 只覆盖读者真的会看到的那些 —— 其余显示 GeoNames 的英文名,那比一个猜出来的
 * 中文名诚实。不要改成从 cities15000 的别名列里取中文:那一列不标语言,实测会把
 * 深圳叫成"宝安"、科隆叫成"古龍"、首尔叫成"ソウル特別市"。
 */
const ZH = {
  "JP:Tokyo": "东京", "JP:Osaka": "大阪", "JP:Nagoya": "名古屋", "JP:Fukuoka": "福冈",
  "JP:Sapporo": "札幌", "JP:Yokohama": "横滨", "JP:Kyoto": "京都", "JP:Kobe": "神户",
  "JP:Sendai": "仙台", "JP:Hiroshima": "广岛", "JP:Naha": "那霸",
  "KR:Seoul": "首尔", "KR:Busan": "釜山", "KR:Incheon": "仁川", "KR:Daejeon": "大田",
  "KR:Gwangju": "光州", "KR:Daegu": "大邱",
  "SG:Singapore": "新加坡",
  "MY:Kuala Lumpur": "吉隆坡", "MY:George Town": "槟城", "MY:Johor Bahru": "新山",
  "TH:Bangkok": "曼谷", "TH:Chiang Mai": "清迈", "TH:Phuket": "普吉",
  "VN:Hanoi": "河内", "VN:Ho Chi Minh City": "胡志明市", "VN:Da Nang": "岘港",
  "ID:Jakarta": "雅加达", "ID:Surabaya": "泗水", "ID:Denpasar": "登巴萨",
  "PH:Manila": "马尼拉", "PH:Quezon City": "奎松", "PH:Cebu City": "宿务",
  "KH:Phnom Penh": "金边", "LA:Vientiane": "万象", "MM:Yangon": "仰光",
  "BD:Dhaka": "达卡", "LK:Colombo": "科伦坡", "NP:Kathmandu": "加德满都",
  "IN:Mumbai": "孟买", "IN:New Delhi": "新德里", "IN:Delhi": "德里",
  "IN:Bengaluru": "班加罗尔", "IN:Chennai": "金奈", "IN:Hyderabad": "海得拉巴",
  "IN:Kolkata": "加尔各答", "IN:Pune": "浦那",
  "PK:Karachi": "卡拉奇", "PK:Lahore": "拉合尔", "PK:Islamabad": "伊斯兰堡",
  "AE:Dubai": "迪拜", "AE:Abu Dhabi": "阿布扎比", "SA:Riyadh": "利雅得",
  "SA:Jeddah": "吉达", "QA:Doha": "多哈", "KW:Kuwait City": "科威特城",
  "BH:Manama": "麦纳麦", "OM:Muscat": "马斯喀特",
  "IL:Tel Aviv": "特拉维夫", "IL:Jerusalem": "耶路撒冷",
  "TR:Istanbul": "伊斯坦布尔", "TR:Ankara": "安卡拉", "TR:Izmir": "伊兹密尔",
  "IR:Tehran": "德黑兰", "IQ:Baghdad": "巴格达",
  "KZ:Almaty": "阿拉木图", "KZ:Astana": "阿斯塔纳", "UZ:Tashkent": "塔什干",
  "MN:Ulan Bator": "乌兰巴托", "KG:Bishkek": "比什凯克",
  "RU:Moscow": "莫斯科", "RU:Saint Petersburg": "圣彼得堡",
  "RU:Novosibirsk": "新西伯利亚", "RU:Yekaterinburg": "叶卡捷琳堡",
  "RU:Vladivostok": "海参崴", "RU:Khabarovsk": "哈巴罗夫斯克",
  "UA:Kyiv": "基辅", "UA:Odesa": "敖德萨", "BY:Minsk": "明斯克",
  "GB:London": "伦敦", "GB:Manchester": "曼彻斯特", "GB:Birmingham": "伯明翰",
  "GB:Edinburgh": "爱丁堡", "GB:Glasgow": "格拉斯哥", "GB:Bristol": "布里斯托尔",
  "GB:Leeds": "利兹", "GB:Liverpool": "利物浦", "GB:Reading": "雷丁",
  "IE:Dublin": "都柏林",
  "DE:Frankfurt am Main": "法兰克福", "DE:Berlin": "柏林", "DE:München": "慕尼黑",
  "DE:Hamburg": "汉堡", "DE:Köln": "科隆", "DE:Düsseldorf": "杜塞尔多夫",
  "DE:Stuttgart": "斯图加特", "DE:Nuremberg": "纽伦堡", "DE:Nürnberg": "纽伦堡",
  "DE:Leipzig": "莱比锡", "DE:Dresden": "德累斯顿", "DE:Hannover": "汉诺威",
  "NL:Amsterdam": "阿姆斯特丹", "NL:Rotterdam": "鹿特丹", "NL:The Hague": "海牙",
  "NL:Utrecht": "乌得勒支", "NL:Eindhoven": "埃因霍温",
  "FR:Paris": "巴黎", "FR:Marseille": "马赛", "FR:Lyon": "里昂",
  "FR:Toulouse": "图卢兹", "FR:Bordeaux": "波尔多", "FR:Nice": "尼斯",
  "FR:Strasbourg": "斯特拉斯堡", "FR:Lille": "里尔",
  "BE:Brussels": "布鲁塞尔", "BE:Antwerp": "安特卫普", "LU:Luxembourg": "卢森堡",
  "CH:Zürich": "苏黎世", "CH:Geneva": "日内瓦", "CH:Bern": "伯尔尼",
  "CH:Basel": "巴塞尔", "CH:Lausanne": "洛桑",
  "AT:Vienna": "维也纳", "AT:Graz": "格拉茨", "AT:Salzburg": "萨尔茨堡",
  "IT:Milan": "米兰", "IT:Rome": "罗马", "IT:Turin": "都灵", "IT:Naples": "那不勒斯",
  "IT:Florence": "佛罗伦萨", "IT:Bologna": "博洛尼亚", "IT:Venice": "威尼斯",
  "ES:Madrid": "马德里", "ES:Barcelona": "巴塞罗那", "ES:Valencia": "瓦伦西亚",
  "ES:Sevilla": "塞维利亚", "ES:Bilbao": "毕尔巴鄂", "ES:Málaga": "马拉加",
  "PT:Lisbon": "里斯本", "PT:Porto": "波尔图",
  "SE:Stockholm": "斯德哥尔摩", "SE:Göteborg": "哥德堡", "SE:Malmö": "马尔默",
  "NO:Oslo": "奥斯陆", "NO:Bergen": "卑尔根",
  "DK:Copenhagen": "哥本哈根", "DK:Aarhus": "奥胡斯",
  "FI:Helsinki": "赫尔辛基", "FI:Tampere": "坦佩雷",
  "IS:Reykjavík": "雷克雅未克",
  "PL:Warsaw": "华沙", "PL:Kraków": "克拉科夫", "PL:Wrocław": "弗罗茨瓦夫",
  "PL:Gdańsk": "格但斯克", "PL:Poznań": "波兹南",
  "CZ:Prague": "布拉格", "CZ:Brno": "布尔诺",
  "SK:Bratislava": "布拉迪斯拉发", "HU:Budapest": "布达佩斯",
  "RO:Bucharest": "布加勒斯特", "RO:Cluj-Napoca": "克卢日",
  "BG:Sofia": "索非亚", "RS:Belgrade": "贝尔格莱德", "HR:Zagreb": "萨格勒布",
  "SI:Ljubljana": "卢布尔雅那", "GR:Athens": "雅典", "GR:Thessaloniki": "塞萨洛尼基",
  "LT:Vilnius": "维尔纽斯", "LV:Riga": "里加", "EE:Tallinn": "塔林",
  "MD:Chisinau": "基希讷乌", "CY:Nicosia": "尼科西亚", "MT:Valletta": "瓦莱塔",
  "US:New York City": "纽约", "US:Los Angeles": "洛杉矶", "US:Chicago": "芝加哥",
  "US:San Francisco": "旧金山", "US:San Jose": "圣何塞", "US:Seattle": "西雅图",
  "US:Ashburn": "阿什本", "US:Washington": "华盛顿", "US:Arlington": "阿灵顿",
  "US:Dallas": "达拉斯", "US:Houston": "休斯顿", "US:Atlanta": "亚特兰大",
  "US:Miami": "迈阿密", "US:Boston": "波士顿", "US:Denver": "丹佛",
  "US:Phoenix": "凤凰城", "US:Las Vegas": "拉斯维加斯", "US:Portland": "波特兰",
  "US:San Diego": "圣迭戈", "US:Salt Lake City": "盐湖城",
  "US:Minneapolis": "明尼阿波利斯", "US:Detroit": "底特律",
  "US:Philadelphia": "费城", "US:Austin": "奥斯汀", "US:Honolulu": "檀香山",
  "CA:Toronto": "多伦多", "CA:Vancouver": "温哥华", "CA:Montréal": "蒙特利尔",
  "CA:Calgary": "卡尔加里", "CA:Ottawa": "渥太华",
  "MX:Mexico City": "墨西哥城", "MX:Guadalajara": "瓜达拉哈拉",
  "MX:Monterrey": "蒙特雷", "MX:Querétaro": "克雷塔罗",
  "BR:São Paulo": "圣保罗", "BR:Rio de Janeiro": "里约热内卢",
  "BR:Brasília": "巴西利亚", "BR:Fortaleza": "福塔莱萨",
  "AR:Buenos Aires": "布宜诺斯艾利斯", "CL:Santiago": "圣地亚哥",
  "CO:Bogotá": "波哥大", "CO:Medellín": "麦德林", "PE:Lima": "利马",
  "UY:Montevideo": "蒙得维的亚", "EC:Quito": "基多", "PA:Panamá": "巴拿马城",
  "AU:Sydney": "悉尼", "AU:Melbourne": "墨尔本", "AU:Brisbane": "布里斯班",
  "AU:Perth": "珀斯", "AU:Adelaide": "阿德莱德", "AU:Canberra": "堪培拉",
  "NZ:Auckland": "奥克兰", "NZ:Wellington": "惠灵顿", "NZ:Christchurch": "基督城",
  "ZA:Johannesburg": "约翰内斯堡", "ZA:Cape Town": "开普敦", "ZA:Durban": "德班",
  "EG:Cairo": "开罗", "NG:Lagos": "拉各斯", "KE:Nairobi": "内罗毕",
  "MA:Casablanca": "卡萨布兰卡", "TN:Tunis": "突尼斯城", "GH:Accra": "阿克拉",
  "ET:Addis Ababa": "亚的斯亚贝巴", "TZ:Dar es Salaam": "达累斯萨拉姆",
};

/**
 * Inflate the single entry of a zip. Adding a zip library for one file would
 * be the only npm dependency in the build path, and this is 20 lines — the
 * same trade already made for src/dns.ts and src/x509.ts.
 */
function unzipOne(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip file");
  const method = buf.readUInt16LE(8);
  let compressed = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (compressed === 0) {
    // Streamed entry: the size lives in the central directory, which starts at
    // the offset recorded in the end-of-central-directory record.
    let eocd = buf.length - 22;
    while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error("no end-of-central-directory record");
    compressed = buf.readUInt32LE(buf.readUInt32LE(eocd + 16) + 20);
  }
  const body = buf.subarray(start, start + compressed);
  return method === 0 ? body : inflateRawSync(body);
}

const R = Math.PI / 180;
function km(aLat, aLon, bLat, bLon) {
  const x =
    Math.sin(((bLat - aLat) * R) / 2) ** 2 +
    Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(((bLon - aLon) * R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

/**
 * Same rule as src/geo.ts, kept here so the coverage report tells the truth —
 * including the longitude reach, which has to widen towards the poles: a
 * degree of longitude is 111 km at the equator and 39 km at Tromsø.
 */
const KM_PER_DEGREE = 111.32;
const lonReach = (lat) =>
  Math.min(180, Math.ceil(MATCH_KM / (KM_PER_DEGREE * Math.cos(Math.min(89.9, Math.abs(lat) + 0.5) * (Math.PI / 180)))));

function lookup(index, lat, lon, cc) {
  let best = null;
  const reach = lonReach(lat);
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -reach; dLon <= reach; dLon++) {
      const lonBucket = ((((Math.floor(lon) + dLon + 180) % 360) + 360) % 360) - 180;
      for (const row of index.get(`${Math.floor(lat) + dLat},${lonBucket}`) ?? []) {
        const d = km(lat, lon, row[0], row[1]);
        if (d > MATCH_KM) continue;
        if (!best || d < best.d - 0.001 || (Math.abs(d - best.d) <= 0.001 && row[2] === cc)) {
          best = { d, row };
        }
      }
    }
  }
  return best?.row ?? null;
}

/**
 * cities15000 is not a list of cities — it also carries the pieces big cities
 * are cut into: Tokyo's 目黒 and 中央, London's Islington and Barking,
 * Singapore's housing estates. Left in, the nearest-city rule answers "目黒"
 * for a probe in Tokyo, which is true of the address and useless to a reader
 * asking which city measured this.
 *
 * So a place is dropped when a neighbour within SWALLOW_KM is at least
 * SWALLOW_RATIO times its size — a ward next to its own metropolis, never two
 * cities that merely sit close. Fremont (230k) survives beside San José
 * (1.0M, 4.4x); 目黒 (280k) does not survive beside Tokyo (9.7M, 34x).
 */
const SWALLOW_KM = 35;
const SWALLOW_RATIO = 5;

function swallowSubdivisions(places) {
  const cells = new Map();
  for (const p of places) {
    const key = `${Math.floor(p.lat)},${Math.floor(p.lon)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  const kept = [];
  for (const p of places) {
    let swallowed = false;
    for (let dLat = -1; dLat <= 1 && !swallowed; dLat++) {
      for (let dLon = -1; dLon <= 1 && !swallowed; dLon++) {
        for (const other of cells.get(`${Math.floor(p.lat) + dLat},${Math.floor(p.lon) + dLon}`) ?? []) {
          if (other === p || other.pop < p.pop * SWALLOW_RATIO) continue;
          if (km(p.lat, p.lon, other.lat, other.lon) <= SWALLOW_KM) {
            swallowed = true;
            break;
          }
        }
      }
    }
    if (!swallowed) kept.push(p);
  }
  process.stderr.write(`swallowed ${places.length - kept.length} sub-city entries\n`);
  return kept;
}

async function atlasProbes() {
  const out = [];
  const fields = "id,country_code,geometry,tags";
  for (let page = 1; ; page++) {
    const url = `${ATLAS}/probes/?status=1&is_public=true&page_size=500&page=${page}&fields=${fields}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`atlas ${res.status}`);
    const body = await res.json();
    out.push(...(body.results ?? []));
    if (!body.next) return out;
  }
}

const main = async () => {
  const res = await fetch(GEONAMES);
  if (!res.ok) throw new Error(`geonames ${res.status}`);
  const text = unzipOne(Buffer.from(await res.arrayBuffer())).toString("utf8");

  const candidates = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    const cc = f[8];
    if (CHINA_CODES.has(cc)) continue; // China is CHINA's job, not GeoNames'.
    const pop = Number(f[14]);
    if (pop < MIN_POP) continue;
    const name = f[1];
    candidates.push({ lat: Number(f[4]), lon: Number(f[5]), cc, name: ZH[`${cc}:${name}`] ?? name, pop });
  }

  const abroad = swallowSubdivisions(candidates).map((c) => [c.lat, c.lon, c.cc, c.name]);

  const cities = [...CHINA, ...abroad]
    .map(([lat, lon, cc, name]) => [Math.round(lat * 1e4), Math.round(lon * 1e4), cc, name])
    .sort((a, b) => a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]));

  // Coverage report: how many real probes this table can actually name. Free —
  // one sweep of Atlas, no credits, no measurement.
  const index = new Map();
  for (const [lat, lon, cc, name] of cities) {
    const key = `${Math.floor(lat / 1e4)},${Math.floor(lon / 1e4)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push([lat / 1e4, lon / 1e4, cc, name]);
  }
  const probes = await atlasProbes();
  const tally = { total: 0, named: 0, cnTotal: 0, cnNamed: 0, countryOnly: 0 };
  const missed = [];
  for (const p of probes) {
    if (!p.geometry || !p.country_code) continue;
    const [lon, lat] = p.geometry.coordinates;
    const china = CHINA_CODES.has(p.country_code);
    // These 500 probes are geolocated to a country centroid, not a place.
    // Naming them would be inventing a fact.
    const centroid = (p.tags ?? []).some((t) => t.slug === "system-auto-geoip-country");
    if (centroid) {
      tally.countryOnly++;
      continue;
    }
    tally.total++;
    if (china) tally.cnTotal++;
    const hit = lookup(index, lat, lon, p.country_code);
    if (hit) {
      tally.named++;
      if (china) tally.cnNamed++;
    } else if (china) {
      missed.push(`${p.id} ${p.country_code} ${lat.toFixed(4)},${lon.toFixed(4)}`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    matchKm: MATCH_KM,
    minPopulation: MIN_POP,
    cities,
  };
  process.stdout.write(JSON.stringify(out) + "\n");

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0");
  process.stderr.write(
    `wrote ${cities.length} cities (${CHINA.length} 中国手写 + ${abroad.length} GeoNames)\n` +
      `coverage: ${tally.named}/${tally.total} nameable probes named ` +
      `(${pct(tally.named, tally.total)}%), ` +
      `${tally.countryOnly} skipped as country-centroid only\n` +
      `中国: ${tally.cnNamed}/${tally.cnTotal} named (${pct(tally.cnNamed, tally.cnTotal)}%)\n` +
      (missed.length ? `中国 unnamed: ${missed.join(" | ")}\n` : ""),
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
