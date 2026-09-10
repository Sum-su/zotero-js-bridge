/* Zotero JS Bridge
 *
 * 在 Zotero 自带的 127.0.0.1 HTTP 服务器（默认 23119）上挂四个端点：
 *
 *   GET  /zoterojs/ping    健康检查，不需要 token
 *   POST /zoterojs/exec    执行任意 JS（支持顶层 await / return），需要 token
 *   POST /zoterojs/merge   带自检的条目合并（支持 dryRun），需要 token
 *   GET|POST /zoterojs/logs 读错误控制台 / 调试输出，需要 token
 *
 * Token 首次启动生成并记在 pref 里，每次启动都写入 Zotero 数据目录下的
 * zoterojs-token.txt，外部程序读这个文件即可。
 *
 * Zotero 的服务器只绑 127.0.0.1，且会拒绝 UA 以 Mozilla/ 开头或带 Origin 头的
 * 请求（browser 防护），token 是第二道闸。不另起 socket，因此不阻止 Zotero 退出。
 */

var token = "";
var savedEndpoints = {};
var epTable = null;
var addonVersion = "?";
var registered = false;

const PREF_TOKEN = "jsbridge.token";          // → extensions.zotero.jsbridge.token
const TOKEN_FILE = "zoterojs-token.txt";
const PATHS = ["/zoterojs/ping", "/zoterojs/exec", "/zoterojs/merge", "/zoterojs/logs"];

function logErr(e) {
  try { Zotero.logError(e); } catch (_) { /* Zotero 不在就没办法了 */ }
}

function makeToken() {
  try {
    if (typeof Zotero.Utilities.randomString === "function") {
      return Zotero.Utilities.randomString(40);
    }
  } catch (e) { logErr(e); }
  try {
    return Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
  } catch (e) { logErr(e); }
  return "t" + Date.now() + Math.random().toString(36).slice(2);
}

async function ensureToken() {
  try { token = Zotero.Prefs.get(PREF_TOKEN) || ""; } catch (e) { token = ""; }
  if (!token) {
    token = makeToken();
    try { Zotero.Prefs.set(PREF_TOKEN, token); } catch (e) { logErr(e); }
  }
  // 落到数据目录，方便外部程序读取；三种写法依次退化
  const p = (() => {
    try { return PathUtils.join(Zotero.DataDirectory.dir, TOKEN_FILE); }
    catch (e) { return Zotero.DataDirectory.dir + "\\" + TOKEN_FILE; }
  })();
  try {
    if (typeof IOUtils !== "undefined" && IOUtils.writeUTF8) {
      await IOUtils.writeUTF8(p, token);
    }
    else if (Zotero.File.putContentsAsync) {
      await Zotero.File.putContentsAsync(p, token);
    }
    else {
      Zotero.File.putContents(p, token);
    }
  } catch (e) { logErr(e); }
}

/* ---------------- 结果序列化 ---------------- */

function safe(v, depth) {
  depth = depth || 0;
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === "string") return v.length > 20000 ? v.slice(0, 20000) + "…[truncated]" : v;
  if (t === "number" || t === "boolean") return v;
  if (t === "function") return `[Function ${v.name || "anonymous"}]`;
  if (t === "symbol" || t === "bigint") return String(v);
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  // Zotero 10 的数据 API 大多是 async（getAll / getDeleted / getAsync …），
  // 忘了 await 的话序列化出来是个空对象 {}，排查起来极费劲 —— 大声报出来。
  if (t === "object" && typeof v.then === "function") {
    return "[Promise 未 await：Zotero 10 里 getAll / getDeleted / getAsync 等都是 async]";
  }
  if (depth > 4) return "[max depth]";

  // Zotero 对象：只摘关键字段，否则序列化会爆
  try {
    if (v instanceof Zotero.Item) {
      return {
        _zoteroItem: v.key,
        itemType: v.itemType,
        title: v.getField("title"),
        date: v.getField("date"),
        deleted: v.deleted,
        collections: v.getCollections().length,
        attachments: v.getAttachments().length,
      };
    }
    if (v instanceof Zotero.Collection) {
      return { _zoteroCollection: v.key, name: v.name, items: v.getChildItems().length };
    }
  } catch (e) { /* 不是 Zotero 对象 */ }

  if (Array.isArray(v)) {
    const out = v.slice(0, 300).map(x => safe(x, depth + 1));
    if (v.length > 300) out.push(`…[${v.length - 300} more]`);
    return out;
  }
  if (t === "object") {
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 120) { out["…"] = "truncated"; break; }
      try { out[k] = safe(v[k], depth + 1); } catch (e) { out[k] = "[throws]"; }
    }
    return out;
  }
  return String(v);
}

