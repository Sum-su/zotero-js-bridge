/* Zotero JS Bridge
 *
 * 在 Zotero 自带的 127.0.0.1 HTTP 服务器（默认 23119）上挂八个端点：
 *
 *   GET       /zoterojs/ping    健康检查，不需要 token
 *   POST      /zoterojs/exec    执行任意 JS（支持顶层 await / return），需要 token
 *   POST      /zoterojs/merge   带自检的条目合并（支持 dryRun），需要 token
 *   GET|POST  /zoterojs/logs    读错误控制台 / 调试输出，需要 token
 *   GET|POST  /zoterojs/query   结构化只读查询（不用写 SQL），需要 token
 *   GET|POST  /zoterojs/doctor  库体检：孤儿目录、未归类、附件标题、重名附件…需要 token
 *   POST      /zoterojs/apply   批量写（支持 dryRun）+ 集合归属前后差分，需要 token
 *   GET|POST  /zoterojs/enrich  扫描件补全：找没文本层的 PDF / 写回视觉读到的，需要 token
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

const PANE_ID = "zoterojs-bridge-pane";       // 固定 id，热重载时才能把旧的那块摘掉
const PREF_TOKEN = "jsbridge.token";          // → extensions.zotero.jsbridge.token
const PREF_ENABLED = "jsbridge.enabled";
const PREF_READONLY = "jsbridge.readonly";
const PREF_RESPONSE_KB = "jsbridge.limit.responseKB";
const PREF_BACKUP = "jsbridge.backup.enabled";
const PREF_BACKUP_KEEP = "jsbridge.backup.keep";
const PREF_ENRICH_MIN = "jsbridge.enrich.minChars";
const TOKEN_FILE = "zoterojs-token.txt";
const BACKUP_DIR = "jsbridge-backups";
const PATHS = ["/zoterojs/ping", "/zoterojs/exec", "/zoterojs/merge", "/zoterojs/logs",
  "/zoterojs/query", "/zoterojs/doctor", "/zoterojs/apply", "/zoterojs/enrich",
  "/zoterojs/storage"];

/* 每个端点一个开关。面板上勾掉哪个，哪个当场返回 404 —— 闸门在请求路径上现读 pref，
 * 所以改完立刻生效，既不用重启也不用重新注册端点。 */
const PREF_EP = {
  "/zoterojs/ping": "jsbridge.endpoint.ping",
  "/zoterojs/exec": "jsbridge.endpoint.exec",
  "/zoterojs/merge": "jsbridge.endpoint.merge",
  "/zoterojs/logs": "jsbridge.endpoint.logs",
  "/zoterojs/query": "jsbridge.endpoint.query",
  "/zoterojs/doctor": "jsbridge.endpoint.doctor",
  "/zoterojs/apply": "jsbridge.endpoint.apply",
  "/zoterojs/enrich": "jsbridge.endpoint.enrich",
  "/zoterojs/storage": "jsbridge.endpoint.storage",
};

/* 读 pref 的三条规矩（都踩过）：
 *   - 用短名：Zotero.Prefs.get 自己补 extensions.zotero. 前缀，写全长反而取不到；
 *   - pref 没注册时返回 undefined，不是 false，不能直接当真假用；
 *   - 空字符串也是 falsy，所以这里把 "" 当成"没设过"回落到默认值。 */
function prefBool(name, dflt) {
  try {
    const v = Zotero.Prefs.get(name);
    if (v === undefined || v === null || v === "") return dflt;
    return !!v;
  } catch (e) { return dflt; }
}

function prefInt(name, dflt, lo, hi) {
  try {
    const n = parseInt(Zotero.Prefs.get(name), 10);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  } catch (e) { return dflt; }
}

// 响应上限做成可调：exec 吐一大片数据时，卡住的是调用方而不是 Zotero
function responseLimit() { return prefInt(PREF_RESPONSE_KB, 1500, 10, 20000) * 1000; }

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

function tokenFilePath() {
  try { return PathUtils.join(Zotero.DataDirectory.dir, TOKEN_FILE); }
  catch (e) { return Zotero.DataDirectory.dir + "\\" + TOKEN_FILE; }
}

// 落到数据目录，方便外部程序读取；三种写法依次退化
async function writeTokenFile() {
  const p = tokenFilePath();
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
    return { ok: true, path: p };
  } catch (e) {
    logErr(e);
    return { ok: false, path: p, error: String((e && e.message) || e) };
  }
}

