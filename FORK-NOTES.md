# Fork Notes

本 fork（yanayanyy/qm）相对上游 yc-software/qm 的自有改动记录。上游同步（update-qm）时先读这里。

## 网关 Provider 支持（2026-08-05 合入 main，merge commit 99a18fb）

### 功能

让部署把模型流量指向 Anthropic/OpenAI 兼容网关（智谱 GLM Coding Plan、阿里云百炼
Token Plan、企业代理等），而不是写死的厂商端点。两部分能力：

1. **Base URL 覆盖**：`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `OPENROUTER_BASE_URL`
   替换对应 provider 的厂商端点。所有走 `resolveModel` 的流量（agent turn、judge、
   压缩、标题、ack、detect）统一生效，clone 模型同样覆盖。
2. **槽位 wire 模型名重写**：网关只认自家模型名（如 `glm-5.2`），不认 qm 目录 ID
   （如 `claude-opus-5`）。以下 env 在发送时重写模型名，目录逻辑（picker、
   allowed-models、fast-mode、上下文预算）不受影响：
   - `ANTHROPIC_DEFAULT_FABLE_MODEL` / `_OPUS_MODEL` / `_SONNET_MODEL` / `_HAIKU_MODEL`
     （命名沿用 Claude Code 约定）
   - `ANTHROPIC_MODEL`（无槽位命中时的兜底）
   - 辅助调用（judge/标题/压缩）走 haiku 槽位，配便宜模型可省配额

改动范围：18 文件（pi-models 单一出口重写、config 解析、四个 harness 桥接、
admin 存 key 校验、CLI doctor、secret-masking），含完整测试。

### 为什么不走上游

决策记录：功能曾按上游标准开发（三个独立视角的代码审查、实测矩阵齐备），
但所有者选择保留在 fork 内，不提交上游 PR。代价是**上游同步时以下文件可能冲突**，
需手工合并（本改动的语义是"resolveModel 单一出口 + harness 线边缘重写"，
合并时保持这个不变量即可）：

- `src/model/pi-models.ts`（重写核心：MODEL_SLOTS、applyGatewayOverrides、wireModelId）
- `src/config.ts`（base URL + 槽位 env 解析、URL 校验）
- `src/wiring.ts`（buildApp 注入两行）
- `src/harness/{pi,claude,codex,opencode}-harness.ts`
- `src/api/routes/admin/model-providers.ts`、`cli/src/backends/doctor.ts`
- `src/security/secret-masking.ts`（*_BASE_URL 不脱敏）

上游相关动态：上游 PR #110（仅 base URL 覆盖）如合入，与本改动重叠，
同步时以上游为基础重新套用 wire 重写部分。

### 部署配置配方

**智谱 GLM Coding Plan（已活体实测 ALL PASS）**：

```bash
HARNESS=pi
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=<Coding Plan 专属 key，bigmodel.cn 套餐页创建>
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_DEFAULT_FABLE_MODEL=glm-5.2
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air    # 辅助调用省配额；全用 glm-5.2 亦可
```

**阿里云百炼 Token Plan（已活体实测 ALL PASS）**：

```bash
HARNESS=pi
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=<Token Plan 专属 key，百炼控制台华北2地域>
ANTHROPIC_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic
ANTHROPIC_DEFAULT_FABLE_MODEL=qwen3.8-max
ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3.8-max
ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3.8-max
ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3.6-flash
```

注意：Token Plan 没有 `qwen3.7-flash` 这个模型（实测 400 Model not exist），
haiku 槽用 `qwen3.6-flash`。

注意：

- 两个网关的专属 key 与普通按量 API key 是两套凭据，不可混用。
- 百炼必须用 `token-plan.cn-beijing.maas.aliyuncs.com` 专属域名 + 华北2地域。
- 百炼无 `/v1/models` 端点：admin 页面存 key 会走降级探测或报
  `gateway_not_provable`，env 方式配 key 不受影响；`qm doctor` 对该情况只警告。
- GLM Coding Plan 条款限定"官方指定工具"，qm 不在列表，自用需知悉此风险；
  百炼明确允许第三方 Anthropic 兼容工具接入。
- 配额放大：qm 每 turn 有 judge/标题/ack 等辅助调用；智谱 GLM-5.2 高峰 3× 消耗。
- 百炼 SSE 帧冒号后**不带空格**（`event:message_start`、`data:{...}`），智谱带空格。
  两种都符合 SSE 规范，但个别解析器只认带空格的；若真实 qm turn 在百炼上出现流式
  解析异常，优先排查 pi-ai 的 SSE 容错（活体探针 live-turn.ts 已因该差异修过一次）。

### 实测结论（2026-08-04/05）

| 项目                              | 智谱              | 百炼                   |
| --------------------------------- | ----------------- | ---------------------- |
| 裸模型名（glm-5.2 / qwen3.8-max） | ✅                | ✅                     |
| `[1M]` 后缀名                     | ❌ 400 模型不存在 | ❌ 400                 |
| x-api-key / Bearer                | ✅ 均可           | ✅ 均可                |
| thinking / cache_control / 流式   | ✅                | ✅                     |
| GET /v1/models                    | ✅ 有             | ❌ 404（已有降级处理） |
| 活体 turn（qm 解析链路 + 流式）   | ✅ ALL PASS       | ✅ ALL PASS            |

关键结论：wire 名必须用**裸名**；`[1M]` 是 Claude Code 的本地元数据（发送前剥除），
网关不认。GLM-5.2 / qwen3.8-max 均为 1M 上下文，与 qm 目录的 opus/sonnet 条目
（1M 窗口）对齐，上下文预算无需覆盖。

验证工具在 fork 之外：`~/VSCodeProjects/qm-gateway-probe/`（probe.sh 协议矩阵、
live-turn.ts 活体探针）。
