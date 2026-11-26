# 模型目录维护规则

- `ultra` 不是模型或 API 支持的思考强度。它只是客户端预设：实际发送的档位是 `xhigh`，其余行为由客户端调整。
- 任何模型或渠道变体都不得把 `ultra` 写进 `reasoning_effort_levels`、`default_reasoning_effort`，也不得作为推理档位发给上游。此规则不影响名称包含 Ultra 的模型或 Ultrafast 服务计价。