async function ensureToken() {
  try { token = Zotero.Prefs.get(PREF_TOKEN) || ""; } catch (e) { token = ""; }
  if (!token) {
    token = makeToken();
    try { Zotero.Prefs.set(PREF_TOKEN, token); } catch (e) { logErr(e); }
  }
  await writeTokenFile();
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

/* 闸门。放在鉴权之后：没带对 token 的请求不该从错误信息里读出我们的配置。
 *
 * write=true 的端点（以及 logs 的 clear）在只读模式下整体拒绝。
 * 只读模式**不是沙箱**——它不分析你的代码，因为 exec 能写出多少种副作用根本
 * 静态判不全，假装能判只会给人虚假的安全感。它的语义是"拒绝服务"：
 * 把写入口整个关掉，读的口子留着。 */
function gate(path, write) {
  if (!prefBool(PREF_ENABLED, true)) {
    return jsonReply(503, {
      ok: false,
      error: "JS Bridge 已停用（首选项 → 插件 → JS Bridge 的总开关）",
      pref: "extensions.zotero." + PREF_ENABLED,
    });
  }
  if (!prefBool(PREF_EP[path], true)) {
    return jsonReply(404, {
      ok: false,
      error: `端点 ${path} 已在首选项里关闭`,
      pref: "extensions.zotero." + PREF_EP[path],
    });
  }
  if (write && prefBool(PREF_READONLY, false)) {
    return jsonReply(403, {
      ok: false,
      error: "只读模式已开启：写操作与合并被整体拒绝",
      pref: "extensions.zotero." + PREF_READONLY,
    });
  }
  return null;
}

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
  const limit = responseLimit();
  if (s.length > limit) {
    const { logs, omitted } = clipLogs(payload.logs, 50, 4000);
    const out = {
      ok: payload.ok,
      truncated: true,
      note: `响应 ${s.length} 字节，超过 ${limit} 上限，结果已截断` +
        `（上限可在 首选项 → 插件 → JS Bridge 里调）`,
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
// GET 过来的参数**全都是字符串**，`where=[{...}]` 这种带结构的参数用 GET 根本传不进来
// （curl 和 zoterojs.py 都是 GET）。所以在这一层统一解一次：看着像数组/对象的才解，
// 解不出来就原样当字符串 —— 别把 "2022" 变成数字，"0012" 那种前导零会被吃掉。
function decodeParam(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s[0] !== "[" && s[0] !== "{") return v;
  try { return JSON.parse(s); } catch (e) { return v; }
}

function readParams(options) {
  const out = {};
  try {
    const sp = options && options.searchParams;
    if (sp && typeof sp.forEach === "function") sp.forEach((v, k) => { out[k] = decodeParam(v); });
  } catch (e) { /* 没有查询串 */ }
  const d = options && options.data;
  if (d && typeof d === "object") for (const k of Object.keys(d)) out[k] = d[k];
  return out;
}

// 列表参数两种写法都收：JSON 数组（POST，以及 decodeParam 解出来的 GET），
// 或者逗号分隔的字符串（`checks=sync,unfiled`）。命令行里后者好敲得多。
function asList(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(",").map(s => s.trim()).filter(Boolean);
  return null;
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

/* ---------------- 备份 ---------------- */

/* 用 VACUUM INTO，不用 Zotero.DB.backUpDatabase()：后者默认写 zotero.sqlite.bak
 * 并且做轮转，可能把 .1.bak 那个唯一还原点覆盖掉。
 *
 * VACUUM INTO 实测（Zotero 10.0.2，52 MB 的库）：586 ms、不动 WAL、
 * **目标已存在就直接报错拒写**，所以撞名不会静默盖掉上一份。
 * 目标路径走绑定参数是可行的（不是字符串拼接）——省掉 Windows 反斜杠转义那一堆事。 */

function backupDirPath() {
  try { return PathUtils.join(Zotero.DataDirectory.dir, BACKUP_DIR); }
  catch (e) { return Zotero.DataDirectory.dir + "\\" + BACKUP_DIR; }
}

async function listBackups() {
  try {
    const kids = await IOUtils.getChildren(backupDirPath());
    return kids.map(p => PathUtils.filename(p))
      .filter(n => n && n.endsWith(".sqlite"))
      .sort();                      // 文件名以 ISO 时间戳开头，字典序就是时间序
  } catch (e) { return []; }        // 目录还不存在
}

async function rotateBackups(keep) {
  const all = await listBackups();
  const dead = all.slice(0, Math.max(0, all.length - keep));
  const removed = [];
  for (const n of dead) {
    try {
      await IOUtils.remove(PathUtils.join(backupDirPath(), n));
      removed.push(n);
    } catch (e) { logErr(e); }
  }
  return removed;
}

// 撞名时往后加序号，而不是让 VACUUM INTO 报错 —— 同一毫秒内连备两次虽然不常见，
// 但自动备份是挂在写操作上的，连着来两条命令就会撞上。
async function freeBackupPath(stamp) {
  for (let i = 1; i < 100; i++) {
    const name = `zotero-${stamp}${i === 1 ? "" : "-" + i}.sqlite`;
    const p = PathUtils.join(backupDirPath(), name);
    let exists = false;
    try { exists = await IOUtils.exists(p); } catch (e) { /* 查不到就试写 */ }
    if (!exists) return p;
  }
  throw new Error("同名备份太多，先清一下 " + backupDirPath());
}

async function doBackup() {
  const dir = backupDirPath();
  await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = await freeBackupPath(stamp);
  const t0 = Date.now();
  await Zotero.DB.queryAsync("VACUUM INTO ?", [dest]);
  let bytes = 0;
  try { bytes = (await IOUtils.stat(dest)).size; } catch (e) { logErr(e); }
  const keep = prefInt(PREF_BACKUP_KEEP, 5, 1, 200);
  const removed = await rotateBackups(keep);
  return {
    path: dest,
    bytes,
    ms: Date.now() - t0,
    kept: keep,
    removed,
    remaining: (await listBackups()).length,
  };
}

/* 自动备份挂在写操作上。备份失败就**不写** —— 用户专门打开这个开关就是为了有个兜底，
 * 兜不住还照写，等于把这个开关变成一句安慰话。 */
async function backupBefore(tag) {
  if (!prefBool(PREF_BACKUP, false)) return null;
  try {
    const b = await doBackup();
    b.reason = tag;
    return b;
  } catch (e) {
    throw new Error(`自动备份失败（${tag}），本次写操作已中止：` + String(e.message || e) +
      `\n备份开关：extensions.zotero.${PREF_BACKUP}`);
  }
}

/* ---------------- 结构化查询 ---------------- */

/* 目的不是"再做一个 SQL 壳"，而是**让调用方不用写 SQL**——那三类坑
 * （LIKE 必须带绑定、字符串里不能有字面问号、全角字符会炸解析器）全在 SQL 那一层，
 * 走 Zotero 自己的 Search 就一个都碰不到。
 *
 * 条件名和算符不猜：拿 Zotero.SearchConditions 现查现验，不认识就报 400 并把
 * 可选的面列出来。查的是真源码里的那张表（searchConditions.js），不是文档。 */

const QUERY_SHORTHAND = {
  title: "title", doi: "DOI", isbn: "ISBN", creator: "creator", author: "creator",
  collection: "collection", tag: "tag", itemType: "itemType", type: "itemType",
  key: "key", abstract: "abstractNote", journal: "publicationTitle",
  q: "titleCreatorYear", text: "fulltextContent", year: "year",
};

function conditionOps(field) {
  try {
    const c = Zotero.SearchConditions.get(field);
    return c && c.operators ? Object.keys(c.operators) : null;
  } catch (e) { return null; }
}

// 简写默认用 contains（"查得到"比"一模一样"常用得多），但 is / true 这类要显式给的
// 条件给个好默认值。
function defaultOp(field) {
  const ops = conditionOps(field) || [];
  if (ops.indexOf("contains") >= 0) return "contains";
  if (ops.indexOf("is") >= 0) return "is";
  if (ops.indexOf("true") >= 0) return "true";
  return ops[0];
}

function buildConditions(p) {
  const out = [];
  const bad = [];
  const push = (field, op, value) => {
    const ops = conditionOps(field);
    if (!ops) { bad.push(`未知条件 ${field}`); return; }
    const o = op || defaultOp(field);
    if (ops.indexOf(o) < 0) { bad.push(`${field} 不支持算符 ${o}（可用：${ops.join(" / ")}）`); return; }
    out.push([field, o, value]);
  };

  for (const k of Object.keys(QUERY_SHORTHAND)) {
    if (p[k] === undefined || p[k] === null || p[k] === "") continue;
    push(QUERY_SHORTHAND[k], p[k + "Op"], p[k]);
  }
  const where = Array.isArray(p.where) ? p.where : [];
  for (const w of where) {
    if (!w || !w.field) { bad.push("where 里有一项没写 field"); continue; }
    push(String(w.field), w.op, w.value);
  }
  if (asBool(p.unfiled) || String(p.unfiled || "").toLowerCase() === "true") {
    push("unfiled", "true", true);
  }
  return { conditions: out, bad };
}

async function collectionsBrief(ids) {
  const out = {};
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await Zotero.DB.queryAsync(
    `SELECT ci.itemID AS itemID, c.collectionID AS cid, c.collectionName AS name, c.key AS ckey
     FROM collectionItems ci JOIN collections c ON c.collectionID = ci.collectionID
     WHERE ci.itemID IN (${marks})`, ids);
  for (const r of rows || []) {
    (out[r.itemID] = out[r.itemID] || []).push({ key: r.ckey, name: r.name });
  }
  return out;
}

function creatorLine(c) {
  if (c.fieldMode === 1) return String(c.lastName || "");
  return [c.lastName, c.firstName].filter(Boolean).join(" ");
}

async function doQuery(p) {
  const { conditions, bad } = buildConditions(p);
  if (bad.length) {
    return { error: bad.join("；") + "\n可用条件见 Zotero.SearchConditions.getStandardConditions()，" +
      "常用的：title / DOI / ISBN / creator / collection / tag / itemType / anyField / q（标题+作者+年份）" };
  }
  if (!conditions.length) {
    return { error: "没给查询条件。至少要有一个（title / doi / creator / collection / tag / where）" };
  }

  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  for (const [f, o, v] of conditions) {
    // 集合用 key 还是名字都能给：key 是 8 位且库里认得出来才当 key，否则当名字
    s.addCondition(f, o, v);
  }
  let ids = [];
  try { ids = await s.search(); }
  catch (e) { return { error: "搜索失败: " + String(e.message || e), conditions }; }

  const limit = asInt(p.limit, 50, 1, 500);
  const total = ids.length;
  const shown = ids.slice(0, limit);
  const items = (await Zotero.Items.getAsync(shown) || []).filter(Boolean);
  const wantCols = p.includeCollections === undefined || asBool(p.includeCollections);
  const cols = wantCols ? await collectionsBrief(shown) : {};

  // 父条目一次批量查出来，别在循环里一条条 get
  const parents = items.map(it => it.parentItemID).filter(Boolean);
  const parentKeys = {};
  if (parents.length) {
    for (const p of (await Zotero.Items.getAsync([...new Set(parents)]) || [])) {
      if (p) parentKeys[p.itemID] = p.key;
    }
  }

  const fields = asList(p.fields) || [];
  const out = items.map(it => {
    const o = {
      key: it.key,
      itemID: it.itemID,
      itemType: Zotero.ItemTypes.getName(it.itemTypeID),
      title: it.getField("title"),
      date: it.getField("date"),
      creators: it.getCreators().map(creatorLine).filter(Boolean),
      inTrash: !!it.deleted,
    };
    if (it.parentItemID) o.parent = parentKeys[it.parentItemID] || it.parentItemID;
    for (const f of fields) {
      try { o[f] = it.getField(f); } catch (e) { o[f] = "[没有这个字段]"; }
    }
    if (wantCols) o.collections = cols[it.itemID] || [];
    return o;
  });

  const res = { ok: true, total, returned: out.length, items: out, conditions };
  if (total > out.length) {
    res.omitted = total - out.length;
    res.hint = `命中 ${total} 条，只回了前 ${out.length} 条（limit）。` +
      `items[].key 可以直接喂给 merge / apply。`;
  }
  return res;
}

/* ---------------- 库体检 ---------------- */

/* 检查项都是这台机器上真踩过的坑，判据照抄 docs/07 和 docs/08 —— 不是凭空想的规则。 */

const DOCTOR_CHECKS = ["orphanStorage", "linkedFiles", "tagVariants", "unfiled", "attachmentTitle",
  "duplicateFilenames", "duplicates", "trashWriteback", "sync"];

// 默认只跑本地检查。sync 要连 zotero.org，藏在一个"体检"按钮后面不合适 —— 想要就点名要。
const DOCTOR_DEFAULT = DOCTOR_CHECKS.filter(c => c !== "sync");

const mb = (b) => Math.round(b / 1048576 * 10) / 10;

/* 目录遍历。两个实测过的坑，都吃过：
 *   - `Zotero.File.iterateDirectory` 返回的东西**不可直接 for...of**（实测抛
 *     "is not iterable"），所以这里自己用 IOUtils.getChildren 递归。
 *   - `IOUtils.stat().type` 对普通文件是 **"regular"**，不是 "regularFile"。
 *     写成后者不会抛错，只是所有文件都不匹配 —— 于是体积统计出一个**自信的 0**。
 *     2026-09-13 就是这么被骗过一次的。两处都有 mutant 盯着（见 mutate.py）。 */
const CACHE_FILE_RE = /^\.zotero-(?:ft-cache|reader-state)/;

/* `strict` 只管**根目录**：根读不了就抛出去。
 * 子树读不了照旧跳过 —— 根是调用方给的，它错了是调用方的问题（典型是把路径打错），
 * 静默返回 0 个文件会让 relocate 报出「扫了 0 个、修了 0 个」，看着像"没事"，
 * 而不是"你给我的路径是错的"。子树属于数据，里面的权限或损坏问题不该让整件事失败。
 * （2026-09-13：不传 strict 时，`relocate dir=Z:\根本不存在` 会回 200 + scanned:0。） */
async function walkFiles(root, strict) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let kids;
    try { kids = await IOUtils.getChildren(cur); }
    catch (e) { if (strict && cur === root) throw e; continue; }
    for (const p of kids || []) {
      let st;
      try { st = await IOUtils.stat(p); } catch (e) { continue; }
      if (st.type === "directory") { stack.push(p); continue; }
      const name = PathUtils.filename(p);
      out.push({ path: p, name: name, size: Number(st.size) || 0, cache: CACHE_FILE_RE.test(name) });
    }
  }
  return out;
}

function extOf(name) {
  const m = String(name).match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : "(无扩展名)";
}

async function checkOrphanStorage(p) {
  const live = new Set(await Zotero.DB.columnQueryAsync(
    "SELECT key FROM items WHERE itemID IN (SELECT itemID FROM itemAttachments)") || []);
  const dir = PathUtils.join(Zotero.DataDirectory.dir, "storage");
  let kids = [];
  try { kids = await IOUtils.getChildren(dir); } catch (e) { return { error: String(e.message || e) }; }
  const dirs = kids.map(f => PathUtils.filename(f)).filter(n => n && n.length === 8);
  const orphans = dirs.filter(n => !live.has(n));

  /* 只走孤儿那几棵子树，**不遍历整个 storage/**。理由是这两条，都是 2026-09-13 实测的：
   *   · 孤儿那几棵树一共 447 个文件 / 3.53 GB / 220 ms；
   *     全量是 3820 个文件 / 13.67 GB / ~2.0 s —— 九倍的 I/O，而活目录里的内容
   *     **对这份输出毫无贡献**（活目录不可能出现在孤儿清单里）。
   *   · 需要活目录内容的只有 deep，所以它单独开关。
   * 别在这里写「全量遍历会超时」：那是错的，全量稳定在 2 秒（跑了三遍：2023/2013/2054 ms）。
   * 更要命的是 deep 走的就是全量，等于说一个每次调用都在做的动作会超时。 */
  let files = 0, bytes = 0, cacheFiles = 0, cacheBytes = 0;
  const byExt = {};
  const orphanFiles = [];
  for (const n of orphans) {
    for (const f of await walkFiles(PathUtils.join(dir, n))) {
      files++; bytes += f.size;
      orphanFiles.push(f);
      if (f.cache) { cacheFiles++; cacheBytes += f.size; continue; }
      const k = extOf(f.name);
      const b = byExt[k] || (byExt[k] = { files: 0, bytes: 0 });
      b.files++; b.bytes += f.size;
    }
  }

  const out = {
    count: orphans.length,
    scanned: dirs.length,
    files: files,
    bytes: bytes,
    mb: mb(bytes),
    // 缓存那一组也要报出来。只报 content 的话，两个数之间的差是个**算不出来的数**，
    // 而"差在哪"恰恰是这一项唯一的用处（缓存可以再生，内容不行）。
    cacheFiles: cacheFiles,
    cacheBytes: cacheBytes,
    cacheMB: mb(cacheBytes),
    contentFiles: files - cacheFiles,
    contentBytes: bytes - cacheBytes,
    contentMB: mb(bytes - cacheBytes),
    byExt: byExt,
    sample: orphans.slice(0, 20),
    note: "孤儿目录 = storage/ 下有、items 表里没有对应附件。这个数**只增不减**是正常的：" +
      "历史遗留会一直留着。要看的是**本次操作前后有没有变多**，别把基数当故障。\n" +
      "体积那一组按**内容**和**缓存**分开算：`.zotero-ft-cache` / `.zotero-reader-state` " +
      "是 Zotero 自己可再生出来的，内建的 Zotero.FullText.purgeOrphanedContent 就管这个；" +
      "真正占地方的是 contentMB。\n" +
      "内建**没有**任何东西清理剩下的那些文件：Zotero 10 里没有 Zotero.FileIntegrity，" +
      "Zotero.Schema.integrityCheck 查的是数据库 schema，不碰文件系统。",
  };

  if (asBool(p && p.deep)) out.deep = await orphanRedundancy(dir, live, orphanFiles);
  return out;
}

/* deep：拿孤儿里的文件去和**在用的附件文件**比字节数。判据故意用字节数而不是文件名 ——
 * 这个库里同名未必同一份、同一份未必同名：`Ch1_微生物建造研究进展.pdf` 在 8 个孤儿目录里
 * 各有一份，而库里的真本叫「史 等 - 2025 - 微生物建造研究进展与趋势.pdf」。
 * 字节数相同**只说明可能是副本，不构成证据** —— 报出来的是线索，不是结论。 */
async function orphanRedundancy(storageDir, live, orphanFiles) {
  const sizes = new Set();
  for (const n of live) {
    for (const f of await walkFiles(PathUtils.join(storageDir, n))) {
      if (!f.cache) sizes.add(f.size);
    }
  }
  let dup = 0, dupBytes = 0, uniq = 0, uniqBytes = 0;
  for (const f of orphanFiles) {
    if (f.cache) continue;
    if (sizes.has(f.size)) { dup++; dupBytes += f.size; } else { uniq++; uniqBytes += f.size; }
  }
  return {
    duplicateBySize: dup, duplicateMB: mb(dupBytes),
    unmatchedBySize: uniq, unmatchedMB: mb(uniqBytes),
    note: "判据是**字节数相同**，只能说可能是副本，不构成证据；" +
      "unmatchedBySize 那一批在库里找不到同尺寸的文件，删之前要单独看。",
  };
}

/* 外链附件。linkMode 2 = LINKED_FILE（指向磁盘上的一个文件），3 = LINKED_URL。
 * 这两种**本来就不该有 storage 目录** —— 所以「附件条目没有 storage 目录」里混着这两类，
 * 把它们当成"文件丢了"是误报。
 * LINKED_URL 不测可达性：那要连网，体检默认不连网（和 sync 一个道理）。 */
const LINK_MODE_LINKED_FILE = 2;
const LINK_MODE_LINKED_URL = 3;

async function checkLinkedFiles() {
  const ids = await Zotero.DB.columnQueryAsync(
    "SELECT i.itemID FROM itemAttachments ia JOIN items i ON i.itemID = ia.itemID " +
    "WHERE ia.linkMode IN (?, ?)", [LINK_MODE_LINKED_FILE, LINK_MODE_LINKED_URL]);
  const items = await Zotero.Items.getAsync((ids || []).map(Number));
  const broken = [], good = [], urls = [];
  for (const it of items || []) {
    if (!it) continue;
    const rec = { key: it.key, path: String(it.attachmentPath || "") };
    const par = it.parentItemID ? Zotero.Items.get(it.parentItemID) : null;
    if (par) rec.title = par.getField("title");
    if (it.attachmentLinkMode === LINK_MODE_LINKED_URL) { urls.push(rec); continue; }
    let f = null;
    try { f = await it.getFilePathAsync(); } catch (e) { f = null; }
    (f ? good : broken).push(rec);
  }
  return {
    total: (items || []).length,
    brokenCount: broken.length,
    broken: broken.slice(0, 20),
    okCount: good.length,
    ok: good.slice(0, 10),
    urlCount: urls.length,
    urls: urls.slice(0, 10),
    note: "外链附件（linkMode 2/3）本来就没有 storage 目录，**别把它算进孤儿里**。" +
      "broken 的修法是换掉附件指向的路径，不是重建附件 —— 用 storage 端点的 relocate。",
  };
}

/* 大小写/标点只差一点点的标签。归一用现成的 strip()：它本来就是回答"两个值算不算同一个"
 * 的，标签是同一个问题，没必要再写一套。
 * ⚠️ Zotero 自己的 `tags.nameNormalized` 指望不上 —— 实测这个库 3467 个标签里 3440 行是 NULL，
 * 那一列基本没在维护，所以归一必须自己算。
 * manual / auto 分开报是有用的：Zotero.Tags.rename 的 SQL 里写死了 `type=0`，
 * 归并会把自动标签**转成手动标签**。实测这个库的大小写重复**全部**是自动标签。 */
async function checkTagVariants() {
  const rows = await Zotero.DB.queryAsync(
    "SELECT t.tagID AS id, t.name AS name, count(it.itemID) AS n, " +
    "sum(CASE WHEN it.type = 0 THEN 1 ELSE 0 END) AS manual, " +
    "sum(CASE WHEN it.type = 1 THEN 1 ELSE 0 END) AS auto " +
    "FROM tags t LEFT JOIN itemTags it ON it.tagID = t.tagID GROUP BY t.tagID");
  const groups = new Map();
  for (const r of rows || []) {
    const k = strip(r.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({
      name: r.name, items: Number(r.n) || 0,
      manual: Number(r.manual) || 0, auto: Number(r.auto) || 0,
    });
  }
  const dup = [...groups.values()].filter(g => g.length > 1);
  let auto = 0, manual = 0;
  for (const g of dup) for (const t of g) { auto += t.auto; manual += t.manual; }
  return {
    groups: dup.length,
    variants: dup.reduce((a, g) => a + g.length, 0),
    autoTagRows: auto,
    manualTagRows: manual,
    sample: dup.slice(0, 10),
    note: "每一组只差大小写或标点。修法是 apply 端点的 {tags:[{from,to},…]}，" +
      "dry-run 默认开。\n" +
      "**归并会把自动标签转成手动标签** —— Zotero.Tags.rename 的 SQL 里写死 type=0。" +
      "自动标签重新导入会被 Zotero 再补回来，转手动之后就归你管了；" +
      "这未必是坏事，但要知情。autoTagRows 就是会被转掉的行数。",
  };
}

async function checkUnfiled() {
  // 官方口径的"未分类"，别自己写 SQL 定义（annotation 是独立 itemType，
  // 只排除 attachment + note 会把上万条批注算进去）
  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  s.addCondition("unfiled", "true");
  const ids = await s.search();
  const brief = await collectionsBrief(ids.slice(0, 20));
  return { count: ids.length, sample: await keysOf(ids.slice(0, 20)), _cols: brief };
}

async function keysOf(ids) {
  const items = await Zotero.Items.getAsync(ids);
  return (items || []).filter(Boolean).map(it => ({ key: it.key, title: it.getField("title") }));
}

async function checkAttachmentTitle(p) {
  const attType = Zotero.ItemTypes.getID("attachment");
  const titleField = Zotero.ItemFields.getID("title");
  // attachmentFilename 是 Zotero 自己的取文件名方式，path 里带 "storage:" 前缀要剥掉
  const rows = await Zotero.DB.queryAsync(
    `SELECT i.itemID AS itemID, i.key AS key, idv.value AS title, ia.path AS path
     FROM itemAttachments ia
     JOIN items i ON i.itemID = ia.itemID
     LEFT JOIN itemData id ON id.itemID = i.itemID AND id.fieldID = ?
     LEFT JOIN itemDataValues idv ON idv.valueID = id.valueID
     WHERE i.itemTypeID = ? AND ia.path IS NOT NULL AND ia.path LIKE ?`,
    [titleField, attType, "storage:%"]);

  const defaults = (asList(p.titles) || ["Full Text PDF"]).map(t => String(t).toLowerCase());
  const flagged = [], mismatch = [], empty = [];
  for (const r of rows || []) {
    const file = String(r.path || "").replace(/^storage:/, "");
    const base = file.replace(/\.[^.]+$/, "");
    const title = String(r.title || "");
    if (!title.trim()) { empty.push({ key: r.key, file }); continue; }
    if (defaults.indexOf(title.toLowerCase()) >= 0) {
      flagged.push({ key: r.key, title, file });
      continue;
    }
    // 标题和文件名对得上就算一致。**两种形态都得认**：Zotero 给独立附件存的标题是
    // 带扩展名的完整文件名，而重命名过的往往只剩主名。只把文件名那一边的扩展名剥掉
    // （原来的写法）会把 721 条本来就一致的判成不一致 —— 实测这个库有 721 条是
    // title === 完整文件名，剥完就成了 789 条"不一致"，全是假的。
    const t = strip(title);
    if (t !== strip(file) && t !== strip(base)) mismatch.push({ key: r.key, title, file });
  }
  return {
    count: flagged.length,
    sample: flagged.slice(0, 20),
    emptyCount: empty.length,
    emptySample: empty.slice(0, 10),
    mismatchCount: mismatch.length,
    mismatchSample: mismatch.slice(0, 10),
    note: "三个数说的不是一回事，别混着看：\n" +
      "count = 标题停在导入器默认值（默认认「Full Text PDF」，可用 titles 换）—— 这个要修；\n" +
      "emptyCount = 标题是空的 —— 也要修，而且修起来最省事；\n" +
      "mismatchCount = 标题和文件名两边都对不上（两种形态都算过）。" +
      "这个库里独占 PDF 的父条目本来就该显示成「PDF」，所以**这个数偏大是正常的**；" +
      "要动就只在界面上走批量重命名，别脚本硬写文件名。",
  };
}

async function checkDuplicateFilenames() {
  const attType = Zotero.ItemTypes.getID("attachment");
  const rows = await Zotero.DB.queryAsync(
    `SELECT ia.parentItemID AS parent, ia.path AS path, i.key AS key
     FROM itemAttachments ia JOIN items i ON i.itemID = ia.itemID
     WHERE i.itemTypeID = ? AND ia.parentItemID IS NOT NULL
       AND ia.path IS NOT NULL AND ia.path LIKE ?`, [attType, "storage:%"]);
  // 两级 map，不拼分隔符：文件名里什么字符都可能有，拼字符串迟早撞上
  const byParent = {};
  for (const r of rows || []) {
    const file = String(r.path || "").replace(/^storage:/, "");
    const per = byParent[r.parent] = byParent[r.parent] || {};
    const k = file.toLowerCase();
    (per[k] = per[k] || []).push({ key: r.key, file, parent: r.parent });
  }
  const clashes = [];
  for (const per of Object.values(byParent)) {
    for (const g of Object.values(per)) if (g.length > 1) clashes.push(g);
  }
  return {
    count: clashes.length,
    sample: clashes.slice(0, 10),
    note: "同一个父条目下有两个**完全同名**的附件。" +
      "典型来源是 pdf2zh 输出 xxx-mono.pdf / xxx-dual.pdf 之后被 Zotero 的自动重命名" +
      "统一改成了「作者 - 年 - 标题.pdf」。修法是给译文加后缀（文件 + 标题都要）。",
  };
}

async function checkDuplicates() {
  const out = {};
  for (const f of ["DOI", "ISBN"]) {
    const fid = Zotero.ItemFields.getID(f);
    if (!fid) continue;
    const rows = await Zotero.DB.queryAsync(
      `SELECT idv.value AS v, COUNT(*) AS n
       FROM itemData id
       JOIN itemDataValues idv ON idv.valueID = id.valueID
       JOIN items i ON i.itemID = id.itemID
       WHERE id.fieldID = ?
         AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
         AND i.itemTypeID NOT IN (SELECT itemTypeID FROM itemTypes
                                  WHERE typeName IN ('attachment','note','annotation'))
         AND idv.value IS NOT NULL AND idv.value <> ''
       GROUP BY idv.value HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC LIMIT 50`, [fid]);
    const groups = [];
    for (const r of rows || []) {
      const ids = await Zotero.DB.columnQueryAsync(
        `SELECT id.itemID FROM itemData id JOIN itemDataValues idv ON idv.valueID = id.valueID
         WHERE id.fieldID = ? AND idv.value = ?`, [fid, r.v]);
      groups.push({ value: r.v, count: r.n, keys: await keysOf(ids || []) });
    }
    out[f.toLowerCase()] = { groups: groups.length, sample: groups.slice(0, 5) };
  }
  out.note = "只按 DOI / ISBN 分组，**这是线索不是判决**：" +
    "同一教材上下册 ISBN 不同不算重复，网络首发版页号不同也不算。" +
    "真要合并先跑 merge 的 dryRun，让自检说话。";
  return out;
}

async function checkTrashWriteback(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const rows = await Zotero.DB.queryAsync(
    `SELECT i.itemID AS itemID, i.key AS key, i.dateModified AS dateModified
     FROM items i
     WHERE i.itemID IN (SELECT itemID FROM deletedItems) AND i.dateModified >= ?
     ORDER BY i.dateModified DESC LIMIT 50`, [since]);
  const total = await Zotero.DB.valueQueryAsync(
    "SELECT COUNT(*) FROM deletedItems") || 0;

  const out = {
    trashTotal: total,
    recentlyModified: (rows || []).length,
    sample: (rows || []).map(r => ({ key: r.key, dateModified: r.dateModified })),
    windowDays: days,
  };
  // 话随事实走。回收站空着的时候还硬讲一遍「里面有插件私有数据」，是在拿一段
  // 写死的经历冒充当前状态 —— 2026-09-11 确实有一条（Ethereal Style 那套，
  // 27055，正躺在回收站里却仍在被写入），2026-09-12 再查回收站已经是空的、
  // 四个容器都活着。所以按查到的说。
  if (!total) {
    out.note = "回收站现在是空的。这条检查只在回收站里真有条目时才有话可说 —— " +
      "空的时候不必担心，也别特意去翻。";
  } else if (out.recentlyModified) {
    out.note = `回收站里有 ${out.recentlyModified} 条在最近 ${days} 天还被改写 —— ` +
      "有插件把它当私有数据库用了（Chartero 的阅读历史、Ethereal Style 的阅读进度都是这种）。" +
      "**别清空回收站**：那些条目还在被写，清掉等于删掉那个插件的存储，而且不可恢复。" +
      "要动它们先看清 key 属于谁。";
  } else {
    out.note = `回收站里有 ${total} 条，但最近 ${days} 天都没被改写。` +
      "清空前仍然值得先看一眼它们是谁 —— 插件私有条目会伪装成普通条目。";
  }
  return out;
}

/* 这一项**要连 zotero.org**，所以默认不跑。API 三个都在真机上点过名
 * （getLastSyncTime / getAPIKey / _libraryHasUnsyncedData 都是 Zotero.Sync.Data.Local
 * 的**自有属性**，不是原型方法），userID 用 Zotero.Users.getCurrentUserID()。 */
async function checkSync() {
  const D = Zotero.Sync.Data.Local;
  const out = {};
  try {
    const t = await D.getLastSyncTime();
    out.lastSync = t instanceof Date ? t.toISOString() : String(t);
  } catch (e) { out.lastSyncError = String(e.message || e); }
  try { out.hasUnsyncedData = await D._libraryHasUnsyncedData(1); }
  catch (e) { out.unsyncedError = String(e.message || e); }

  try {
    const local = await Zotero.DB.valueQueryAsync("SELECT MAX(version) FROM syncCache");
    out.localVersion = Number(local);
    const uid = Zotero.Users.getCurrentUserID();
    const key = await D.getAPIKey();
    if (!uid || !key) { out.note = "没登录，跳过服务器版本比对"; return out; }

    const r = await Zotero.HTTP.request("GET",
      `https://api.zotero.org/users/${uid}/items?limit=1&format=json`,
      { headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" }, responseType: "text" });
    const server = parseInt(r.getResponseHeader("Last-Modified-Version"), 10);
    out.serverVersion = server;
    out.inSync = out.localVersion === server;
    if (!out.inSync) {
      out.note = server > out.localVersion
        ? `服务器 ${server} > 本机 ${out.localVersion} —— 本机没下全，同步一下`
        : `本机 ${out.localVersion} > 服务器 ${server} —— 有东西还没传上去`;
    }
  } catch (e) { out.networkError = String(e.message || e); }
  return out;
}

async function doDoctor(p) {
  let want = asList(p.checks);
  if (asBool(p.all)) want = DOCTOR_CHECKS.slice();
  if (!want) want = DOCTOR_DEFAULT.slice();
  const unknown = want.filter(c => DOCTOR_CHECKS.indexOf(c) < 0);
  if (unknown.length) {
    return { error: `未知检查项 ${unknown.join("、")}；可用：${DOCTOR_CHECKS.join(" / ")}` };
  }

  const t0 = Date.now();
  const out = { ok: true, checks: {}, ran: want };
  for (const c of want) {
    try {
      if (c === "orphanStorage") out.checks[c] = await checkOrphanStorage(p);
      else if (c === "linkedFiles") out.checks[c] = await checkLinkedFiles();
      else if (c === "tagVariants") out.checks[c] = await checkTagVariants();
      else if (c === "unfiled") out.checks[c] = await checkUnfiled();
      else if (c === "attachmentTitle") out.checks[c] = await checkAttachmentTitle(p);
      else if (c === "duplicateFilenames") out.checks[c] = await checkDuplicateFilenames();
      else if (c === "duplicates") out.checks[c] = await checkDuplicates();
      else if (c === "trashWriteback") {
        out.checks[c] = await checkTrashWriteback(asInt(p.days, 30, 1, 3650));
      }
      else if (c === "sync") out.checks[c] = await checkSync();
    } catch (e) {
      out.checks[c] = { error: String(e.message || e) };
    }
  }
  out.ms = Date.now() - t0;
  out.note = "体检**只读**，不改任何东西。没点名的检查没跑：" +
    "sync 要连 zotero.org，默认不跑，要的话传 {checks:[\"sync\"]} 或 {all:true}。" +
    "orphanStorage 传 {deep:true} 会额外扫全部在用附件的体积来估冗余，慢得多，默认不跑。";
  return out;
}

/* ---------------- 存储卫生：storage ---------------- */

/* 这个端点动的是**文件系统**，而备份机制（VACUUM INTO）只覆盖数据库 —— 一次 move 出错没有
 * 备份可回。所以纪律比 apply 更严：dry-run 默认开，真写还要再传 `confirm:true`，
 * 而且写之前先落一份 manifest.json，记下每个目录的原位置和体积，restore 靠它整体搬回。
 *
 * **隔离而不是删除**：实测这个库 288 个孤儿 PDF 有 115 个在库内找不到同尺寸的文件
 * （含一本 87 MB 的教科书），"删"这个动作有真实的误伤面。
 * 判据是字节数相同 —— 只能说明可能是副本，不构成证据，所以这里只做可逆的那一步。 */
const QUARANTINE_DIR = "jsbridge-quarantine";

function storageRoot() { return PathUtils.join(Zotero.DataDirectory.dir, "storage"); }
function quarantineRoot() { return PathUtils.join(Zotero.DataDirectory.dir, QUARANTINE_DIR); }

function quarantineStamp() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function currentOrphans() {
  const live = new Set(await Zotero.DB.columnQueryAsync(
    "SELECT key FROM items WHERE itemID IN (SELECT itemID FROM itemAttachments)") || []);
  let kids = [];
  try { kids = await IOUtils.getChildren(storageRoot()); }
  catch (e) { return { error: String(e.message || e) }; }
  const dirs = kids.map(f => PathUtils.filename(f)).filter(n => n && n.length === 8);
  return { orphans: dirs.filter(n => !live.has(n)) };
}

/* 真写要过两道闸：`dryRun` 显式关掉（和 apply 一致），再加 `confirm`。
 * 拆成两个独立判断，是因为「没说要写」和「说要写但没确认」要回不同的东西 ——
 * 前者是正常预演，后者是拒绝。 */
const wantsWrite = (p) => p.dryRun !== undefined && !asBool(p.dryRun);
const CONFIRM_MSG = "真写要同时传 dryRun:false 和 confirm:true。" +
  "这个端点动文件系统，VACUUM 备份覆盖不到它，所以比 apply 多一道闸。";

async function storageList() {
  const root = quarantineRoot();
  const stamps = [];
  try {
    const kids = await IOUtils.getChildren(root);
    for (const d of kids) {
      let st; try { st = await IOUtils.stat(d); } catch (e) { continue; }
      if (st.type !== "directory") continue;
      const rec = { stamp: PathUtils.filename(d) };
      try {
        const mf = await IOUtils.readJSON(PathUtils.join(d, "manifest.json"));
        rec.dirs = (mf.dirs || []).length;
        rec.bytes = mf.bytes || 0;
        rec.mb = mb(mf.bytes || 0);
        rec.at = mf.at;
      } catch (e) { rec.manifest = "读不到"; }
      stamps.push(rec);
    }
  } catch (e) { /* 还没建过隔离目录，正常 */ }
  return { ok: true, op: "list", root, count: stamps.length, stamps,
    note: "每次隔离一个时间戳子目录，里面的 manifest.json 记着每个目录的原位置和体积，" +
      "restore 就是照着它搬回来。" };
}

async function storageQuarantine(p) {
  const found = await currentOrphans();
  if (found.error) return { error: found.error };
  const src = storageRoot();
  const entries = [];
  let bytes = 0, files = 0;
  for (const n of found.orphans) {
    let b = 0, f = 0;
    for (const x of await walkFiles(PathUtils.join(src, n))) { b += x.size; f++; }
    bytes += b; files += f;
    entries.push({ dir: n, bytes: b, files: f });
  }
  const base = { op: "quarantine", dirs: entries.length, files, bytes, mb: mb(bytes) };

  if (!wantsWrite(p)) {
    return Object.assign(base, { ok: true, dryRun: true, sample: entries.slice(0, 20) });
  }
  if (!asBool(p.confirm)) return Object.assign(base, { ok: false, dryRun: true, error: CONFIRM_MSG });

  const stamp = quarantineStamp();
  const dest = PathUtils.join(quarantineRoot(), stamp);
  await IOUtils.makeDirectory(dest);
  const moved = [], failed = [];
  for (const e of entries) {
    try { await IOUtils.move(PathUtils.join(src, e.dir), PathUtils.join(dest, e.dir)); moved.push(e.dir); }
    catch (err) { failed.push({ dir: e.dir, why: String(err.message || err) }); }
  }
  const kept = entries.filter(e => moved.indexOf(e.dir) >= 0);
  /* manifest 在**搬完之后**写，只记真正搬成功了的那批 —— 记多了 restore 会去搬不存在的目录，
   * 记少了那批就再也找不回来。**体积和文件数也要按 kept 重算**，不能直接抄上面的总计：
   * 搬失败几个的话，manifest 里的字节数会比实际躺在隔离区里的多，
   * 而 restore 报的就是这个数 —— 一个偏大的"还原了 N MB"没有任何用处。 */
  const keptBytes = kept.reduce((a, e) => a + e.bytes, 0);
  const keptFiles = kept.reduce((a, e) => a + e.files, 0);
  await IOUtils.writeJSON(PathUtils.join(dest, "manifest.json"),
    { stamp, at: new Date().toISOString(), from: src, dirs: kept, bytes: keptBytes, files: keptFiles });
  return Object.assign(base, {
    ok: true, dryRun: false, stamp, quarantined: moved.length,
    failed: failed.length, failedSample: failed.slice(0, 10), root: dest,
    undo: `POST /zoterojs/storage {"op":"restore","stamp":"${stamp}","dryRun":false,"confirm":true}`,
  });
}

async function storageRestore(p) {
  const stamp = String(p.stamp || "").trim();
  if (!stamp) return { error: "要传 stamp。先 op:list 看有哪些。" };
  const src = PathUtils.join(quarantineRoot(), stamp);
  let mf;
  try { mf = await IOUtils.readJSON(PathUtils.join(src, "manifest.json")); }
  catch (e) { return { error: `读不到 ${stamp} 的 manifest.json：${String(e.message || e)}` }; }
  const base = { op: "restore", stamp, dirs: (mf.dirs || []).length, bytes: mf.bytes || 0 };

  if (!wantsWrite(p)) return Object.assign(base, { ok: true, dryRun: true });
  if (!asBool(p.confirm)) return Object.assign(base, { ok: false, dryRun: true, error: CONFIRM_MSG });

  const dest = storageRoot();
  const moved = [], failed = [];
  for (const e of mf.dirs || []) {
    try { await IOUtils.move(PathUtils.join(src, e.dir), PathUtils.join(dest, e.dir)); moved.push(e.dir); }
    catch (err) {
      // 目标已存在就别硬搬 —— 上一轮搬回去了、或者那 8 位 key 被 Zotero 重新分配了
      failed.push({ dir: e.dir, why: String(err.message || err) });
    }
  }
  const partial = moved.length < (mf.dirs || []).length;
  // manifest 只在**全部搬回去之后**才删：还剩几个没搬，留着才能再来一次。
  if (!failed.length) {
    try { await IOUtils.remove(PathUtils.join(src, "manifest.json")); } catch (e) {}
  }
  return Object.assign(base, {
    ok: true, dryRun: false, restored: moved.length, failed: failed.length,
    failedSample: failed.slice(0, 10),
    partial: partial ? "有一部分没搬回去，manifest 留着，可以再来一次" : undefined,
  });
}

/* 按文件名把断掉的外链附件重新指回去。匹配用 basename **全等**，不做模糊匹配 ——
 * 模糊匹配会"修"出一个错的路径，那比不修更糟：条目看着好了，点开是另一篇。
 * 只在调用方点名的目录里找，不扫全盘。
 *
 * 这里**不覆盖 storage 那一路**：外链附件本来就不该有 storage 目录（见 doctor 的 linkedFiles），
 * 所以这一项和隔离/还原是两回事，只是都落在"文件到底在哪"这个问题上。 */
async function storageRelocate(p) {
  const where = String(p.dir || "").trim();
  if (!where) return { error: "要传 dir（去哪里找那些文件）" };

  const ids = await Zotero.DB.columnQueryAsync(
    "SELECT i.itemID FROM itemAttachments ia JOIN items i ON i.itemID = ia.itemID WHERE ia.linkMode = ?",
    [LINK_MODE_LINKED_FILE]);
  const items = await Zotero.Items.getAsync((ids || []).map(Number));
  const broken = [];
  for (const it of items || []) {
    if (!it) continue;
    let f = null;
    try { f = await it.getFilePathAsync(); } catch (e) { f = null; }
    if (!f) broken.push(it);
  }

  let scanned = 0;
  let onDisk = [];
  try { onDisk = await walkFiles(where, true); }
  catch (e) { return { error: `读不了 ${where}：${String(e.message || e)}` }; }
  const byName = new Map();
  for (const x of onDisk) {
    const k = x.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, x.path);
    scanned++;
  }
  const plan = [];
  for (const it of broken) {
    const want = PathUtils.filename(String(it.attachmentPath || ""));
    const hit = want ? byName.get(want.toLowerCase()) : null;
    plan.push({ key: it.key, want, found: hit || null });
  }
  const matched = plan.filter(x => x.found);
  const base = { op: "relocate", searched: where, scanned, broken: broken.length, matched: matched.length, plan };

  if (!wantsWrite(p)) return Object.assign(base, { ok: true, dryRun: true });
  if (!asBool(p.confirm)) return Object.assign(base, { ok: false, dryRun: true, error: CONFIRM_MSG });

  const libID = Zotero.Libraries.userLibraryID;
  const done = [], failed = [];
  for (const x of matched) {
    const it = Zotero.Items.getByLibraryAndKey(libID, x.key);
    if (!it) { failed.push({ key: x.key, why: "条目不见了" }); continue; }
    try { it.attachmentPath = x.found; await it.saveTx(); done.push({ key: x.key, to: x.found }); }
    catch (e) { failed.push({ key: x.key, why: String(e.message || e) }); }
  }
  return Object.assign(base, {
    ok: true, dryRun: false, relocated: done.length, done,
    failed: failed.length, failedSample: failed.slice(0, 10),
  });
}

async function doStorage(p) {
  const op = String(p.op || "list").toLowerCase();
  if (op === "list") return await storageList();
  if (op === "quarantine") return await storageQuarantine(p);
  if (op === "restore") return await storageRestore(p);
  if (op === "relocate") return await storageRelocate(p);
  return { error: `未知 op ${op}；可用 list / quarantine / restore / relocate` };
}

/* ---------------- 批量写：apply ---------------- */

/* 这个端点存在的唯一理由是**自动做那件总是忘记做的事**：
 * 把条目挂成子条目（设 parentItemID）会**静默摘掉它的集合归属**，
 * 而"说完回头查 collectionItems"是靠人记的，靠不住。
 *
 * ⚠️ 2026-09-12 更正：这里原先把 setType() 也列成会摘集合的一种，**那是错的**。
 * 真机上 presentation → document → presentation 走一遍，collectionItems 一行没动；
 * 读源码也对得上（item.js 的 setType 只碰 itemData / creators）。摘集合的是
 * collectionItems 上那条数据库触发器 —— 集合里不许有"有父级的条目"。
 *
 * 差分不看内存缓存。saveTx() 之后立刻读 it.getCollections() 可能还是旧值，所以直接查表。 */

async function collectionsOf(itemID) {
  try {
    const rows = await Zotero.DB.columnQueryAsync(
      "SELECT collectionID FROM collectionItems WHERE itemID=?", [itemID]);
    return (rows || []).map(Number).sort((a, b) => a - b);
  } catch (e) { return []; }
}

function asKeyList(v) {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

async function resolveCollection(key) {
  const libID = Zotero.Libraries.userLibraryID;
  return Zotero.Collections.getByLibraryAndKey(libID, String(key));
}

/* Zotero 的 Collection 对象上主键叫 **`.id`**，不叫 `collectionID` —— 后者是数据库列名。
 * 两套名字混用是这插件最容易踩的一类坑（pref 的短名/全长、条目类型的名字/ID 都是同一类）。
 *
 * ⚠️ 这里是 2026-09-12 在真库上实测才抓出来的：写成 `c.collectionID` 时它是 `undefined`，
 * 于是 `item.addToCollection(undefined)` → Zotero 抛 `Invalid collection 'undefined'`，
 * **addToCollection / removeFromCollection 两个操作在真机上从来没成功过**。
 * 单测没抓住，是因为 stub 里的集合对象是我自己捏的 `{collectionID, collectionName}`，
 * 而真对象是 `{id, name, key, libraryID}` —— **stub 的形状错了，测试就只是在自我印证**。
 * 现在 stub 照真形状来，并且对非数字 ID 同样抛错。 */
function collectionIdOf(c) {
  const cid = c.id;
  if (typeof cid !== "number") {
    throw new Error(`集合对象上没有数字 id（拿到了 ${JSON.stringify(cid)}）—— ` +
      `Zotero 的 Collection 对象用 .id，只有数据库列才叫 collectionID`);
  }
  return cid;
}

// 字符串形式的创建者按**单字段模式**处理：中文名交给 Zotero 拆会被按"首字为姓"硬拆
// （"朱其志" → 姓朱 / 名其志）。要拆的名字自己写成对象。
function normalizeCreator(c) {
  if (typeof c === "string") {
    return { creatorType: "author", fieldMode: 1, lastName: c };
  }
  const o = Object.assign({}, c);
  if (o.creatorType === undefined) o.creatorType = o.creatorTypeID === 8 ? "author" : "author";
  return o;
}

async function applyOne(item, op, dryRun) {
  const changes = [];
  // 结构性改动：挂父级会静默摘集合，所以这里记下来给差分用（setType 不会，见 doApply 上面那段）
  if (op.set && typeof op.set === "object") {
    for (const f of Object.keys(op.set)) {
      let before;
      try { before = item.getField(f); } catch (e) { before = "[没有这个字段]"; }
      const after = op.set[f];
      if (String(before) !== String(after)) {
        changes.push({ field: f, from: before, to: after });
        if (!dryRun) item.setField(f, after);
      }
    }
  }
  if (op.setCreators && Array.isArray(op.setCreators)) {
    const cs = op.setCreators.map(normalizeCreator);
    changes.push({ field: "creators", from: item.getCreators().map(creatorLine), to: cs.map(creatorLine) });
    if (!dryRun) item.setCreators(cs);
  }
  if (op.setType) {
    const tid = typeof op.setType === "number" ? op.setType : Zotero.ItemTypes.getID(String(op.setType));
    if (!tid) throw new Error(`未知条目类型 ${op.setType}`);
    changes.push({ field: "itemType", from: item.itemType, to: Zotero.ItemTypes.getName(tid) });
    if (!dryRun) item.setType(tid);
  }
  if (op.parent !== undefined) {
    const pk = op.parent === null ? null : String(op.parent);
    let pid = null;
    if (pk) {
      const par = await getItem(Zotero.Libraries.userLibraryID, pk);
      if (!par) throw new Error(`父条目 ${pk} 不存在`);
      pid = par.itemID;
    }
    changes.push({ field: "parentItemID", from: item.parentItemID || null, to: pid });
    if (!dryRun) item.parentItemID = pid;
  }
  for (const k of asKeyList(op.addToCollection)) {
    const c = await resolveCollection(k);
    if (!c) throw new Error(`集合 ${k} 不存在`);
    const cid = collectionIdOf(c);
    changes.push({ field: "addToCollection", to: c.name, collectionID: cid });
    if (!dryRun) item.addToCollection(cid);
  }
  for (const k of asKeyList(op.removeFromCollection)) {
    const c = await resolveCollection(k);
    if (!c) throw new Error(`集合 ${k} 不存在`);
    const cid = collectionIdOf(c);
    changes.push({ field: "removeFromCollection", to: c.name, collectionID: cid });
    if (!dryRun) item.removeFromCollection(cid);
  }
  return changes;
}

/* ---------------- 标签归并（库级，不是条目级） ---------------- */

/* 标签是**库级**的：归并两个标签动的是全库里所有带着它的条目，塞不进 applyOne 那套
 * 「一个 op 对一个条目」的形状。这里只沿用 doApply 的**纪律**（备份、dry-run 默认开、
 * 逐条报告），不走它的条目差分 —— 那套差分盯的是集合归属，标签归并不碰集合。
 *
 * 下面这条是真副作用，写在这里是因为它必须被报出来而不是默默发生：
 * Zotero.Tags.rename 的 SQL 是
 *   UPDATE OR REPLACE itemTags SET tagID = ?, **type = 0** WHERE tagID = ? AND itemID IN (…)
 * 那个 type=0 会把**自动标签转成手动标签**。实测这个库 48 组大小写重复**全部**是自动标签
 * （196 条自动关联 vs 2 条手动），所以归并等于把这 196 条转成手动。未必是坏事 ——
 * 用户主动归并过之后本来就不该再被自动管理 —— 但调用方得知道。
 *
 * 目标名已经存在时**不是错误**：rename 内部 `create(newName)` 把两边并成一条，
 * 结尾的 `purge(oldTagID)` 清掉旧行，颜色也一并转移。所以这里不必自己做合并检测，
 * 只把 mergesIntoExisting 报出来给人看。 */
async function renameTag(libID, from, to, dryRun) {
  const f = String(from == null ? "" : from).trim();
  const t = String(to == null ? "" : to).trim();
  if (!f || !t) throw new Error("from / to 都要给");
  if (f === t) return { from: f, to: t, status: "no-change", why: "两个名字一样" };
  const id = Zotero.Tags.getID(f);
  if (!id) throw new Error(`标签「${f}」不存在`);
  const rows = await Zotero.DB.queryAsync(
    "SELECT type AS t, count(*) AS n FROM itemTags WHERE tagID = ? GROUP BY type", [id]);
  let manual = 0, auto = 0;
  for (const r of rows || []) {
    if (Number(r.t) === 0) manual += Number(r.n); else auto += Number(r.n);
  }
  const rec = { from: f, to: t, items: manual + auto, autoBecomeManual: auto };
  const tid = Zotero.Tags.getID(t);
  if (tid) {
    const n = await Zotero.DB.queryAsync("SELECT count(*) AS n FROM itemTags WHERE tagID = ?", [tid]);
    rec.mergesIntoExisting = (n && n[0] && Number(n[0].n)) || 0;
  }
  if (dryRun) return Object.assign(rec, { status: "would-merge" });
  await Zotero.Tags.rename(libID, f, t);
  return Object.assign(rec, { status: "merged" });
}

async function applyTags(list, dryRun, libID) {
  const report = [];
  for (const raw of list) {
    const rec = { from: raw && raw.from, to: raw && raw.to };
    try {
      report.push(Object.assign(rec, await renameTag(libID, rec.from, rec.to, dryRun)));
    } catch (e) {
      report.push(Object.assign(rec, { status: "error", why: String(e.message || e) }));
    }
  }
  return report;
}

async function doApply(p) {
  const ops = Array.isArray(p.ops) ? p.ops : [];
  const tags = Array.isArray(p.tags) ? p.tags : [];
  if (!ops.length && !tags.length) {
    return { error: "需要 {ops: [{item: 'KEY', set: {...}}, ...]} 或 {tags: [{from, to}, ...]}" };
  }
  const dryRun = !!p.dryRun;
  const libID = Zotero.Libraries.userLibraryID;
  const stoppedOnError = p.stopOnError === undefined ? true : asBool(p.stopOnError);

  let backup = null;
  // tag 只影响备份文件名。enrich 复用这段写逻辑时传 "enrich"，
  // 事后翻备份目录能一眼看出这次写是哪个端点干的。
  if (!dryRun) backup = await backupBefore(p.tag || (tags.length ? "tags" : "apply"));

  const tagReport = tags.length ? await applyTags(tags, dryRun, libID) : null;

  const report = [];
  for (const op of ops) {
    const key = String(op.item || op.key || "");
    const rec = { item: key };
    try {
      const item = await getItem(libID, key);
      if (!item) { report.push(Object.assign(rec, { status: "error", why: "条目不存在" })); if (stoppedOnError) break; continue; }

      // expect：改之前先读原值比对，不符就跳过 —— 别对着错误的条目动手
      const expect = op.expect && typeof op.expect === "object" ? op.expect : null;
      if (expect) {
        const bad = Object.keys(expect).filter(f => String(item.getField(f)) !== String(expect[f]));
        if (bad.length) {
          report.push(Object.assign(rec, {
            status: "skipped", why: "原值与 expect 不符",
            mismatch: bad.map(f => ({ field: f, want: expect[f], got: item.getField(f) })),
          }));
          continue;
        }
      }

      const before = await collectionsOf(item.itemID);
      /* 挂父级有**第二重**副作用，而且落在**另一个条目**上：Zotero 把子条目原有的集合
       * 归属整个转给父条目（item.js:1944-1967，注释原文 "remove from any collections
       * where it existed previously and add parent instead"）。
       *
       * ⚠️ 2026-09-12 在真库上踩到才知道要让差分盯着父条目：把集合 307 里的裸附件
       * 4WWZ44HC 挂到 X3DGSJ99 名下，附件那半边差分报得好好的（collectionsLost:[307]），
       * 而**父条目被凭空加进了 307，报告里一个字都没有** —— 这恰恰是这个端点要防的那种
       * 静默改动，只是以前只盯着被写的那一个条目。
       * 更难发现的是父条目的 save() 带 skipDateModifiedUpdate，dateModified 不变，
       * 事后想靠"最近改过哪些条目"倒查都查不出来。 */
      let watched = null;
      if (op.parent) {
        const par = await getItem(libID, String(op.parent));
        if (par) watched = { itemID: par.itemID, key: par.key, before: await collectionsOf(par.itemID) };
      }
      const changes = await applyOne(item, op, dryRun);

      if (dryRun) {
        const extra = {};
        // 预测：子条目现在的集合，挂上去之后就归父条目了（真机就是这么搬的）
        if (watched) {
          extra.wouldGiveParent = before;
          extra.parentItem = watched.key;
        }
        report.push(Object.assign(rec, {
          status: changes.length ? "would-change" : "no-change",
          changes, collections: before,
        }, extra));
        continue;
      }

      if (!changes.length) { report.push(Object.assign(rec, { status: "no-change" })); continue; }
      await item.saveTx();

      const after = await collectionsOf(item.itemID);
      // 这个 op 自己要求的摘除不算"意外丢失"
      const intended = new Set(changes.filter(c => c.field === "removeFromCollection")
        .map(c => c.collectionID));
      const lost = before.filter(c => after.indexOf(c) < 0 && !intended.has(c));
      const rec2 = { status: "applied", changes, collectionsBefore: before, collectionsAfter: after };
      if (lost.length) {
        rec2.collectionsLost = lost;
        rec2.why = "有个条目被**静默摘掉了集合归属** —— 它被挂成了别人的子条目，" +
          "而集合里不许有子条目（collectionItems 上的数据库触发器）。";
      }
      if (watched) {
        const pAfter = await collectionsOf(watched.itemID);
        const gained = pAfter.filter(c => watched.before.indexOf(c) < 0);
        if (gained.length) {
          rec2.parentItem = watched.key;
          rec2.parentCollectionsBefore = watched.before;
          rec2.parentCollectionsAfter = pAfter;
          rec2.parentCollectionsGained = gained;
        }
      }
      report.push(Object.assign(rec, rec2));
    } catch (e) {
      report.push(Object.assign(rec, { status: "error", why: String(e.message || e) }));
      if (stoppedOnError) break;
    }
  }

  const out = {
    ok: true,
    dryRun,
    applied: report.filter(r => r.status === "applied").length,
    skipped: report.filter(r => r.status === "skipped").length,
    errors: report.filter(r => r.status === "error").length,
    report,
  };
  if (tagReport) {
    out.tags = tagReport;
    out.tagsMerged = tagReport.filter(r => r.status === "merged").length;
    out.tagsErrors = tagReport.filter(r => r.status === "error").length;
  }
  if (backup) out.backup = backup;
  const warns = [];
  if (tagReport && tagReport.some(r => r.autoBecomeManual)) {
    warns.push("标签归并会把**自动标签转成手动标签**（Zotero.Tags.rename 的 SQL 里写死 type=0），" +
      "见各条的 autoBecomeManual —— 转手动之后 Zotero 不会再自动管理它们。");
  }
  if (report.some(r => r.collectionsLost)) {
    warns.push("有条目丢了集合归属，见各条的 collectionsLost —— **这不是报错，是 Zotero 的正常行为**，" +
      "但它静默发生，所以必须补回去。");
  }
  if (report.some(r => r.parentCollectionsGained)) {
    warns.push("**父条目**也中招了：挂父级会把子条目原有的集合归属转给父条目，" +
      "见各条的 parentCollectionsGained —— 那多半不是你想要的，父条目自己不会退出那些集合。");
  }
  if (warns.length) out.warning = warns.join(" ");
  return out;
}

/* ---------------- 视觉补全：外部抽出来的字段，过闸再写 ---------------- */

/* 这段为什么在插件里、而不在调用方的脚本里：

   2026-09-12 拿 74 个没有文本层的扫描件跑了一遍视觉提取，45 个抽出了字段，其中两次是幻觉：

     · 82L9PCBI 是一篇期刊论文，正文里有参考文献页，而那一行的格式
       （`书名/作者. —版次. 出版地：出版社，年.月`）和 CIP 行几乎一样，模型把
       **被它引用的那本书**的出版社 / 年份 / ISBN 当成了条目自己的；
     · H2GCDM5B 从前言里的一句致谢（"感谢清华大学出版社…"）抠出了出版社。

   当场能看出这两条的只有模型自己回报的 evidence 原文；真正把它们拦下来的是
   「期刊论文身上不该出现出版社 / ISBN」这一条 —— 而判它需要知道**条目是什么类型、
   现值是什么**，那只有 Zotero 有。所以闸门留在这一侧：不管字段是视觉模型、别的
   插件还是手工填的，进这个端点都得过同一道。

   ⚠️ 这个端点**只补空，不覆盖**。两边都有值且不同的一律列成 conflict 挂起。
   要改已有值就走 apply —— 那是另一个口子，得由人明确说改哪个字段。 */

/* 见到这些页，抽出来的书目字段才算数。 */
const FRONT_KINDS = ["封面", "书名页", "扉页", "版权页", "CIP", "题名页"];

/* 只列不写。series 是模型明显越界的一处：它把封面上任何显眼的行都当丛书，
   实测 23 处里混着「国家自然科学基金重大项目」（资助项目）、
   「中华人民共和国国家标准」（文献类型）、「水利部科技专著出版基金资助项目」（基金）。
   这个字段错了不影响检索，但会污染引文样式，不值得冒自动写的险。 */
const REVIEW_ONLY_FIELDS = ["series"];

/* 按条目类型列出「还该有、但现在空着」的字段。先知道缺什么，才知道值不值得为它跑视觉。 */
const ENRICH_NEEDED = {
  book: ["publisher", "date", "ISBN", "creators"],
  bookSection: ["publisher", "date", "ISBN", "creators"],
  conferencePaper: ["publisher", "date", "ISBN", "creators"],
  report: ["publisher", "date", "ISBN", "creators"],
  standard: ["publisher", "date", "ISBN", "creators"],
  thesis: ["university", "date", "creators"],
  journalArticle: ["publicationTitle", "date", "volume", "issue", "pages", "DOI", "creators"],
};
const ENRICH_NEEDED_DEFAULT = ["date", "creators"];

function normForCompare(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/[\s《》〈〉:：,，.。\-—－_/·、（）()\[\]【】]/g, "").toLowerCase();
}

/* 闸一：见没见过前置页。 */
function hasFrontMatter(f) {
  const pages = Array.isArray(f.pages) ? f.pages : [];
  return pages.some(p => FRONT_KINDS.some(k => String((p && p.type) || "").indexOf(k) >= 0));
}

/* 闸二：抽出的书名和条目自己的标题对得上吗。

   这条比闸一更硬，因为**页类型判定本身也会错**：82L9PCBI 的参考文献页格式像 CIP 行，
   模型把它判成了「版权页CIP」，闸一于是放行。而它抽出的书名（弹性力学简明教程）
   和条目标题（对《弹性力学简明教程》中一处内容的商榷）根本对不上 —— 一测就露。 */
function titleFits(item, f) {
  const a = normForCompare(item.getField("title"));
  const b = normForCompare(f.title);
  if (!a || !b) return true;                    // 任一边没有标题就无从判，交给闸一
  return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
}

/* 闸三：期刊论文身上不该出现出版社 / ISBN / 版次 / 丛书。

   这是三道里唯一挡住 82L9PCBI 的：那条闸二也能过 ——
   《对〈弹性力学简明教程〉中一处内容的商榷》里**确实**含「弹性力学简明教程」。
   但它是期刊论文，没有 ISBN 和出版社字段，抽出来了就说明读的是被它引用的那本书。
   只卡期刊论文：学位论文的「出版者」栏本来就放授予单位，会议论文也有出版社。 */
const NOT_FOR_JOURNAL = ["isbn", "publisher", "edition", "series"];

function fieldsFitType(item, f) {
  if (item.itemType !== "journalArticle") return true;
  return !NOT_FOR_JOURNAL.some(k => f[k]);
}

function gateFinding(item, f) {
  const why = [];
  if (!hasFrontMatter(f)) {
    why.push("没见到前置页（封面 / 书名页 / 版权页）—— 抽出来的很可能是正文里的参考文献或致谢");
  }
  if (!titleFits(item, f)) why.push("抽出的书名与条目标题对不上");
  if (!fieldsFitType(item, f)) why.push("这是期刊论文，却抽出了出版社 / ISBN —— 读的多半是被它引用的那本书");
  return why;
}

/* 抽出来的年 / 月拼成 Zotero 认的日期。月份出了 1–12 就当没有月份。 */
function enrichDate(year, month) {
  const y = String(year === null || year === undefined ? "" : year).trim();
  if (!/^\d{4}$/.test(y)) return null;
  const m = String(month === null || month === undefined ? "" : month).trim();
  if (/^\d{1,2}$/.test(m) && +m >= 1 && +m <= 12) return y + "-" + ("0" + (+m)).slice(-2);
  return y;
}

/* 这个条目还缺哪些可填字段。 */
function missingFields(item) {
  const want = ENRICH_NEEDED[item.itemType] || ENRICH_NEEDED_DEFAULT;
  const out = [];
  for (const f of want) {
    if (f === "creators") {
      if (!item.getCreators().length) out.push("creators");
      continue;
    }
    try { if (!String(item.getField(f) || "").trim()) out.push(f); }
    catch (e) { /* 这个类型没这个字段，本来就不该列 */ }
  }
  return out;
}

async function pdfAttsOf(item) {
  const out = [];
  let ids = [];
  try { ids = await item.getAttachments(); } catch (e) { return out; }
  for (const id of ids) {
    const a = Zotero.Items.get(id);
    if (a && a.attachmentContentType === "application/pdf") out.push(a);
  }
  return out;
}

/* 附件的真实文件路径。getFilePathAsync 会处理链接附件和相对路径，
   比拿 dataDir 拼 "storage/<key>/<文件名>" 靠得住 —— 那个拼法对链接附件是错的。 */
async function filePathOf(a) {
  try {
    if (typeof a.getFilePathAsync === "function") {
      const p = await a.getFilePathAsync();
      if (p) return String(p);
    }
  } catch (e) { /* 文件不在本地之类，退回 storage 目录 */ }
  try {
    const d = Zotero.Attachments.getStorageDirectory(a);
    if (d) {
      const base = d.path || String(d);
      const name = a.attachmentFilename || "";
      if (typeof PathUtils !== "undefined" && PathUtils.join) return PathUtils.join(base, name);
      return base + "/" + name;
    }
  } catch (e) { /* 真拿不到就返回空串，调用方按"没有本地文件"处理 */ }
  return "";
}

/* 比对一条 finding，产出 {rows, op}。op 为 null 表示没有可写的东西。

   规则和 apply 不同：这里**只补空**。两边都有值且不同的一律 conflict，不写。 */
async function enrichDiff(item, f) {
  const cand = {
    title: f.title, publisher: f.publisher, place: f.place,
    date: enrichDate(f.year, f.month), edition: f.edition,
    ISBN: f.isbn, series: f.series,
  };
  // 学位论文没有「出版者」栏，视觉抽到的那个出版社其实是学位授予单位
  if (item.itemType === "thesis") { cand.university = f.publisher; delete cand.publisher; }

  const rows = [], set = {};
  for (const field of Object.keys(cand)) {
    const raw = cand[field];
    if (raw === null || raw === undefined) continue;
    const nv = String(raw).trim();
    if (!nv) continue;

    let old;
    try { old = String(item.getField(field) || "").trim(); }
    catch (e) { rows.push({ field, to: nv, kind: "nofield" }); continue; }  // 这类型没这字段

    if (field === "title" && old) {
      if (old === nv) { rows.push({ field, from: old, to: nv, kind: "same" }); continue; }
      /* 两个标题互为前缀时是同一本书，谁更全用谁 —— 但**只认「抽出来的更全」这一边**。
         反过来写会把已有的完整标题截短：实测库里是「从抛物线谈起：混沌动力学引论」，
         而视觉那张扉页只印了「从抛物线谈起」，盲目跟视觉会把副标题丢掉。 */
      if (nv.indexOf(old) === 0) {
        rows.push({ field, from: old, to: nv, kind: "extend" });
        set[field] = nv;
        continue;
      }
      if (old.indexOf(nv) === 0) { rows.push({ field, from: old, to: nv, kind: "same" }); continue; }
      rows.push({ field, from: old, to: nv, kind: "conflict" });
      continue;
    }

    if (old === nv) { rows.push({ field, from: old, to: nv, kind: "same" }); continue; }
    if (!old) {
      if (REVIEW_ONLY_FIELDS.indexOf(field) >= 0) { rows.push({ field, to: nv, kind: "review" }); continue; }
      rows.push({ field, to: nv, kind: "new" });
      set[field] = nv;
      continue;
    }
    rows.push({ field, from: old, to: nv, kind: "conflict" });
  }

  // 创建者只在库里一个都没有时补。字符串交给 applyOne 的 normalizeCreator 走单字段模式，
  // 中文名才不会被 Zotero 按"首字为姓"硬拆。
  const names = (Array.isArray(f.authors) ? f.authors : [])
    .map(x => String(x === null || x === undefined ? "" : x).trim()).filter(Boolean);
  const emptyCreators = !item.getCreators().length;
  if (names.length) {
    const cur = item.getCreators().map(creatorLine).join(" / ");
    if (emptyCreators) rows.push({ field: "creators", to: names.join(" / "), kind: "new" });
    else rows.push({ field: "creators", from: cur, to: names.join(" / "), kind: "same" });
  }

  const op = { item: item.key };
  if (Object.keys(set).length) op.set = set;
  if (names.length && emptyCreators) op.setCreators = names;
  return { rows, op: Object.keys(op).length > 1 ? op : null };
}

async function doEnrich(p) {
  const findings = Array.isArray(p.findings) ? p.findings : [];
  if (!findings.length) {
    return { error: "需要 {findings: [{item: 'KEY', pages: [{p: 1, type: '封面'}], " +
      "title: …, publisher: …}, …]}；只想找候选就给 items= 或 scan=1" };
  }
  const strict = p.strict === undefined ? true : asBool(p.strict);
  const libID = Zotero.Libraries.userLibraryID;

  const ops = [], gated = [], checked = [], errors = [];
  for (const f of findings) {
    const key = String(f.item || f.key || "");
    if (!key) { errors.push({ item: "", why: "findings 里有一条没给 item" }); continue; }
    try {
      const item = await getItem(libID, key);
      if (!item) { errors.push({ item: key, why: "条目不存在" }); continue; }

      const why = strict ? gateFinding(item, f) : [];
      if (why.length) {
        gated.push({ item: key, title: item.getField("title"), why,
                     evidence: String(f.evidence || "").slice(0, 300) });
        continue;
      }
      const { rows, op } = await enrichDiff(item, f);
      checked.push({ item: key, title: item.getField("title"), fields: rows });
      if (op) ops.push(op);
    } catch (e) {
      errors.push({ item: key, why: String(e.message || e) });
    }
  }

  const tally = {};
  for (const c of checked) for (const r of c.fields) tally[r.kind] = (tally[r.kind] || 0) + 1;

  const out = {
    ok: true, strict,
    findings: findings.length,
    gated: gated.length, gatedReport: gated,
    checked: checked.length,
    withOps: ops.length,
    tally,
    // 全部已过闸的条目都带回去，**不滤掉「只有 same」的** ——
    // 滤掉的话调用方看不出"这条查过了、两边一致"，只看到它凭空消失，
    // 于是分不清"比对过了"和"根本没处理"。
    report: checked,
    errors: errors.length,
  };
  if (errors.length) out.errorReport = errors;

  /* 写走 doApply：备份、expect、集合差分都在那边，不另起一套 ——
     两套写库逻辑迟早会分叉，而分叉的那一套不会有备份。 */
  out.apply = ops.length
    ? await doApply({ ops, dryRun: !!p.dryRun, stopOnError: p.stopOnError, tag: "enrich" })
    : { ok: true, dryRun: !!p.dryRun, applied: 0, skipped: 0, errors: 0, report: [] };
  return out;
}

/* 找出「没有文本层」的 PDF 附件 —— 也就是视觉（或 OCR）唯一帮得上忙的那批。

   判据用 Zotero.PDFWorker.getFullText 抽出来的字符数，比 Zotero.Fulltext.getIndexedState
   准得多：后者把「正常书里有一页没字」和「整本扫描件」都叫 PARTIAL。实测（2026-09-12）：

     23NZF8PY  10.0 万字符 → PARTIAL   ┐ 都是正常书，只是个别页没字
     27RCEEVC  29.7 万字符 → PARTIAL   ┘
     2J4LLG6Q   0 字符     → UNINDEXED ┐ 同为纯扫描件，状态却判得不一样，
     4BY9B5LC   0 字符     → PARTIAL   ┘ 所以不能拿状态当判据

   ⚠️ 代价实测（1235 个 PDF）：getIndexedState 全库 198 ms，是纯 DB 读；
   而 getFullText 每本约 337 ms，**全库要 7 分钟**。放进 HTTP 请求里太久了，
   所以默认只处理调用方点名的条目（items=…）。全库扫要显式给 scan=1，
   并且先拿 getIndexedState 粗筛掉已有索引的（1235 → 200），约 67 秒。 */
async function doEnrichScan(p) {
  const libID = Zotero.Libraries.userLibraryID;
  const minChars = asInt(p.minChars, prefInt(PREF_ENRICH_MIN, 1000, 0, 1000000), 0, 1000000);
  const missingOnly = p.missingOnly === undefined ? true : asBool(p.missingOnly);
  const limit = asInt(p.limit, 100, 1, 1000);
  const offset = asInt(p.offset, 0, 0, 1000000);
  const wantKeys = asKeyList(asList(p.items));
  const fullScan = asBool(p.scan);

  let items = [];
  if (wantKeys.length) {
    for (const k of wantKeys) {
      const it = await getItem(libID, k);
      if (it) items.push(it);
      else if (!fullScan) items.push(null);      // 占位，下面报出来
    }
  } else if (fullScan) {
    /* onlyTopLevel=true 只挡掉「有父条目的」笔记和附件。**要注意两个坑：**

       ① 独立笔记 / 独立附件本身是顶层，自己不是书目条目 —— 下面一并滤掉。
       ② ⚠️ getAll 只 LEFT JOIN 了 itemNotes 和 itemAttachments，
          **没 join itemAnnotations** —— 于是 10030 条高亮批注全被当成顶层条目
          （实测：getAll(lib,true)=11231，其中 annotation 10030、独立附件 2、
          独立笔记 2，真正的书目条目只有 1197）。
          不滤掉的话，每条批注都要白跑一次 getAttachments()，实测那一步
          直接超时；而 itemsProbed 还会报 11231，看着像"扫了一万多个条目"，
          其实真正查过的只有一千出头 —— 数字骗人比慢更糟。 */
    const ids = await Zotero.Items.getAll(libID, true, false, true);
    for (const id of ids) {
      const it = Zotero.Items.get(id);
      if (!it) continue;
      if (it.isAttachment() || it.isNote()) continue;
      if (typeof it.isAnnotation === "function" && it.isAnnotation()) continue;
      items.push(it);
    }
  } else {
    return { error: "要么给 items=KEY1,KEY2 点名（快），要么给 scan=1 扫全库（慢，见端点注释）" };
  }

  const candidates = [], missingKeys = [];
  let attsProbed = 0, skippedIndexed = 0;
  for (const it of items) {
    if (!it) { missingKeys.push("(不存在的条目)"); continue; }
    const atts = await pdfAttsOf(it);
    if (!atts.length) continue;
    const miss = missingOnly ? missingFields(it) : [];
    if (missingOnly && !miss.length) continue;      // 字段齐了，视觉没得补

    const rows = [];
    for (const a of atts) {
      attsProbed++;
      let state = null;
      try { state = await Zotero.Fulltext.getIndexedState(a); } catch (e) { /* 拿不到就当未知 */ }
      // 粗筛只在全库扫时用：已经有索引的附件不可能需要视觉，跳过能省掉大头的时间。
      // 点名查的时候不跳 —— 点名就是想看这个附件的真实情况。
      if (fullScan && !wantKeys.length && state === Zotero.Fulltext.INDEX_STATE_INDEXED
          && !asBool(p.includeIndexed)) {
        skippedIndexed++;
        continue;
      }
      let chars = null, err = null;
      try {
        const t = await Zotero.PDFWorker.getFullText(a.itemID);
        chars = String((t && t.text) || "").length;
      } catch (e) { err = String(e.message || e); }
      if (chars !== null && chars >= minChars) continue;   // 有文本层，视觉用不上
      const row = {
        akey: a.key, file: await filePathOf(a), chars, state,
        filename: a.attachmentFilename || "",
      };
      if (err) row.error = err;
      rows.push(row);
    }
    if (rows.length) {
      candidates.push({ item: it.key, type: it.itemType, title: it.getField("title"),
                        missing: miss, atts: rows });
    }
  }

  const out = {
    ok: true, minChars, missingOnly,
    itemsProbed: items.length, attsProbed, skippedIndexed,
    candidates: candidates.length, offset, limit,
    page: candidates.slice(offset, offset + limit),
    truncated: candidates.length > offset + limit,
  };
  if (missingKeys.length) out.errorReport = missingKeys.map(k => ({ item: k, why: "条目不存在" }));
  return out;
}

/* ---------------- 管理面板 ---------------- */

/* 面板是静态 XHTML 片段，够不着 bootstrap 作用域里的函数，所以把要用的几个挂到
 * Zotero 上（生态惯例）。它们都由面板把 document 传进来，不自己去猜窗口。 */

function paneText(doc, id, text) {
  try { const el = doc.getElementById(id); if (el) el.textContent = text; }
  catch (e) { /* 面板已经关了 */ }
}

function buildPaneApi() {
  const api = {
    // 面板每次载入都刷一遍：token 是会变的，不能在 XHTML 里写死
    refreshTokenView(doc) {
      try { const f = doc.getElementById("jsb-token"); if (f) f.value = token || ""; }
      catch (e) { logErr(e); }
      paneText(doc, "jsb-status", "token 文件：" + tokenFilePath());
    },

    copyToken(doc) {
      let ok = false;
      try {
        const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
        helper.copyString(token);
        ok = true;
      } catch (e) { logErr(e); }
      paneText(doc, "jsb-status", ok
        ? `已复制 ${token.length} 个字符到剪贴板`
        : "复制失败：拿不到剪贴板 —— 可以直接选中上面那个框手动复制");
    },

    async regenerateToken(doc) {
      let yes = false;
      try {
        yes = Services.prompt.confirm(null, "重新生成 token？",
          "所有拿旧 token 的脚本会立刻失效，需要同步更新。要继续吗？");
      } catch (e) { logErr(e); }
      if (!yes) { paneText(doc, "jsb-status", "已取消，token 没变"); return; }
      token = makeToken();
      try { Zotero.Prefs.set(PREF_TOKEN, token); } catch (e) { logErr(e); }
      const w = await writeTokenFile();
      api.refreshTokenView(doc);
      paneText(doc, "jsb-status", w.ok
        ? "已换新 token，并写入 " + w.path
        : "已换新 token，但写文件失败：" + w.error);
    },

    async rewriteTokenFile(doc) {
      const w = await writeTokenFile();
      paneText(doc, "jsb-status", w.ok ? "已写入 " + w.path : "写文件失败：" + w.error);
    },

    // 备份是**同步等**的：52 MB 的库约 0.6 秒，等得起。
    // 期间界面不响应是正常的，别做成「后台跑着」—— 那样用户以为完事了其实没有。
    //
    // doc 可以不传。面板之外（zoterojs.py 的 backup 走 exec 调这个函数）拿不到 document，
    // 而 paneText 对 null doc 是安全的。返回值带 ok，调用方才判断得了成败 ——
    // 这里不抛：面板按钮的 oncommand 会把返回值丢掉，抛出去就变成一条没人管的
    // unhandled rejection，只会在错误控制台里躺着。
    async backupNow(doc) {
      paneText(doc, "jsb-status", "正在备份…（库大的话要几秒，界面会卡住）");
      try {
        const b = await doBackup();
        const mb = (b.bytes / 1048576).toFixed(1);
        // remaining 是轮转**之后**的数，到上限时恒等于 kept，写成两个数看着像重复。
        // 要报的是轮转前有几份，那才是"删掉了多少"的参照。
        let msg = `已备份 ${mb} MB · ${b.ms} ms\n${b.path}\n保留最近 ${b.kept} 份`;
        if (b.removed.length) {
          msg += `，这次删掉 ${b.removed.length} 份旧的（备份前有 ${b.kept + b.removed.length} 份）`;
        } else {
          msg += `，目录里现在 ${b.remaining} 份`;
        }
        if (b.removed.length) msg += `\n轮转删掉了：\n  ` + b.removed.slice(-5).join("\n  ");
        paneText(doc, "jsb-status", msg);
        return Object.assign({ ok: true }, b);
      } catch (e) {
        const why = String(e.message || e);
        paneText(doc, "jsb-status", "备份失败：" + why + "\n（目标目录 " + backupDirPath() + "）");
        return { ok: false, error: why, dir: backupDirPath() };
      }
    },

    // 只做静态自检：注册表、pref、token 文件。发真实 HTTP 请求去测自己的话，
    // UA 会被 Zotero 自己的 CSRF 防护掐断，测出来的失败说明不了任何问题。
    async selfCheck(doc) {
      const lines = [`版本 ${addonVersion} · Zotero ${Zotero.version}`];
      lines.push(`总开关：${prefBool(PREF_ENABLED, true) ? "开" : "关（所有端点停用）"}` +
        `　只读模式：${prefBool(PREF_READONLY, false) ? "开（写入口被拒）" : "关"}`);
      for (const p of PATHS) {
        const on = prefBool(PREF_EP[p], true);
        const installed = !!epTable && Zotero.Server.Endpoints[p] === epTable[p];
        lines.push(`　${on ? "✓" : "✗"} ${p} —— ${on ? "启用" : "已关闭"}` +
          (installed ? "" : "（未注册：总开关关着，或需要重装插件）"));
      }
      const p = tokenFilePath();
      let exists = false;
      try {
        if (typeof IOUtils !== "undefined" && IOUtils.exists) exists = await IOUtils.exists(p);
        else exists = !!Zotero.File.pathToFile(p).exists;
      } catch (e) { /* 查不到就当没有 */ }
      lines.push(`　${token ? "✓" : "✗"} token ${token ? token.length + " 字符" : "为空"}` +
        `　${exists ? "✓" : "✗"} token 文件` +
        (exists ? "" : "（点上面的「重写 token 文件」）"));

      // 备份状态也一并报出来：自动备份是个「开了就忘」的开关，
      // 面板上不显示的话，用户没法知道它到底有没有在工作
      const bs = await listBackups();
      const auto = prefBool(PREF_BACKUP, false);
      lines.push(`　${bs.length ? "✓" : "·"} 备份 ${bs.length} 份` +
        `（自动备份：${auto ? "开，每次写操作前备一份" : "关"}）` +
        (bs.length ? `\n　  最新：${bs[bs.length - 1]}` : "\n　  （点上面的「立即备份」建第一份）"));
      paneText(doc, "jsb-status", lines.join("\n"));
    },
  };
  return api;
}

async function registerPane(id, rootURI) {
  try {
    if (!Zotero.PreferencePanes || typeof Zotero.PreferencePanes.register !== "function") {
      Zotero.debug("Zotero JS Bridge: 这个 Zotero 没有 PreferencePanes，跳过管理面板");
      return;
    }
    // 先按固定 id 摘一次。热重载会再走一遍 startup，而 Zotero 的 shutdown 观察者
    // 在那种路径上不一定跑过 —— 不给 id 的话每次 register 都生成一个新的随机 id
    // （preferencePanes.js 里是 plugin-pane-<random>-<pluginID>），于是侧栏里会
    // 一个接一个堆出同样的面板，直到插件真正 shutdown 才一起消失。
    // unregister 对不存在的 id 是安全的（就是个 filter），不用先查。
    Zotero.PreferencePanes.unregister(PANE_ID);
    // 不给 label / image：Zotero 会回落到 manifest 里的插件名和图标，
    // 少两处要跟着改的地方。面板在插件 shutdown 时会由 Zotero 按 pluginID 自动摘掉。
    await Zotero.PreferencePanes.register({ pluginID: id, id: PANE_ID, src: rootURI + "prefs.xhtml" });
  } catch (e) { logErr(e); }
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
    const bad = gate("/zoterojs/ping", false);
    if (bad) return bad;
    // 端点清单照旧给全量（调用方按这个列表做能力探测），另给一份当前关掉的。
    // 只加字段不改老字段，老客户端读到的还是它认识的那个形状。
    return jsonReply(200, {
      ok: true,
      name: "Zotero JS Bridge",
      version: addonVersion,
      zotero: Zotero.version,
      libraryID: Zotero.Libraries.userLibraryID,
      endpoints: PATHS,
      disabled: PATHS.filter(p => !prefBool(PREF_EP[p], true)),
      readonly: prefBool(PREF_READONLY, false),
    });
  },
});

const EP_EXEC = Ctor({
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options) || gate("/zoterojs/exec", true);
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
    const bad = checkAuth(options) || gate("/zoterojs/merge", true);
    if (bad) return bad;

    const data = options.data || {};
    const masterKey = String(data.master || "");
    const dupKeys = Array.isArray(data.dups) ? data.dups.map(String) : [];
    if (!masterKey || !dupKeys.length) {
      return jsonReply(400, { ok: false, error: "需要 {master: 'KEY', dups: ['KEY', ...]}" });
    }
    try {
      const dryRun = !!data.dryRun;
      // 自动备份只挂在真写之前。dry-run 不写，没必要备 —— 备份一份 52 MB 的库要 0.6 秒，
      // 而 dry-run 是拿来反复试的。
      const backup = dryRun ? null : await backupBefore("merge");
      const out = await doMerge(masterKey, dupKeys, dryRun);
      if (backup) out.backup = backup;
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_QUERY = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options) || gate("/zoterojs/query", false);
    if (bad) return bad;
    try {
      const out = await doQuery(readParams(options));
      if (out.error) return jsonReply(400, { ok: false, error: out.error, conditions: out.conditions });
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_DOCTOR = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options) || gate("/zoterojs/doctor", false);
    if (bad) return bad;
    try {
      const out = await doDoctor(readParams(options));
      if (out.error) return jsonReply(400, { ok: false, error: out.error });
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_APPLY = Ctor({
  supportedMethods: ["POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    // 闸门按「写」算，**连 dryRun 也算**：dry-run 只是这一次不写，
    // 但把写入口整个关掉的人（只读模式 / 端点开关）本来就不该看到这个端点通着。
    const bad = checkAuth(options) || gate("/zoterojs/apply", true);
    if (bad) return bad;
    try {
      const out = await doApply(options.data || {});
      if (out.error) return jsonReply(400, { ok: false, error: out.error });
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_ENRICH = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    /* 按**写**过闸，而且 GET 也按写算，两个理由：
       一是 POST 确实会写库；二是 GET 的 scan 模式要抽几百个附件的全文、耗时以分钟计，
       而只读模式 / 关掉这个端点的人，本来就不该让这个入口通着。 */
    const bad = checkAuth(options) || gate("/zoterojs/enrich", true);
    if (bad) return bad;
    try {
      const p = readParams(options);
      // 带 findings 就是「我有抽好的字段，帮我过闸写进去」；否则是「帮我找候选」。
      const out = Array.isArray(p.findings) ? await doEnrich(p) : await doEnrichScan(p);
      if (out.error) return jsonReply(400, { ok: false, error: out.error });
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

/* 按**写**过闸，连 GET 也算：默认那个 list 动作是只读的，但同一个入口能 move 文件，
 * 而只读模式 / 关掉这个端点的人本来就不该让这个入口通着（和 enrich 同一个理由）。 */
const EP_STORAGE = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options) || gate("/zoterojs/storage", true);
    if (bad) return bad;
    try {
      const out = await doStorage(readParams(options));
      if (out.error) return jsonReply(400, { ok: false, error: out.error });
      return pack(out);
    } catch (e) {
      return jsonReply(500, { ok: false, error: String(e.message || e), stack: String(e.stack || "") });
    }
  },
});

const EP_LOGS = Ctor({
  supportedMethods: ["GET", "POST"],
  supportedDataTypes: ["application/json"],
  init: async function (options) {
    const bad = checkAuth(options) || gate("/zoterojs/logs", false);
    if (bad) return bad;

    const p = readParams(options);
    const source = String(p.source || "console").toLowerCase();
    if (["console", "debug", "both"].indexOf(source) < 0) {
      return jsonReply(400, { ok: false, error: "source 只能是 console / debug / both" });
    }
    // 读日志是只读的，但 clear 是破坏性的（清掉的是用户正在看的控制台/调试缓冲），
    // 所以只读模式拦的是 clear，不是整个 logs 端点
    if (asBool(p.clear) && prefBool(PREF_READONLY, false)) {
      return jsonReply(403, {
        ok: false,
        error: "只读模式已开启：logs 的 clear 被拒绝（读日志本身仍然可用）",
        pref: "extensions.zotero." + PREF_READONLY,
      });
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

  // 面板无条件注册，且排在总开关判断之前：总开关关掉之后如果连面板都没了，
  // 用户就再没有地方把它打开。停用的效果交给请求路径上的 gate()，不靠「不注册」实现。
  Zotero.JSBridge = buildPaneApi();
  await registerPane(id, rootURI);

  try {
    if (Zotero.Prefs.get(PREF_ENABLED) === false) {
      Zotero.debug("Zotero JS Bridge: 已停用（jsbridge.enabled=false），端点未注册；"
        + "管理面板仍可用，在那里可以重新打开");
      return;
    }
  } catch (e) { /* pref 未注册时按启用处理 */ }

  await ensureToken();

  epTable = {
    "/zoterojs/ping": EP_PING,
    "/zoterojs/exec": EP_EXEC,
    "/zoterojs/merge": EP_MERGE,
    "/zoterojs/logs": EP_LOGS,
    "/zoterojs/query": EP_QUERY,
    "/zoterojs/doctor": EP_DOCTOR,
    "/zoterojs/apply": EP_APPLY,
    "/zoterojs/enrich": EP_ENRICH,
    "/zoterojs/storage": EP_STORAGE,
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
  try { delete Zotero.JSBridge; } catch (e) { /* 已经没有就算了 */ }
  // 面板不用自己摘：Zotero.PreferencePanes 监听了插件 shutdown，会按 pluginID 清掉。
  // 端点得自己还原。
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
