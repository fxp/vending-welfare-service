# vending-welfare-service

> **企业福利账户参考服务**（Cloudflare Worker）—— 为 [`commerce-harness`](https://github.com/fxp/commerce-harness)
> 的 `welfare` 适配器（`WelfareHTTPAdapter`）提供真实 HTTP 端点：余额 + 授权冻结（**部分抵扣不透支**）+
> capture 扣减 + void 释放。属"外部系统各自独立成 repo"范式
> （与 `ucp-vending-machine`、`vending-supply-chain`、`vending-payment-sandbox` 并列）。

品牌中立：这是通用的"企业福利账户"，可对接任意企业 HR/福利系统；harness 核心不含任何品牌。

## API（基址 `/welfare/v1`，金额一律整数分）

| 端点 | 行为 | 返回 |
|---|---|---|
| `GET /accounts/{id}/balance` | 查账户 | `{ account: { balance, held, currency } }`（可用 = balance − held）|
| `POST /authorizations` | 授权冻结（`allow_partial` 时余额不足按可用额部分批准，**不透支**）| `{ authorization: {id,user_id,amount,approved_amount,currency,status}, remainder }` ｜ 不足且非部分 → `402 { detail }` |
| `POST /authorizations/{id}/capture` | 出货成功后扣减（幂等）| `{ authorization }` |
| `POST /authorizations/{id}/void` | 释放冻结（幂等）| `{ authorization }` |
| `POST /_reset` | 重置为种子账户 | `{ ok, reseeded }` |
| `GET /health` | 健康检查 | `{ ok, accounts }` |

**种子账户**（与 harness 契约测试对齐）：`u_1001` = ¥50（充足）· `u_1002` = ¥3（触发部分抵扣）。

## 本地运行 / 部署 / 测试

```bash
npm install
npm test                    # 复刻 harness 契约场景的冒烟（部分抵扣/扣减/释放/402/幂等）
npm run dev                 # http://localhost:8787
npm run deploy              # 部署到 <account>.workers.dev（需 wrangler 已登录 Cloudflare）
```

## 把 commerce-harness 适配器指向本服务

```bash
export WELFARE_URL="https://vending-welfare-service.<account>.workers.dev"
cd <commerce-harness> && python -m pytest tests/contracts/test_welfare_contract.py -q
# 原本无 WELFARE_URL → 6 个用例 skip；指向本服务后实跑（Mock 与真实适配器跑同一份契约）
```
> 契约 fixture 每例先 `POST /welfare/v1/_reset` 取干净种子态——本服务的 `_reset` 正为此而设。

## 设计取舍
- **状态进程内 `Map` + `_reset`**：契约测试即依赖"重置→种子→若干操作"的语义，进程内足够且可复现。
  生产需跨实例持久化余额/冻结 → 取消 `wrangler.toml` 的 D1 绑定并改读写（升级路径已留）。
- **整数分**：与 harness `Money` 一致，杜绝浮点。
- **不透支（INV-12）**：`approved = min(requested, available)`，冻结/扣减严格在可用额内。

## 谱系
`commerce-harness` 的外部系统之一。同族：`ucp-vending-machine` · `vending-supply-chain` ·
`vending-payment-sandbox` · **vending-welfare-service（本仓库）**。
