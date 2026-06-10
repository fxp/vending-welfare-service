// 冒烟：复刻 harness tests/contracts/test_welfare_contract 的场景，直接驱动 handler。
import worker from "../src/index.ts";

function makeReq(method: string, path: string, body?: unknown): Request {
  const headers: Record<string, string> = {};
  let data: string | undefined;
  if (body !== undefined) { headers["content-type"] = "application/json"; data = JSON.stringify(body); }
  return new Request("http://welfare" + path, { method, headers, body: data });
}
async function call(method: string, path: string, body?: unknown) {
  const r = await (worker as any).fetch(makeReq(method, path, body));
  return { status: r.status, body: await r.json() as any };
}
const B = "/welfare/v1";
const reset = () => call("POST", `${B}/_reset`);
const balance = async (u: string) => { const r = await call("GET", `${B}/accounts/${u}/balance`); return r.body.account; };
const authorize = (u: string, amount: number, allow_partial = true) => call("POST", `${B}/authorizations`, { user_id: u, order_id: "t", amount, currency: "CNY", allow_partial });
const avail = (acc: any) => acc.balance - acc.held;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓", name); } else { fail++; console.log("  ✗", name, JSON.stringify(extra)); }
}

// R8 部分抵扣不透支：u_1002 可用 300，申请 715 → 批 300、余 415、可用归 0
await reset();
let a = await authorize("u_1002", 715, true);
check("partial approved=300", a.body.authorization.approved_amount === 300, a.body);
check("partial remainder=415", a.body.remainder === 415, a.body);
check("partial 可用归 0", avail(await balance("u_1002")) === 0);

// 充足全额：u_1001 申请 715 → 批 715、余 0
await reset();
a = await authorize("u_1001", 715);
check("full approved=715", a.body.authorization.approved_amount === 715, a.body);
check("full remainder=0", a.body.remainder === 0, a.body);

// capture 扣减余额 + 幂等
await reset();
a = await authorize("u_1002", 300);
let cap = await call("POST", `${B}/authorizations/${a.body.authorization.id}/capture`);
check("capture→captured", cap.body.authorization.status === "captured", cap.body);
check("capture 后可用 0", avail(await balance("u_1002")) === 0);
cap = await call("POST", `${B}/authorizations/${a.body.authorization.id}/capture`);
check("capture 幂等", cap.body.authorization.status === "captured", cap.body);

// void 释放冻结
await reset();
const before = avail(await balance("u_1002"));
a = await authorize("u_1002", 300);
check("authorize 后可用 0", avail(await balance("u_1002")) === 0);
let voi = await call("POST", `${B}/authorizations/${a.body.authorization.id}/void`);
check("void→voided", voi.body.authorization.status === "voided", voi.body);
check("void 释放回 before", avail(await balance("u_1002")) === before);
voi = await call("POST", `${B}/authorizations/${a.body.authorization.id}/void`);
check("void 幂等", voi.body.authorization.status === "voided", voi.body);

// allow_partial=false 且不足 → 402
await reset();
const ins = await authorize("u_1002", 715, false);
check("不足非部分 → 402", ins.status === 402, ins);

// 负数 amount 被拒（否则 held 变负、可用额虚增，击穿不透支）
await reset();
const neg = await authorize("u_1002", -9999, true);
check("负数 amount → 400", neg.status === 400, neg);
check("负数被拒后可用额不变(300)", avail(await balance("u_1002")) === 300);

// 边界
await reset();
const nf = await call("GET", `${B}/accounts/u_999/balance`);
check("未知账户 404", nf.status === 404, nf);
const health = await call("GET", "/health");
check("health ok", health.body.ok === true, health.body);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