function jsonReply(code, obj) {
  return [code, "application/json", JSON.stringify(obj)];
}

/* 常数时间比较。README 从 v1.0.0 起就宣称"constant comparison against the stored
 * token"，实际一直是普通的 !== —— 文档在说谎，这里补上让它变成真的。
 * 长度不等时直接返回是真的会泄漏长度，但 token 长度固定且公开，不构成额外信息。 */
function tokenEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkAuth(options) {
  const h = (options && options.headers) || {};
  const got = h["x-zoterojs-token"];
  if (!token || !got || !tokenEq(String(got), token)) {
    return jsonReply(403, { ok: false, error: "missing or invalid X-ZoteroJS-Token" });
  }
  return null;
}

const SIZE_LIMIT = 1500000;

/* 截断响应时保住 logs —— 响应之所以超限，往往正是因为 log() 吐了太多东西，
 * 而这时候 logs 恰恰是唯一能说明问题的线索，丢掉它是本末倒置。
 * 但不能因此又把响应顶穿，所以给 logs 单独设预算，只留尾部若干条。 */
function clipLogs(logs, maxEntries, maxChars) {
  if (!Array.isArray(logs) || !logs.length) return { logs, omitted: 0 };
  const out = [];
  let used = 0;
  for (let i = logs.length - 1; i >= 0 && out.length < maxEntries; i--) {
    const s = String(logs[i]);
    // out.length 那句让第一条无论多长都留得下，否则只剩个空数组更没用
    if (out.length && used + s.length + 1 > maxChars) break;
    out.push(s);
    used += s.length + 1;                     // +1 补回 join 时的换行
  }
  out.reverse();
  return { logs: out, omitted: logs.length - out.length };
}

function pack(payload) {
  let s;
  try { s = JSON.stringify(payload); }
  catch (e) { return jsonReply(200, { ok: false, error: "JSON.stringify failed: " + (e.message || e) }); }
  if (s.length > SIZE_LIMIT) {
    const { logs, omitted } = clipLogs(payload.logs, 50, 4000);
    const out = {
      ok: payload.ok,
      truncated: true,
      note: `响应 ${s.length} 字节，超过 ${SIZE_LIMIT} 上限，结果已截断`,
      mode: payload.mode,
      ms: payload.ms,
      logs,
      result: safe(payload.result, 2),
    };
    if (omitted) out.logsOmitted = omitted;
    if (payload.error) out.error = safe(payload.error, 2);
    return jsonReply(200, out);
  }
  return [200, "application/json", s];
}

/* ---------------- 执行 JS ---------------- */

const ARG_NAMES = ["Zotero", "Services", "ChromeUtils", "Components", "Cu", "Ci", "Cc",
  "PathUtils", "IOUtils", "OS", "log"];

function argValues(logs) {
  return [
    Zotero, Services, ChromeUtils, Components,
    Components.utils, Components.interfaces, Components.classes,
    (typeof PathUtils !== "undefined" ? PathUtils : null),
    (typeof IOUtils !== "undefined" ? IOUtils : null),
    (typeof OS !== "undefined" ? OS : null),
    (...a) => logs.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(safe(x, 3)))).join(" ")),
  ];
}

