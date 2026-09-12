/* 用 stub 把 bootstrap.js 跑起来，验证端点契约和自检逻辑。
   不需要 Zotero，只需要 node。用法： node test_bridge.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ADDON = path.join(__dirname, "addon");
const SRC = path.join(ADDON, "bootstrap.js");
const MANIFEST = path.join(ADDON, "manifest.json");

/* ---------- stub 世界 ---------- */
const prefs = new Map();
const merged = [];
const tokenWrites = [];
const paneRegs = [];          // 面板注册调用，用来断言注册参数
let panePanes = [];           // 面板“注册表”当前内容，断言没有重复堆积
let paneSeq = 0;
const loggedErrors = [];      // Zotero.logError 收到的东西
let tokenFileOnDisk = true;   // 自检要查 token 文件在不在，测试里可切换
let confirmAnswer = true;     // Services.prompt.confirm 的替身
let tokenSeq = 0;             // 让 randomString 每次都不同

class Item {
  constructor(o) { Object.assign(this, o); this.deleted = false; }
  getField(f) { return (this.fields || {})[f] ?? ""; }
  getCollections() { return this.collections || []; }
  getAttachments() { return this.attachments || []; }
}

const ITEMS = {
  MASTER01: new Item({ key: "MASTER01", itemType: "journalArticle", fields: { title: "某篇论文", date: "2022", volume: "59", issue: "3", pages: "1-9" }, attachments: [1, 2], collections: ["C1"] }),
  DUPGOOD: new Item({ key: "DUPGOOD", itemType: "journalArticle", fields: { title: "某篇论文", date: "2022", volume: "", issue: "3", pages: "1-9" }, attachments: [3], collections: ["C2"] }),
  DUPBAD_TITLE: new Item({ key: "DUPBAD_TITLE", itemType: "journalArticle", fields: { title: "另一篇论文", date: "2022" } }),
  DUPBAD_ISBN: new Item({ key: "DUPBAD_ISBN", itemType: "book", fields: { title: "某教材", ISBN: "978-0-00-000000-1" } }),
  DUPINTASH: new Item({ key: "DUPINTASH", itemType: "journalArticle", fields: { title: "某篇论文", date: "2022", volume: "61", issue: "3" } }),
  // 破折号变体：Zotero 抓来的条目里 "-" 常常是 EN DASH（CNKI / JSTOR / Springer 都这么排）
  MASTERDASH: new Item({ key: "MASTERDASH", itemType: "journalArticle", fields: { title: "Deep Learning-Based Method", date: "2021", pages: "1-9" } }),
  // 下面几个是字面量而非转义，肉眼分不出 U+2013 / U+2014，改动前先 dump 码点：
  //   DUPDASH   标题和页号用 U+2013 EN DASH
  //   DUPMINUS  用 U+2212 MINUS SIGN（Sm 类，不在 \p{Pd} 里）
  //   DUPZWSP   用 U+2011 非断连字符 + U+200B 零宽空格
  DUPDASH: new Item({ key: "DUPDASH", itemType: "journalArticle", fields: { title: "Deep Learning–Based Method", date: "2021", pages: "1–9" } }),
  DUPMINUS: new Item({ key: "DUPMINUS", itemType: "journalArticle", fields: { title: "Deep Learning−Based Method", date: "2021", pages: "1−9" } }),
  DUPZWSP: new Item({ key: "DUPZWSP", itemType: "journalArticle", fields: { title: "Deep Learning‑Based​Method", date: "2021", pages: "1-9" } }),
  DUPPAGESBAD: new Item({ key: "DUPPAGESBAD", itemType: "journalArticle", fields: { title: "Deep Learning-Based Method", date: "2021", pages: "11-19" } }),
};

const Zotero = {
  version: "10.0.2",
  debug: () => {},
  // 记一笔再抛：bootstrap 里所有东西都包在 try/catch 里，不记的话"吞掉一个异常"
  // 和"根本没出错"在测试里长得一模一样（logErr 的 catch 会把抛出也吃掉）。
  logError: (e) => { loggedErrors.push(String((e && e.message) || e)); throw e; },
  initializationPromise: Promise.resolve(),
  Libraries: { userLibraryID: 1 },
  DataDirectory: { dir: "C:\\Users\\you\\Zotero" },
  Prefs: {
    get: (k) => prefs.get("extensions.zotero." + k),
    set: (k, v) => prefs.set("extensions.zotero." + k, v),
  },
  // 末尾那位递增：真 randomString 每次都不一样，返回常量的话
  // 「换 token」这类测试会假绿。长度仍是 n。
  Utilities: { randomString: (n) => "T".repeat(n - 1) + (tokenSeq++ % 10) },
  File: {
    putContentsAsync: async (p, c) => { tokenWrites.push([p, c]); },
    pathToFile: (p) => ({ exists: tokenFileOnDisk }),
  },
  // 照 preferencePanes.js 的行为做替身：显式 id 撞了就抛；不给 id 就每次生成一个
  // 新的随机 id（真实实现是 plugin-pane-<random>-<pluginID>）—— 正因为如此，
  // 热重载重复 register 不会报错，只会悄悄多出一块面板，必须靠 unregister 自己收。
  PreferencePanes: {
    pluginPanes: [],
    register: async (o) => {
      paneRegs.push(o);
      if (o.id && panePanes.some((p) => p.id === o.id)) {
        throw new Error(`Pane with ID ${o.id} already registered`);
      }
      const id = o.id || `plugin-pane-${paneSeq++}-${o.pluginID}`;
      panePanes.push({ id, pluginID: o.pluginID, src: o.src });
      return id;
    },
    unregister: (id) => { panePanes = panePanes.filter((p) => p.id !== id); },
  },
  Item,
  Collection: class {},
  Items: {
    getByLibraryAndKeyAsync: async (lib, key) => ITEMS[key] || null,
    merge: () => { throw new Error("不该走 deprecated 路径"); },
  },
  Server: { Endpoints: {} },
};

