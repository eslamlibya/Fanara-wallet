"use strict";
// Integration tests: starts the real HTTP server on a temp DB and calls the API.
const { open, createServer, CFG } = require("./server.js");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
CFG.adminKey = "test-admin-key"; CFG.maxUsers = 4;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fw-")), "t.db");
const d = open(file), srv = createServer(d);
let pass = 0, fail = 0;
const ok = (name, c, extra) => { if (c) pass++; else { fail++; console.log("FAIL:", name, extra === undefined ? "" : JSON.stringify(extra)); } };
let base;
const call = async (m, p, body, tok, admin) => {
  const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}), ...(admin ? { "x-admin-key": admin === true ? "test-admin-key" : admin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json() };
};
const K = () => "k" + Math.random().toString(36).slice(2) + Date.now();
(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = "http://127.0.0.1:" + srv.address().port;
  let r = await call("GET", "/api/health"); ok("health", r.j.ok && r.j.fee === 500 && r.j.open === true);
  r = await call("POST", "/api/admin/invites", { count: 5 }); ok("admin needs key", r.s === 403);
  r = await call("POST", "/api/admin/invites", { count: 5 }, null, "wrong"); ok("admin wrong key", r.s === 403);
  r = await call("POST", "/api/admin/invites", { count: 5 }, null, true); const inv = r.j.codes; ok("invites", inv.length === 5);
  const reg = (name, phone, pw, i) => call("POST", "/api/register", { name, phone, password: pw, invite: i });
  r = await reg("أحمد", "0911111111", "password1", "BAD"); ok("bad invite", r.s === 400);
  r = await reg("أحمد", "123", "password1", inv[0]); ok("bad phone", r.s === 400);
  r = await reg("أحمد", "0911111111", "short", inv[0]); ok("short pw", r.s === 400);
  r = await reg("أحمد", "0911111111", "password1", inv[0]); ok("register A", r.j.ok);
  r = await reg("x", "0911111111", "password1", inv[1]); ok("dup phone", r.s === 400);
  r = await reg("سالم", "0922222222", "password2", inv[0]); ok("invite single use", r.s === 400);
  r = await reg("سالم", "0922222222", "password2", inv[1]); ok("register B", r.j.ok);
  r = await reg("فاطمة", "0933333333", "password3", inv[2]); ok("register C", r.j.ok);
  r = await reg("علي", "0944444444", "password4", inv[3]); ok("register D (4th = max)", r.j.ok);
  r = await reg("زائد", "0955555555", "password5", inv[4]); ok("max users enforced", r.s === 403);
  r = await call("GET", "/api/health"); ok("health closed when full", r.j.open === false);

  r = await call("POST", "/api/login", { phone: "0911111111", password: "wrong" }); ok("wrong pw", r.s === 401);
  r = await call("POST", "/api/login", { phone: "0900000000", password: "x" }); ok("unknown phone same error", r.s === 401 && r.j.error.includes("غير صحيحة"));
  const A = (await call("POST", "/api/login", { phone: "0911111111", password: "password1" })).j.token;
  const B = (await call("POST", "/api/login", { phone: "0922222222", password: "password2" })).j.token;
  const C = (await call("POST", "/api/login", { phone: "0933333333", password: "password3" })).j.token;
  ok("tokens", A && B && C);
  r = await call("GET", "/api/state"); ok("state needs auth", r.s === 401);
  r = await call("GET", "/api/state", null, A + "x"); ok("tampered token", r.s === 401);
  r = await call("GET", "/api/state", null, A); ok("initial zero", r.j.accs.length === 3 && r.j.accs.every((a) => a.m === 0) && r.j.tx.length === 0 && /^W-\d{4}-\d{4}-\d{4}$/.test(r.j.accs[0].no));
  const noA = r.j.accs[0].no;

  // top-up
  r = await call("POST", "/api/admin/topup-codes", { amount: 100000, count: 3 }, null, true); const tc = r.j.codes; ok("topup codes", tc.length === 3);
  r = await call("POST", "/api/topup", { code: "NOPE", key: K() }, A); ok("bad topup code", r.s === 400);
  const k1 = K(); r = await call("POST", "/api/topup", { code: tc[0], key: k1 }, A); ok("topup ok", r.j.ok && r.j.bal === 100000 && r.j.amount === 100000);
  r = await call("POST", "/api/topup", { code: tc[0], key: k1 }, A); ok("topup replay same key => same result", r.j.replayed === true && r.j.bal === 100000);
  r = await call("POST", "/api/topup", { code: tc[0], key: K() }, B); ok("topup code single use", r.s === 400);
  r = await call("GET", "/api/state", null, A); ok("balance after topup (once)", r.j.accs[0].m === 100000 && r.j.tx.length === 1);

  // send with fee
  r = await call("POST", "/api/send", { phone: "0922222222", amount: 10000, key: K() }, A); ok("send ok", r.j.ok && r.j.bal === 100000 - 10000 - 500, r);
  const kk = K(); r = await call("POST", "/api/send", { phone: "0922222222", amount: 1000, key: kk }, A);
  const r2 = await call("POST", "/api/send", { phone: "0922222222", amount: 1000, key: kk }, A); ok("send idempotent", r2.j.replayed && r2.j.ref === r.j.ref);
  r = await call("GET", "/api/state", null, B); ok("receiver got money", r.j.accs[0].m === 11000, r.j.accs[0]);
  r = await call("GET", "/api/state", null, A); ok("sender debited incl 2 fees", r.j.accs[0].m === 100000 - 11000 - 1000, r.j.accs[0]);
  r = await call("POST", "/api/send", { phone: "0911111111", amount: 1000, key: K() }, A); ok("self send rejected", r.s === 400);
  r = await call("POST", "/api/send", { phone: "0999999999", amount: 1000, key: K() }, A); ok("unknown phone", r.s === 404);
  r = await call("POST", "/api/send", { phone: "0922222222", amount: -5, key: K() }, A); ok("negative amount", r.s === 400);
  r = await call("POST", "/api/send", { phone: "0922222222", amount: 1.5, key: K() }, A); ok("fractional amount", r.s === 400);
  r = await call("POST", "/api/send", { phone: "0922222222", amount: 1000 }, A); ok("missing key", r.s === 400);
  r = await call("POST", "/api/send", { phone: "0922222222", amount: 99000000, key: K() }, A); ok("insufficient", r.s === 400 && r.j.error.includes("الرصيد") || r.j.error.includes("الحد"), r);

  // concurrency: C has 5000 + fees; 20 parallel sends of 1000 must succeed at most floor(5000/1500)=3
  r = await call("POST", "/api/admin/topup-codes", { amount: 5000, count: 1 }, null, true);
  await call("POST", "/api/topup", { code: r.j.codes[0], key: K() }, C);
  const res = await Promise.all(Array.from({ length: 20 }, () => call("POST", "/api/send", { phone: "0911111111", amount: 1000, key: K() }, C)));
  const good = res.filter((x) => x.j.ok).length; r = await call("GET", "/api/state", null, C);
  ok("parallel sends never overdraw", good === 3 && r.j.accs[0].m === 5000 - 3 * 1500 && r.j.accs[0].m >= 0, { good, m: r.j.accs[0].m });
  const sameKey = K(); r = await call("POST", "/api/admin/topup-codes", { amount: 100000, count: 1 }, null, true); await call("POST", "/api/topup", { code: r.j.codes[0], key: K() }, C);
  const dup = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/api/send", { phone: "0911111111", amount: 2000, key: sameKey }, C)));
  const refs = new Set(dup.map((x) => x.j.ref)); ok("parallel same key posts once", refs.size === 1 && dup.every((x) => x.j.ok), [...refs]);

  // QR
  r = await call("GET", "/api/payee?no=" + noA, null, B); ok("payee lookup", r.j.name === "أحمد");
  r = await call("GET", "/api/payee?no=" + noA, null, A); ok("payee self blocked", r.s === 400);
  r = await call("GET", "/api/payee?no=W-0000-0000-0000", null, B); ok("payee unknown", r.s === 404);
  const before = (await call("GET", "/api/state", null, B)).j.accs[0].m;
  r = await call("POST", "/api/qrpay", { no: noA, amount: 2000, key: K() }, B); ok("qr pay no fee", r.j.ok && r.j.bal === before - 2000, r);

  // internal transfer
  r = await call("POST", "/api/transfer", { from: "cur", to: "wal", amount: 3000, key: K() }, B); ok("own transfer", r.j.ok);
  r = await call("GET", "/api/state", null, B); ok("wal credited", r.j.accs[2].m === 3000 && r.j.accs[0].m === before - 2000 - 3000);
  r = await call("POST", "/api/transfer", { from: "cur", to: "cur", amount: 1, key: K() }, B); ok("same wallet rejected", r.s === 400);
  r = await call("POST", "/api/transfer", { from: "usd", to: "cur", amount: 1, key: K() }, B); ok("usd transfer rejected", r.s === 400);

  // store
  r = await call("POST", "/api/order", { product: "lib", den: 5, acc: "cur", key: K() }, A); ok("out of stock", r.s === 409);
  r = await call("POST", "/api/admin/cards", { product: "lib", den: 5, codes: ["LIB-AAA-111", "LIB-BBB-222", "LIB-AAA-111"] }, null, true); ok("add cards (dup ignored)", r.j.added === 2 && r.j.duplicates === 1);
  const ko = K(); r = await call("POST", "/api/order", { product: "lib", den: 5, acc: "cur", key: ko }, A); ok("order gives card", r.j.ok && r.j.code === "LIB-AAA-111");
  const r3 = await call("POST", "/api/order", { product: "lib", den: 5, acc: "cur", key: ko }, A); ok("order replay same card, no 2nd charge", r3.j.code === "LIB-AAA-111" && r3.j.replayed);
  r = await call("POST", "/api/order", { product: "lib", den: 5, acc: "cur", key: K() }, B); ok("next buyer gets next card", r.j.code === "LIB-BBB-222");
  r = await call("POST", "/api/order", { product: "lib", den: 5, acc: "cur", key: K() }, B); ok("stock exhausted", r.s === 409);
  r = await call("POST", "/api/order", { product: "zzz", den: 5, acc: "cur", key: K() }, A); ok("bad product", r.s === 400);
  r = await call("POST", "/api/admin/cards", { product: "itu", den: 100, codes: ["ITU-1"] }, null, true);
  const poor = (await call("POST", "/api/login", { phone: "0944444444", password: "password4" })).j.token;
  r = await call("POST", "/api/order", { product: "itu", den: 100, acc: "cur", key: K() }, poor); ok("order insufficient funds keeps card", r.s === 400);
  r = await call("GET", "/api/stock", null, A); ok("card still in stock after failed order", r.j.stock.some((x) => x.product === "itu" && x.n === 1));

  // password change invalidates old token
  r = await call("POST", "/api/password", { old: "bad", new: "newpassword1" }, A); ok("password old wrong", r.s === 400);
  r = await call("POST", "/api/password", { old: "password1", new: "newpassword1" }, A); ok("password changed", r.j.ok && r.j.token);
  r = await call("GET", "/api/state", null, A); ok("old token revoked", r.s === 401);
  r = await call("POST", "/api/login", { phone: "0911111111", password: "newpassword1" }); ok("login with new pw", r.j.ok);
  r = await call("POST", "/api/admin/status", { phone: "0933333333", status: "suspended" }, null, true); ok("suspend", r.j.ok);
  r = await call("GET", "/api/state", null, C); ok("suspended token dead", r.s === 401);
  r = await call("POST", "/api/login", { phone: "0933333333", password: "password3" }); ok("suspended cannot login", r.s === 401);
  r = await call("POST", "/api/admin/reset-password", { phone: "0933333333", password: "resetpass1" }, null, true); ok("admin reset pw", r.j.ok);

  // lockout
  for (let i = 0; i < 5; i++) await call("POST", "/api/login", { phone: "0922222222", password: "nope" });
  r = await call("POST", "/api/login", { phone: "0922222222", password: "password2" }); ok("lockout after 5 fails", r.s === 429);

  // daily limit
  CFG.dailyLimit = 20000;
  const D1 = (await call("POST", "/api/login", { phone: "0911111111", password: "newpassword1" })).j.token;
  r = await call("POST", "/api/admin/topup-codes", { amount: 500000, count: 1 }, null, true); await call("POST", "/api/topup", { code: r.j.codes[0], key: K() }, D1);
  r = await call("POST", "/api/send", { phone: "0944444444", amount: 30000, key: K() }, D1); ok("daily limit enforced", r.s === 400 && r.j.error.includes("الحد"), r);
  CFG.dailyLimit = 5000000;

  // ledger invariants
  r = await call("GET", "/api/admin/summary", null, null, true);
  ok("ledger consistent (sum 0, balances = entries, no negatives)", r.j.consistent === true, r.j);
  ok("money conserved: user balances = -cash - fees - store", r.j.userBalances === -(r.j.system.cash + r.j.system.fees + r.j.system.store), r.j);

  // static + headers
  const idx = await fetch(base + "/"); ok("serves app", idx.status === 200 && (await idx.text()).includes("Fanara Wallet"));
  const nf = await fetch(base + "/server/server.js"); ok("does not serve source", nf.status === 404);
  const tr = await fetch(base + "/../../etc/passwd"); ok("no traversal", tr.status === 404);
  const bad = await fetch(base + "/api/send", { method: "POST", headers: { authorization: "Bearer " + D1, "content-type": "application/json" }, body: "{not json" }); ok("bad json 400", bad.status === 400);

  srv.close(); d.close();
  console.log(`\nPassed: ${pass}  Failed: ${fail}`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