async function runCode(code, logs) {
  // 主路径：AsyncFunction —— 支持顶层 await 和 return
  let fn = null, ctorErr = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    fn = new AsyncFunction(...ARG_NAMES, '"use strict";\n' + code);
  } catch (e) { ctorErr = e; }

  if (fn) {
    try {
      return { mode: "AsyncFunction", value: await fn(...argValues(logs)) };
    } catch (e) {
      return { mode: "AsyncFunction", error: e };
    }
  }

  // 退路：new Function 被拦时改用系统沙箱
  try {
    const sb = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      sandboxName: "zoterojs",
      wantGlobalProperties: ["PathUtils", "IOUtils"],
    });
    sb.Zotero = Zotero;
    sb.Services = Services;
    sb.Components = Components;
    sb.log = (...a) => logs.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(safe(x, 3)))).join(" "));
    const value = await Cu.evalInSandbox(`(async () => {\n${code}\n})()`, sb);
    return { mode: "sandbox", value };
  } catch (e) {
    return { mode: "unavailable", error: ctorErr || e };
  }
}

/* ---------------- 合并自检 ---------------- */

/* 归一化噪声字符。原来只列了 U+002D / U+2014 / U+FF0D 三种连字符，
 * 而 Zotero 抓来的条目里 "-" 经常是 EN DASH（U+2013，CNKI、JSTOR、Springer 都这么排），
 * "1–10" 和 "1-10" 于是被判定成不同值 —— 真重复会被自检误杀。
 *
 * \p{Pd} 一次收全所有破折号类（U+002D、U+2010–U+2015、U+FE63、U+FF0D…），
 * 但下面三个不在 Pd 类里，必须单独列：
 *   U+2212 MINUS SIGN 是 Sm（数学符号）
 *   U+00AD SOFT HYPHEN 是 Cf（格式字符）
 *   U+2043 HYPHEN BULLET 是 Po
 * U+200B ZERO WIDTH SPACE 也是 Cf，JS 的 \s 不收它，而网页复制的文字里极常见。 */
