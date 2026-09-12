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
const saveTxCalls = [];       // 落盘的条目 key —— apply 的 dryRun 就是靠它证明没写
// 回收站是个**独立的集合**，不从 item.deleted 推。合并测试会把一堆条目标成 deleted，
// 拿那个当回收站的话，每个跟回收站有关的断言测的都是别的测试的残留。
const trash = new Set();
const sqlUnmatched = [];      // 没人接的 SQL。有东西进来 = 查询改了而 stub 没跟上
const httpCalls = [];         // 真实会发出去的请求。doctor 默认不该产生任何一条
const prefMisuse = [];        // 拿全长当短名用的 pref 读写。读不到就回落默认值，不会报错

let itemSeq = 100;            // itemID 从 100 起，跟 key 分开，免得两套数字看着像一回事
const TYPE_ID = { journalArticle: 1, book: 2, attachment: 3, note: 4, annotation: 5 };
const TYPE_NAME = { 1: "journalArticle", 2: "book", 3: "attachment", 4: "note", 5: "annotation" };

/* 真实现（item.js:4980-4986）：ID 解析不出来就抛 `Invalid collection '<值>'`。
   照抄的理由和 SQL 守卫一样 —— stub 比真机松，一类错误就永远只在真机上出现。 */
function assertCollectionId(cid) {
  if (!(parseInt(cid) === cid && cid)) {
    throw new Error("Invalid collection '" + cid + "'");
  }
}

// 真机（item.js 的 _setParentKey）：只有这三种类型能有父级。
const CHILD_TYPES = new Set(["note", "attachment", "annotation"]);

class Item {
  constructor(o) {
    // parentItemID 要摘出来单独赋给后备字段：走 setter 的话，**构造**一个本来就是
    // 子条目的对象也会触发「挂父级摘集合」，而真机只在「改成」子条目时才摘。
    const { parentItemID, ...rest } = o;
    Object.assign(this, rest);
    if (this.itemID === undefined) this.itemID = itemSeq++;
    /* 真机的 Item 上 `.id` 和 `.itemID` 是同一个值（item.js 里 `this.id = this.itemID`），
       插件代码两种写法都有。stub 只给 itemID 的话，写成 `.id` 的那处会拿到 undefined
       → getFullText(undefined) 抛错 → 被 catch 成 chars = null ——
       **于是"抽不出来"和"没有文本层"在候选列表里长得一模一样**（都进候选，只差一个
       error 字段）。而这一处恰恰就是"这个 PDF 有没有文本层"的判据，判错了整张候选表就翻。
       （实测：把这一行和 bootstrap 里的 `.itemID` 一起改回去，4 条断言当场转红。） */
    this.id = this.itemID;
    if (this.deleted === undefined) this.deleted = false;
    this._parentItemID = parentItemID === undefined ? null : parentItemID;
    if (this.itemTypeID === undefined) this.itemTypeID = TYPE_ID[this.itemType] ?? 1;
    if (!this.creators) this.creators = [];
  }
  getField(f) { return (this.fields || {})[f] ?? ""; }
  setField(f, v) { (this.fields = this.fields || {})[f] = v; }
  getCreators() { return this.creators || []; }
  setCreators(cs) { this.creators = cs.slice(); }
  setType(tid) {
    this.itemTypeID = tid; this.itemType = TYPE_NAME[tid] || "journalArticle";
    /* ⚠️ 这里**故意不碰 collections**。上一版写的是 `this.collections = []`，
     * 注释还理直气壮：「Zotero 的真实行为：改类型会静默摘掉集合归属」——**那是我编的**。
     *
     * 2026-09-12 在真库上实测：presentation → document → 再改回 presentation，
     * collectionItems 一行没动。读源码也对得上 —— item.js 的 setType 只处理
     * _requireData('itemData') / _requireData('creators')，真正写集合的那段挂在
     * `if (this._changed.collections)` 上，而那个标志只有 setCollections() 会置。
     *
     * 编出来的行为让那条测试**自说自话**：它"证明"的正是我自己写进 stub 的东西。
     * 真会摘集合的是**挂父级**，见下面 parentItemID 的 setter。 */
  }
  getCollections() { return this.collections || []; }
  get parentItemID() { return this._parentItemID ?? null; }
  /* 这条规则在真机上不在 JS 里，而在数据库触发器上：collectionItems 里不许出现
   * 「有父级的条目」（item.js:2056 那句注释点名的就是 collectionItems /
   * itemAttachments / itemNotes 三张表之间的联动）。表现出来就是 ——
   * **设 parentItemID 会静默摘掉该条目的集合归属**。
   *
   * 2026-09-12 在真库上实测：集合 307 里的裸附件 4WWZ44HC 一挂上父级，
   * collectionItems 里那一行当场没了，apply 报出 collectionsLost:[307]。 */
  set parentItemID(v) {
    // 真机实测（同一天）：拿一个 presentation 去挂父级，真机抛这句。
    // 只有 note / attachment / annotation 能有父级 —— 普通条目之间不能互为父子。
    if (v && !CHILD_TYPES.has(this.itemType)) {
      throw new Error("_setParentKey() can only be called on items of type " +
        "'note', 'attachment', or 'annotation'");
    }
    const hadParent = !!this._parentItemID;
    this._parentItemID = v || null;
    if (v && !hadParent) this._pendingTransfer = true;
  }
  getAttachments() { return this.attachments || []; }
  /* 真实现是 `this.itemType === 'attachment'` 的语法糖（item.js）。照着写，
     不另立一套判断 —— 两套迟早会分叉。 */
  isAttachment() { return this.itemType === "attachment"; }
  isNote() { return this.itemType === "note"; }
  /* 批注也得有这一条，否则「全库扫要滤掉批注」那条测试在 stub 里根本没机会跑到 ——
     而真机上它恰恰是最贵的那一步：10030 条批注，每条白跑一次 getAttachments()。
     注意夹具要**显式写 itemType: "annotation"**：上面的 TYPE_ID 是随便定的，
     跟真机对不上（真机是 annotation=1 / attachment=3 / book=7 / note=28，
     这里为了可读性各排各的）—— 所以判据只能走 itemType 字符串，别拿 ID 比。 */
  isAnnotation() { return this.itemType === "annotation"; }
  /* 真实现会解析链接附件和相对路径，拿不到（文件不在本地）时返回 false。
     夹具用 filePath 给出结果；不给就返回 false，走"没有本地文件"那条分支。 */
  getFilePathAsync() { return Promise.resolve(this.filePath || false); }
  /* 真实现（item.js:4975）拿到非数字 ID 会抛 `Invalid collection 'undefined'`，
     这里**照抄那个校验**。抄之前 stub 是来者不拒的，于是"插件传了 undefined"
     在测试里完全看不出来 —— 而这正是真机上 addToCollection 从来没成功过的原因。 */
  addToCollection(cid) {
    assertCollectionId(cid);
    (this.collections = this.collections || []).push(cid);
  }
  removeFromCollection(cid) {
    assertCollectionId(cid);
    this.collections = (this.collections || []).filter(c => c !== cid);
  }
  /* 挂父级的**第二重**副作用，而且落在另一个条目上：Zotero 会把子条目原有的集合归属
   * 整个转给父条目，子条目自己的行再被触发器删掉。真机顺序（item.js:1944-1967 在
   * 2111 那行 UPDATE 之前）是**先转、后删**，两件事都发生在 save 的时候，
   * 所以这里照抄在 saveTx 里，而不是在赋值时就摘 —— 赋值到 save 之间，
   * 子条目在 `collectionItems` 里其实还在。
   *
   * ⚠️ 2026-09-12 在真库上是先踩到才知道的：把集合 307 里的裸附件挂到 X3DGSJ99 名下，
   * **X3DGSJ99 被凭空加进了 307**。父条目那次 save 带 skipDateModifiedUpdate，
   * 父条目的 dateModified 一动不动，事后倒查都查不出来。 */
  saveTx() {
    saveTxCalls.push(this.key);
    if (this._pendingTransfer) {
      this._pendingTransfer = false;
      const par = byItemID(this._parentItemID);
      if (par) {
        for (const cid of (this.collections || [])) {
          if (!(par.collections || []).includes(cid)) {
            (par.collections = par.collections || []).push(cid);
          }
        }
      }
      this.collections = [];   // 触发器 fku_itemAttachments_parentItemID_collectionItems_itemID
    }
    return Promise.resolve();
  }
}

/* ---- enrich 用的附件。先在这里建好，下面的条目才能引用它们的 itemID。
   字符数照着真机量到的量级给：真扫描件是 0 或几十个噪声字符，正常书几万起步，
   中间是空的 —— 所以阈值 1000 不用精细调（prefs.js 里那句注释说的就是这个）。 ---- */
const EN_ATT_SCAN = new Item({ key: "ENATSCAN", itemType: "attachment", itemTypeID: 3,
  attachmentContentType: "application/pdf", attachmentFilename: "计算土力学.pdf",
  filePath: "C:\\Zotero\\storage\\ENATSCAN\\计算土力学.pdf", textChars: 0, indexState: 2 });
const EN_ATT_TEXT = new Item({ key: "ENATTEXT", itemType: "attachment", itemTypeID: 3,
  attachmentContentType: "application/pdf", attachmentFilename: "正常书.pdf",
  filePath: "C:\\Zotero\\storage\\ENATTEXT\\正常书.pdf", textChars: 97248, indexState: 3 });
// 有 23.6 万字符却仍是 PARTIAL —— 这条就是「state 不能当判据」的活证据
const EN_ATT_PARTIAL = new Item({ key: "ENATPART", itemType: "attachment", itemTypeID: 3,
  attachmentContentType: "application/pdf", attachmentFilename: "个别页没字.pdf",
  filePath: "C:\\Zotero\\storage\\ENATPART\\个别页没字.pdf", textChars: 236341, indexState: 2 });
// 非 PDF 不该进候选
const EN_ATT_NONPDF = new Item({ key: "ENATHTML", itemType: "attachment", itemTypeID: 3,
  attachmentContentType: "text/html", attachmentFilename: "网页快照.html" });
