/* Zotero JS Bridge
 *
 * 在 Zotero 自带的 127.0.0.1 HTTP 服务器（默认 23119）上挂三个端点：
 *
 *   GET  /zoterojs/ping    健康检查，不需要 token
 *   POST /zoterojs/exec    执行任意 JS（支持顶层 await / return），需要 token
 *   POST /zoterojs/merge   带自检的条目合并（支持 dryRun），需要 token
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

const PREF_TOKEN = "jsbridge.token";          // → extensions.zotero.jsbridge.token
const TOKEN_FILE = "zoterojs-token.txt";
const PATHS = ["/zoterojs/ping", "/zoterojs/exec", "/zoterojs/merge"];

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

function checkAuth(options) {
  const h = (options && options.headers) || {};
  const got = h["x-zoterojs-token"];
  if (!token || !got || String(got) !== token) {
    return jsonReply(403, { ok: false, error: "missing or invalid X-ZoteroJS-Token" });
  }
  return null;
}

const SIZE_LIMIT = 1500000;

function pack(payload) {
  let s;
  try { s = JSON.stringify(payload); }
  catch (e) { return jsonReply(200, { ok: false, error: "JSON.stringify failed: " + (e.message || e) }); }
  if (s.length > SIZE_LIMIT) {
    return jsonReply(200, {
      ok: payload.ok,
      truncated: true,
      note: `响应 ${s.length} 字节，超过 ${SIZE_LIMIT} 上限，结果已截断`,
      result: safe(payload.result, 2),
    });
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

const strip = s => String(s || "").toLowerCase()
  .replace(/[\s\-_.,;:()[\]（）【】《》"'’·、，。：；！？!?—－]/g, "");
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
  };
  for (const path of Object.keys(epTable)) {
    if (Zotero.Server.Endpoints[path]) savedEndpoints[path] = Zotero.Server.Endpoints[path];
    Zotero.Server.Endpoints[path] = epTable[path];
  }
  Zotero.debug(`Zotero JS Bridge: 已注册 ${Object.keys(epTable).join(", ")}`);
}

async function onMainWindowLoad({ window }, reason) {}
async function onMainWindowUnload({ window }, reason) {}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  for (const path of PATHS) {
    if (savedEndpoints[path]) Zotero.Server.Endpoints[path] = savedEndpoints[path];
    else delete Zotero.Server.Endpoints[path];
  }
  Zotero.debug("Zotero JS Bridge: 已卸载端点");
}

function install(data, reason) {}
function uninstall(data, reason) {}