const NOISE = /[\s\p{Pd}−­⁃​_.,;:()[\]（）【】《》"'’·、，。：；！？!?]/gu;
const strip = s => String(s || "").toLowerCase().replace(NOISE, "");
// ★ 关键：缺失 ≠ 冲突。只有两边都有值且不同才算冲突
const conflict = (x, y) => !!(strip(x) && strip(y) && strip(x) !== strip(y));
const yearOf = it => (String(it.getField("date") || "").match(/\d{4}/) || [""])[0];

async function getItem(libID, key) {
  try {
    if (Zotero.Items.getByLibraryAndKeyAsync) {
      return await Zotero.Items.getByLibraryAndKeyAsync(libID, key);
    }
  } catch (e) { /* 退化到同步版 */ }
  return Zotero.Items.getByLibraryAndKey(libID, key);
}

async function doMerge(masterKey, dupKeys, dryRun) {
  const libID = Zotero.Libraries.userLibraryID;
  const master = await getItem(libID, masterKey);
  if (!master) return { ok: false, error: `master ${masterKey} 不存在` };
  if (master.deleted) return { ok: false, error: `master ${masterKey} 已在回收站` };

  let mergeItems = null;
  if (!dryRun) {
    try {
      ({ mergeItems } = ChromeUtils.importESModule("chrome://zotero/content/mergeItems.mjs"));
    } catch (e) {
      mergeItems = (m, others) => Zotero.Items.merge(m, others);
    }
  }

  const report = [];
  for (const k of dupKeys) {
    const dup = await getItem(libID, k);
    if (!dup) { report.push({ key: k, merged: false, why: "条目不存在" }); continue; }
    if (dup.deleted) { report.push({ key: k, merged: false, why: "已在回收站" }); continue; }

    // 自检：只有确认是同一种著作才动手
    const checks = {
      "标题相同": strip(master.getField("title")) === strip(dup.getField("title")),
      "类型相同": master.itemType === dup.itemType,
      "年份不冲突": !conflict(yearOf(master), yearOf(dup)),
      "卷号不冲突": !conflict(master.getField("volume"), dup.getField("volume")),
      "期号不冲突": !conflict(master.getField("issue"), dup.getField("issue")),
      "页号不冲突": !conflict(master.getField("pages"), dup.getField("pages")),
      "DOI 不冲突": !conflict(master.getField("DOI"), dup.getField("DOI")),
      "ISBN 不冲突": !conflict(master.getField("ISBN"), dup.getField("ISBN")),
    };
    const failed = Object.keys(checks).filter(c => !checks[c]);
    if (failed.length) {
      report.push({ key: k, merged: false, checks, why: `自检未通过: ${failed.join("、")}` });
      continue;
    }
    if (dryRun) {
      report.push({ key: k, merged: false, dryRun: true, checks,
        attachments: master.getAttachments().length + dup.getAttachments().length,
        collections: master.getCollections().length + dup.getCollections().length });
      continue;
    }
    const nAtt = master.getAttachments().length + dup.getAttachments().length;
    try {
      await mergeItems(master, [dup]);
      report.push({ key: k, merged: true, checks, attachments: nAtt });
    } catch (e) {
      report.push({ key: k, merged: false, checks, why: "mergeItems 报错: " + (e.message || e) });
    }
  }
  return {
    ok: true,
    dryRun: !!dryRun,
    master: { key: master.key, title: master.getField("title") },
    report,
    attachmentsAfter: master.getAttachments().length,
  };
}

/* ---------------- 日志 ---------------- */

/* 两个源，可用性完全不同，别混为一谈：
 *
 *   console —— Services.console（"工具 → 错误控制台"里那些）。永远有货，
 *              不需要开任何 pref，实测 250 条。getMessageArray() 返回快照数组，只读安全。
 *
 *   debug   —— Zotero.Debug 的内部 _output。只在 _store 为真时才填充，
 *              而 debug.store 是个一次性 pref（debug.js 的 init() 读完就把它设回 false），
 *              所以默认 count()=0 是正常状态，不是坏了。
 *
 * 取 debug 只能走 Zotero.Debug.get() 的无参形式，原因有二：
 *   - get(maxChars, maxLineLength) 里 `var output = _output`，传 maxLineLength 会
 *     就地 ellipsize 掉缓冲区里的行 —— 永久截断用户正在看的调试输出。
 *   - getConsoleViewerOutput() 会把 _consoleViewerQueue 读空（`_consoleViewerQueue = []`），
 *     调试输出窗口开着时等于从用户眼皮底下偷走那些行。
 * get() 无参两个坑都不踩，代价是它顺带拼上了系统信息和错误报告，多几百字节。 */

const MAX_MSG_CHARS = 2000;      // 单条消息的字符上限，防止一条超大 dump 顶爆响应
const DEBUG_MAX_CHARS = 100000;  // debug 文本的字符上限，只保留尾部

/* Log.sys.mjs（Firefox 的 modules/Log.sys.mjs）写进控制台的普通消息长这样：
 *     <毫秒时间戳>\t<logger 名>\t<级别>\t<正文>
 * 级别取自它的 Level.Desc 表：FATAL / ERROR / WARN / INFO / CONFIG / DEBUG / TRACE。
 *
 * 为什么不能只信 m.logLevel：实测一条正文写着 WARN 的 addons.xpi 消息带的是
 * logLevel = 1（按 nsIConsoleMessage 的常量就是 info），照 logLevel 分类会让
 * --min-level warn 把这条 WARN 悄悄漏掉 —— 恰好是日志端点最该命中的那类。 */
const LOG_LINE_RE = /^\d{10,}\t([^\t]*)\t(FATAL|ERROR|WARN|INFO|CONFIG|DEBUG|TRACE)\t([\s\S]*)$/;
const LOG_LEVEL_MAP = {
  FATAL: "error", ERROR: "error", WARN: "warning",
  INFO: "info", CONFIG: "info", DEBUG: "debug", TRACE: "debug",
};

// nsIScriptError.flags 的位。实测 Ci.nsIScriptError 上只暴露了 errorFlag/warningFlag/
// infoFlag，exceptionFlag 和 strictFlag 是 undefined，所以数值直接写字面量。
// flags === 0 就是 errorFlag（= 0，任何位都没置）。
function levelOf(m, logLineLevel) {
  try {
    const flags = m.flags;
    if (typeof flags === "number") {
      if (flags & 8) return "info";
      if (flags & 4) return "strict";
      if (flags & 2) return "exception";
      if (flags & 1) return "warning";
      return "error";
    }
  } catch (e) { /* 不是 nsIScriptError，往下走 */ }
  if (logLineLevel) return LOG_LEVEL_MAP[logLineLevel];
  try {
    // nsIConsoleMessage 的 logLevel：debug=0 / info=1 / warn=2 / error=3。
    // 必须挡 typeof —— 下标不是数字时（比如 "constructor"）会命中 Array 的原型属性，
    // 返回一个函数而不是 undefined，后面对它做算术会得到一堆 NaN 比较。
    const lv = m.logLevel;
    if (typeof lv === "number" && lv >= 0 && lv <= 3) {
      return ["debug", "info", "warn", "error"][lv];
    }
  } catch (e) { /* 没有 logLevel 字段 */ }
  return "log";
}

// minLevel 用"至少这么严重"的语义，比精确匹配好用
const SEVERITY = { debug: 0, log: 1, info: 1, strict: 2, warn: 2, warning: 2, exception: 3, error: 3 };

function describeMsg(m) {
  const o = { time: 0, level: "log", message: "" };
  try { o.time = Number(m.timeStamp) || 0; } catch (e) { /* 没有就算了 */ }
  if (o.time) { try { o.iso = new Date(o.time).toISOString(); } catch (e) { } }
  // 对 nsIScriptError，message 是包了一层的 '[JavaScript Warning: "..." {file:line}]'，
  // errorMessage 才是干净原文；普通消息没有 errorMessage，自然落回 message。
  let text = "";
  try { text = m.errorMessage || m.message || ""; } catch (e) { }
  text = String(text);
  // Log.sys.mjs 那层前缀（时间戳/logger 名/级别）是给机器看的，扒掉，级别单独给字段
  const line = LOG_LINE_RE.exec(text);
  if (line) {
    o.logger = line[1];
    text = line[3];
  }
  o.level = levelOf(m, line ? line[2] : null);
  if (text.length > MAX_MSG_CHARS) {
    o.messageClipped = text.length;
    text = text.slice(0, MAX_MSG_CHARS) + "…";
  }
  o.message = text;
  try { if (m.category) o.category = String(m.category); } catch (e) { }
  try { if (m.sourceName) o.source = String(m.sourceName); } catch (e) { }
  try { if (m.lineNumber) o.line = m.lineNumber; } catch (e) { }
  try { if (m.columnNumber) o.column = m.columnNumber; } catch (e) { }
  try { if (typeof m.flags === "number") o.flags = m.flags; } catch (e) { }
  try { if (typeof m.logLevel === "number") o.logLevel = m.logLevel; } catch (e) { }
  return o;
}

/* 参数既能从 GET 的 searchParams 来，也能从 POST 的 JSON body 来。
 * server.js:479 的 options 是 {method, pathname, pathParams, searchParams, headers, data}，
 * GET 走的是 data = null，所以查询串必须从 searchParams 读。 */
function readParams(options) {
  const out = {};
  try {
    const sp = options && options.searchParams;
    if (sp && typeof sp.forEach === "function") sp.forEach((v, k) => { out[k] = v; });
  } catch (e) { /* 没有查询串 */ }
  const d = options && options.data;
  if (d && typeof d === "object") for (const k of Object.keys(d)) out[k] = d[k];
  return out;
}

function asBool(v) {
  if (v === true) return true;
  return ["1", "true", "yes", "on"].indexOf(String(v == null ? "" : v).toLowerCase()) >= 0;
}

function asInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function readConsole(params) {
  let all;
  try { all = Services.console.getMessageArray() || []; }
  catch (e) { return { error: "Services.console 不可用: " + String(e.message || e) }; }

  const total = all.length;
  let list = all.map(describeMsg);

  // typeof 而不是 !== undefined：SEVERITY["constructor"] 是 Object 的构造函数，
  // 不是 undefined，会一路混进比较里
  const minLevel = String(params.minLevel || params.level || "all").toLowerCase();
  if (typeof SEVERITY[minLevel] === "number") {
    const min = SEVERITY[minLevel];
    list = list.filter(m => (SEVERITY[m.level] || 0) >= min);
  }
  const cat = String(params.category || "").toLowerCase();
  if (cat) list = list.filter(m => String(m.category || "").toLowerCase().indexOf(cat) >= 0);
  const grep = String(params.grep || "").toLowerCase();
  if (grep) {
    // logger 名也算在内。Log.sys.mjs 的前缀被扒掉之后，正文里就不再出现 logger 名了，
    // 只搜正文的话 `grep=addons.xpi` 会莫名其妙地搜不到那些消息本身。
    list = list.filter(m =>
      ((m.logger ? m.logger + " " : "") + m.message).toLowerCase().indexOf(grep) >= 0);
  }
  const since = parseInt(params.since, 10);
  if (isFinite(since) && since > 0) list = list.filter(m => m.time >= since);

  const matched = list.length;
  const limit = asInt(params.limit, 100, 1, 1000);
  const returned = Math.min(limit, matched);
  // 从最新往回取：日志场景要的是"刚才发生了什么"。返回的这批仍按时间正序。
  const messages = list.slice(matched - returned);

  const out = { total, matched, returned, messages };
  if (matched > returned) out.omitted = matched - returned;
  return out;
}

async function readDebug() {
  const out = { storing: false, count: 0, enabled: 0, text: "" };
  try {
    out.storing = !!Zotero.Debug.storing;
    out.count = Zotero.Debug.count();
    out.enabled = Zotero.Debug.enabled;
  } catch (e) { /* 接口没了就报默认值 */ }
  if (!out.count) {
    out.note = "调试缓冲为空。要在本次会话里启用：设置 extensions.zotero.debug.store = true " +
      "然后重启 Zotero —— 它是一次性 pref，Zotero 启动读完就会自己设回 false。";
    return out;
  }
  try {
    // 无参调用：不改缓冲区、不偷 _consoleViewerQueue（见本节开头）
    let text = String((await Zotero.Debug.get()) || "");
    if (text.length > DEBUG_MAX_CHARS) {
      out.textClipped = text.length;
      text = "…[前 " + (text.length - DEBUG_MAX_CHARS) + " 字符已省略]\n" + text.slice(-DEBUG_MAX_CHARS);
    }
    out.text = text;
  } catch (e) {
    out.error = "Zotero.Debug.get() 报错: " + String(e.message || e);
  }
  return out;
}

/* ---------------- 端点定义 ---------------- */

// server.js 里是 `var endpoint = new this.endpoint();`，所以必须交出构造函数
function Ctor(proto) {
  const F = function () {};
  F.prototype = proto;
  return F;
}

const EP_PING = Ctor({
  supportedMethods: ["GET"],
  init: async function (options) {
    return jsonReply(200, {
      ok: true,
      name: "Zotero JS Bridge",
      version: addonVersion,
      zotero: Zotero.version,
      libraryID: Zotero.Libraries.userLibraryID,
      endpoints: PATHS,
    });
  },
});

const EP_EXEC = Ctor({
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options);
    if (bad) return bad;

    const data = options.data || {};
    const code = String(data.code || "");
    if (!code.trim()) return jsonReply(400, { ok: false, error: "code 为空" });

    const logs = [];
    const t0 = Date.now();
    const r = await runCode(code, logs);
    const ms = Date.now() - t0;

    if (r.error) {
      return pack({ ok: false, mode: r.mode, ms, logs,
        error: String((r.error && r.error.message) || r.error),
        stack: String((r.error && r.error.stack) || "") });
    }
    return pack({ ok: true, mode: r.mode, ms, logs, result: safe(r.value, 0) });
  },
});