// 抽全文时炸了的附件：要如实报出来，不能当成"字符数 0 = 扫描件"
const EN_ATT_BROKEN = new Item({ key: "ENATBROK", itemType: "attachment", itemTypeID: 3,
  attachmentContentType: "application/pdf", attachmentFilename: "坏文件.pdf",
  textError: "file not found" });

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

  /* ---- 下面这批只服务 query / doctor / apply 的测试 ---- */

  // 命中 collection 查询、也用来测「改类型**不**动集合」
  APPTYPE: new Item({ key: "APPTYPE", itemType: "journalArticle", itemTypeID: 1,
    fields: { title: "待改类型的那篇", date: "2020" }, collections: [10] }),
  /* 挂在集合里的**笔记**，用来测「挂父级会静默摘集合」。
   * 用笔记而不是附件：attachmentTitle / duplicateFilenames / orphanStorage 三处都是
   * 按 `attPath`（或 `itemAttachments` 那张表）认附件的，插一个带路径的附件会把
   * 那几条测试的计数一起带偏。笔记不进那三处。
   * 真机实测用的是附件（4WWZ44HC），触发器本身对 itemAttachments / itemNotes 是同一条规则。
   * 每条测试配一个自己的父条目：挂父级会把集合**塞给**父条目，共用一个父条目的话，
   * 第二条测试的前置条件就被第一条改掉了。 */
  APPCHILD: new Item({ key: "APPCHILD", itemType: "note",
    fields: { title: "挂在集合里的一条笔记" }, collections: [10] }),
  APPCHILD2: new Item({ key: "APPCHILD2", itemType: "note",
    fields: { title: "另一条挂在集合里的笔记" }, collections: [10] }),
  APPCHILD3: new Item({ key: "APPCHILD3", itemType: "note",
    fields: { title: "演练用的那条笔记" }, collections: [10] }),
  APPPARENT1: new Item({ key: "APPPARENT1", itemType: "journalArticle",
    fields: { title: "来接盘的父条目一", date: "2014" } }),
  APPPARENT2: new Item({ key: "APPPARENT2", itemType: "journalArticle",
    fields: { title: "来接盘的父条目二", date: "2013" } }),
  APPTITLE: new Item({ key: "APPTITLE", itemType: "journalArticle",
    fields: { title: "旧标题", date: "2019", DOI: "10.1000/dup" }, collections: [10] }),
  // 和 APPTITLE 同 DOI —— duplicates 检查该把它们抓出来
  DUPDOI: new Item({ key: "DUPDOI", itemType: "journalArticle",
    fields: { title: "另一篇同 DOI 的", date: "2019", DOI: "10.1000/dup" }, collections: [11] }),
  APPGUARD: new Item({ key: "APPGUARD", itemType: "journalArticle",
    fields: { title: "标题不是你以为的那个", date: "2018" }, collections: [10] }),
  // 未分类：三条，用来验 unfiled 检查
  UNFILED1: new Item({ key: "UNFILED1", itemType: "journalArticle", fields: { title: "未分类一", date: "2017" } }),
  UNFILED2: new Item({ key: "UNFILED2", itemType: "book", fields: { title: "未分类二", date: "2016" } }),
  // 作者拆分：中文名，fieldMode=1 单字段
  APPCREATOR: new Item({ key: "APPCREATOR", itemType: "journalArticle",
    fields: { title: "讲作者的", date: "2015" }, collections: [10],
    creators: [{ creatorType: "author", fieldMode: 1, lastName: "张三" }] }),
  // 回收站里还在被写的那类：进了回收站，但 dateModified 很近。
  // 它此刻在回收站里 —— 这一点记在下面的 trash 集合里，不从 item.deleted 推。
  TRASHED: new Item({ key: "TRASHED", itemType: "journalArticle", deleted: true,
    fields: { title: "躺在回收站里", date: "2014" }, dateModified: "2026-09-11 03:00:00" }),

  // 附件：标题停在导入器默认值，和标题早已不等于文件名 —— 两种都放进来
  ATT_DEFAULT: new Item({ key: "ATT_DEF1", itemType: "attachment", itemTypeID: 3,
    fields: { title: "Full Text PDF" }, attPath: "storage:fulltext.pdf", parentItemID: 1000 }),
  ATT_OKTITLE: new Item({ key: "ATT_OK1", itemType: "attachment", itemTypeID: 3,
    fields: { title: "paper" }, attPath: "storage:paper.pdf", parentItemID: 1000 }),
  // pdf2zh 那个坑：同一父条目下两个完全同名的附件。
  // path 的真实形状是 `storage:<文件名>`，**不带目录 key**（1380 条实测过），
  // 目录名是附件自己的 8 位 key —— 所以「同名」就是这一段的字符串相等。
  ATT_DUP_A: new Item({ key: "ATT_DUPA", itemType: "attachment", itemTypeID: 3,
    fields: { title: "作者 - 年 - 标题.pdf" }, attPath: "storage:作者 - 年 - 标题.pdf", parentItemID: 1001 }),
  ATT_DUP_B: new Item({ key: "ATT_DUPB", itemType: "attachment", itemTypeID: 3,
    fields: { title: "作者 - 年 - 标题.pdf" }, attPath: "storage:作者 - 年 - 标题.pdf", parentItemID: 1001 }),

  /* ---- enrich 的夹具。每一条都对应 2026-09-12 真机跑出来的一个案例 ---- */

  EN_ATT_SCAN, EN_ATT_TEXT, EN_ATT_PARTIAL, EN_ATT_NONPDF, EN_ATT_BROKEN,

  // 正常补全：扫描书缺 publisher / date / ISBN / creators，视觉读到了封面 + 版权页
  EN_BOOK: new Item({ key: "EN_BOOK", itemType: "book",
    fields: { title: "计算土力学" }, attachments: [EN_ATT_SCAN.itemID] }),
  // 库里标题**更全**：视觉那张扉页只印了主标题，跟视觉会把副标题截掉
  EN_LONGTITLE: new Item({ key: "EN_LONGT", itemType: "book",
    fields: { title: "从抛物线谈起：混沌动力学引论" } }),
  // 抽出来的**更全**：这条才该写（extend）
  EN_SHORTTITLE: new Item({ key: "EN_SHORT", itemType: "book",
    fields: { title: "从抛物线谈起" } }),
  /* 82L9PCBI：期刊论文，视觉读的是它参考文献里那本书。
     三道闸里**只有闸三拦得住** —— 闸二也能过，因为文章标题
     《对〈弹性力学简明教程〉中一处内容的商榷》里确实含「弹性力学简明教程」。 */
  EN_HALLU_REF: new Item({ key: "EN_HALLU", itemType: "journalArticle",
    fields: { title: "对《弹性力学简明教程》中一处内容的商榷", date: "2009" } }),
  // H2GCDM5B：出版社是从前言的一句致谢里抠的，页类型只有正文/目录 —— 闸一拦
  EN_HALLU_ACK: new Item({ key: "EN_HALLUA", itemType: "book",
    fields: { title: "数学物理方程的matlab解法与可视化" } }),
  // 两边都有值且不同 —— 挂起，不写
  EN_CONFLICT: new Item({ key: "EN_CONF", itemType: "book",
    fields: { title: "土的本构关系", ISBN: "978-7-114-14996-2" } }),
  // 影印本 vs 原版的版次分歧：库里 "原书2"，视觉读出 "第1版"
  EN_EDITION: new Item({ key: "EN_EDIT", itemType: "book",
    fields: { title: "利用Python进行数据分析", edition: "原书2" } }),
  // creators 库里已经有了，就不动
  EN_HASCREATOR: new Item({ key: "EN_HASCR", itemType: "book",
    fields: { title: "已经有作者的书" },
    creators: [{ creatorType: "author", fieldMode: 1, lastName: "张三" }] }),
  // series 只列不写
  EN_SERIES: new Item({ key: "EN_SERI", itemType: "book",
    fields: { title: "带丛书的书" } }),
  // 学位论文：视觉抽到的那个"出版社"其实是学位授予单位 → 映射到 university
  EN_THESIS: new Item({ key: "EN_THES", itemType: "thesis",
    fields: { title: "某篇学位论文" } }),
  // 字段已经齐了 —— 不该进候选。它身上挂的是**正常有文本层**的 PDF（EN_ATT_TEXT），
  // 于是顺带钉住粗筛：scan=1 全库扫时，这个附件该被 getIndexedState 挡在 getFullText 之前，
  // 而不是白白抽一遍全文再发现「有字」。
  EN_COMPLETE: new Item({ key: "EN_CMPL", itemType: "book",
    fields: { title: "什么都不缺的书", publisher: "某社", date: "2020", ISBN: "978-0-00-000000-0" },
    creators: [{ creatorType: "author", fieldMode: 1, lastName: "李四" }],
    attachments: [EN_ATT_TEXT.itemID] }),
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
  // 照真实实现来：Zotero.Prefs.get(pref, global) 在 !global 时自己补 extensions.zotero. 前缀，
  // global 时把 pref 当全长直接查。两边的名字一旦用混，读到的就是另一把 key —— 而 prefBool/prefInt
  // 在 key 不存在时会回落默认值，于是"开关没生效"和"开关本来就是关的"长得一模一样。
  // 所以这里把用混的名字记下来，末尾由 [8.9] 那条断言兜住（和 LIKE 守卫是同一个套路）。
  Prefs: {
    get: (k, global) => {
      if (!global && String(k).startsWith("extensions.")) prefMisuse.push(["get", k]);
      return prefs.get(global ? k : "extensions.zotero." + k);
    },
    set: (k, v, global) => {
      if (!global && String(k).startsWith("extensions.")) prefMisuse.push(["set", k]);
      return prefs.set(global ? k : "extensions.zotero." + k, v);
    },
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
  ItemTypes: {
    getID: (n) => TYPE_ID[n] ?? false,
    getName: (id) => TYPE_NAME[id] || "",
  },
  ItemFields: {
    // 只认测试里真的用到的字段。返回 false 是 Zotero 的"没这个字段"约定
    getID: (n) => ({ title: 1, DOI: 2, ISBN: 3, date: 4, abstractNote: 5, publicationTitle: 6 }[n] ?? false),
  },
  Collections: {
    getByLibraryAndKey: (lib, key) => COLLECTIONS.find(c => c.key === key) || null,
  },
  Items: {
    /* 认的是 item.key，**不是对象属性名** —— 真机的 getByLibraryAndKey 就是按 key 查的。
       之前写成 `ITEMS[key]`，于是夹具的属性名和 key 一旦不一致就静默查不到，
       表现是端点上那句"条目不存在"，而不是抛错，很难看出是 stub 的问题。 */
    getByLibraryAndKeyAsync: async (lib, key) => byItemKey(key),
    getAsync: async (ids) => (ids || []).map(id => byItemID(id)),
    get: (id) => byItemID(id),
    // 签名照真实现：(libraryID, onlyTopLevel, includeDeleted, asIDs)
    getAll: (lib, onlyTopLevel, includeDeleted, asIDs) => {
      let all = Object.values(ITEMS).filter(i => includeDeleted || !i.deleted);
      if (onlyTopLevel) all = all.filter(i => !i.parentItemID);
      return asIDs ? all.map(i => i.itemID) : all;
    },
    merge: () => { throw new Error("不该走 deprecated 路径"); },
  },
  /* 全文索引状态的替身。真实分布（2026-09-12 实测 1235 个 PDF）：
     INDEXED 1035 / PARTIAL 173 / UNINDEXED 27。
     ⚠️ PARTIAL **不是"扫描件"的意思** —— 实测 23NZF8PY（10.0 万字符）与
     27RCEEVC（29.7 万字符）都是 PARTIAL，只因个别页没字；而 2J4LLG6Q（0 字符）
     和 4BY9B5LC（0 字符）同为纯扫描件，一个判 UNINDEXED 一个判 PARTIAL。
     所以找候选的判据用 PDFWorker.getFullText 的字符数，**不用这里的 state**。 */
  Fulltext: {
    INDEX_STATE_UNAVAILABLE: 0, INDEX_STATE_UNINDEXED: 1, INDEX_STATE_PARTIAL: 2,
    INDEX_STATE_INDEXED: 3, INDEX_STATE_QUEUED: 4,
    getIndexedState: async (a) => (a.indexState === undefined ? 3 : a.indexState),
  },
  // getFullText 的替身：夹具给 textChars（字符数）或 textError（抛错）
  PDFWorker: {
    getFullText: async (id) => {
      const a = byItemID(id);
      if (!a) throw new Error("no such item: " + id);
      if (a.textError) throw new Error(a.textError);
      return { text: "字".repeat(a.textChars === undefined ? 50000 : a.textChars) };
    },
  },
  Attachments: {
    // 真实现返回 nsIFile；被测代码只读 .path，给个带 path 的替身就够
    getStorageDirectory: (a) => ({ path: "C:\\Zotero\\storage\\" + a.key }),
  },
  Server: { Endpoints: {} },
  DB: {
    queryAsync: async (sql, args) => dispatch(sql, args, "rows"),
    columnQueryAsync: async (sql, args) => dispatch(sql, args, "column"),
    valueQueryAsync: async (sql, args) => dispatch(sql, args, "value"),
  },
  // 条件表照抄 searchConditions.js 里真实存在的那几项，不是编的。
  // 被测代码会拿它做白名单校验，所以 stub 里多一项少一项都会改变结论。
  SearchConditions: {
    _c: {
      title: ["is", "isNot", "contains", "doesNotContain", "beginsWith", "isEmpty", "isNotEmpty"],
      DOI: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty"],
      ISBN: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty"],
      creator: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty"],
      collection: ["is", "isNot"],
      tag: ["is", "isNot", "contains", "doesNotContain"],
      itemType: ["is", "isNot"],
      unfiled: ["true", "false"],
      date: ["is", "isNot", "isBefore", "isAfter", "isInTheLast", "isEmpty", "isNotEmpty"],
      year: ["is", "isNot", "isBefore", "isAfter", "isInTheLast"],
      anyField: ["contains", "doesNotContain", "isEmpty", "isNotEmpty"],
      titleCreatorYear: ["contains", "doesNotContain", "isEmpty", "isNotEmpty"],
      fulltextContent: ["contains", "doesNotContain"],
      key: ["is", "isNot", "beginsWith"],
      publicationTitle: ["is", "isNot", "contains", "doesNotContain"],
      abstractNote: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty"],
    },
    get(name) {
      const ops = this._c[name];
      if (!ops) return undefined;      // 真实实现就是 _conditions[name] 的直查，不认识返回 undefined
      return { name, operators: ops.reduce((o, k) => (o[k] = true, o), {}) };
    },
    hasOperator: (name, op) => {
      const c = Zotero.SearchConditions.get(name);
      return !!(c && c.operators[op]);
    },
  },
  Users: { getCurrentUserID: () => 10329789 },
  Sync: { Data: { Local: {
    getLastSyncTime: async () => new Date("2026-09-12T01:00:00Z"),
    getAPIKey: async () => "K".repeat(24),
    _libraryHasUnsyncedData: async () => false,
  } } },
  HTTP: {
    request: async (method, url, opts) => {
      httpCalls.push(url);
      return { getResponseHeader: (h) => (h === "Last-Modified-Version" ? "187176" : null), response: null };
    },
  },
};

