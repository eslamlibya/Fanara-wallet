// Usage: node tests.js [path-to-html]
const fs = require("fs"), vm = require("vm");
const file = process.argv[2] || "fanara-wallet-v2.html";
const html = fs.readFileSync(file, "utf8");
const src = html.split("<script>")[1].split("</script>")[0];
let pass = 0, fail = 0;
const t = (n, c) => { c ? pass++ : (fail++, console.log("FAIL:", n)); };

// 0) Names that a browser forbids as global declarations (this was the "app won't open" bug)
const RESERVED = ["top","self","window","document","location","parent","frames","opener","name","status","history","length","origin","closed","event","screen","navigator"];
const declared = [...src.matchAll(/(?:^|[\n;}])\s*(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/g)].map(m => m[1] || m[2]);
t("no reserved global names declared: " + declared.filter(n => RESERVED.includes(n)).join(","), !declared.some(n => RESERVED.includes(n)));

function boot() {
  const store = {}, inputs = {}, app = { innerHTML: "" };
  const ctx = {
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    window: { scrollY: 0, scrollTo() {} },
    document: { getElementById: id => id === "app" ? app : (inputs[id] ? inputs[id] : null), documentElement: { removeAttribute() {}, setAttribute() {} } },
    navigator: { onLine: true }, location: { protocol: "file:" }, setTimeout: () => 0, console, Date, Math, JSON, parseFloat, String, Object, Array, RegExp, Number, Error
  };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__api={S:S,get D(){return D},A:A,post:post,doL:doL,doX:doX,doF:doF,buy:buy,vw:vw,tg:tg,rs:rs,go:go,back:back,mny:mny,hist:hist,CAT:CAT,LOGOS:LOGOS,doS:doS,csend:csend,doT:doT,spark:spark,FEE:FEE,recv:recv,sendv:sendv,topv:topv,trf:trf}", ctx);
  return { api: ctx.__api, app, inputs, store };
}

// 1) Login
let { api, app, inputs } = boot();
t("login screen renders", app.innerHTML.includes("تسجيل الدخول"));
inputs.lu = { value: "" }; inputs.lp = { value: "" }; api.doL();
t("login: empty fields rejected", !api.S.login);
inputs.lu.value = "0911111111"; inputs.lp.value = "x"; api.doL();
t("login: wrong data rejected", !api.S.login);
inputs.lu.value = "0912345678"; inputs.lp.value = "demo"; api.doL();
t("login: test account accepted", api.S.login === true);
t("home renders after login", app.innerHTML.includes("Fanara Wallet") && app.innerHTML.includes("1,367,842.457"));
inputs.fu = { value: "123" }; api.S.login = false; api.S.fp = true; api.doF();
t("forgot password: invalid phone rejected", api.S.err.length > 0 && !api.S.fpd);
inputs.fu.value = "0912345678"; api.doF();
t("forgot password: simulation message only", api.S.fpd === true && app.innerHTML.includes("محاكاة"));
api.S.login = true; api.S.fp = false;

// 2) Balances and hiding
t("opening balance is exact", api.A("cur").m === 1367842457);
api.tg("cur");
t("hide: only one account hidden", api.D.hid.cur === true && !api.D.hid.wal && !api.D.hid.usd);
t("hide: masked in HTML", app.innerHTML.includes("****"));
api.tg("cur");

// 3) Store purchase
const opening = api.A("cur").m, n0 = api.D.tx.length;
api.vw("prod", { p: { id: "lib", den: 20, acc: "cur" } });
api.S.confirm = true; api.S.key = 0.5; api.buy();
t("purchase: balance reduced by 20.000", api.A("cur").m === opening - 20000);
t("purchase: one ledger entry", api.D.tx.length === n0 + 1);
t("purchase: receipt shown with DEMO code", api.S.v === "rcpt" && /DEMO-\d{4}-\d{4}-\d{4}/.test(app.innerHTML));
api.buy(); // repeated press with same confirmation key
t("purchase: repeat press does not charge twice", api.A("cur").m === opening - 20000 && api.D.tx.length === n0 + 1);
api.vw("prod", { p: { id: "bin", den: 100, acc: "wal" } }); api.S.confirm = true; api.S.key = 0.7; api.buy();
t("purchase: insufficient funds blocked", api.A("wal").m === 0 && api.S.err.length > 0 && api.D.tx.length === n0 + 1);
t("catalog: 8 cards with logos", api.CAT.length === 8 && api.CAT.every(c => api.LOGOS[c.id]));

// 4) Transfers
const setX = (f, to, a) => { inputs.xf = { value: f }; inputs.xt = { value: to }; inputs.xa = { value: a }; };
const cases = [["cur", "wal", "", "empty amount"], ["cur", "wal", "-5", "negative"], ["cur", "wal", "0", "zero"], ["cur", "wal", "abc", "non numeric"], ["cur", "wal", "1.2345", "4 decimals"], ["cur", "cur", "5", "same account"], ["wal", "cur", "1", "exceeds balance"]];
cases.forEach(([f, to, a, name]) => { const before = JSON.stringify(api.D.accs.map(x => x.m)); const len = api.D.tx.length; setX(f, to, a); api.doX(); t("transfer rejected: " + name, JSON.stringify(api.D.accs.map(x => x.m)) === before && api.D.tx.length === len && api.S.err.length > 0); });
const c1 = api.A("cur").m, len1 = api.D.tx.length; setX("cur", "wal", "100.250"); api.doX();
t("transfer ok: source reduced", api.A("cur").m === c1 - 100250);
t("transfer ok: target increased", api.A("wal").m === 100250);
t("transfer ok: two ledger entries", api.D.tx.length === len1 + 2);