const EP_MERGE = Ctor({
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options);
    if (bad) return bad;

    const data = options.data || {};
    const masterKey = String(data.master || "");
    const dupKeys = Array.isArray(data.dups) ? data.dups.map(String) : [];
    if (!masterKey || !dupKeys.length) {
      return jsonReply(400, { ok: false, error: "需要 {master: 'KEY', dups: ['KEY', ...]}" });
    }
    try {
      return pack(await doMerge(masterKey, dupKeys, !!data.dryRun));
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_LOGS = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options);
    if (bad) return bad;

    const p = readParams(options);
    const source = String(p.source || "console").toLowerCase();
    if (["console", "debug", "both"].indexOf(source) < 0) {
      return jsonReply(400, { ok: false, error: "source 只能是 console / debug / both" });
    }

    const out = { ok: true, source, params: p };
    if (source !== "debug") out.console = readConsole(p);
    if (source !== "console") out.debug = await readDebug();

    // clear 默认关。开了就只清被本次读到的那些源，不做额外的事。
    if (asBool(p.clear)) {
      try {
        if (source !== "debug") { Services.console.reset(); out.cleared = ["console"]; }
        if (source !== "console") {
          Zotero.Debug.clear();
          out.cleared = (out.cleared || []).concat("debug");
        }
      } catch (e) { out.clearError = String(e.message || e); }
    }

    return pack(out);
  },
});