// ---- 给 SQL 用的假数据 ----
trash.add("TRASHED");         // 起点：回收站里就这一条

/* ⚠️ 形状必须照真对象来：Zotero 的 Collection 上是 `.id` / `.name`，
   `collectionID` / `collectionName` **只是数据库列名**。2026-09-12 之前这里写的是后者，
   于是插件的 `c.collectionID` 在 stub 里读得到、在真机上永远是 undefined ——
   真机实测 `item.addToCollection(undefined)` 直接抛 `Invalid collection 'undefined'`，
   而测试全绿。**stub 的形状错了，测试就只是在自我印证。** */
const COLLECTIONS = [
  { id: 10, key: "COLAAAAA", name: "博士课题" },
  { id: 11, key: "COLBBBBB", name: "图书馆" },
];

const byItemID = (id) =>
  Object.values(ITEMS).find(it => it.itemID === Number(id)) || null;
const byItemKey = (key) =>
  Object.values(ITEMS).find(it => it.key === String(key)) || null;

function collectionsOfItem(itemID) {
  const it = byItemID(itemID);
  return it ? (it.collections || []).map(c => (typeof c === "string" ? colID(c) : c)) : [];
}
const colID = (key) => (COLLECTIONS.find(c => c.key === key) || {}).id;
// 注意这里是**两个名字空间**：内存里的对象用 `.id` / `.name`（Zotero 对象），
// SQL 返回的行用 `collectionID` / `collectionName`（数据库列）。真机上就是这样分开的，
// 混起来写就会得出「对象上也有 collectionID」这种结论。这个函数负责 id → 数据库列名那半边。
const colRow = (id) => {
  const c = COLLECTIONS.find(c => c.id === Number(id)) || {};
  return { collectionID: c.id, collectionName: c.name, key: c.key };
};

/* SQL 派发。**按语句的关键特征匹配，不解析 SQL** —— 目的是让被测代码真的走一遍
   取数的路，而不是让 stub 假装会 SQL。匹配不上的一律记进 sqlUnmatched，
   测试末尾断言它是空的：查询改了而这里没跟上，会当场红，而不是悄悄返回空。 */
function dispatch(sql, args, mode) {
  const s = sql.replace(/\s+/g, " ").trim();
  const pick = (rows, col) =>
    mode === "rows" ? rows : mode === "column" ? rows.map(r => Object.values(r)[0]) : rows;

  // Zotero 自己的 SQL 守卫：LIKE 后面的模式必须走绑定。
  // 这条**必须照抄** —— 不抄的话，一条能被 stub 收下的字面量 LIKE 在真机上会当场报错，
  // 而测试全绿。（这次就是：两个附件检查都写了 `LIKE 'storage:%'`，stub 毫无反应。）
  //
  // 正则逐字取自真源码（Firefox 的 modules/Sqlite.sys.mjs，不是 Zotero 自己的代码）：
  //     var likeSqlRegex = /\bLIKE\b\s(?![@:?])/i;
  // 语义是「LIKE 后面跟空白，且再下一个字符不是 @ : ?」——也就是只认 LIKE ? / LIKE :n / LIKE @n。
  // 比只挡引号更严：`LIKE 列名`、`LIKE (子查询)` 一样会被拒。
  //
  // ⚠️ 这条守卫**是无条件的**，跟传不传 params 无关 —— 这里是 2026-09-12 改对的一次。
  // 原先写的是 `args !== undefined && …`，注释里还写着「守卫只在传了 params 时才跑」，
  // 依据是 `execute(sql, params = null, …)` 的默认值 —— 那是**读源码推的，没跑过**。
  // 真机实测：不传第二参照样抛 `Please enter a LIKE clause with bindings`
  // （queryAsync / valueQueryAsync / columnQueryAsync / executeTransaction 都拦）。
  // 留着这个 `args !== undefined` 的后果是：stub 对"不传参的字面量 LIKE"放行，
  // 而真机抛 —— 正是这条守卫当初加进 stub 要防的那种假绿。
  if (/\bLIKE\b\s(?![@:?])/i.test(s)) {
    throw new Error("Please enter a LIKE clause with bindings");
  }

  // VACUUM INTO 是 SQLite 的语句，走的是同一条 queryAsync。
  // 「目标已存在就报错拒写」是实测行为，照抄 —— 撞名静默盖掉上一份备份是不能接受的。
  if (/^VACUUM INTO \?$/.test(s)) {
    const name = basename(args[0]);
    if (vacuumFails) throw new Error(vacuumFails);
    if (backupFiles.includes(name)) throw new Error("output file already exists");
    backupFiles.push(name);
    backupSizes[name] = 52496032;
    return mode === "rows" ? [] : null;
  }
  // collectionItems ⋈ collections
  if (/FROM collectionItems ci JOIN collections c/.test(s)) {
    const ids = (args || []).map(Number);
    const rows = [];
    for (const id of ids) {
      for (const cid of collectionsOfItem(id)) {
        const c = colRow(cid);
        if (c.collectionID) rows.push({ itemID: id, cid, name: c.collectionName, ckey: c.key });
      }
    }
    return pick(rows);
  }
  // apply 的集合差分读的就是这一条
  if (/^SELECT collectionID FROM collectionItems WHERE itemID=\?$/.test(s)) {
    return mode === "value" ? collectionsOfItem(args[0])[0] : collectionsOfItem(args[0]);
  }
  // 回收站。deleteLog 那张表在 Zotero 10 里**不存在**（实测 no such table），
  // 权威记录就是 deletedItems
  if (/^SELECT COUNT\(\*\) FROM deletedItems$/.test(s)) return trash.size;
  if (/FROM items i WHERE i.itemID IN \(SELECT itemID FROM deletedItems\)/.test(s)) {
    return pick(Object.values(ITEMS)
      .filter(it => trash.has(it.key) && (it.dateModified || "") >= args[0])
      .map(it => ({ itemID: it.itemID, key: it.key, dateModified: it.dateModified })));
  }
  if (/SELECT key FROM items WHERE itemID IN \(SELECT itemID FROM itemAttachments\)/.test(s)) {
    return Object.values(ITEMS)
      .filter(it => it.itemType === "attachment" && (it.attPath || "").startsWith("storage:"))
      .map(it => it.key);
  }
  // 两条附件查询靠 SELECT 列表区分：同名文件那条取 parentItemID，标题那条取 idv.value
  if (/SELECT ia\.parentItemID AS parent/.test(s)) {
    return pick(Object.values(ITEMS)
      .filter(it => it.itemType === "attachment" && it.parentItemID && it.attPath)
      .map(it => ({ parent: it.parentItemID, path: it.attPath, key: it.key })));
  }
  if (/SELECT i\.itemID AS itemID, i\.key AS key, idv\.value AS title/.test(s)) {
    return pick(Object.values(ITEMS)
      .filter(it => it.itemType === "attachment" && it.attPath)
      .map(it => ({ itemID: it.itemID, key: it.key, title: it.getField("title"), path: it.attPath })));
  }
  if (/SELECT idv.value AS v, COUNT\(\*\) AS n/.test(s)) {
    const field = args[0] === 2 ? "DOI" : "ISBN";
    const counts = {};
    for (const it of Object.values(ITEMS)) {
      // 查询里有 `NOT IN (SELECT itemID FROM deletedItems)`，回收站里的一律不算
      if (trash.has(it.key) || it.itemType === "attachment" || it.itemType === "note") continue;
      const v = it.getField(field);
      if (v) counts[v] = (counts[v] || 0) + 1;
    }
    return pick(Object.entries(counts).filter(([, n]) => n > 1).map(([v, n]) => ({ v, n })));
  }
  if (/^SELECT id.itemID FROM itemData id/.test(s)) {
    const field = args[0] === 2 ? "DOI" : "ISBN";
    return Object.values(ITEMS).filter(it => it.getField(field) === args[1]).map(it => it.itemID);
  }
  if (/^SELECT MAX\(version\) FROM syncCache$/.test(s)) return syncCacheMax;

  sqlUnmatched.push(s);
  return mode === "rows" ? [] : mode === "value" ? null : [];
}
let syncCacheMax = 187176;

/* ---- 备份 / 体检 用的假文件系统 ---- */
const BACKUP_SUBDIR = "jsbridge-backups";
const backupFiles = [];        // 备份目录里现有的文件名
const backupSizes = {};        // 文件名 → 字节
const removedBackups = [];     // 轮转删掉的
let backupDirExists = false;   // 一开始不存在，第一次备份才建
let vacuumFails = null;        // 设成字符串 → VACUUM INTO 抛这个错
// storage/ 下的目录名。第一个是 ATT_DEF1 的 key —— 它在用，不该被算成孤儿
let storageDirs = ["ATT_DEF1", "ZZZZZZZZ", "YYYYYYYY"];
const basename = (p) => String(p).split(/[\\/]/).pop();

/* ---- Zotero.Search 的替身 ---- */
const searchCalls = [];        // 每次 search 的条件，用来断言端点确实传对了
function matchCond(it, f, o, v) {
  if (f === "unfiled") return (it.collections || []).length === 0;
  if (f === "itemType") return it.itemType === String(v);
  if (f === "collection") return (it.collections || []).map(String).includes(String(v));
  if (f === "tag") return (it.tags || []).includes(String(v));
  if (f === "key") return it.key === String(v);
  const cur = String(it.getField(f === "titleCreatorYear" || f === "anyField" ? "title" : f) || "");
  const want = String(v);
  if (o === "is") return cur === want;
  if (o === "isNot") return cur !== want;
  if (o === "contains") return cur.toLowerCase().includes(want.toLowerCase());
  if (o === "doesNotContain") return !cur.toLowerCase().includes(want.toLowerCase());
  return false;   // 其余算符现在用不到。真要用到再加，不假装支持
}
Zotero.Search = class {
  constructor() { this.conditions = []; this.libraryID = null; }
  // 实测：addCondition 会把不传的 value 归一成 null（unfiled 这种算符即值的条件
  // 根本不用 value，传 true 和传 null 跑出来一模一样）。照抄这个归一化。
  addCondition(f, o, v) { this.conditions.push([f, o, v === undefined ? null : v]); }
  async search() {
    searchCalls.push(this.conditions.map(c => c.slice()));
    return Object.values(ITEMS)
      .filter(it => ["attachment", "note", "annotation"].indexOf(it.itemType) < 0)
      .filter(it => this.conditions.every(([f, o, v]) => matchCond(it, f, o, v)))
      .map(it => it.itemID);
  }
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
    // 合并的 dup 进回收站 —— 真实的 mergeItems 就是这么做的，
    // 往 deletedItems 里落一笔（不是只把 item.deleted 标一下）
    return { mergeItems: (master, dups) => { merged.push([master.key, dups.map(d => d.key)]); dups.forEach(d => { d.deleted = true; trash.add(d.key); }); } };
  },
};

