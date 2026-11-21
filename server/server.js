"use strict";
// Fanara Wallet server — zero dependencies (Node 22+). SQLite ledger, invite-only signup.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const CFG = {
  port: +process.env.PORT || 3000,
  db: process.env.DB_PATH || path.join(__dirname, "data", "fanara.db"),
  adminKey: process.env.ADMIN_KEY || "",
  live: process.env.LIVE_MODE === "true",
  maxUsers: +process.env.MAX_USERS || 200,
  fee: 500, // milli-dinar fee on wallet-to-wallet send (0.500)
  dailyLimit: (+process.env.DAILY_LIMIT_LYD || 5000) * 1000,
};
const NAMES = { cur: "المحفظة الرئيسية", usd: "محفظة الدولار", wal: "محفظة المدخرات" };
const CUR = { cur: "د.ل", usd: "$", wal: "د.ل" };
const PRODUCTS = { lib: "ليبيانا", mad: "المدار الجديد", ltt: "LTT", giga: "Giga", itu: "iTunes", she: "SHEIN", bin: "Binance", etr: "eTravel" };

class ApiErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function open(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', tv INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), kind TEXT NOT NULL,
    number TEXT UNIQUE NOT NULL, balance INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, kind));
  CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, user_id INTEGER,
    idem_key TEXT, result TEXT, created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS tx_idem ON transactions(user_id, idem_key) WHERE idem_key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, tx_id INTEGER NOT NULL REFERENCES transactions(id),
    account_id INTEGER NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
    title TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS ent_acc ON entries(account_id, id);
  CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY, used_by INTEGER, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS topup_codes(code TEXT PRIMARY KEY, amount INTEGER NOT NULL, used_by INTEGER, used_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY, product TEXT NOT NULL, den INTEGER NOT NULL, code TEXT UNIQUE NOT NULL,
    sold_to INTEGER, sold_at TEXT);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, info TEXT);`);
  // system accounts (counter-parties). They may go negative: CASH is the liability for money issued to users.
  for (const [n, num] of [["cash", "SYS-CASH"], ["fees", "SYS-FEES"], ["store", "SYS-STORE"]])
    d.prepare("INSERT OR IGNORE INTO accounts(user_id,kind,number) VALUES(NULL,?,?)").run(n, num);
  return d;
}

const now = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " "); // Libya time (UTC+2)
const today = () => now().slice(0, 10);
const rnd = (n) => crypto.randomBytes(n).toString("hex").toUpperCase();

function makeApp(d) {
  const q = (sql, ...a) => d.prepare(sql).get(...a);
  const all = (sql, ...a) => d.prepare(sql).all(...a);
  const run = (sql, ...a) => d.prepare(sql).run(...a);
  const audit = (actor, action, info) => run("INSERT INTO audit(at,actor,action,info) VALUES(?,?,?,?)", now(), String(actor), action, info ? JSON.stringify(info) : null);

  function secret() {
    let r = q("SELECT v FROM settings WHERE k='secret'");
    if (!r) { run("INSERT INTO settings VALUES('secret',?)", process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex")); r = q("SELECT v FROM settings WHERE k='secret'"); }
    return r.v;
  }
  const SECRET = secret();
  const b64 = (b) => Buffer.from(b).toString("base64url");
  function sign(u) {
    const p = b64(JSON.stringify({ u: u.id, v: u.tv, e: Math.floor(Date.now() / 1000) + 12 * 3600 }));
    return p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
  }
  function verify(tok) {
    if (typeof tok !== "string") return null;
    const [p, s] = tok.split(".");
    if (!p || !s) return null;
    const ok = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
    if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
    let j; try { j = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
    if (!j.e || j.e < Date.now() / 1000) return null;
    const u = q("SELECT * FROM users WHERE id=?", j.u);
    return u && u.status === "active" && u.tv === j.v ? u : null;
  }
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
  const checkPw = (u, pw) => { const h = Buffer.from(hash(pw, u.pw_salt)), o = Buffer.from(u.pw_hash); return h.length === o.length && crypto.timingSafeEqual(h, o); };

  // Atomic section. BEGIN IMMEDIATE takes the write lock up front: concurrent requests are serialised.
  function atomic(fn) {
    d.exec("BEGIN IMMEDIATE");
    try { const r = fn(); d.exec("COMMIT"); return r; } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; }
  }

  // Double-entry posting. legs: [{acc:accountId, amt:signed int, title, type}] must sum to 0.
  function post(userId, kind, idem, legs) {
    if (legs.reduce((s, l) => s + l.amt, 0) !== 0) throw new Error("unbalanced transaction");
    const delta = new Map();
    for (const l of legs) delta.set(l.acc, (delta.get(l.acc) || 0) + l.amt);
    for (const [id, dl] of delta) {
      const a = q("SELECT * FROM accounts WHERE id=?", id);
      if (!a) throw new Error("no account");
      if (a.user_id !== null && a.balance + dl < 0) throw new ApiErr(400, "الرصيد غير كافٍ");
    }
    const ref = "FW-" + Date.now().toString(36).toUpperCase() + rnd(3), at = now();
    const t = run("INSERT INTO transactions(ref,kind,user_id,idem_key,created_at) VALUES(?,?,?,?,?)", ref, kind, userId, idem || null, at);
    const out = {};
    for (const l of legs) {
      run("UPDATE accounts SET balance=balance+? WHERE id=?", l.amt, l.acc);
      const bal = q("SELECT balance FROM accounts WHERE id=?", l.acc).balance;
      run("INSERT INTO entries(tx_id,account_id,amount,balance_after,title,type,created_at) VALUES(?,?,?,?,?,?,?)", t.lastInsertRowid, l.acc, l.amt, bal, l.title, l.type, at);
      out[l.acc] = bal;
    }
    return { txId: Number(t.lastInsertRowid), ref, date: at, bal: out };
  }
  const sys = (k) => q("SELECT id FROM accounts WHERE kind=? AND user_id IS NULL", k).id;
  const acct = (uid, kind) => q("SELECT * FROM accounts WHERE user_id=? AND kind=?", uid, kind);

  // Idempotent wrapper: same (user,key) returns the first result and never posts twice.
  function idem(u, key, fn) {
    if (typeof key !== "string" || key.length < 8 || key.length > 64) throw new ApiErr(400, "مفتاح العملية مطلوب");
    return atomic(() => {
      const prev = q("SELECT result FROM transactions WHERE user_id=? AND idem_key=?", u.id, key);
      if (prev) return { ...JSON.parse(prev.result), replayed: true };
      const { _tx, ...pub } = fn();
      run("UPDATE transactions SET result=? WHERE id=?", JSON.stringify(pub), _tx);
      return pub;
    });
  }
  const fin = (res, extra) => { const r = { ok: true, ref: res.ref, date: res.date, ...extra, _tx: res.txId }; return r; };

  const amountOf = (v) => { if (!Number.isInteger(v) || v <= 0 || v > 1e12) throw new ApiErr(400, "المبلغ غير صحيح"); return v; };
  function dailyOut(uid) {
    const a = acct(uid, "cur");
    const r = q("SELECT COALESCE(-SUM(amount),0) s FROM entries WHERE account_id=? AND type IN ('send','qr') AND created_at>=?", a.id, today() + " 00:00");
    return r.s;
  }
  function checkLimit(uid, amt) { if (dailyOut(uid) + amt > CFG.dailyLimit) throw new ApiErr(400, "تجاوزت الحد اليومي للإرسال"); }

  // ---- handlers ----
  const H = {};
  const fails = new Map();
  const phoneOk = (p) => typeof p === "string" && /^09\d{8}$/.test(p);

  H.health = () => ({ ok: true, live: CFG.live, fee: CFG.fee, open: q("SELECT COUNT(*) c FROM users").c < CFG.maxUsers });

  H.register = (b) => {
    const name = String(b.name || "").trim(), phone = b.phone, pw = String(b.password || ""), inv = String(b.invite || "").trim().toUpperCase();
    if (name.length < 2 || name.length > 40) throw new ApiErr(400, "أدخل اسمًا صحيحًا");
    if (!phoneOk(phone)) throw new ApiErr(400, "رقم الهاتف غير صحيح (10 أرقام يبدأ بـ 09)");
    if (pw.length < 8 || pw.length > 100) throw new ApiErr(400, "كلمة المرور 8 أحرف على الأقل");
    return atomic(() => {
      if (q("SELECT COUNT(*) c FROM users").c >= CFG.maxUsers) throw new ApiErr(403, "اكتمل عدد المستخدمين");
      const iv = q("SELECT * FROM invites WHERE code=?", inv);
      if (!iv || iv.used_by) throw new ApiErr(400, "رمز الدعوة غير صالح");
      if (q("SELECT 1 x FROM users WHERE phone=?", phone)) throw new ApiErr(400, "رقم الهاتف مسجل من قبل");
      const salt = rnd(16), at = now();
      const u = run("INSERT INTO users(phone,name,pw_hash,pw_salt,created_at) VALUES(?,?,?,?,?)", phone, name, hash(pw, salt), salt, at);
      const uid = Number(u.lastInsertRowid);
      for (const k of ["cur", "usd", "wal"]) {
        for (let i = 0; i < 20; i++) {
          const num = "W-" + [1, 2, 3].map(() => String(crypto.randomInt(0, 10000)).padStart(4, "0")).join("-");
          try { run("INSERT INTO accounts(user_id,kind,number) VALUES(?,?,?)", uid, k, num); break; } catch (e) { if (i === 19) throw e; }
        }
      }
      run("UPDATE invites SET used_by=? WHERE code=?", uid, inv);
      audit(uid, "register", { phone });
      return { ok: true };
    });
  };

  H.login = (b, ctx) => {
    const phone = b.phone, key = String(phone) + "|" + ctx.ip, f = fails.get(key);
    if (f && f.until > Date.now()) throw new ApiErr(429, "محاولات كثيرة. حاول بعد قليل");
    const u = phoneOk(phone) ? q("SELECT * FROM users WHERE phone=?", phone) : null;
    // run a hash anyway so timing does not reveal whether the phone exists
    const good = u ? checkPw(u, String(b.password || "")) : (hash(String(b.password || ""), "x".repeat(32)), false);
    if (!good || u.status !== "active") {
      const n = (f && !(f.until && f.until <= Date.now()) ? f.n : 0) + 1;
      fails.set(key, { n, until: n >= 5 ? Date.now() + 15 * 60e3 : 0 });
      throw new ApiErr(401, "رقم الهاتف أو كلمة المرور غير صحيحة");
    }
    fails.delete(key);
    return { ok: true, token: sign(u), user: { name: u.name, phone: u.phone } };
  };

  H.state = (b, ctx) => {
    const u = ctx.user;
    const accs = all("SELECT * FROM accounts WHERE user_id=? ORDER BY CASE kind WHEN 'cur' THEN 0 WHEN 'usd' THEN 1 ELSE 2 END", u.id);
    const ids = accs.map((a) => a.id), kindOf = Object.fromEntries(accs.map((a) => [a.id, a.kind]));
    const rows = all(`SELECT e.id,e.account_id,e.amount,e.balance_after,e.title,e.type,e.created_at,t.ref FROM entries e JOIN transactions t ON t.id=e.tx_id
      WHERE e.account_id IN (${ids.map(() => "?").join(",")}) ORDER BY e.id DESC LIMIT 300`, ...ids);
    return {
      ok: true, user: { name: u.name, phone: u.phone },
      accs: accs.map((a) => ({ id: a.kind, n: NAMES[a.kind], no: a.number, c: CUR[a.kind], m: a.balance })),
      tx: rows.map((r) => ({ id: r.id, ref: r.ref, title: r.title, type: r.type, date: r.created_at, amt: r.amount, acc: kindOf[r.account_id], st: "مكتمل", bal: r.balance_after })),
      dailyLeft: Math.max(0, CFG.dailyLimit - dailyOut(u.id)),
    };
  };

  H.payee = (b, ctx) => {
    let r;
    if (b.phone) r = q("SELECT u.name, u.phone, a.number FROM users u JOIN accounts a ON a.user_id=u.id AND a.kind='cur' WHERE u.phone=? AND u.status='active'", String(b.phone));
    else if (b.no) r = q("SELECT u.name, u.phone, a.number FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.number=? AND a.kind='cur' AND u.status='active'", String(b.no));
    if (!r) throw new ApiErr(404, "المحفظة غير موجودة");
    if (r.phone === ctx.user.phone) throw new ApiErr(400, "لا يمكن الإرسال إلى محفظتك نفسها");
    return { ok: true, name: r.name, no: r.number, phone: r.phone };
  };

  function payTo(u, payee, amt, key, fee, type, label) {
    return idem(u, key, () => {
      const from = acct(u.id, "cur"), to = acct(payee.id, "cur");
      if (from.id === to.id) throw new ApiErr(400, "لا يمكن الإرسال إلى محفظتك نفسها");
      checkLimit(u.id, amt + fee);
      const legs = [
        { acc: from.id, amt: -amt, title: `${label} ${payee.name}`, type },
        { acc: to.id, amt, title: `استلام من ${u.name}`, type: "transfer" },
      ];
      if (fee) legs.push({ acc: from.id, amt: -fee, title: `رسوم إرسال إلى ${payee.name}`, type: "fee" }, { acc: sys("fees"), amt: fee, title: "رسوم", type: "fee" });
      const r = post(u.id, type, key, legs);
      audit(u.id, type, { to: payee.id, amt, ref: r.ref });
      return fin(r, { bal: r.bal[from.id], name: payee.name });
    });
  }

  H.send = (b, ctx) => {
    const amt = amountOf(b.amount), p = phoneOk(b.phone) ? q("SELECT * FROM users WHERE phone=? AND status='active'", b.phone) : null;
    if (!p) throw new ApiErr(404, "المحفظة غير موجودة");
    return payTo(ctx.user, p, amt, b.key, CFG.fee, "send", "إرسال إلى");
  };
  H.qrpay = (b, ctx) => {
    const amt = amountOf(b.amount), a = q("SELECT user_id FROM accounts WHERE number=? AND kind='cur' AND user_id IS NOT NULL", String(b.no || ""));
    const p = a && q("SELECT * FROM users WHERE id=? AND status='active'", a.user_id);
    if (!p) throw new ApiErr(404, "رمز غير معروف");
    return payTo(ctx.user, p, amt, b.key, 0, "qr", "دفع QR إلى");
  };

  H.transfer = (b, ctx) => {
    const u = ctx.user, amt = amountOf(b.amount), f = b.from, t = b.to;
    if (!["cur", "wal"].includes(f) || !["cur", "wal"].includes(t) || f === t) throw new ApiErr(400, "اختر محفظتين مختلفتين");
    return idem(u, b.key, () => {
      const A = acct(u.id, f), B = acct(u.id, t);
      const r = post(u.id, "transfer", b.key, [
        { acc: A.id, amt: -amt, title: `تحويل إلى ${NAMES[t]}`, type: "transfer" },
        { acc: B.id, amt, title: `تحويل من ${NAMES[f]}`, type: "transfer" }]);
      return fin(r, { bal: r.bal[A.id] });
    });
  };

  H.topup = (b, ctx) => {
    const u = ctx.user, code = String(b.code || "").trim().toUpperCase();
    if (!code) throw new ApiErr(400, "أدخل رمز الشحن");
    return idem(u, b.key, () => {
      const c = q("SELECT * FROM topup_codes WHERE code=?", code);
      if (!c) throw new ApiErr(400, "رمز غير صالح");
      if (c.used_by) throw new ApiErr(400, "تم استخدام هذا الرمز من قبل");
      run("UPDATE topup_codes SET used_by=?, used_at=? WHERE code=? AND used_by IS NULL", u.id, now(), code);
      const A = acct(u.id, "cur");
      const r = post(u.id, "topup", b.key, [
        { acc: sys("cash"), amt: -c.amount, title: "إصدار رصيد", type: "topup" },
        { acc: A.id, amt: c.amount, title: "شحن المحفظة", type: "topup" }]);
      audit(u.id, "topup", { code: code.slice(0, 4) + "…", amt: c.amount });
      return fin(r, { bal: r.bal[A.id], amount: c.amount });
    });
  };

  H.order = (b, ctx) => {
    const u = ctx.user, den = b.den, prod = b.product, kind = b.acc;
    if (!PRODUCTS[prod] || !Number.isInteger(den) || den <= 0 || den > 100000 || !["cur", "wal"].includes(kind)) throw new ApiErr(400, "طلب غير صحيح");
    return idem(u, b.key, () => {
      const card = q("SELECT * FROM cards WHERE product=? AND den=? AND sold_to IS NULL ORDER BY id LIMIT 1", prod, den);
      if (!card) throw new ApiErr(409, "نفد المخزون من هذه الفئة");
      run("UPDATE cards SET sold_to=?, sold_at=? WHERE id=? AND sold_to IS NULL", u.id, now(), card.id);
      const A = acct(u.id, kind), price = den * 1000;
      const r = post(u.id, "card", b.key, [
        { acc: A.id, amt: -price, title: `شراء كرت ${PRODUCTS[prod]} ${den} د.ل`, type: "card" },
        { acc: sys("store"), amt: price, title: "مبيعات الكروت", type: "card" }]);
      audit(u.id, "order", { product: prod, den, ref: r.ref });
      return fin(r, { bal: r.bal[A.id], code: card.code, wallet: kind });
    });
  };
  H.stock = () => {
    const rows = all("SELECT product, den, COUNT(*) n FROM cards WHERE sold_to IS NULL GROUP BY product, den");
    return { ok: true, stock: rows };
  };

  H.password = (b, ctx) => {
    const u = ctx.user, np = String(b.new || "");
    if (!checkPw(u, String(b.old || ""))) throw new ApiErr(400, "كلمة المرور الحالية غير صحيحة");
    if (np.length < 8 || np.length > 100) throw new ApiErr(400, "كلمة المرور الجديدة 8 أحرف على الأقل");
    const salt = rnd(16);
    run("UPDATE users SET pw_hash=?, pw_salt=?, tv=tv+1 WHERE id=?", hash(np, salt), salt, u.id);
    audit(u.id, "password", null);
    const nu = q("SELECT * FROM users WHERE id=?", u.id);
    return { ok: true, token: sign(nu) };
  };

  // ---- admin (ADMIN_KEY header) ----
  const A = {};
  A.invites = (b) => { const n = Math.min(Math.max(+b.count || 1, 1), 200), out = []; for (let i = 0; i < n; i++) { const c = rnd(4); run("INSERT INTO invites VALUES(?,NULL,?)", c, now()); out.push(c); } audit("admin", "invites", { n }); return { ok: true, codes: out }; };
  A.topupCodes = (b) => {
    const amt = amountOf(b.amount), n = Math.min(Math.max(+b.count || 1, 1), 500), out = [];
    atomic(() => { for (let i = 0; i < n; i++) { const c = "FW-" + rnd(4) + "-" + rnd(2); run("INSERT INTO topup_codes VALUES(?,?,NULL,NULL,?)", c, amt, now()); out.push(c); } });
    audit("admin", "topup-codes", { n, amt }); return { ok: true, codes: out };
  };
  A.cards = (b) => {
    if (!PRODUCTS[b.product] || !Number.isInteger(b.den) || b.den <= 0 || !Array.isArray(b.codes)) throw new ApiErr(400, "بيانات غير صحيحة");
    let added = 0, dup = 0;
    atomic(() => { for (const c of b.codes.map((x) => String(x).trim()).filter(Boolean)) { try { run("INSERT INTO cards(product,den,code) VALUES(?,?,?)", b.product, b.den, c); added++; } catch { dup++; } } });
    audit("admin", "cards", { product: b.product, den: b.den, added }); return { ok: true, added, duplicates: dup };
  };
  A.resetPassword = (b) => {
    const u = q("SELECT * FROM users WHERE phone=?", String(b.phone || "")), np = String(b.password || "");
    if (!u) throw new ApiErr(404, "المستخدم غير موجود");
    if (np.length < 8) throw new ApiErr(400, "كلمة المرور 8 أحرف على الأقل");
    const salt = rnd(16); run("UPDATE users SET pw_hash=?, pw_salt=?, tv=tv+1 WHERE id=?", hash(np, salt), salt, u.id); audit("admin", "reset-password", { u: u.id }); return { ok: true };
  };
  A.status = (b) => {
    if (!["active", "suspended"].includes(b.status)) throw new ApiErr(400, "حالة غير صحيحة");
    const r = run("UPDATE users SET status=?, tv=tv+1 WHERE phone=?", b.status, String(b.phone || ""));
    if (!r.changes) throw new ApiErr(404, "المستخدم غير موجود"); audit("admin", "status", b); return { ok: true };
  };
  A.summary = () => {
    const users = q("SELECT COUNT(*) c FROM users").c;
    const userBal = q("SELECT COALESCE(SUM(balance),0) s FROM accounts WHERE user_id IS NOT NULL").s;
    const sysRows = all("SELECT kind, balance FROM accounts WHERE user_id IS NULL");
    const entriesSum = q("SELECT COALESCE(SUM(amount),0) s FROM entries").s;
    const mismatch = q(`SELECT COUNT(*) c FROM accounts a WHERE a.balance != COALESCE((SELECT SUM(amount) FROM entries e WHERE e.account_id=a.id),0)`).c;
    const unbalanced = q(`SELECT COUNT(*) c FROM (SELECT tx_id FROM entries GROUP BY tx_id HAVING SUM(amount)!=0)`).c;
    const neg = q("SELECT COUNT(*) c FROM accounts WHERE user_id IS NOT NULL AND balance<0").c;
    return { ok: true, users, maxUsers: CFG.maxUsers, userBalances: userBal, system: Object.fromEntries(sysRows.map((r) => [r.kind, r.balance])),
      ledgerSum: entriesSum, accountMismatch: mismatch, unbalancedTx: unbalanced, negativeAccounts: neg,
      consistent: entriesSum === 0 && mismatch === 0 && unbalanced === 0 && neg === 0,
      invitesLeft: q("SELECT COUNT(*) c FROM invites WHERE used_by IS NULL").c, topupCodesLeft: q("SELECT COUNT(*) c FROM topup_codes WHERE used_by IS NULL").c,
      cardsInStock: q("SELECT COUNT(*) c FROM cards WHERE sold_to IS NULL").c };
  };

  const PUBLIC = { "GET /api/health": H.health, "POST /api/register": H.register, "POST /api/login": H.login };
  const AUTHED = { "GET /api/state": H.state, "GET /api/payee": H.payee, "POST /api/send": H.send, "POST /api/qrpay": H.qrpay, "POST /api/transfer": H.transfer,
    "POST /api/topup": H.topup, "POST /api/order": H.order, "GET /api/stock": H.stock, "POST /api/password": H.password };
  const ADMIN = { "POST /api/admin/invites": A.invites, "POST /api/admin/topup-codes": A.topupCodes, "POST /api/admin/cards": A.cards,
    "POST /api/admin/reset-password": A.resetPassword, "POST /api/admin/status": A.status, "GET /api/admin/summary": A.summary };
  return { route: (m, p) => PUBLIC[m + " " + p] ? [PUBLIC[m + " " + p], "public"] : AUTHED[m + " " + p] ? [AUTHED[m + " " + p], "user"] : ADMIN[m + " " + p] ? [ADMIN[m + " " + p], "admin"] : null, verify, close: () => d.close() };
}

const STATIC = { "/": "index.html", "/index.html": "index.html", "/manifest.webmanifest": "manifest.webmanifest", "/sw.js": "sw.js",
  "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png", "/og-image.png": "og-image.png", "/admin": "server/admin.html", "/admin.html": "server/admin.html" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function createServer(d) {
  const app = makeApp(d), hits = new Map();
  setInterval(() => hits.clear(), 60e3).unref();
  const send = (res, code, obj, extra) => { const b = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(b); };
  return http.createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("x-frame-options", "DENY");
    const url = new URL(req.url, "http://x"), ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!url.pathname.startsWith("/api/")) {
      const f = STATIC[url.pathname];
      if (!f || req.method !== "GET") { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": f === "sw.js" || f === "index.html" ? "no-cache" : "public, max-age=3600" });
      return res.end(fs.readFileSync(full));
    }
    const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > 300) return send(res, 429, { ok: false, error: "طلبات كثيرة" });
    const r = app.route(req.method, url.pathname);
    if (!r) return send(res, 404, { ok: false, error: "غير موجود" });
    let raw = "", size = 0;
    req.on("data", (c) => { size += c.length; if (size > 65536) { send(res, 413, { ok: false, error: "الطلب كبير" }); req.destroy(); } else raw += c; });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        let body = {};
        if (req.method === "POST") { try { body = raw ? JSON.parse(raw) : {}; } catch { throw new ApiErr(400, "طلب غير صحيح"); } if (!body || typeof body !== "object") throw new ApiErr(400, "طلب غير صحيح"); }
        else for (const [k, v] of url.searchParams) body[k] = v;
        const ctx = { ip };
        if (r[1] === "admin") {
          const k = String(req.headers["x-admin-key"] || "");
          if (!CFG.adminKey || k.length !== CFG.adminKey.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(CFG.adminKey))) throw new ApiErr(403, "غير مصرح");
        } else if (r[1] === "user") {
          const m = /^Bearer (.+)$/.exec(req.headers.authorization || ""), u = m && app.verify(m[1]);
          if (!u) throw new ApiErr(401, "انتهت الجلسة. سجّل الدخول من جديد");
          ctx.user = u;
        }
        send(res, 200, r[0](body, ctx));
      } catch (e) {
        if (e instanceof ApiErr) send(res, e.code, { ok: false, error: e.message });
        else { console.error(e); send(res, 500, { ok: false, error: "خطأ في الخادم" }); }
      }
    });
  });
}

module.exports = { open, createServer, CFG };
if (require.main === module) {
  const d = open(CFG.db);
  if (!CFG.adminKey) console.warn("ADMIN_KEY not set: admin API disabled");
  createServer(d).listen(CFG.port, () => console.log(`Fanara server on :${CFG.port} (live=${CFG.live}, max users=${CFG.maxUsers})`));
}