/* ---------------- 生命周期 ---------------- */

async function startup({ id, version, resourceURI, rootURI }, reason) {
  addonVersion = version || "?";
  try { await Zotero.initializationPromise; } catch (e) { /* 已经初始化完也会 resolve */ }

  try {
    if (Zotero.Prefs.get("jsbridge.enabled") === false) {
      Zotero.debug("Zotero JS Bridge: 已禁用（jsbridge.enabled=false）");
      return;
    }
  } catch (e) { /* pref 未注册时按启用处理 */ }

  await ensureToken();

  epTable = {
    "/zoterojs/ping": EP_PING,
    "/zoterojs/exec": EP_EXEC,
    "/zoterojs/merge": EP_MERGE,
    "/zoterojs/logs": EP_LOGS,
  };
  for (const path of Object.keys(epTable)) {
    const existing = Zotero.Server.Endpoints[path];
    // bootstrapped 扩展是原地热重载的，startup() 可能被调第二次。无条件保存的话，
    // 第二次会把「我们自己上次装进去的」当成原值存下来，于是 shutdown() 之后
    // 端点还原成我们的旧版本而不是真正被顶掉的那个，甚至删不掉。
    if (!(path in savedEndpoints) && existing && existing !== epTable[path]) {
      savedEndpoints[path] = existing;
    }
    Zotero.Server.Endpoints[path] = epTable[path];
  }
  registered = true;
  Zotero.debug(`Zotero JS Bridge: 已注册 ${Object.keys(epTable).join(", ")}`);
}

async function onMainWindowLoad({ window }, reason) {}
async function onMainWindowUnload({ window }, reason) {}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  // savedEndpoints 故意不清空：清空之后再来一次 shutdown 就会走到 else 分支，
  // 把已经还原好的原件当成我们的端点删掉。用 registered 挡住重入即可。
  if (!registered) return;
  registered = false;
  for (const path of PATHS) {
    if (savedEndpoints[path]) Zotero.Server.Endpoints[path] = savedEndpoints[path];
    else delete Zotero.Server.Endpoints[path];
  }
  Zotero.debug("Zotero JS Bridge: 已卸载端点");
}

function install(data, reason) {}
function uninstall(data, reason) {}
