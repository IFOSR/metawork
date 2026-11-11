# MetaWork 决策模型协议（System One 标准）

- 日期：2026-10-11
- 状态：Review Draft
- 目标：让所有 MetaWork 决策模型使用同一套 System One/Jev 协议，避免决策模型之间出现不同输入输出格式。

## 1. 统一原则

MetaWork 的决策模型只使用 System One/Jev 兼容协议。Mercury、Jev、Drex v1.5 以及以后接入的其他决策模型，都必须遵循同一套请求和响应结构。

MetaWork 不定义第二套 `metawork-routing/v1`、`decisions` 或 `winner` 协议。普通 Chat Completions 模型不能直接作为决策模型使用；只有明确声明或验证支持 System One 的模型才会出现在决策模型选择器中。

Provider 的域名和实现方式可以不同，但进入 MetaWork 路由校验前，必须已经是 System One 语义。OpenRouter 使用其 `/v1/systemone` 接口；兼容的其他 Provider 使用其配置 Base URL 下的 `/systemone` 接口。

## 2. 请求格式

MetaWork 向决策模型发送一个 System One 请求：

```json
{
  "model": "nace-ai/drex-v1.5",
  "state": "{\"subtask\":{\"title\":\"查询今天的天气\"},\"candidates\":{...}}",
  "questions": {
    "candidates": {
      "type": "choice",
      "instructions": "Choose the best candidate from all options.",
      "criteria": {
        "c000": "Candidate c000 is the daily assistant.",
        "c001": "Candidate c001 is the research analyst."
      }
    }
  }
}
```

其中：

- 以上是发送到 Provider `/systemone` 的实际 HTTP body。OpenRouter SDK 的
  `decisionsRequest` 只是 SDK 调用时的参数封装，不属于 wire body；自定义
  Provider 也必须发送相同的顶层 `model`、`state`、`questions` 字段；

- `state` 必须是 JSON 字符串，这是 System One 的协议要求；
- `state` 只包含当前 Subtask、验收条件、所需能力和已经通过硬校验的候选；
- 候选使用 `c000`、`c001` 等稳定 ID；
- 模型只能在给定候选中选择，不能创建 AgentClass、Model 或权限；
- `questions` 使用 System One 的 typed choice 结构；
- 候选集合绑定到配置 revision 和 candidate fingerprint，在本次评估期间固定。

## 3. 响应格式

所有决策模型必须返回同一种 `answers` 结构：

```json
{
  "model": "nace-ai/drex-v1.5",
  "answers": {
    "candidates": {
      "type": "choice",
      "choice": "c001",
      "probabilities": {
        "c000": 0.25,
        "c001": 0.75
      }
    }
  }
}
```

校验要求：

- `model` 必须是非空字符串；
- `answers` 必须包含且只包含请求中的问题键；
- 每个答案的 `type` 必须为 `choice`；
- `choice` 必须是本次候选中的合法 ID；
- `probabilities` 必须完整覆盖本次全部候选，不能缺少或增加 ID；
- 概率必须是有限数字，范围为 `0` 到 `1`；
- 任意字段不符合要求，整个 Subtask 回退到确定性路由，不部分采用。

MetaWork 适配器只负责把不同 Provider 的 System One 请求发到对应端点，不转换协议字段。进入响应校验器的内容始终是同一套 `answers` 结构。

## 4. 模型配置与选择

用户只能从当前 Provider/Model 目录中选择已声明 System One/Jev 兼容的模型。以下信息任意一项满足即可作为识别依据：

- OpenRouter 公开资料的 `outputModalities` 包含 `decisions`；
- 模型描述明确声明 `/v1/systemone`、System One 或 Jev 兼容；
- 已知的 Mercury 决策模型兼容项。

截图中的 `nace-ai/drex-v1.5` 描述明确写明“通过 `/v1/systemone` 契约提供服务，与 TypeSafe 的 Jev 共用接口”，因此与 Mercury/Jev 使用同一协议，可以直接作为 MetaWork 决策模型。

无法确认 System One 能力的普通模型不进入选择列表，也不再通过另一套 Chat Completions 协议兜底。用户需要先补充模型描述或模型信息链接，再重新识别模型能力。

主决策模型和有序备选模型随配置 revision 一起固定。决策模型调用只发生在多候选 Subtask；单候选直接绑定。同一 Graph 的重试、恢复和重放沿用已持久化的决策结果。

## 5. 失败与回退

失败状态使用有限枚举，不保存模型原始响应：

- `span_invalid_response`：响应不是合法 System One `answers` 结构；
- `span_candidate_mismatch`：问题键、choice 或概率键与本次固定候选不一致；
- `span_timeout`：超过请求截止时间；
- `span_http_error`：Provider 请求失败；
- `span_secret_unavailable`：决策模型凭证不可用。

`span_candidate_mismatch` 表示模型答案与固定候选不一致，不表示运行期间候选发生了变化。真正的配置 revision 或 candidate fingerprint 变化仍由 Kernel 的候选一致性错误记录。

所有失败都回退到经过 Kernel 校验的确定性路由。决策模型不能绕过能力、权限、Provider、Model、Harness 或最终授权检查。

## 6. 可审计信息

路由卡片展示：

- 本次使用的 Provider/Model；
- 协议：`System One/Jev`；
- 是否成功参与排序；
- 最终采用的候选及概率；
- 失败时的有限中文原因。

“未采纳”只表示响应没有通过 System One 协议或 Kernel 复核，不表示候选集发生变化。
