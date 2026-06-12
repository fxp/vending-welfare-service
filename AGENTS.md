# AGENTS.md — vending-welfare-service

> 企业福利账户参考服务（Cloudflare Worker）。Project Vend 生态的外部服务之一——"外部系统各自独立成 repo，
> harness 只写适配器"。本文件供**独立开发本 repo 的 Agent** 上手；完整 API/seed 见 [README.md](README.md)。

## 角色定位
- harness（`fxp/commerce-harness`）的 `welfare` 能力 = `WelfareHTTPAdapter`，通过 `WELFARE_URL` 指向本服务。
- 提供：余额查询 + 授权冻结（**部分抵扣、绝不透支**）+ capture 扣减 + void 释放，均幂等。
- 品牌中立：通用"企业福利账户"，可对接任意 HR/福利系统。

## 技术栈 / 绑定
- TS + Cloudflare Worker，单文件 `src/index.ts`，配置 `wrangler.toml`。
- **无外部绑定**：状态在**进程内 Map**（含 `_reset` 重置种子）。无 KV/D1/DO。
- 金额**一律整数分**（fen），不用浮点。

## 开发 / 测试 / 部署
```bash
npm install
npm test          # 复刻 harness 契约场景的冒烟（部分抵扣/扣减/释放/402/幂等）
npm run dev       # http://localhost:8787
npm run deploy    # 需 wrangler 已登录（本地手动部署）
```
契约 fixture 每例先 `POST /welfare/v1/_reset` 取干净种子（`u_1001`=¥50、`u_1002`=¥3）。

## CI/CD（GitHub Actions，`.github/workflows/ci.yml`）
- push 到 `main` → **typecheck（tsc）→ deploy（wrangler）→ curl `/health` 冒烟**；PR 只 typecheck。
- 部署 secret：**`CLOUDFLARE_API_TOKEN`**（repo secret，需 Workers Scripts + KV + D1 三项 Edit）。
- 因用 scoped token、`wrangler.toml` 无 `account_id` → deploy 步骤显式给 `CLOUDFLARE_ACCOUNT_ID`（非敏感，写在 workflow 里）。
- 缺 token 时 deploy job 有守卫**优雅跳过**（不报红），打印启用命令。

## 不可破坏的契约（harness 依赖）
- `GET /health` 必须返回含 `{"ok":true}`（CI 冒烟 + 状态看板都断言它）。
- API 基址 `/welfare/v1`、各端点返回字段（`balance/held`、`authorization.approved_amount/remainder`、不足→`402`）**精确匹配** harness `WelfareHTTPAdapter` 的解析。改返回形状前先看 harness `tests/contracts/test_welfare_contract.py`。
- `allow_partial` 时余额不足 → 按可用额**部分批准**，**不透支**。

## 已知坑 / 约定
- 进程内状态跨 isolate 不共享、会随冷启动重置——仅供联调/CI，不是生产持久层。需持久化时绑 KV/D1。
- `_reset` 是测试基础设施，别在生产暴露/依赖。

## 关系
同族外部服务：`ucp-vending-machine`(出货) · `vending-supply-chain`(库存) · `vending-payment-sandbox`(支付) · `vending-identity-service`(识别) · `vending-notify-gateway`(通知)。监控看板：`vending-status-dashboard`。
