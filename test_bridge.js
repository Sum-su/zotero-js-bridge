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
};

const Zotero = {
  version: "10.0.2",
  debug: () => {},
  logError: (e) => { throw e; },
  initializationPromise: Promise.resolve(),
  Libraries: { userLibraryID: 1 },
  DataDirectory: { dir: "C:\\Users\\you\\Zotero" },
  Prefs: {
    get: (k) => prefs.get("extensions.zotero." + k),
    set: (k, v) => prefs.set("extensions.zotero." + k, v),
  },
  Utilities: { randomString: (n) => "T".repeat(n) },
  File: { putContentsAsync: async (p, c) => { tokenWrites.push([p, c]); } },
  Item,
  Collection: class {},
  Items: {
    getByLibraryAndKeyAsync: async (lib, key) => ITEMS[key] || null,
    merge: () => { throw new Error("不该走 deprecated 路径"); },
  },
  Server: { Endpoints: {} },
};

const Services = {
  uuid: { generateUUID: () => ({ toString: () => "{deadbeef-0000-1111-2222-333344445555}" }) },
  scriptSecurityManager: { getSystemPrincipal: () => ({}) },
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
  IOUtils: { writeUTF8: async (p, c) => { tokenWrites.push([p, c]); } },
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
  await t("三个路径都注册上了", () => {
    assert.deepStrictEqual(Object.keys(EP).sort(), ["/zoterojs/exec", "/zoterojs/merge", "/zoterojs/ping"]);
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

  const TOKEN = prefs.get("extensions.zotero.jsbridge.token");
  const H = { "x-zoterojs-token": TOKEN };
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

  console.log("\n[6] shutdown");
  await t("端点被摘干净", () => {
    call("shutdown", { id: "zoterojs-bridge@local", version: "1.0.0", rootURI: "file:///x/" }, 2);
    assert.deepStrictEqual(Object.keys(sandboxGlobals.Zotero.Server.Endpoints), []);
  });

  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