// 错误控制台的替身。字段照抄实测的 nsIScriptError / nsIConsoleMessage：
// scriptError 走 flags（0=error 1=warning 8=info），普通消息只有 logLevel 和 message。
const consoleMsgs = [
  { timeStamp: 1000, flags: 0, errorMessage: "TypeError: x is undefined", category: "JavaScript",
    sourceName: "file:///app/a.js", lineNumber: 12, columnNumber: 3 },
  { timeStamp: 2000, flags: 1, errorMessage: "downloadable font: OS/2", category: "CSS Loader",
    sourceName: "", lineNumber: 0, columnNumber: 0 },
  // Log.sys.mjs 格式。故意让 logLevel=1（info）而正文写着 WARN —— 实测就是这样，
  // 照 logLevel 分类会让 minLevel=warn 把它漏掉
  { timeStamp: 3000, logLevel: 1, message: "1789020868988\taddons.xpi\tWARN\tDownload failed" },
  // 既没有 flags 也没有 Log 前缀，走 logLevel 兜底的那条路
  { timeStamp: 4000, logLevel: 1, message: "plain info message" },
];
let consoleResets = 0;

const Services = {
  uuid: { generateUUID: () => ({ toString: () => "{deadbeef-0000-1111-2222-333344445555}" }) },
  scriptSecurityManager: { getSystemPrincipal: () => ({}) },
  prompt: { confirm: () => confirmAnswer },
  console: {
    getMessageArray: () => consoleMsgs.slice(),
    reset: () => { consoleResets++; },
  },
};

// Zotero.Debug 的替身。get() 在 Zotero 里对"空/非空"返回类型不一致
// （count()==0 时返回字符串 ""，否则返回 Promise），故意照抄这个怪癖。
const debugBuf = { storing: false, count: 0, text: "" };
Zotero.Debug = {
  get storing() { return debugBuf.storing; },
  get enabled() { return debugBuf.count ? 1 : 0; },
  count: () => debugBuf.count,
  get: () => (debugBuf.count === 0 ? "" : Promise.resolve(debugBuf.text)),
  clear: () => { debugBuf.count = 0; debugBuf.text = ""; },
};

const Components = { utils: {}, interfaces: {}, classes: {} };
const ChromeUtils = {
  importESModule: (uri) => {
    assert.strictEqual(uri, "chrome://zotero/content/mergeItems.mjs", "mergeItems 模块路径");
    return { mergeItems: (master, dups) => { merged.push([master.key, dups.map(d => d.key)]); dups.forEach(d => { d.deleted = true; }); } };
  },
};

const sandboxGlobals = {
  Zotero, Services, Components, ChromeUtils,
  PathUtils: { join: (...a) => a.join("\\") },
  IOUtils: {
    writeUTF8: async (p, c) => { tokenWrites.push([p, c]); },
    exists: async () => tokenFileOnDisk,
  },
  Cu: { Sandbox: () => ({}), evalInSandbox: () => { throw new Error("不该走沙箱退路"); } },
  Ci: {}, Cc: {}, OS: {},
  console,
  setTimeout, clearTimeout, URLSearchParams, JSON, Object, Array, String, Number, Math, Date, Promise, Error, RegExp, Boolean,
};
sandboxGlobals.globalThis = sandboxGlobals;

const ctx = vm.createContext(sandboxGlobals);
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: "bootstrap.js" });

const call = (fn, ...a) => vm.runInContext(fn, ctx)(...a);

/* ---------- 测试 ---------- */
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log("  ✓", name); pass++; }
  catch (e) { console.log("  ✗", name, "\n     ", e.message); fail++; }
};