const sandboxGlobals = {
  Zotero, Services, Components, ChromeUtils,
  PathUtils: {
    join: (...a) => a.join("\\"),
    filename: (p) => String(p).split(/[\\/]/).pop(),
  },
  IOUtils: {
    writeUTF8: async (p, c) => { tokenWrites.push([p, c]); },
    // token 文件用 tokenFileOnDisk 控制；备份文件查真的那个列表
    exists: async (p) => (String(p).includes("zoterojs-token")
      ? tokenFileOnDisk : backupFiles.includes(basename(p))),
    // 目录不存在就抛 —— 真实 IOUtils.getChildren 就是抛，listBackups 的 catch 靠它
    getChildren: async (dir) => {
      if (basename(dir) === BACKUP_SUBDIR) {
        if (!backupDirExists) throw new Error("NS_ERROR_FILE_NOT_FOUND");
        return backupFiles.map(f => dir + "\\" + f);
      }
      if (basename(dir) === "storage") return storageDirs.map(d => dir + "\\" + d);
      throw new Error("NS_ERROR_FILE_NOT_FOUND");
    },
    makeDirectory: async () => { backupDirExists = true; },
    remove: async (p) => {
      const i = backupFiles.indexOf(basename(p));
      if (i < 0) throw new Error("NS_ERROR_FILE_NOT_FOUND");
      backupFiles.splice(i, 1);
      removedBackups.push(basename(p));
    },
    stat: async (p) => ({ size: backupSizes[basename(p)] ?? 0 }),
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
  await t("八个路径都注册上了", () => {
    assert.deepStrictEqual(Object.keys(EP).sort(),
      ["/zoterojs/apply", "/zoterojs/doctor", "/zoterojs/enrich", "/zoterojs/exec",
        "/zoterojs/logs", "/zoterojs/merge", "/zoterojs/ping", "/zoterojs/query"]);
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
    for (const id of ["jsb-token", "jsb-status", "jsb-copy", "jsb-regen", "jsb-rewrite", "jsb-check",
      "jsb-backup"]) {
      assert.ok(x.includes(`id="${id}"`), `面板里没有 ${id}，按钮点了会报错`);
    }
  });
  await t("面板每个 preference= 都在 prefs.js 里有默认值", () => {
    // 先剥掉 XML 注释 —— 注释里那句 preference="..." 是说明文字，不是绑定
    const x = fs.readFileSync(path.join(ADDON, "prefs.xhtml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    // 十三个可调参数：总开关、只读、八个端点、响应上限、备份开关与保留份数。
    // token 不在其中 —— 那个框是只读展示，由 JSBridge.refreshTokenView 填，不走 preference 绑定。
    // enrich 的 minChars 也不在：它没做成面板控件（改的人先得知道自己在改什么），
    // 只由 prefs.js 给默认值，需要时用 about:config 调。
    const WANT = [
      "extensions.zotero.jsbridge.enabled",
      "extensions.zotero.jsbridge.readonly",
      "extensions.zotero.jsbridge.endpoint.ping",
      "extensions.zotero.jsbridge.endpoint.exec",
      "extensions.zotero.jsbridge.endpoint.merge",
      "extensions.zotero.jsbridge.endpoint.logs",
      "extensions.zotero.jsbridge.endpoint.query",
      "extensions.zotero.jsbridge.endpoint.doctor",
      "extensions.zotero.jsbridge.endpoint.apply",
      "extensions.zotero.jsbridge.endpoint.enrich",
      "extensions.zotero.jsbridge.limit.responseKB",
      "extensions.zotero.jsbridge.backup.enabled",
      "extensions.zotero.jsbridge.backup.keep",
    ];
    const want = [...x.matchAll(/preference="([^"]+)"/g)].map(m => m[1]);
    // 用「集合相等」而不是「不少于 N 个」：少绑一个和少绑另一个是两种不同的漏，
    // 数个数看不出来；多绑了一个不存在的 pref 也要挡住。
    assert.deepStrictEqual([...want].sort(), [...WANT].sort(), "面板绑的参数和预期对不上");
    const declared = new Set([...fs.readFileSync(path.join(ADDON, "prefs.js"), "utf8")
      .matchAll(/pref\("([^"]+)"/g)].map(m => m[1]));
    for (const k of WANT) assert.ok(declared.has(k), `prefs.js 没给默认值: ${k}`);
  });
  await t("插件读的每个 pref 都在 prefs.js 里有默认值", () => {
    // pref 名字打错一个字，读到的就是 undefined，而 prefBool/prefInt 会安静地回落默认值 ——
    // 于是「开关没生效」和「开关本来就是这个值」在运行时分不出来。静态对一遍最省事。
    const boot = fs.readFileSync(SRC, "utf8");
    const declared = new Set([...fs.readFileSync(path.join(ADDON, "prefs.js"), "utf8")
      .matchAll(/pref\("([^"]+)"/g)].map(m => m[1]));
    const names = [
      ...[...boot.matchAll(/^const PREF_[A-Z_]+ = "([^"]+)"/gm)].map(m => m[1]),
      ...[...boot.matchAll(/"(\/zoterojs\/[a-z]+)": "([^"]+)"/g)].map(m => m[2]),
    ];
    assert.ok(names.length >= 12, `只抽出 ${names.length} 个 pref 名，正则八成没跟上`);
    for (const n of names) {
      assert.ok(declared.has("extensions.zotero." + n),
        `插件读 ${n}，但 prefs.js 里没声明 —— 读到的永远是默认值`);
    }
  });
  await t("Zotero.JSBridge 暴露给面板，函数齐全", () => {
    assert.ok(pane(), "没挂上 —— 面板上每个按钮都会报错");
    for (const f of ["refreshTokenView", "copyToken", "regenerateToken", "rewriteTokenFile",
      "selfCheck", "backupNow"]) {
      assert.strictEqual(typeof pane()[f], "function", `缺 ${f}`);
    }
  });
  await t("自检报出八个端点、总开关、只读、token 文件和备份状态", async () => {
    const doc = fakeDoc();
    await pane().selfCheck(doc);
    const out = doc.els["jsb-status"].textContent;
    assert.ok(out.includes(man.version), out);
    for (const p of Object.keys(EP)) {
      assert.ok(out.includes(p), `自检没提 ${p}: ${out}`);
    }
    assert.ok(out.includes("token 文件"), out);
    assert.ok(out.includes("备份"), "自检该报出备份状态（自动备份是个开了就忘的开关）");
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

  await t("总开关关掉 → 八个端点全 503，且说得出是哪个开关", () =>
    withPref("jsbridge.enabled", false, async () => {
      for (const p of Object.keys(EP)) {
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
  await t("只读模式：exec/merge/apply 403，读的口子（logs/query/doctor）照常", () =>
    withPref("jsbridge.readonly", true, async () => {
      assert.strictEqual((await epCall("/zoterojs/exec",
        { headers: H, data: { code: "return 1" } }))[0], 403);
      assert.strictEqual((await epCall("/zoterojs/merge",
        { headers: H, data: { master: "MASTER01", dups: ["DUPGOOD"] } }))[0], 403);
      // dry-run 也算写：把写入口整个关掉的人不该看到这个端点还通着
      const dry = await epCall("/zoterojs/apply",
        { headers: H, data: { dryRun: true, ops: [{ item: "APPTITLE", set: { title: "x" } }] } });
      assert.strictEqual(dry[0], 403, "apply 的 dry-run 也走写闸门");
      const read = await epCall("/zoterojs/logs", { headers: H, data: null,
        searchParams: new URLSearchParams("source=console&limit=5") });
      assert.strictEqual(read[0], 200, "读日志是只读的，不该被拦");
      const clear = await epCall("/zoterojs/logs", { headers: H, data: null,
        searchParams: new URLSearchParams("source=console&clear=1") });
      assert.strictEqual(clear[0], 403, "clear 是破坏性的，只读模式该拦");
      assert.strictEqual((await epCall("/zoterojs/query",
        { headers: H, searchParams: new URLSearchParams("title=某篇论文") }))[0], 200);
      assert.strictEqual((await epCall("/zoterojs/doctor", { headers: H }))[0], 200);
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

  console.log("\n[8.5] query —— 结构化只读查询");
  await t("query 要 token（读的口子也是口子）", async () => {
    const r = await epCall("/zoterojs/query", { headers: BADH,
      searchParams: new URLSearchParams("title=x") });
    assert.strictEqual(r[0], 403);
  });
  await t("title 简写 → Zotero.Search 的 title / contains", async () => {
    searchCalls.length = 0;
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=某篇论文") });
    assert.strictEqual(r[0], 200, r[2]);
    assert.deepStrictEqual(searchCalls[0], [["title", "contains", "某篇论文"]]);
    const body = JSON.parse(r[2]);
    // MASTER01 / DUPGOOD / DUPINTASH 三条都叫「某篇论文」，三条都该回来
    assert.strictEqual(body.total, 3);
    assert.ok(body.items.every(i => i.key), "每条都该带 key，否则没法喂给 merge/apply");
  });
  await t("不给任何条件 → 400，并说清要给什么", async () => {
    const r = await epCall("/zoterojs/query", { headers: H });
    assert.strictEqual(r[0], 400);
    assert.ok(/至少要有一个/.test(JSON.parse(r[2]).error));
  });
  await t("未知条件 / 未知算符 → 400，把可选的面列出来（不猜）", async () => {
    const bad1 = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("where=" + JSON.stringify([{ field: "不存在的字段", op: "is", value: "x" }])) });
    assert.strictEqual(bad1[0], 400);
    assert.ok(/未知条件/.test(JSON.parse(bad1[2]).error));
    const bad2 = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("where=" + JSON.stringify([{ field: "unfiled", op: "contains", value: "x" }])) });
    assert.strictEqual(bad2[0], 400);
    // 列出可用算符比说一句"非法"有用得多 —— 用户是被这个拒绝的，得知道改成什么
    assert.ok(/可用：/.test(JSON.parse(bad2[2]).error), JSON.parse(bad2[2]).error);
  });
  await t("unfiled 用官方条件，不自己写 SQL 定义", async () => {
    searchCalls.length = 0;
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("unfiled=true") });
    assert.deepStrictEqual(searchCalls[0], [["unfiled", "true", true]],
      "该把工作交给 Zotero.Search，而不是自己写「id NOT IN (SELECT ...)」");
    const keys = JSON.parse(r[2]).items.map(i => i.key);
    assert.ok(keys.includes("UNFILED1") && keys.includes("UNFILED2"), keys.join());
  });
  await t("GET 传进来的结构化参数会被解出来（curl / zoterojs.py 都是 GET）", async () => {
    // readParams 拿到的一律是字符串。不解的话 where=[{...}] 这种参数用 GET 永远传不进来，
    // 而 POST 能用的东西 GET 用不了，是最容易在文档里写错的那种不一致。
    searchCalls.length = 0;
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("where=" +
        JSON.stringify([{ field: "itemType", op: "is", value: "book" }])) });
    assert.strictEqual(r[0], 200, r[2]);
    assert.deepStrictEqual(searchCalls[0], [["itemType", "is", "book"]]);
  });
  await t("长得像结构但解析不出来的，原样当字符串，不吞掉", async () => {
    // "[未完成的" 以 [ 开头但 JSON.parse 会抛。抛了就原样传下去 ——
    // 静默把它丢掉的话，用户看到的是"零结果"，而不是"你的参数写错了"
    searchCalls.length = 0;
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=" + encodeURIComponent("[未完成的")) });
    assert.strictEqual(r[0], 200, r[2]);
    assert.deepStrictEqual(searchCalls[0], [["title", "contains", "[未完成的"]]);
  });
  await t("fields / checks 也吃逗号分隔（命令行里好敲）", async () => {
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=待改类型的那篇&fields=DOI,ISBN") });
    const it = JSON.parse(r[2]).items[0];
    assert.ok("DOI" in it && "ISBN" in it, JSON.stringify(it));
  });
  await t("limit 截断时给出 omitted，别让人以为这就是全部", async () => {
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=某篇论文&limit=1") });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.returned, 1);
    assert.strictEqual(b.omitted, b.total - 1);
    assert.ok(b.hint.includes("key"), "要告诉用户 key 在哪、能拿去干什么");
  });
  await t("exclude 掉集合字段：includeCollections=false 时不去查 collectionItems", async () => {
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=某篇论文&includeCollections=false") });
    const b = JSON.parse(r[2]);
    assert.ok(b.items.every(i => i.collections === undefined), "明确说了不要还去查，是白花一次查询");
  });
  await t("集合归属按名字给出，不是一串 collectionID", async () => {
    const r = await epCall("/zoterojs/query", { headers: H,
      searchParams: new URLSearchParams("title=待改类型的那篇") });
    const it = JSON.parse(r[2]).items[0];
    assert.deepStrictEqual(it.collections, [{ key: "COLAAAAA", name: "博士课题" }]);
  });

  console.log("\n[8.6] doctor —— 库体检（只读）");
  await t("doctor 默认**不联网**：sync 要连 zotero.org，得点名要", async () => {
    httpCalls.length = 0;
    const r = await epCall("/zoterojs/doctor", { headers: H });
    const b = JSON.parse(r[2]);
    assert.strictEqual(r[0], 200, r[2]);
    assert.ok(b.ran.indexOf("sync") < 0, "默认跑了 sync —— 等于点一下体检就往外发请求");
    assert.strictEqual(httpCalls.length, 0, "默认路径发出了网络请求");
    assert.ok(b.note.includes("sync"), "得告诉用户 sync 是要单独点的");
  });
  await t("checkSync 真的会去问服务器，并且拿得到 Last-Modified-Version", async () => {
    httpCalls.length = 0;
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=" + JSON.stringify(["sync"])) });
    const s = JSON.parse(r[2]).checks.sync;
    assert.strictEqual(httpCalls.length, 1, "该发且只发一个请求");
    assert.ok(httpCalls[0].includes("/users/10329789/items"), httpCalls[0]);
    assert.strictEqual(s.serverVersion, 187176);
    assert.strictEqual(s.inSync, true, "本机与服务器都是 187176，该判为一致");
  });
  await t("本机版本落后时 sync 说得清是谁新谁旧", async () => {
    syncCacheMax = 187100;
    try {
      const r = await epCall("/zoterojs/doctor", { headers: H,
        searchParams: new URLSearchParams("checks=" + JSON.stringify(["sync"])) });
      const s = JSON.parse(r[2]).checks.sync;
      assert.strictEqual(s.inSync, false);
      assert.ok(s.note.includes("没下全"), s.note);
    } finally { syncCacheMax = 187176; }
  });
  await t("未知检查项 → 400 并列出可用的（不是静默忽略）", async () => {
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=" + JSON.stringify(["sync", "乱写的"])) });
    assert.strictEqual(r[0], 400);
    assert.ok(JSON.parse(r[2]).error.includes("乱写的"));
  });
  await t("unfiled 检查走 Zotero 官方条件，不自己写 SQL 定义未分类", async () => {
    searchCalls.length = 0;
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=unfiled") });
    // 自己写 `itemID NOT IN (SELECT collectionID FROM collectionItems)` 有两个坑：
    // 批注是独立 itemType 会被算进来，回收站里的也算。官方条件两个都处理了。
    // doctor 这边不传 value（unfiled 用不着），归一化后是 null
    assert.deepStrictEqual(searchCalls[0], [["unfiled", "true", null]]);
    const keys = JSON.parse(r[2]).checks.unfiled.sample.map(s => s.key);
    assert.ok(keys.includes("UNFILED1") && keys.includes("UNFILED2"), keys.join());
  });
  await t("orphanStorage：认得出哪些 storage 目录还在用，别把在用的算成孤儿", async () => {
    storageDirs = ["ATT_DEF1", "ZZZZZZZZ", "YYYYYYYY"];   // 第一个是 ATT_DEFAULT 的 key
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=orphanStorage") });
    const o = JSON.parse(r[2]).checks.orphanStorage;
    assert.strictEqual(o.scanned, 3);
    assert.strictEqual(o.count, 2, "在用的那个目录被算成孤儿了 —— 等于把「哪些 key 被引用」这条 join 写废了");
    assert.ok(o.sample.includes("ZZZZZZZZ") && !o.sample.includes("ATT_DEF1"), o.sample.join());
    assert.ok(o.note.includes("只增不减"), "这个数天然只涨，不说明白会被当成故障");
  });
  await t("★ attachmentTitle：标题等于文件名就不算「对不上」（两种形态都要认）", async () => {
    // 实测踩到的：只把**文件名**那边的扩展名剥掉，会把 721 条 title === 完整文件名
    // 的本来自洽的附件全判成不一致（这个库上 789 条"不一致"里绝大多数是假的）。
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=attachmentTitle") });
    const a = JSON.parse(r[2]).checks.attachmentTitle;
    assert.strictEqual(a.count, 1, "只有 ATT_DEFAULT 的标题是 'Full Text PDF'");
    assert.strictEqual(a.sample[0].key, "ATT_DEF1");
    assert.strictEqual(a.mismatchCount, 0,
      "ATT_OK1 的标题是 'paper'、文件是 paper.pdf，本来就是一致的");
  });
  await t("attachmentTitle：标题和文件名真的对不上时才计入 mismatch", async () => {
    ITEMS.ATT_OKTITLE.fields.title = "完全对不上的标题";
    try {
      const r = await epCall("/zoterojs/doctor", { headers: H,
        searchParams: new URLSearchParams("checks=attachmentTitle") });
      const a = JSON.parse(r[2]).checks.attachmentTitle;
      assert.strictEqual(a.mismatchCount, 1);
      assert.strictEqual(a.mismatchSample[0].key, "ATT_OK1");
    } finally { ITEMS.ATT_OKTITLE.fields.title = "paper"; }
  });
  await t("attachmentTitle：空标题单独报，不混进 mismatch", async () => {
    ITEMS.ATT_OKTITLE.fields.title = "";
    try {
      const r = await epCall("/zoterojs/doctor", { headers: H,
        searchParams: new URLSearchParams("checks=attachmentTitle") });
      const a = JSON.parse(r[2]).checks.attachmentTitle;
      assert.strictEqual(a.emptyCount, 1);
      assert.strictEqual(a.mismatchCount, 0, "空标题是另一类问题，混在一起就没法照着修");
    } finally { ITEMS.ATT_OKTITLE.fields.title = "paper"; }
  });
  await t("attachmentTitle：默认值口径可以用 titles 换掉", async () => {
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams(
        "checks=attachmentTitle&titles=" + JSON.stringify(["paper"])) });
    const a = JSON.parse(r[2]).checks.attachmentTitle;
    assert.ok(a.sample.some(s => s.key === "ATT_OK1"), "换了默认值列表却没生效");
    assert.ok(!a.sample.some(s => s.key === "ATT_DEF1"), "换掉之后不该还按旧的认");
  });
  await t("duplicateFilenames：认出同一父条目下的同名附件（pdf2zh 那个坑）", async () => {
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=" + JSON.stringify(["duplicateFilenames"])) });
    const d = JSON.parse(r[2]).checks.duplicateFilenames;
    assert.strictEqual(d.count, 1);
    assert.strictEqual(d.sample[0].length, 2, "该是成对报出来的");
  });
  await t("duplicates：同 DOI 的抓得出来，且明说它只是线索不是判决", async () => {
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=" + JSON.stringify(["duplicates"])) });
    const d = JSON.parse(r[2]).checks.duplicates;
    assert.strictEqual(d.doi.groups, 1);
    assert.deepStrictEqual(d.doi.sample[0].keys.map(k => k.key).sort(), ["APPTITLE", "DUPDOI"]);
    assert.ok(d.note.includes("线索"), "不说明白的话，用户会照着它去合并上下册");
  });
  await t("trashWriteback：回收站里还在被改写的条目要点名，并警告别清空回收站", async () => {
    const r = await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=trashWriteback") });
    const t2 = JSON.parse(r[2]).checks.trashWriteback;
    assert.strictEqual(t2.recentlyModified, 1);
    assert.strictEqual(t2.sample[0].key, "TRASHED");
    assert.ok(t2.note.includes("别清空回收站"), "这是整条检查在命中时唯一的作用，不能只说数字");
  });
  await t("回收站空着时不说「里面有插件数据」—— 话要随事实走", async () => {
    // 2026-09-11 确实有条目躺在回收站里被写；2026-09-12 再查已经是空的。
    // 把一段写死的经历当成当前状态讲，就是在骗人。
    // 前面的合并测试已经往回收站里放了几条（合并的 dup 会进回收站），
    // 所以这里整个清空再还原，别只删 TRASHED
    const saved = [...trash];
    trash.clear();
    try {
      const r = await epCall("/zoterojs/doctor", { headers: H,
        searchParams: new URLSearchParams("checks=trashWriteback") });
      const t2 = JSON.parse(r[2]).checks.trashWriteback;
      assert.strictEqual(t2.trashTotal, 0);
      assert.ok(!t2.note.includes("别清空回收站"), t2.note);
      assert.ok(t2.note.includes("空的"), t2.note);
    } finally { saved.forEach(k => trash.add(k)); }
  });
  await t("doctor 的每一项都不写数据", async () => {
    saveTxCalls.length = 0;
    await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("all=true") });
    assert.deepStrictEqual(saveTxCalls, [], "体检动了数据");
  });
  await t("单项炸了不影响其余项，且如实报出是哪项炸的", async () => {
    storageDirs = null;   // IOUtils.getChildren 会抛
    try {
      const r = await epCall("/zoterojs/doctor", { headers: H });
      const b = JSON.parse(r[2]);
      assert.strictEqual(r[0], 200, "一项炸了不该把整个体检变成错误响应");
      assert.ok(b.checks.orphanStorage.error, "该报出这一项的错误");
      assert.ok(b.checks.unfiled, "后面几项该照跑不误");
      assert.ok(!b.checks.unfiled.error, b.checks.unfiled.error);
    } finally { storageDirs = ["ATT_DEF1", "ZZZZZZZZ", "YYYYYYYY"]; }
  });

  console.log("\n[8.7] apply —— 批量写 + 集合差分");
  await t("dryRun 一条都不落盘，但要算出会改什么", async () => {
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      dryRun: true, ops: [{ item: "APPTITLE", set: { title: "新标题", date: "2021" } }] } });
    assert.strictEqual(r[0], 200, r[2]);
    assert.deepStrictEqual(saveTxCalls, [], "dry-run 落了盘");
    const rec = JSON.parse(r[2]).report[0];
    assert.strictEqual(rec.status, "would-change");
    assert.strictEqual(ITEMS.APPTITLE.getField("title"), "旧标题", "dry-run 改了内存里的值");
  });
  await t("不写 dryRun 就真写，并且只写改过的字段", async () => {
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPTITLE", set: { title: "新标题" } }] } });
    const rec = JSON.parse(r[2]).report[0];
    assert.strictEqual(rec.status, "applied");
    assert.deepStrictEqual(saveTxCalls, ["APPTITLE"]);
    assert.strictEqual(ITEMS.APPTITLE.getField("title"), "新标题");
    assert.strictEqual(ITEMS.APPTITLE.getField("date"), "2019", "没点名的字段不该被碰");
  });
  await t("值没变就是 no-change —— 不白写一次、不谎报改动", async () => {
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPTITLE", set: { title: "新标题" } }] } });
    assert.strictEqual(JSON.parse(r[2]).report[0].status, "no-change");
    assert.deepStrictEqual(saveTxCalls, []);
  });
  await t("★ 挂父级会静默摘掉集合归属 —— 差分必须当场报出来", async () => {
    // 这是这个端点存在的唯一理由，也是 2026-09-12 在真库上实测过的那一条：
    // 集合 307 里的裸附件 4WWZ44HC 一挂上父级，collectionItems 里那一行当场没了。
    // 紧跟 saveTx 的那次读还可能读到旧缓存，所以差分直接查表。
    assert.deepStrictEqual(collectionsOfItem(ITEMS.APPCHILD.itemID), [10], "前提：挂之前它在集合 10 里");
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPCHILD", parent: "APPPARENT1" }] } });
    const b = JSON.parse(r[2]);
    const rec = b.report[0];
    assert.strictEqual(rec.status, "applied");
    assert.deepStrictEqual(rec.collectionsBefore, [10]);
    assert.deepStrictEqual(rec.collectionsAfter, [], "挂了父级之后集合该没了");
    assert.deepStrictEqual(rec.collectionsLost, [10], "丢了集合却没说 —— 这就是那个静默故障");
    assert.ok(b.warning, "整体要有个警告，不能只在某一条的字段里");
    assert.ok(rec.why.includes("静默"), "得说清这是 Zotero 的正常行为，不是它坏了");
  });
  await t("★ 挂父级还会**把集合塞给父条目** —— 差分原来只盯着被写的那一个", async () => {
    // 2026-09-12 在真库上踩到的：附件那半边报得好好的，父条目被凭空加进同一个集合，
    // 报告里一个字都没有。父条目那次 save 带 skipDateModifiedUpdate，
    // dateModified 不变，事后靠"最近改过哪些条目"倒查也查不出来。
    assert.deepStrictEqual(collectionsOfItem(ITEMS.APPPARENT2.itemID), [],
      "前提：APPPARENT2 本来不在任何集合里");
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPCHILD2", parent: "APPPARENT2" }] } });
    const b = JSON.parse(r[2]);
    const rec = b.report[0];
    assert.deepStrictEqual(rec.parentCollectionsGained, [10],
      "父条目被塞进了集合 10，差分没说 —— 这正是这个端点该防的静默改动");
    assert.strictEqual(rec.parentItem, "APPPARENT2");
    assert.deepStrictEqual(collectionsOfItem(ITEMS.APPPARENT2.itemID), [10]);
    assert.ok(b.warning.includes("父条目"), "整体警告里也要点名父条目，不能只在某一条的字段里");
  });
  await t("演练时就该预告父条目会拿到哪些集合", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPCHILD3", parent: "APPPARENT2" }], dryRun: true } });
    const rec = JSON.parse(r[2]).report[0];
    assert.deepStrictEqual(rec.wouldGiveParent, [10], "演练得说清父条目会拿到什么，别等写完才知道");
    assert.strictEqual(rec.parentItem, "APPPARENT2");
    assert.deepStrictEqual(collectionsOfItem(ITEMS.APPPARENT2.itemID), [10],
      "演练不该动父条目（它现在是 10，是上一条测试留下的）");
  });
  await t("★ 改类型**不**动集合归属 —— 上一版这里写反了，别再改回去", async () => {
    // 2026-09-12 实测 + 读源码：item.js 的 setType 只碰 itemData / creators。
    // 老注释说「改类型会静默摘集合」是我编的，而 stub 照抄了它 ——
    // 于是那条测试只是在印证我自己写进去的行为。这条留着，防止它被写回去。
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPTYPE", setType: "book" }] } });
    const b = JSON.parse(r[2]);
    const rec = b.report[0];
    assert.strictEqual(rec.status, "applied");
    assert.deepStrictEqual(rec.collectionsBefore, [10]);
    assert.deepStrictEqual(rec.collectionsAfter, [10], "setType 把集合摘了 —— 真机不这么干");
    assert.strictEqual(rec.collectionsLost, undefined, "没丢就不该报成丢失");
    assert.strictEqual(b.warning, undefined, "没丢就不该出警告");
  });
  await t("普通条目挂不了父级 —— 真机抛错，别让它悄悄成功", async () => {
    // 2026-09-12 实测：拿一个 presentation 当子条目去挂父级，真机抛
    // `_setParentKey() can only be called on items of type 'note', 'attachment', or 'annotation'`。
    // 只有 note / attachment / annotation 能有父级，普通条目之间不能互为父子。
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPGUARD", parent: "MASTER01" }] } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.errors, 1, "真机会抛，stub 放行就等于这类错只在真机上出现");
    assert.ok(b.report[0].why.includes("_setParentKey"), b.report[0].why);
    assert.deepStrictEqual(saveTxCalls, [], "抛了就别保存");
  });
  await t("自己要求的 removeFromCollection 不算「意外丢失」", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "DUPDOI", removeFromCollection: "COLBBBBB" }] } });
    const rec = JSON.parse(r[2]).report[0];
    assert.deepStrictEqual(rec.collectionsBefore, [11]);
    assert.deepStrictEqual(rec.collectionsAfter, []);
    assert.strictEqual(rec.collectionsLost, undefined, "自己摘的不该报成故障");
    assert.ok(JSON.parse(r[2]).warning === undefined, "没有意外丢失就不该出警告");
  });
  await t("expect 不符就跳过 —— 宁可不动，也别对着错的条目下手", async () => {
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPGUARD", expect: { title: "我以为的标题" }, set: { date: "2030" } }] } });
    const rec = JSON.parse(r[2]).report[0];
    assert.strictEqual(rec.status, "skipped");
    assert.strictEqual(rec.mismatch[0].got, "标题不是你以为的那个");
    assert.deepStrictEqual(saveTxCalls, []);
    assert.strictEqual(ITEMS.APPGUARD.getField("date"), "2018", "跳过了还是改了");
  });
  await t("expect 相符就照改", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPGUARD", expect: { title: "标题不是你以为的那个" }, set: { date: "2030" } }] } });
    assert.strictEqual(JSON.parse(r[2]).report[0].status, "applied");
    assert.strictEqual(ITEMS.APPGUARD.getField("date"), "2030");
  });
  await t("字符串创建者按单字段模式写 —— 中文名不能被硬拆成姓+名", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPCREATOR", setCreators: ["李四", "王五"] }] } });
    assert.strictEqual(r[0], 200, r[2]);
    // 跨 vm 边界的对象原型不同，deepStrictEqual 会以「结构相同但不是同一个引用」报错，
    // 所以先过一遍 JSON 再比
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ITEMS.APPCREATOR.getCreators())),
      [{ creatorType: "author", fieldMode: 1, lastName: "李四" },
       { creatorType: "author", fieldMode: 1, lastName: "王五" }],
      "中文名被拆成了 firstName/lastName，或者根本没按单字段模式写");
    // 差分里的名字也要对：fieldMode=1 时不该拼出 "李四 undefined"
    assert.deepStrictEqual(JSON.parse(r[2]).report[0].changes[0].to, ["李四", "王五"]);
  });
  await t("条目不存在 → 记成 error，默认停在那儿不再往下写", async () => {
    saveTxCalls.length = 0;
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "NOSUCHKEY", set: { title: "x" } },
            { item: "APPTITLE", set: { date: "1999" } }] } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.errors, 1);
    assert.strictEqual(b.report.length, 1, "默认 stopOnError，第二条不该被执行");
    assert.deepStrictEqual(saveTxCalls, []);
  });
  await t("stopOnError=false 时跳过坏的继续做好的", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      stopOnError: false,
      ops: [{ item: "NOSUCHKEY", set: { title: "x" } },
            { item: "APPTITLE", set: { date: "1999" } }] } });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.errors, 1);
    assert.strictEqual(b.applied, 1);
    assert.strictEqual(ITEMS.APPTITLE.getField("date"), "1999");
  });
  await t("集合 key 写错 → 报错说清是哪个集合，不静默跳过", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPTITLE", addToCollection: "NOSUCHCOL" }] } });
    assert.ok(JSON.parse(r[2]).report[0].why.includes("NOSUCHCOL"));
  });
  await t("addToCollection 按 key 解析，写进去的是 collectionID", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {
      ops: [{ item: "APPTITLE", addToCollection: "COLBBBBB" }] } });
    assert.strictEqual(JSON.parse(r[2]).report[0].status, "applied");
    assert.ok(collectionsOfItem(ITEMS.APPTITLE.itemID).includes(11), "该挂到集合 11 上");
  });
  await t("没有 ops → 400，并给出正确的形状", async () => {
    const r = await epCall("/zoterojs/apply", { headers: H, data: {} });
    assert.strictEqual(r[0], 400);
    assert.ok(JSON.parse(r[2]).error.includes("ops"));
  });

  console.log("\n[8.8] 备份");
  await t("立即备份：建目录、写文件、报出大小", async () => {
    backupDirExists = false;
    backupFiles.length = 0;
    const doc = fakeDoc();
    await pane().backupNow(doc);
    const out = doc.els["jsb-status"].textContent;
    assert.ok(backupDirExists, "没建目录");
    assert.strictEqual(backupFiles.length, 1);
    assert.ok(/^zotero-.*\.sqlite$/.test(backupFiles[0]), backupFiles[0]);
    // 52496032 字节 → 50.06 MiB → toFixed(1) 是 50.1
    assert.ok(out.includes("50.1 MB"), out);
    assert.ok(out.includes("ms"), "该报出耗时");
  });
  await t("备份文件名带 ISO 时间戳，且能被 listBackups 排序", async () => {
    const names = await call("listBackups");
    assert.strictEqual(names.length, 1);
    assert.ok(/^zotero-\d{4}-\d{2}-\d{2}T/.test(names[0]), names[0]);
    assert.ok(!names[0].includes(":"), "文件名里有冒号，Windows 上直接写不出来");
  });
  await t("轮转：超过保留份数就删最旧的", async () => {
    backupFiles.length = 0;
    for (const s of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]) {
      backupFiles.push(`zotero-${s}T00-00-00-000Z.sqlite`);
    }
    removedBackups.length = 0;
    await withPref("jsbridge.backup.keep", 2, async () => {
      const doc = fakeDoc();
      await pane().backupNow(doc);
      // 原有 4 份 + 这次新备 1 份 = 5 份，keep=2 → 删掉最旧的 3 份
      assert.strictEqual(backupFiles.length, 2, "该只留 2 份");
      assert.deepStrictEqual(removedBackups,
        ["zotero-2026-09-01T00-00-00-000Z.sqlite", "zotero-2026-09-02T00-00-00-000Z.sqlite",
         "zotero-2026-09-03T00-00-00-000Z.sqlite"],
        "删的不是最旧的那几份");
      // 新的那份必须在，删的必须是最旧的
      assert.ok(backupFiles.some(n => n > "zotero-2026-09-04"), backupFiles.join());
      assert.ok(doc.els["jsb-status"].textContent.includes("轮转"), "删了旧的要说一声");
    });
  });
  await t("keep 被设成 0 或负数时不越界（下限 1）", () =>
    withPref("jsbridge.backup.keep", 0, async () => {
      const doc = fakeDoc();
      await pane().backupNow(doc);
      assert.ok(backupFiles.length >= 1, "把备份全删光是不可接受的");
    }));
  await t("撞名不覆盖：同一时刻备两次，第二份换个名字", async () => {
    backupFiles.length = 0;
    backupFiles.push("zotero-2026-09-12T00-00-00-000Z.sqlite");
    const p = await call("freeBackupPath", "2026-09-12T00-00-00-000Z");
    assert.notStrictEqual(basename(p), "zotero-2026-09-12T00-00-00-000Z.sqlite",
      "撞名了还往上写 —— VACUUM INTO 会报错，静默盖掉更糟");
    assert.ok(basename(p).includes("-2"), basename(p));
  });
  await t("备份失败时如实报错，并把目标目录写出来", async () => {
    vacuumFails = "database is locked";
    try {
      const doc = fakeDoc();
      await pane().backupNow(doc);
      const out = doc.els["jsb-status"].textContent;
      assert.ok(out.includes("备份失败"), out);
      assert.ok(out.includes("database is locked"), "得带上真实原因");
      assert.ok(out.includes("jsbridge-backups"), "得告诉用户往哪儿找");
    } finally { vacuumFails = null; }
  });
  await t("★ 自动备份失败 → 写操作中止，绝不照写不误", () =>
    // 开了自动备份就是要有兜底。兜不住还照写，这个开关就成了一句安慰话。
    withPref("jsbridge.backup.enabled", true, async () => {
      saveTxCalls.length = 0;
      const before = ITEMS.APPTITLE.getField("title");
      vacuumFails = "disk full";
      try {
        const r = await epCall("/zoterojs/apply", {
          headers: H, data: { ops: [{ item: "APPTITLE", set: { title: "不该写进去" } }] } });
        assert.strictEqual(r[0], 500, "备份失败还返回 200");
        assert.ok(JSON.parse(r[2]).error.includes("备份失败"), r[2]);
        assert.deepStrictEqual(saveTxCalls, [], "备份失败了居然还是写了");
        assert.strictEqual(ITEMS.APPTITLE.getField("title"), before);
      } finally { vacuumFails = null; }
    }));
  await t("自动备份关着的时候不备份，也不因为备份失败而卡住写", async () => {
    saveTxCalls.length = 0;
    vacuumFails = "disk full";     // 关着的时候这个错根本不该被碰到
    try {
      const r = await epCall("/zoterojs/apply", {
        headers: H, data: { ops: [{ item: "APPTITLE", set: { title: "写进去了" } }] } });
      assert.strictEqual(r[0], 200, r[2]);
      assert.deepStrictEqual(saveTxCalls, ["APPTITLE"]);
      assert.strictEqual(JSON.parse(r[2]).backup, undefined, "没开自动备份却备了一份");
    } finally { vacuumFails = null; }
  });
  await t("打开自动备份后：先备一份，再写，报告里带上备份信息", async () => {
    backupFiles.length = 0;
    backupDirExists = true;
    await withPref("jsbridge.backup.enabled", true, async () => {
      saveTxCalls.length = 0;
      const r = await epCall("/zoterojs/apply", {
        headers: H, data: { ops: [{ item: "APPTITLE", set: { title: "又改了" } }] } });
      const b = JSON.parse(r[2]);
      assert.ok(b.backup, "报告里该说备到哪儿了");
      assert.strictEqual(b.backup.reason, "apply");
      assert.ok(b.backup.path.endsWith(".sqlite"));
      assert.deepStrictEqual(saveTxCalls, ["APPTITLE"]);
    });
  });
  await t("merge 的 dry-run 不备份（不写就没必要备）", async () => {
    backupFiles.length = 0;
    await withPref("jsbridge.backup.enabled", true, async () => {
      const r = await epCall("/zoterojs/merge", { headers: H,
        data: { master: "MASTER01", dups: ["DUPGOOD"], dryRun: true } });
      assert.strictEqual(JSON.parse(r[2]).backup, undefined,
        "dry-run 备了一份 50 MB —— 反复试的时候这个代价不小");
    });
  });
  await t("doctor 的 checks 参数里 sync 之外都不联网", async () => {
    httpCalls.length = 0;
    await epCall("/zoterojs/doctor", { headers: H,
      searchParams: new URLSearchParams("checks=" + JSON.stringify(["orphanStorage", "unfiled",
        "attachmentTitle", "duplicateFilenames", "duplicates", "trashWriteback"])) });
    assert.deepStrictEqual(httpCalls, []);
  });

  console.log("\n[8.85] enrich：只补空 + 三道闸");

  const enrich = async (data) => {
    const r = await epCall("/zoterojs/enrich", { headers: H, data });
    return { status: r[0], body: JSON.parse(r[2]) };
  };
  // 一条视觉结果的样板。各用例只覆盖自己关心的那几个字段。
  const finding = (key, over) => Object.assign({
    item: key, pages: [{ p: 1, type: "封面" }, { p: 3, type: "版权页CIP" }],
    evidence: "计算土力学/朱百里. —北京：中国建筑工业出版社，2019.3",
  }, over || {});
  const applyOf = (b) => (b.apply && b.apply.report) || [];
  const opFor = (b, key) => applyOf(b).find(r => r.item === key) || null;
  const fieldsOf = (b, key) => (opFor(b, key) || {}).changes || [];

  await t("正常补全：缺的字段全补上，dry-run 一条也不落盘", async () => {
    const before = saveTxCalls.length;
    const { status, body } = await enrich({ dryRun: true, findings: [finding("EN_BOOK", {
      title: "计算土力学", publisher: "中国建筑工业出版社", place: "北京",
      year: "2019", month: 3, edition: "第1版", isbn: "978-7-112-00000-0", authors: ["朱百里"],
    })] });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.gated, 0, "不该被闸门拦下");
    assert.strictEqual(body.withOps, 1);
    const got = {}; for (const c of fieldsOf(body, "EN_BOOK")) got[c.field] = c.to;
    assert.strictEqual(got.publisher, "中国建筑工业出版社");
    assert.strictEqual(got.place, "北京");
    assert.strictEqual(got.date, "2019-03", "年 + 月要拼成 YYYY-MM");
    assert.strictEqual(got.ISBN, "978-7-112-00000-0");
    // creators 的 to 是**数组**（一条 op 里可以设多位作者），不是字符串
    assert.deepStrictEqual(got.creators, ["朱百里"]);
    assert.strictEqual(saveTxCalls.length, before, "演练模式一个字都不该写");
  });

  await t("★ 闸三挡住「参考文献里的那本书」（真机上的 82L9PCBI）", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_HALLU", {
      // 依据行是 GB/T 7714 参考文献格式，模型还把它判成了"版权页CIP"
      pages: [{ p: 3, type: "版权页CIP" }],
      title: "弹性力学简明教程", publisher: "高等教育出版社", place: "北京",
      year: "2002", month: 8, edition: "第3版", isbn: "7-04-010719-8",
      evidence: "弹性力学简明教程/徐芝纶. —3版. 北京:高等教育出版社,2002.8",
    })] });
    assert.strictEqual(body.gated, 1, "期刊论文身上出现了出版社 / ISBN，必须拦下");
    assert.strictEqual(body.withOps, 0, "拦下的不该生成任何 op");
    assert.match(body.gatedReport[0].why.join(" "), /期刊论文/);
    // 这条闸二**过不了**它 —— 特意钉住：光靠标题子串校验是不够的
    assert.ok(body.gatedReport[0].why.every(w => !/书名/.test(w)),
      "闸二本该放行（文章标题里确实含「弹性力学简明教程」），拦下它的只能是闸三");
  });

  await t("★ 闸一挡住「前言致谢里抠出来的出版社」（真机上的 H2GCDM5B）", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_HALLUA", {
      pages: [{ p: 1, type: "正文" }, { p: 2, type: "目录" }],   // 一页前置页都没见到
      title: "数学物理方程的matlab解法与可视化", publisher: "清华大学出版社",
      evidence: "本书作者感谢清华大学出版社对本书出版所给予的大力支持",
    })] });
    assert.strictEqual(body.gated, 1);
    assert.match(body.gatedReport[0].why.join(" "), /没见到前置页/);
    assert.strictEqual(body.withOps, 0);
  });

  await t("strict=false 时闸门放开（反面证明闸真的在起作用，不是摆设）", async () => {
    const { body } = await enrich({ dryRun: true, strict: false, findings: [finding("EN_HALLUA", {
      pages: [{ p: 1, type: "正文" }], title: "数学物理方程的matlab解法与可视化",
      publisher: "清华大学出版社", evidence: "本书作者感谢清华大学出版社…",
    })] });
    assert.strictEqual(body.gated, 0);
    assert.strictEqual(body.withOps, 1, "关掉闸门后同一条应该能过 —— 否则说明拦住它的不是闸门");
  });

  await t("★ 库里标题更全时不许截短（「从抛物线谈起：混沌动力学引论」）", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_LONGT", {
      title: "从抛物线谈起",        // 视觉那张扉页只印了主标题
    })] });
    assert.strictEqual(body.withOps, 0, "跟着视觉写会把副标题丢掉");
    const row = body.report[0].fields.find(r => r.field === "title");
    assert.strictEqual(row.kind, "same");
    assert.strictEqual(row.from, "从抛物线谈起：混沌动力学引论");
  });

  await t("反过来：抽出来的更全时才写（extend）", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_SHORT", {
      title: "从抛物线谈起：混沌动力学引论",
    })] });
    const row = body.report[0].fields.find(r => r.field === "title");
    assert.strictEqual(row.kind, "extend");
    assert.strictEqual(opFor(body, "EN_SHORT").changes
      .find(c => c.field === "title").to, "从抛物线谈起：混沌动力学引论");
  });

  await t("★ 两边都有值且不同 → conflict，只报不写", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_CONF", {
      title: "土的本构关系", isbn: "978-7-114-08257-3",         // 库里是 ...14996-2
      publisher: "人民交通出版社",
    })] });
    const rows = Object.fromEntries(body.report[0].fields.map(r => [r.field, r]));
    assert.strictEqual(rows.ISBN.kind, "conflict");
    assert.strictEqual(rows.ISBN.from, "978-7-114-14996-2");
    assert.strictEqual(rows.ISBN.to, "978-7-114-08257-3");
    const changed = opFor(body, "EN_CONF").changes.map(c => c.field);
    assert.ok(!changed.includes("ISBN"), "冲突字段绝不能进 op");
    assert.ok(changed.includes("publisher"), "空着的字段照补");
  });

  await t("版次分歧（原书2 vs 第1版）也走 conflict，不是静默覆盖", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_EDIT", {
      title: "利用Python进行数据分析", edition: "第1版",
    })] });
    const row = body.report[0].fields.find(r => r.field === "edition");
    assert.strictEqual(row.kind, "conflict");
    assert.strictEqual(body.withOps, 0);
  });

  await t("series 只列不写（模型把资助项目 / 文献类型都当成了丛书）", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_SERI", {
      title: "带丛书的书", series: "国家自然科学基金重大项目",
    })] });
    const row = body.report[0].fields.find(r => r.field === "series");
    assert.strictEqual(row.kind, "review");
    assert.strictEqual(body.withOps, 0, "series 不该生成 op");
  });

  await t("creators 库里已经有了就不动它", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_HASCR", {
      title: "已经有作者的书", authors: ["王五", "赵六"],
    })] });
    const row = body.report[0].fields.find(r => r.field === "creators");
    assert.strictEqual(row.kind, "same");
    assert.strictEqual(row.from, "张三");
    assert.strictEqual(body.withOps, 0);
  });

  await t("学位论文：抽到的「出版社」落到 university，不是 publisher", async () => {
    const { body } = await enrich({ dryRun: true, findings: [finding("EN_THES", {
      title: "某篇学位论文", publisher: "清华大学", year: "2018",
    })] });
    const changed = Object.fromEntries(fieldsOf(body, "EN_THES").map(c => [c.field, c.to]));
    assert.strictEqual(changed.university, "清华大学");
    assert.strictEqual(changed.publisher, undefined, "学位论文没有 publisher 这个栏");
  });

  await t("dryRun=false 才真落盘，且用 enrich 这个 tag 备份", async () => {
    const before = saveTxCalls.length;
    const { body } = await enrich({ dryRun: false, findings: [finding("EN_BOOK", {
      title: "计算土力学", publisher: "中国建筑工业出版社", year: "2019",
    })] });
    assert.strictEqual(body.apply.dryRun, false);
    assert.strictEqual(body.apply.applied, 1);
    assert.ok(saveTxCalls.length > before, "真写应该落盘");
    assert.ok(saveTxCalls.includes("EN_BOOK"));
  });

  await t("findings 为空时报 400 并说清两种用法", async () => {
    const { status, body } = await enrich({ findings: [] });
    assert.strictEqual(status, 400);
    assert.match(body.error, /items=|scan=1/);
  });

  await t("条目不存在 → 进 errorReport，不影响同批其他条目", async () => {
    // 用本测试自己的一条条目，不蹭 EN_BOOK：上一条真落盘（dryRun=false）已经把
    // publisher 写进 EN_BOOK 了，再喂一个不同的出版社就变成 conflict —— 那样
    // withOps 是 0，"好的那条照常处理"这句断言测的就不是它想测的东西了。
    ITEMS.EN_TMPERR = new Item({ key: "EN_TMPERR", itemType: "book",
      fields: { title: "同批里好的那条" } });
    try {
      const { status, body } = await enrich({ dryRun: true, findings: [
        finding("NOSUCHKEY"),
        finding("EN_TMPERR", { title: "同批里好的那条", publisher: "某社" }),
      ] });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.errors, 1);
      assert.match(body.errorReport[0].why, /不存在/);
      assert.strictEqual(body.withOps, 1, "好的那条照常处理");
    } finally { delete ITEMS.EN_TMPERR; }
  });

  console.log("\n[8.86] enrich 的候选发现");

  await t("点名模式：只回报没有文本层的 PDF", async () => {
    const r = await epCall("/zoterojs/enrich", { headers: H,
      searchParams: new URLSearchParams("items=EN_BOOK") });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.candidates, 1, "EN_BOOK 的扫描件字符数是 0，该进候选");
    assert.strictEqual(b.page[0].atts.length, 1);
    assert.strictEqual(b.page[0].atts[0].akey, "ENATSCAN");
    assert.strictEqual(b.page[0].atts[0].chars, 0);
    assert.match(b.page[0].atts[0].file, /ENATSCAN/, "要给出附件的真实路径");
  });

  await t("★ 有文本层的不进候选 —— 哪怕它的 state 是 PARTIAL", async () => {
    // EN_ATT_PARTIAL 有 23.6 万字符却仍是 PARTIAL。拿 state 当判据的话它会误报，
    // 而这正是不能信 getIndexedState 的原因（真机上 23NZF8PY / 27RCEEVC 就是这情况）。
    const nonPdf = new Item({ key: "EN_TMP1", itemType: "book", fields: { title: "拿 PARTIAL 的文件" },
      attachments: [EN_ATT_PARTIAL.itemID] });
    ITEMS.EN_TMP1 = nonPdf;
    try {
      const r = await epCall("/zoterojs/enrich", { headers: H,
        searchParams: new URLSearchParams("items=EN_TMP1") });
      const b = JSON.parse(r[2]);
      assert.strictEqual(b.candidates, 0,
        "23.6 万字符的附件被当成了扫描件 —— 判据退回了 getIndexedState");
    } finally { delete ITEMS.EN_TMP1; }
  });

  await t("非 PDF 附件不进候选", async () => {
    const it = new Item({ key: "EN_TMP2", itemType: "book", fields: { title: "只有网页快照" },
      attachments: [EN_ATT_NONPDF.itemID] });
    ITEMS.EN_TMP2 = it;
    try {
      const r = await epCall("/zoterojs/enrich", { headers: H,
        searchParams: new URLSearchParams("items=EN_TMP2") });
      assert.strictEqual(JSON.parse(r[2]).candidates, 0);
    } finally { delete ITEMS.EN_TMP2; }
  });

  await t("★ 抽全文失败要如实报，不能当成「0 字符 = 扫描件」", async () => {
    const it = new Item({ key: "EN_TMP3", itemType: "book", fields: { title: "坏文件" },
      attachments: [EN_ATT_BROKEN.itemID] });
    ITEMS.EN_TMP3 = it;
    try {
      const r = await epCall("/zoterojs/enrich", { headers: H,
        searchParams: new URLSearchParams("items=EN_TMP3") });
      const att = JSON.parse(r[2]).page[0].atts[0];
      assert.strictEqual(att.chars, null, "抽不出来就是 null，不能填 0");
      assert.match(att.error, /file not found/);
    } finally { delete ITEMS.EN_TMP3; }
  });

  await t("字段已经齐了的条目不进候选（视觉没得补）", async () => {
    const r = await epCall("/zoterojs/enrich", { headers: H,
      searchParams: new URLSearchParams("items=EN_CMPL") });
    const b = JSON.parse(r[2]);
    assert.strictEqual(b.candidates, 0);
    /* 上面那个 0 得说得出是**哪道闸**挡的 —— 光看 candidates=0 分不清
       "字段齐了"、"没挂附件"、"附件没文本层" 还是 "根本没扫到它"。
       EN_CMPL 身上挂着 EN_ATT_TEXT（9.7 万字符的正常 PDF），所以：
         · 默认（missingOnly=1）：在附件循环**之前**就 continue 了 → attsProbed 必须是 0
         · missingOnly=0：过字段闸、真去查了那个附件 → attsProbed=1，
           仍因字符数够多而不进候选
       两个数合起来才钉死"是字段闸干的"，而不是哪一环悄悄没跑。
       （这条原来附了一句「EN_CMPL 没挂附件，本来就不该出现」—— 夹具给它挂上
        EN_ATT_TEXT 之后那句就成了假话。**失败信息说假话比没有失败信息更坏**：
        哪天它红了，你会去查一个根本不存在的原因。） */
    assert.strictEqual(b.attsProbed, 0, "字段齐了就该在附件循环之前 continue");
    const r2 = await epCall("/zoterojs/enrich", { headers: H,
      searchParams: new URLSearchParams("items=EN_CMPL&missingOnly=0") });
    const b2 = JSON.parse(r2[2]);
    assert.strictEqual(b2.attsProbed, 1, "missingOnly=0 时要真的去查那个附件");
    assert.strictEqual(b2.candidates, 0, "9.7 万字符的 PDF 不该进候选");
  });

  await t("既不给 items 也不给 scan → 400，并把两种用法说清楚", async () => {
    const r = await epCall("/zoterojs/enrich", { headers: H });
    assert.strictEqual(r[0], 400);
    assert.match(JSON.parse(r[2]).error, /items=KEY1,KEY2/);
  });

  await t("scan=1 全库扫：只要有文本层的都被粗筛跳过，不白抽", async () => {
    const r = await epCall("/zoterojs/enrich", { headers: H,
      searchParams: new URLSearchParams("scan=1&missingOnly=0") });
    const b = JSON.parse(r[2]);
    assert.strictEqual(r[0], 200);
    assert.ok(b.skippedIndexed >= 1, "INDEXED 的附件该被 getIndexedState 粗筛掉");
    assert.ok(b.candidates >= 1, "至少 EN_BOOK 该进候选");
  });

  await t("★ 全库扫要滤掉批注 —— getAll 会把它们算成顶层条目", async () => {
    /* 真机实测（2026-09-12）：Zotero.Items.getAll(lib, true) = 11231，
       其中 **10030 条是 annotation** —— 它只 LEFT JOIN 了 itemNotes 和
       itemAttachments，没 join itemAnnotations。不滤掉的话两个后果：
       ① 每条批注白跑一次 getAttachments()，实测那一步直接超时；
       ② itemsProbed 报 11231，看着像"扫了一万多个条目"，而真正的书目条目
          只有 1197 —— 数字骗人比慢更糟。 */
    ITEMS.EN_TMPANN = new Item({ key: "EN_TMPANN", itemType: "annotation",
      fields: { title: "一条高亮" }, attachments: [] });
    try {
      const r = await epCall("/zoterojs/enrich", { headers: H,
        searchParams: new URLSearchParams("scan=1&missingOnly=0") });
      const b = JSON.parse(r[2]);
      assert.ok(!b.page.some(c => c.item === "EN_TMPANN"), "批注不该出现在候选里");
      const topAll = Object.values(ITEMS).filter(i => !i.parentItemID).length;
      assert.ok(b.itemsProbed < topAll,
        `itemsProbed(${b.itemsProbed}) 要小于 getAll 的顶层数(${topAll})` +
        " —— 相等就说明批注没被滤掉");
    } finally { delete ITEMS.EN_TMPANN; }
  });

  await t("只读模式下 enrich 回 403（POST 和 GET 都算写）", () =>
    withPref("jsbridge.readonly", true, async () => {
      assert.strictEqual((await epCall("/zoterojs/enrich",
        { headers: H, data: { findings: [finding("EN_BOOK")] } }))[0], 403);
      assert.strictEqual((await epCall("/zoterojs/enrich", { headers: H,
        searchParams: new URLSearchParams("items=EN_BOOK") }))[0], 403,
        "GET 的 scan 模式要抽几百个附件、耗时以分钟计，也不该放行");
    }));

  await t("端点在面板开关里能关掉，ping 会把它列进 disabled", () =>
    withPref("jsbridge.endpoint.enrich", false, async () => {
      assert.strictEqual((await epCall("/zoterojs/enrich",
        { headers: H, data: { findings: [finding("EN_BOOK")] } }))[0], 404);
      const ping = await epCall("/zoterojs/ping", { method: "GET", headers: {} });
      assert.ok(JSON.parse(ping[2]).disabled.includes("/zoterojs/enrich"));
    }));

  console.log("\n[8.9] stub 自检：没人接的 SQL");
  await t("跑过的每条 SQL 都被 stub 认出来了", () => {
    // 查询改了而 stub 没跟上时，stub 会返回空数组 —— 测试照样绿，但什么也没验。
    // 所以这里断言一条都没漏。
    assert.deepStrictEqual(sqlUnmatched, [], "有 SQL 没被 stub 接住，那些断言是空的");
  });
  await t("没有把 pref 全长当短名用", () => {
    // 真实实现里 Zotero.Prefs.get(k) 会自己补 extensions.zotero.，写成全长查的是另一把 key。
    // 面板的 preference= 属性倒是要用全长（它走 global=true）——两边容易写混，混了就静默失效。
    assert.deepStrictEqual(prefMisuse, [],
      "有 pref 用全长当短名读写（面板用全长，JS 用短名，别混）");
  });
  await t("★ LIKE 守卫不传 params 也拦（我一度以为不传就放行）", async () => {
    // 来源：真机上四个入口逐条实测过，不传第二参照样抛。
    // 之前 stub 写的是 `args !== undefined && …`，于是"不传参的字面量 LIKE"在 stub 里放行、
    // 在真机上抛 —— 假绿。这条断言专门钉住那个下界。
    await assert.rejects(
      () => sandboxGlobals.Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM items WHERE key LIKE 'A%'"),
      /LIKE clause with bindings/,
      "不传 params 就放行了一个字面量 LIKE —— stub 比真机松了");
    // 对照组：合法写法必须还能过。否则上面那条断言把"守卫太严"也一起放行了。
    await sandboxGlobals.Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM items WHERE key LIKE ?", ["A%"]);
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