// 5) Reconciliation: closing balance = opening + signed sum of new entries
const newTx = api.D.tx.filter(x => x.id > 0);
const sumCur = newTx.filter(x => x.acc === "cur").reduce((s, x) => s + x.amt, 0);
t("reconcile current account", api.A("cur").m === 1367842457 + sumCur);
t("reconcile wallet", api.A("wal").m === newTx.filter(x => x.acc === "wal").reduce((s, x) => s + x.amt, 0));
t("balance-after matches latest entry", api.D.tx.find(x => x.acc === "cur" && x.id > 0).bal === api.A("cur").m);
t("refs unique", new Set(api.D.tx.map(x => x.ref)).size === api.D.tx.length);

// 6) Screens render, history filters, reset
["store", "hist", "xfer"].forEach(v => { api.vw(v); t("screen renders: " + v, app.innerHTML.length > 500); });
api.vw("txd", { tid: api.D.tx[0].id }); t("details render", app.innerHTML.includes(api.D.tx[0].ref));
api.S.q = "zzzz-none"; api.vw("hist"); t("history: empty search state", app.innerHTML.includes("لا توجد حركات مطابقة"));
api.S.q = ""; api.S.d1 = "2099-01-01"; api.vw("hist"); t("history: date filter", app.innerHTML.includes("لا توجد حركات مطابقة"));
api.S.d1 = "";
["home", "trf", "prof"].forEach(tab => { api.S.v = ""; api.go(tab); t("tab renders: " + tab, app.innerHTML.length > 500); });
["cards", "ana"].forEach(x => { api.S.v = ""; api.S.tab = "home"; api.S.top = x; api.go("home"); t("home sub-tab renders: " + x, app.innerHTML.length > 500); });
api.rs(); t("reset restores balance and ledger", api.A("cur").m === 1367842457 && api.D.tx.length === 5 && api.A("wal").m === 0);


// 6b) Wallet features: send to wallet, top-up, receive, sparkline
api.rs(); api.S.login = true; api.S.err = "";
const sendIn = (ph, a) => { inputs.sp = { value: ph }; inputs.sa = { value: a }; api.doS(); };
sendIn("0999999999", "5"); t("send: unknown wallet rejected", api.S.err.includes("غير موجودة") && !api.S.sc);
sendIn("12", "5"); t("send: bad phone rejected", api.S.err.length > 0 && !api.S.sc);
sendIn("0911111111", "-5"); t("send: negative rejected", api.S.err.length > 0 && !api.S.sc);
sendIn("0911111111", "0"); t("send: zero rejected", api.S.err.length > 0 && !api.S.sc);
sendIn("0911111111", "99999999999"); t("send: amount over balance rejected", api.S.err.includes("غير كافٍ") && !api.S.sc);
const b0 = api.A("cur").m, l0 = api.D.tx.length;
sendIn("0911111111", "10.250"); t("send: valid reaches confirmation", !!api.S.sc && api.D.tx.length === l0);
api.csend(); t("send: debits amount + fee once", api.A("cur").m === b0 - 10250 - api.FEE && api.D.tx.length === l0 + 2);
t("send: receipt shown", api.S.v === "srcpt");
api.S.sc = null; api.csend(); t("send: repeat confirm ignored", api.A("cur").m === b0 - 10250 - api.FEE);
const bt = api.A("cur").m; inputs.tc = { value: "bad" }; api.doT(); t("top-up: invalid code rejected", api.A("cur").m === bt && api.S.err.length > 0);
inputs.tc.value = "fw-topup-50"; api.doT(); t("top-up: valid code credits 50.000", api.A("cur").m === bt + 50000);
inputs.tc.value = "FW-TOPUP-50"; api.doT(); t("top-up: code is single-use", api.A("cur").m === bt + 50000 && api.S.err.includes("من قبل"));
t("receive screen renders", api.recv().includes("0912345678"));
t("sparkline renders with data", api.spark().includes("polyline"));
t("trf tab lists wallet actions", api.trf().includes("إرسال إلى محفظة") && api.trf().includes("استلام أموال"));
t("no bank-account wording in tabs", !api.trf().includes("مصرف"));
api.rs(); t("sparkline empty state", api.spark().includes("لا توجد بيانات كافية"));

// 7) Persistence across restart
({ api, app, inputs, store: global.__s } = boot());
const b2 = boot(); b2.api.post("cur", -5000, "x", "card"); b2.store.fanara3 = JSON.stringify({ D: b2.api.D, login: true, theme: "auto" });
t("storage has no password", !b2.store.fanara3.includes("demo\""));

console.log(`\nPassed: ${pass}  Failed: ${fail}`);
process.exit(fail ? 1 : 0);