(async () => {
  // manifest 先读，startup 的版本号也从这里取 —— 免得版本一涨测试就假红
  const man = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

  await call("startup", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 1);

  const EP = sandboxGlobals.Zotero.Server.Endpoints;

  console.log("\n[0] manifest（照抄 Extension.sys.mjs:1874-1883 的三项硬要求）");

  await t("applications.zotero.id 存在", () => {
    assert.ok(man.applications?.zotero?.id, "缺 id");
  });
  await t("applications.zotero.update_url 存在（缺了会 packagingError，装不上）", () => {
    assert.ok(man.applications?.zotero?.update_url, "缺 update_url —— Zotero 会报「可能无法与该版本的 Zotero 兼容」");
  });
  await t("applications.zotero.strict_max_version 存在", () => {
    assert.ok(man.applications?.zotero?.strict_max_version, "缺 strict_max_version");
  });
  await t("strict_min_version 里没有 *（Zotero 直接抛错）", () => {
    const v = man.applications.zotero.strict_min_version || "";
    assert.ok(!v.split(".").some(p => p === "*"), `非法: ${v}`);
  });
  await t("版本区间覆盖 10.0.2", () => {
    // 照 XPIDatabase.isCompatibleWith 的语义：分段按数值比
    const cmp = (a, b) => {
      const A = String(a).split("."), B = String(b).split(".");
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const x = parseInt(A[i] ?? "0", 10) || 0, y = parseInt(B[i] ?? "0", 10) || 0;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    };
    const app = "10.0.2";
    assert.ok(cmp(app, man.applications.zotero.strict_min_version) >= 0, "太旧");
    assert.ok(cmp(app, man.applications.zotero.strict_max_version) <= 0, "太新");
  });
  await t("没有 theme/langpack_id/dictionaries（否则 type 不是 extension）", () => {
    for (const k of ["theme", "langpack_id", "dictionaries"]) assert.ok(!(k in man), `有 ${k}`);
  });
  await t("icons 声明的文件都在，且 PNG 实际尺寸与键相符", () => {
    assert.ok(man.icons, "manifest 没写 icons —— 插件列表里会是默认空白图标");
    for (const [size, rel] of Object.entries(man.icons)) {
      const p = path.join(ADDON, ...rel.split("/"));
      assert.ok(fs.existsSync(p), `icons 指向的文件不存在: ${rel}`);
      const buf = fs.readFileSync(p);
      assert.strictEqual(buf.slice(1, 4).toString(), "PNG", `${rel} 不是 PNG`);
      // PNG IHDR：宽、高是偏移 16 / 20 处的大端 32 位
      assert.strictEqual(buf.readUInt32BE(16), Number(size), `${rel} 宽度不是 ${size}`);
      assert.strictEqual(buf.readUInt32BE(20), Number(size), `${rel} 高度不是 ${size}`);
    }
  });

  console.log("\n[1] 端点注册");
  await t("四个路径都注册上了", () => {
    assert.deepStrictEqual(Object.keys(EP).sort(),
      ["/zoterojs/exec", "/zoterojs/logs", "/zoterojs/merge", "/zoterojs/ping"]);
  });
  await t("都是构造函数（server.js 里是 new this.endpoint()）", () => {
    for (const p of Object.keys(EP)) assert.ok(typeof new EP[p]().init === "function");
  });
  await t("init.length === 1（否则会走回调式分支）", () => {
    for (const p of Object.keys(EP)) assert.strictEqual(new EP[p]().init.length, 1, p);
  });
  await t("token 写到了数据目录", () => {
    assert.ok(tokenWrites.some(([p]) => p.endsWith("zoterojs-token.txt")), "没写 token 文件");
  });
  await t("token 落到了 pref", () => {
    assert.ok(prefs.get("extensions.zotero.jsbridge.token"), "pref 没写");
  });

  // 带鉴权的请求头。故意用 getter 而不是把 token 抄成常量：面板上的「重新生成」
  // 会把 token 换掉，抄下来的常量从此再也对不上，后面每个断言都变成 403。更坏的是
  // 闸门排在鉴权之后（这是有意的，见 checkAuth 的注释），403 会盖住本该看到的 503/404，
  // 看上去像闸门坏了，实际是测试自己拿错了钥匙。
  const H = { get "x-zoterojs-token"() { return prefs.get("extensions.zotero.jsbridge.token"); } };
  const BADH = {};

  console.log("\n[2] ping");
  await t("ping 不需要 token，返回库 id", async () => {
    const r = await new EP["/zoterojs/ping"]().init({ method: "GET", headers: {} });
    assert.strictEqual(r[0], 200);
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.libraryID, 1);
    assert.strictEqual(b.zotero, "10.0.2");
    assert.strictEqual(b.version, man.version, "ping 应报 manifest 里的版本");
  });

  console.log("\n[3] exec 鉴权");
  await t("无 token → 403", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: BADH, data: { code: "return 1" } });
    assert.strictEqual(r[0], 403);
  });
  await t("错 token → 403", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: { "x-zoterojs-token": "wrong" }, data: { code: "return 1" } });
    assert.strictEqual(r[0], 403);
  });
  await t("空 code → 400", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "  " } });
    assert.strictEqual(r[0], 400);
  });

  console.log("\n[4] exec 执行");
  await t("同步 return", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "return 1+1" } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    assert.strictEqual(b.result, 2);
    assert.strictEqual(b.mode, "AsyncFunction");
  });
  await t("顶层 await", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "const x = await Promise.resolve(7); return x * 2" } });
    assert.strictEqual(JSON.parse(r[2]).result, 14);
  });
  await t("摸得到 Zotero 全局", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "return Zotero.Libraries.userLibraryID" } });
    assert.strictEqual(JSON.parse(r[2]).result, 1);
  });
  await t("log() 被收集", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "log('hello', {a:1}); return 1" } });
    const b = JSON.parse(r[2]);
    assert.deepStrictEqual(b.logs, ['hello {"a":1}']);
  });
  await t("抛错返回 ok:false + stack，不 500", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "throw new Error('boom')" } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.ok, false);
    assert.match(b.error, /boom/);
    assert.ok(b.stack);
  });
  await t("Zotero.Item 被摘要化，不炸序列化", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "return Zotero.Items.getByLibraryAndKeyAsync(1,'MASTER01')" } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    assert.strictEqual(b.result._zoteroItem, "MASTER01");
    assert.strictEqual(b.result.title, "某篇论文");
  });

  await t("没 await 的 Promise 被大声标出，而不是静默变成 {}", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "return { n: Promise.resolve(1) }" } });
    const b = JSON.parse(r[2]);
    assert.match(b.result.n, /Promise 未 await/);
  });
  await t("顶层 return 的 Promise 会被自动 await", async () => {
    const r = await new EP["/zoterojs/exec"]().init({ headers: H, data: { code: "return Promise.resolve(42)" } });
    assert.strictEqual(JSON.parse(r[2]).result, 42);
  });

  console.log("\n[5] merge 自检");
  const M = (data) => new EP["/zoterojs/merge"]().init({ headers: H, data });

  await t("缺参数 → 400", async () => {
    assert.strictEqual((await M({ master: "MASTER01" }))[0], 400);
  });
  await t("dryRun 不动数据", async () => {
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPGOOD"], dryRun: true }))[2]);
    assert.strictEqual(b.dryRun, true);
    assert.strictEqual(b.report[0].merged, false);
    assert.strictEqual(b.report[0].dryRun, true);
    assert.strictEqual(merged.length, 0, "dryRun 竟然真的合并了");
  });
  await t("正常合并：空 volume 不算冲突（网络首发 vs 正式版）", async () => {
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPGOOD"] }))[2]);
    assert.strictEqual(b.report[0].merged, true, JSON.stringify(b.report[0]));
    // 跨 vm realm 的数组原型不同，deepStrictEqual 会误报，先过一遍 JSON
    assert.deepStrictEqual(JSON.parse(JSON.stringify(merged)), [["MASTER01", ["DUPGOOD"]]]);
  });
  await t("标题不同 → 拒绝", async () => {
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPBAD_TITLE"] }))[2]);
    assert.strictEqual(b.report[0].merged, false);
    assert.match(b.report[0].why, /标题相同/);
  });
  await t("ISBN 冲突 → 拒绝（同一教材上下册/不同版次，绝不能合并）", async () => {
    ITEMS.MASTER01.fields.ISBN = "978-0-00-000000-2";
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPBAD_ISBN"] }))[2]);
    assert.strictEqual(b.report[0].merged, false);
    assert.match(b.report[0].why, /类型相同|ISBN 不冲突/);
    delete ITEMS.MASTER01.fields.ISBN;
  });
  await t("volume 都有值且不同 → 拒绝", async () => {
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPINTASH"] }))[2]);
    assert.strictEqual(b.report[0].merged, false);
    assert.match(b.report[0].why, /卷号不冲突/);
  });
  await t("已在回收站 → 跳过", async () => {
    const b = JSON.parse((await M({ master: "MASTER01", dups: ["DUPGOOD"] }))[2]);
    assert.strictEqual(b.report[0].merged, false);
    assert.match(b.report[0].why, /回收站/);
  });
  await t("master 不存在 → ok:false", async () => {
    const b = JSON.parse((await M({ master: "NOPE", dups: ["DUPGOOD"] }))[2]);
    assert.strictEqual(b.ok, false);
  });

  console.log("\n[5.5] strip() 归一化：破折号变体不该判成冲突");
  const D = async (dup) => {
    const b = JSON.parse((await M({ master: "MASTERDASH", dups: [dup], dryRun: true }))[2]);
    return b.report[0];
  };

  await t("EN DASH U+2013 与 ASCII 连字符等价", async () => {
    const r = await D("DUPDASH");
    assert.strictEqual(r.checks["标题相同"], true, "标题被判成不同");
    assert.strictEqual(r.checks["页号不冲突"], true, "'1–9' vs '1-9' 被判成冲突");
  });
  await t("MINUS SIGN U+2212 被归一化（它不在 \\p{Pd} 类里，容易漏）", async () => {
    const r = await D("DUPMINUS");
    assert.strictEqual(r.checks["标题相同"], true, "标题被判成不同");
    assert.strictEqual(r.checks["页号不冲突"], true, "'1−9' vs '1-9' 被判成冲突");
  });
  await t("U+2011 非断连字符 + U+200B 零宽空格被归一化", async () => {
    const r = await D("DUPZWSP");
    assert.strictEqual(r.checks["标题相同"], true, "标题里的 U+2011/U+200B 没被吃掉");
  });
  await t("真不一样的页号仍然判冲突（别归一化过头）", async () => {
    const r = await D("DUPPAGESBAD");
    assert.strictEqual(r.checks["页号不冲突"], false, "'11-19' 和 '1-9' 被当成一样了");
  });

  console.log("\n[6] logs");
  const L = (opts) => new EP["/zoterojs/logs"]().init(opts);
  const LG = (q) => L({ method: "GET", headers: H, searchParams: new URLSearchParams(q), data: null });
  const LP = (body) => L({ method: "POST", headers: H, searchParams: new URLSearchParams(""), data: body });

  await t("无 token → 403（日志里有路径、URL、系统信息，必须挡）", async () => {
    const r = await L({ method: "GET", headers: BADH, searchParams: new URLSearchParams("") });
    assert.strictEqual(r[0], 403);
  });
  await t("默认回 console 全部消息", async () => {
    const b = JSON.parse((await LG(""))[2]);
    assert.strictEqual(b.console.total, 4);
    assert.strictEqual(b.console.returned, 4);
    assert.deepStrictEqual(b.console.messages.map(m => m.level),
      ["error", "warning", "warning", "info"]);
  });
  await t("scriptError 取 errorMessage 原文，不取包了一层的 message", async () => {
    const b = JSON.parse((await LG(""))[2]);
    assert.strictEqual(b.console.messages[0].message, "TypeError: x is undefined");
    assert.strictEqual(b.console.messages[0].category, "JavaScript");
    assert.strictEqual(b.console.messages[0].line, 12);
    assert.strictEqual(b.console.messages[0].source, "file:///app/a.js");
  });
  await t("Log.sys.mjs 前缀被扒掉，logger 单列，级别以正文为准而非 logLevel", async () => {
    const b = JSON.parse((await LG(""))[2]);
    const m = b.console.messages[2];
    assert.strictEqual(m.message, "Download failed", "前缀没扒干净");
    assert.strictEqual(m.logger, "addons.xpi");
    assert.strictEqual(m.level, "warning", "正文写 WARN，却按 logLevel=1 判成了 info");
    assert.strictEqual(m.logLevel, 1, "原始 logLevel 仍应保留，别丢信息");
  });
  await t("没有 Log 前缀的普通消息走 logLevel 兜底", async () => {
    const b = JSON.parse((await LG(""))[2]);
    assert.strictEqual(b.console.messages[3].level, "info");
    assert.strictEqual(b.console.messages[3].message, "plain info message");
  });
  await t("minLevel=warning 不会漏掉正文写着 WARN 的那种", async () => {
    const b = JSON.parse((await LG("minLevel=warning"))[2]);
    assert.deepStrictEqual(b.console.messages.map(m => m.level), ["error", "warning", "warning"]);
    assert.strictEqual(b.console.total, 4, "total 应是过滤前的总数");
    assert.strictEqual(b.console.matched, 3);
  });
  await t("category 子串过滤", async () => {
    const b = JSON.parse((await LG("category=css"))[2]);
    assert.strictEqual(b.console.matched, 1);
    assert.strictEqual(b.console.messages[0].category, "CSS Loader");
  });
  await t("grep 过滤 + since 过滤", async () => {
    assert.strictEqual(JSON.parse((await LG("grep=font"))[2]).console.matched, 1);
    const b = JSON.parse((await LG("since=2500"))[2]);
    assert.strictEqual(b.console.matched, 2, "since 只留 timeStamp >= 2500 的");
  });
  await t("grep 也能按 logger 名搜（前缀扒掉后正文里已经没有它了）", async () => {
    const b = JSON.parse((await LG("grep=addons.xpi"))[2]);
    assert.strictEqual(b.console.matched, 1);
    assert.strictEqual(b.console.messages[0].message, "Download failed",
      "命中的正文里确实不含 addons.xpi");
  });
  await t("limit 从最新往回取，omitted 报出丢了几条", async () => {
    const b = JSON.parse((await LG("limit=2"))[2]);
    assert.strictEqual(b.console.returned, 2);
    assert.strictEqual(b.console.omitted, 2);
    assert.strictEqual(b.console.messages[0].time, 3000, "应留最新的两条，且按时间正序");
  });
  await t("POST 的 JSON body 同样生效", async () => {
    const b = JSON.parse((await LP({ minLevel: "warning", limit: 1 }))[2]);
    assert.strictEqual(b.console.matched, 3);
    assert.strictEqual(b.console.returned, 1);
  });
  await t("source=debug 且缓冲为空 → 给出怎么开，而不是空结果", async () => {
    const b = JSON.parse((await LG("source=debug"))[2]);
    assert.strictEqual(b.console, undefined);
    assert.strictEqual(b.debug.count, 0);
    assert.match(b.debug.note, /debug\.store/);
  });
  await t("source=debug 有货时取到文本", async () => {
    debugBuf.count = 2; debugBuf.text = "line1\nline2"; debugBuf.storing = true;
    const b = JSON.parse((await LG("source=debug"))[2]);
    assert.strictEqual(b.debug.storing, true);
    assert.match(b.debug.text, /line2/);
    debugBuf.count = 0; debugBuf.text = ""; debugBuf.storing = false;
  });
  await t("source=both 两个源都回", async () => {
    const b = JSON.parse((await LG("source=both"))[2]);
    assert.ok(b.console && b.debug);
  });
  await t("source 非法 → 400", async () => {
    assert.strictEqual((await LG("source=nope"))[0], 400);
  });
  await t("minLevel 传成原型属性名不会炸（SEVERITY[\"constructor\"] 是函数不是 undefined）", async () => {
    const b = JSON.parse((await LG("minLevel=constructor"))[2]);
    assert.strictEqual(b.console.matched, 4, "无法识别的级别应当作不过滤");
    const b2 = JSON.parse((await LG("minLevel=hasOwnProperty"))[2]);
    assert.strictEqual(b2.console.matched, 4);
  });
  await t("clear 默认不动控制台", async () => {
    consoleResets = 0;
    await LG("");
    assert.strictEqual(consoleResets, 0, "没让它清就清了");
  });
  await t("clear=1 才清，且只清被读到的源", async () => {
    consoleResets = 0;
    const b = JSON.parse((await LG("clear=1&source=console"))[2]);
    assert.strictEqual(consoleResets, 1);
    assert.deepStrictEqual(b.cleared, ["console"]);
  });

  console.log("\n[7] pack() 截断");
  await t("超限时保住 logs / mode / ms，不再只剩 result", async () => {
    const big = { ok: true, mode: "AsyncFunction", ms: 42, logs: ["关键线索"], result: "x".repeat(1600000) };
    const b = JSON.parse(call("pack", big)[2]);
    assert.strictEqual(b.truncated, true);
    assert.strictEqual(b.mode, "AsyncFunction");
    assert.strictEqual(b.ms, 42);
    assert.deepStrictEqual(b.logs, ["关键线索"], "截断时把 logs 丢了");
  });
  await t("logs 太多时只留尾部并报 logsOmitted", () => {
    const logs = Array.from({ length: 500 }, (_, i) => `line-${i}-${"y".repeat(50)}`);
    const b = JSON.parse(call("pack", { ok: true, logs, result: "x".repeat(1600000) })[2]);
    assert.ok(b.logs.length > 0 && b.logs.length <= 50);
    assert.strictEqual(b.logs[b.logs.length - 1], logs[499], "应留尾部");
    assert.strictEqual(b.logsOmitted, 500 - b.logs.length);
  });

  console.log("\n[8] 管理面板与开关");
  const setPref = (k, v) => sandboxGlobals.Zotero.Prefs.set(k, v);
  const epCall = (p, opts) => new EP[p]().init(opts);
  // 改 pref 的测试一律走这里：断言抛了也要把 pref 还原。不还原的话，一个断言失败
  // 会把 enabled=false 留给后面的测试，于是后继全红 —— 一次真失败看着像塌了一片。
  const withPref = async (k, v, fn) => {
    const before = sandboxGlobals.Zotero.Prefs.get(k);
    setPref(k, v);
    try { return await fn(); } finally { setPref(k, before); }
  };
  // 面板里的元素替身：自检和按钮只用到 getElementById / textContent / value
  const fakeDoc = () => {
    const els = {};
    return { els, getElementById: (id) => (els[id] ||= { textContent: "", value: "" }) };
  };
  const pane = () => sandboxGlobals.Zotero.JSBridge;

  await t("startup 注册了管理面板，src 指向 prefs.xhtml", () => {
    assert.strictEqual(paneRegs.length, 1, `注册了 ${paneRegs.length} 次面板`);
    assert.strictEqual(paneRegs[0].pluginID, "zoterojs-bridge@local");
    assert.strictEqual(paneRegs[0].src, "file:///x/prefs.xhtml");
    // 必须给固定 id：不给的话 Zotero 每次生成新的随机 id，重复注册既不报错也不去重
    assert.strictEqual(paneRegs[0].id, "zoterojs-bridge-pane", "面板没给固定 id，热重载会堆出多块");
  });
  await t("热重载再 startup 一次，侧栏里不会多出第二块面板，也不报错", async () => {
    const errs = loggedErrors.length;
    await call("startup", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
    assert.strictEqual(panePanes.length, 1, `面板堆到了 ${panePanes.length} 块`);
    assert.strictEqual(panePanes[0].id, "zoterojs-bridge-pane");
    // 不先 unregister 的话，第二次 register 会撞上固定 id 直接抛 —— 抛出被 try/catch
    // 吞掉，面板列表看着还是 1 块，只有这里能看出它其实没注册成
    assert.deepStrictEqual(loggedErrors.slice(errs), [], "第二次 startup 报了错，面板多半没注册上");
  });
  await t("总开关关着也照样注册面板 —— 否则关掉之后就没地方再打开了", () =>
    withPref("jsbridge.enabled", false, async () => {
      await call("startup", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
      assert.strictEqual(panePanes.length, 1, "停用后面板没了，用户只能去改 pref");
    }));
  await t("面板文件存在，按钮要用的 id 都在", () => {
    const p = path.join(ADDON, "prefs.xhtml");
    assert.ok(fs.existsSync(p), "prefs.xhtml 不存在 —— 装上去面板是空的");
    const x = fs.readFileSync(p, "utf8");
    for (const id of ["jsb-token", "jsb-status", "jsb-copy", "jsb-regen", "jsb-rewrite", "jsb-check"]) {
      assert.ok(x.includes(`id="${id}"`), `面板里没有 ${id}，按钮点了会报错`);
    }
  });
  await t("面板每个 preference= 都在 prefs.js 里有默认值", () => {
    // 先剥掉 XML 注释 —— 注释里那句 preference="..." 是说明文字，不是绑定
    const x = fs.readFileSync(path.join(ADDON, "prefs.xhtml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    // 七个可调参数：总开关、只读、四个端点、响应上限。token 不在其中 ——
    // 那个框是只读展示，由 JSBridge.refreshTokenView 填，不走 preference 绑定。
    const WANT = [
      "extensions.zotero.jsbridge.enabled",
      "extensions.zotero.jsbridge.readonly",
      "extensions.zotero.jsbridge.endpoint.ping",
      "extensions.zotero.jsbridge.endpoint.exec",
      "extensions.zotero.jsbridge.endpoint.merge",
      "extensions.zotero.jsbridge.endpoint.logs",
      "extensions.zotero.jsbridge.limit.responseKB",
    ];
    const want = [...x.matchAll(/preference="([^"]+)"/g)].map(m => m[1]);
    // 用「集合相等」而不是「不少于 N 个」：少绑一个和少绑另一个是两种不同的漏，
    // 数个数看不出来；多绑了一个不存在的 pref 也要挡住。
    assert.deepStrictEqual([...want].sort(), [...WANT].sort(), "面板绑的参数和预期对不上");
    const declared = new Set([...fs.readFileSync(path.join(ADDON, "prefs.js"), "utf8")
      .matchAll(/pref\("([^"]+)"/g)].map(m => m[1]));
    for (const k of WANT) assert.ok(declared.has(k), `prefs.js 没给默认值: ${k}`);
  });
  await t("Zotero.JSBridge 暴露给面板，函数齐全", () => {
    assert.ok(pane(), "没挂上 —— 面板上每个按钮都会报错");
    for (const f of ["refreshTokenView", "copyToken", "regenerateToken", "rewriteTokenFile", "selfCheck"]) {
      assert.strictEqual(typeof pane()[f], "function", `缺 ${f}`);
    }
  });
  await t("自检报出四个端点、总开关、只读和 token 文件", async () => {
    const doc = fakeDoc();
    await pane().selfCheck(doc);
    const out = doc.els["jsb-status"].textContent;
    assert.ok(out.includes(man.version), out);
    for (const p of ["/zoterojs/ping", "/zoterojs/exec", "/zoterojs/merge", "/zoterojs/logs"]) {
      assert.ok(out.includes(p), `自检没提 ${p}: ${out}`);
    }
    assert.ok(out.includes("token 文件"), out);
  });
  await t("token 文件不在时自检如实报出来并给修法", async () => {
    tokenFileOnDisk = false;
    const doc = fakeDoc();
    await pane().selfCheck(doc);
    assert.ok(doc.els["jsb-status"].textContent.includes("重写 token 文件"), "没告诉用户怎么办");
    tokenFileOnDisk = true;
  });
  await t("拿不到剪贴板时不抛错，如实报失败", () => {
    const doc = fakeDoc();
    pane().copyToken(doc);
    assert.ok(doc.els["jsb-status"].textContent.includes("复制失败"), "该报失败");
  });
  await t("确认框点取消 → token 不变", async () => {
    confirmAnswer = false;
    const before = sandboxGlobals.Zotero.Prefs.get("jsbridge.token");
    const doc = fakeDoc();
    await pane().regenerateToken(doc);
    assert.strictEqual(sandboxGlobals.Zotero.Prefs.get("jsbridge.token"), before, "token 被换掉了");
    assert.ok(doc.els["jsb-status"].textContent.includes("已取消"));
    confirmAnswer = true;
  });
  await t("确认后换新 token：pref、文件、面板三处都跟上，旧 token 立刻作废", async () => {
    const before = sandboxGlobals.Zotero.Prefs.get("jsbridge.token");
    const writes = tokenWrites.length;
    const doc = fakeDoc();
    await pane().regenerateToken(doc);
    const after = sandboxGlobals.Zotero.Prefs.get("jsbridge.token");
    assert.notStrictEqual(after, before, "token 没换");
    assert.ok(tokenWrites.length > writes, "没重写 token 文件");
    assert.strictEqual(doc.els["jsb-token"].value, after, "面板上显示的没刷新");
    // 换 token 的全部意义就是让旧钥匙作废。这条不验，等于换了个寂寞。
    const stale = await epCall("/zoterojs/exec",
      { headers: { "x-zoterojs-token": before }, data: { code: "return 1" } });
    assert.strictEqual(stale[0], 403, "旧 token 还能用");
  });

  await t("总开关关掉 → 四个端点全 503，且说得出是哪个开关", () =>
    withPref("jsbridge.enabled", false, async () => {
      for (const p of ["/zoterojs/ping", "/zoterojs/exec", "/zoterojs/merge", "/zoterojs/logs"]) {
        const r = await epCall(p, { method: "GET", headers: H,
          searchParams: new URLSearchParams("source=console"),
          data: { code: "return 1", master: "MASTER01", dups: ["DUPGOOD"] } });
        assert.strictEqual(r[0], 503, p);
        // 503 得指明去哪个 pref 打开，否则用户只能翻文档
        assert.ok(JSON.parse(r[2]).pref.endsWith("jsbridge.enabled"), `${p} 的 503 没说是哪个开关`);
      }
    }));
  await t("单独关掉 exec → exec 404，ping 照常并列出 disabled", () =>
    withPref("jsbridge.endpoint.exec", false, async () => {
      const r = await epCall("/zoterojs/exec", { headers: H, data: { code: "return 1" } });
      assert.strictEqual(r[0], 404);
      assert.ok(JSON.parse(r[2]).pref.endsWith("endpoint.exec"), "错误里该指出是哪个 pref");
      const ping = await epCall("/zoterojs/ping", { method: "GET", headers: {} });
      assert.strictEqual(ping[0], 200);
      assert.deepStrictEqual(JSON.parse(ping[2]).disabled, ["/zoterojs/exec"]);
    }));
  await t("只读模式：exec/merge 403，logs 能读但 clear 403，ping 照常", () =>
    withPref("jsbridge.readonly", true, async () => {
      assert.strictEqual((await epCall("/zoterojs/exec",
        { headers: H, data: { code: "return 1" } }))[0], 403);
      assert.strictEqual((await epCall("/zoterojs/merge",
        { headers: H, data: { master: "MASTER01", dups: ["DUPGOOD"] } }))[0], 403);
      const read = await epCall("/zoterojs/logs", { headers: H, data: null,
        searchParams: new URLSearchParams("source=console&limit=5") });
      assert.strictEqual(read[0], 200, "读日志是只读的，不该被拦");
      const clear = await epCall("/zoterojs/logs", { headers: H, data: null,
        searchParams: new URLSearchParams("source=console&clear=1") });
      assert.strictEqual(clear[0], 403, "clear 是破坏性的，只读模式该拦");
      const ping = await epCall("/zoterojs/ping", { method: "GET", headers: {} });
      assert.strictEqual(JSON.parse(ping[2]).readonly, true, "ping 该报出只读状态");
    }));
  await t("只读关掉后 exec 立刻恢复（读的是实时 pref，不是启动时的快照）", async () => {
    const r = await epCall("/zoterojs/exec", { headers: H, data: { code: "return 1+1" } });
    assert.strictEqual(r[0], 200);
    assert.strictEqual(JSON.parse(r[2]).result, 2);
  });
  await t("闸门在鉴权之后：错 token 的响应里不泄漏配置", () =>
    withPref("jsbridge.readonly", true, async () => {
      const r = await epCall("/zoterojs/exec", { headers: BADH, data: { code: "return 1" } });
      assert.strictEqual(r[0], 403);
      assert.ok(!JSON.parse(r[2]).pref, "未鉴权的响应里漏出了 pref 名");
    }));
  await t("响应上限可调：默认不截断，调到 10KB 就截", async () => {
    const big = { ok: true, logs: [], result: "y".repeat(30000) };
    assert.ok(!JSON.parse(call("pack", big)[2]).truncated, "默认上限下不该截断");
    await withPref("jsbridge.limit.responseKB", 10, () => {
      const t2 = JSON.parse(call("pack", big)[2]);
      assert.strictEqual(t2.truncated, true, "调小上限后应截断（下限就是 10KB）");
      assert.ok(t2.note.includes("首选项"), "截断提示该告诉用户在哪儿改");
    });
  });

  console.log("\n[9] 生命周期重入");
  const FOREIGN = function () {};
  await t("热重载第二次 startup 后，shutdown 仍还原真正的原件", async () => {
    sandboxGlobals.Zotero.Server.Endpoints["/zoterojs/ping"] = FOREIGN;  // 假装被别的插件占着
    await call("startup", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
    await call("startup", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
    call("shutdown", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
    assert.strictEqual(sandboxGlobals.Zotero.Server.Endpoints["/zoterojs/ping"], FOREIGN,
      "还原成了我们自己的旧副本 —— savedEndpoints 被第二次 startup 覆盖了");
  });
  await t("重复 shutdown 不会误删已还原的端点", () => {
    call("shutdown", { id: "zoterojs-bridge@local", version: man.version, rootURI: "file:///x/" }, 2);
    assert.strictEqual(sandboxGlobals.Zotero.Server.Endpoints["/zoterojs/ping"], FOREIGN);
  });
  await t("其余端点被摘干净", () => {
    assert.deepStrictEqual(Object.keys(sandboxGlobals.Zotero.Server.Endpoints),
      ["/zoterojs/ping"], "除那个假的原件外不该剩东西");
  });
  await t("shutdown 摘掉 Zotero.JSBridge，不留全局垃圾", () => {
    assert.strictEqual(sandboxGlobals.Zotero.JSBridge, undefined);
  });

  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
