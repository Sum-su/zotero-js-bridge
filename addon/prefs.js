pref("extensions.zotero.jsbridge.token", "");
pref("extensions.zotero.jsbridge.enabled", true);
pref("extensions.zotero.jsbridge.readonly", false);
pref("extensions.zotero.jsbridge.endpoint.ping", true);
pref("extensions.zotero.jsbridge.endpoint.exec", true);
pref("extensions.zotero.jsbridge.endpoint.merge", true);
pref("extensions.zotero.jsbridge.endpoint.logs", true);
pref("extensions.zotero.jsbridge.endpoint.query", true);
pref("extensions.zotero.jsbridge.endpoint.doctor", true);
pref("extensions.zotero.jsbridge.endpoint.apply", true);
pref("extensions.zotero.jsbridge.endpoint.enrich", true);
pref("extensions.zotero.jsbridge.limit.responseKB", 1500);
// 低于这个字符数就当附件"没有文本层"，是扫描件。1000 是实测定的下界：
// 真扫描件抽出来是 0 或者几十个噪声字符（2D9U3FZP 全书 79 字符），
// 而一篇正常论文动辄几万（23NZF8PY 97248），中间是空的，不用精细调。
pref("extensions.zotero.jsbridge.enrich.minChars", 1000);
pref("extensions.zotero.jsbridge.backup.enabled", false);
pref("extensions.zotero.jsbridge.backup.keep", 5);
