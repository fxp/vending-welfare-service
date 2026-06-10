/**
 * vending-welfare-service —— 企业福利账户参考服务（Cloudflare Worker）
 *
 * 为 commerce-harness 的 welfare 适配器（WelfareHTTPAdapter）提供真实 HTTP 端点：
 * 余额查询 + 授权冻结（部分抵扣不透支 INV-12）+ capture 扣减 + void 释放，capture/void 幂等。
 *
 * 基址 /welfare/v1：
 *   GET  /accounts/{id}/balance                  → { account: { balance, held, currency } }
 *   POST /authorizations  { user_id, order_id, amount(分), currency, allow_partial }
 *                         → { authorization: { id,user_id,amount,approved_amount,currency,status }, remainder }
 *                         → 402 { detail } （allow_partial=false 且不足）
 *   POST /authorizations/{id}/capture            → { authorization }
 *   POST /authorizations/{id}/void               → { authorization }
 *   POST /_reset                                 → 重置为种子账户（契约测试每例先调）
 *
 * 状态进程内 Map（_reset 重置；契约测试即依赖此语义）。生产持久化 → 绑 D1（见 wrangler.toml）。
 * 金额一律整数分。这是**品牌中立**的"企业福利账户"——harness 核心不含任何品牌。
 */

interface Account { balance: number; held: number; currency: string; }
interface Auth {
  user_id: string;
  amount: number;
  approved: number;
  currency: string;
  status: "authorized" | "captured" | "voided";
}

const ACCOUNTS = new Map<string, Account>();
const AUTHS = new Map<string, Auth>();

/** 种子：u_1001 充足；u_1002 仅 ¥3（触发部分抵扣不透支）。与 harness 契约测试对齐。 */
function seed(): void {
  ACCOUNTS.clear();
  AUTHS.clear();
  ACCOUNTS.set("u_1001", { balance: 5000, held: 0, currency: "CNY" });
  ACCOUNTS.set("u_1002", { balance: 300, held: 0, currency: "CNY" });
}
seed();

const BASE = "/welfare/v1";

export default {
  async fetch(req: Request): Promise<Response> {
    const p = new URL(req.url).pathname;

    if (p === "/" || p === "/health")
      return json({ ok: true, service: "vending-welfare-service", accounts: ACCOUNTS.size, note: "参考服务：状态进程内、_reset 重置种子、金额整数分。" });

    if (req.method === "POST" && p === `${BASE}/_reset`) {
      seed();
      return json({ ok: true, reseeded: [...ACCOUNTS.keys()] });
    }

    let m = p.match(/^\/welfare\/v1\/accounts\/([^/]+)\/balance$/);
    if (req.method === "GET" && m) return getBalance(m[1]);

    if (req.method === "POST" && p === `${BASE}/authorizations`) return authorize(req);

    m = p.match(/^\/welfare\/v1\/authorizations\/([^/]+)\/(capture|void)$/);
    if (req.method === "POST" && m) return transition(m[1], m[2] as "capture" | "void");

    return json({ error: "not_found", method: req.method, path: p }, 404);
  },
};

function getBalance(userId: string): Response {
  const acc = ACCOUNTS.get(userId);
  if (!acc) return json({ error: "account_not_found", user_id: userId }, 404);
  return json({ account: { balance: acc.balance, held: acc.held, currency: acc.currency } });
}

async function authorize(req: Request): Promise<Response> {
  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { return json({ detail: "invalid json" }, 400); }

  const userId = String(b.user_id ?? "");
  const want = Math.trunc(Number(b.amount) || 0);
  // 必须为正整数分：否则负数会让 held 变负、可用额虚增，击穿不透支（INV-12）
  if (want <= 0) return json({ detail: `invalid_amount: ${b.amount}（须为正整数分）` }, 400);
  const allowPartial = b.allow_partial !== false;
  const acc = ACCOUNTS.get(userId);
  if (!acc) return json({ error: "account_not_found", user_id: userId }, 404);

  const available = acc.balance - acc.held;
  let approved: number;
  if (want <= available) approved = want;                     // 充足：全额
  else if (allowPartial) approved = Math.max(available, 0);   // 不足：部分抵扣（不透支）
  else return json({ detail: `insufficient_balance: available=${available} < requested=${want}` }, 402);

  acc.held += approved;
  const id = "wf" + uid();
  AUTHS.set(id, { user_id: userId, amount: want, approved, currency: acc.currency, status: "authorized" });
  return json({
    authorization: { id, user_id: userId, amount: want, approved_amount: approved, currency: acc.currency, status: "authorized" },
    remainder: want - approved,
  });
}

function transition(authId: string, action: "capture" | "void"): Response {
  const a = AUTHS.get(authId);
  if (!a) return json({ error: "authorization_not_found" }, 404);
  const acc = ACCOUNTS.get(a.user_id);
  if (!acc) return json({ error: "account_not_found" }, 404);

  if (action === "capture") {
    if (a.status === "voided") return json({ error: "cannot_capture_voided" }, 409);
    if (a.status === "authorized") { acc.balance -= a.approved; acc.held -= a.approved; a.status = "captured"; }  // 扣减
  } else {
    if (a.status === "captured") return json({ error: "cannot_void_captured" }, 409);
    if (a.status === "authorized") { acc.held -= a.approved; a.status = "voided"; }                              // 释放冻结
  }
  return json({ authorization: { id: authId, user_id: a.user_id, amount: a.amount, approved_amount: a.approved, currency: a.currency, status: a.status } });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function uid(): string { return crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase(); }
