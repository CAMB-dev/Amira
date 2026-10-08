# Provider 与模型

[English](../providers.md) · [文档首页](../../README.zh-CN.md)

Provider 定义请求使用的协议、地址和凭据。Amira 没有内置 provider，发送第一个任务前需要添加一个。模型使用 `provider/model` 格式选择，其中 provider 名称是你设置的 ID。

## 选择协议

| 协议 | 适用服务 | Base URL 示例 |
| --- | --- | --- |
| `openai-chat` | 兼容 OpenAI Chat Completions 的服务，包括许多代理和本地服务 | `https://api.openai.com/v1` |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |
| `google-gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` |

使用服务商为相应协议提供的 Base URL。兼容 Chat Completions 不代表同时支持 Responses 或 Anthropic 的功能。

## 添加、编辑与删除

在交互会话中，`/provider` 列出已配置的 provider 和密钥是否可用。`/provider add` 先让你选择协议，再打开配置表单；也可以用 `/provider add openai-chat` 预选协议。

填写 ID、Base URL 和密钥来源。**Fetch models** 向服务请求模型列表，也可以手动填写模型 ID。**Test connection** 使用选中的第一个模型发送一个小请求。这两个操作会访问服务；仅打开或保存表单不会测试连接。点击 **Save** 后，配置写入用户设置，并立即在当前会话生效。

用 `/model` 从列表中选择模型，或用 `/model <provider/model>` 直接指定。列表便于选择，也支持输入未列出的模型 ID。如果当前会话尚未选择模型，保存第一个 provider 后会选用其列表中的第一个模型；列表为空时不会自动选择。

| 会话内命令 | 用途 |
| --- | --- |
| `/provider edit <id>` | 编辑地址、密钥来源、模型列表和默认参数 |
| `/provider key <id>` | 保存或替换密钥 |
| `/provider remove <id>` | 确认删除配置，并单独选择是否删除已保存的密钥 |

删除正在使用的 provider 前，先用 `/model` 切换到其他模型。

命令行也提供相同的表单：

```sh
amira provider add
amira provider edit <id>
amira provider key <id>
amira provider remove <id>
amira provider help
```

无需交互的添加方式要指定协议、ID、URL 和一种密钥来源。下面通过环境变量读取密钥，地址和模型请替换成实际服务的值：

```sh
amira provider add openai-chat --id my-provider --base-url https://api.example.com/v1 --key-env MY_PROVIDER_API_KEY --model my-model
```

模型选项可重复，添加多个模型。其他密钥选项是 `--key-stdin`（从管道读取）和 `--no-key`（服务无需密钥）。删除时，`--yes` 跳过确认，`--keep-key` 保留已保存的密钥；无人值守删除未加后者时，也会删除已有密钥。

## 凭据与设置

密钥可以保存在 `~/.amira/auth.json`，也可以从环境变量读取，或不使用密钥。交互表单的密钥输入会被遮蔽。`AMIRA_HOME` 可以更改用户目录，设置文件和凭据文件的位置也随之改变。

使用环境变量时，在启动 Amira 前设置好变量。配置的 `apiKeyEnv` 只保存变量名。请求先读取该变量，再按顺序尝试 `apiKeyEnvFallbacks`，最后使用该 provider 已保存的密钥。Amira 不会自动猜测服务商的密钥环境变量名。

PowerShell 示例：

```powershell
$env:MY_PROVIDER_API_KEY = "replace-with-your-key"
amira
```

POSIX shell 示例：

```sh
export MY_PROVIDER_API_KEY="replace-with-your-key"
amira
```

也可以直接编辑用户设置。下面的示例为某个模型指定了上下文窗口：

```json
{
  "model": "my-provider/my-model",
  "providers": {
    "my-provider": {
      "dialect": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY",
      "models": [
        { "id": "my-model", "contextWindow": 128000, "maxOutput": 8192 }
      ]
    }
  }
}
```

项目设置可以调整模型信息，但地址、密钥变量名、备用变量名和请求头只接受用户设置中的值。合并规则和仅限用户设置的字段见[设置参考](settings.md)。

## 模型信息与上下文窗口

Amira 通过 models.dev 目录获取模型信息。优先级是：`models` 中明确指定的参数、模型目录、`defaultModel`。没有任何信息时，上下文窗口使用 128,000 tokens，输出上限使用 8,192。这只是兜底估值，未知模型应填写实际限制。

Provider 表单中的默认参数用于目录中没有描述的模型。要调整某一个模型，在设置中指定其 `contextWindow`、`maxOutput` 或 `caps`。`caps` 描述服务已支持的能力，并不能让模型获得新能力。

通过 `catalogId` 指定 models.dev 中用于获取模型信息（上下文窗口、能力和价格）的 provider；设为 `false` 则停用该 provider 的目录信息。对于 `local-fast` 这样的自定义 provider，`"catalogId": "llmgateway"` 只借用目录中对应模型的信息，不会把网关的其他模型加入模型选择器、`/model` 列表或补全候选。请在 `models` 中列出服务实际提供的模型。如果目录 ID 与 provider ID 相同，或属于内置映射（如 `gemini` → `google`），仍会将该目录的模型加入这些列表。

添加或编辑 provider 时，`/provider` 可能根据模型 ID 推断 `catalogId`。如果借用了其他 provider 的目录，保存摘要会用“Model details from …”标明来源。选择模型或查看信息不会验证服务是否实际提供该模型，明确的连接检查是 **Test connection**。

## 兼容选项与原生功能

兼容选项放在 provider 的 `compat` 对象中：

| 选项 | 行为 |
| --- | --- |
| `maxTokensField` | Chat 输出限制字段，默认 `max_tokens`，也可用 `max_completion_tokens` |
| `streamUsage` | 请求 Chat 流中的用量信息，默认 `true` |
| `thinking` | Anthropic 思考模式，默认 `adaptive`；需要 token 预算的兼容服务使用 `budget` |
| `webSearch` | 提供服务端搜索（Responses、Anthropic Messages、Gemini），模型的 `caps.webSearch` 优先 |
| `compaction` | 原生压缩模式：`auto`、`on` 或 `off`，默认 `auto` |

服务端搜索在 `openai-responses`、`anthropic-messages` 和 `google-gemini` 中实现。官方地址默认开启：OpenAI 和 Amira 识别为 Azure OpenAI 的 URL、`api.anthropic.com`、`generativelanguage.googleapis.com`；其他地址默认关闭。Gemini 只有 Gemini 3 模型能同时使用 Google 搜索和 Amira 的工具，较早的 Gemini 模型仍用客户端搜索。开启后，模型不再看到客户端 `web_search` 工具，`web_fetch` 仍可用。将 `web.nativeSearch` 设为 `false` 可改用客户端搜索；客户端搜索后端通过 web 设置另行选择。模型目录不提供搜索费用，因此搜索过的回复费用显示为未知，除非设置了模型的 `cost.webSearch`（每次搜索的美元价格）。

`openai-responses` 和 `anthropic-messages` 实现了原生压缩。`auto` 只对识别出的官方地址开启，分别是 OpenAI/Azure OpenAI 和 Anthropic。自动压缩和不带指令的 `/compact` 会先尝试原生压缩，失败后回退到文本摘要。设置了 `compact.model`，或向 `/compact` 提供指令时，则使用文本摘要。

代理确实能转发服务端搜索和原生压缩时，可以明确开启：

```json
{
  "providers": {
    "proxy": {
      "dialect": "openai-responses",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY",
      "compat": { "webSearch": true, "compaction": "on" },
      "models": [{ "id": "my-model", "contextWindow": 128000 }]
    }
  }
}
```

本地 Chat 服务选择 `openai-chat` 和本地 Base URL；通过 CLI 添加时，服务无需密钥即可用 `--no-key`。填写服务暴露的模型 ID 和真实限制，只开启服务实际支持的能力。

## 编辑工具

Amira 有两个修改已有文件的工具：`edit` 替换确切的文本，`apply_patch` 应用 OpenAI Codex 所用格式的多文件补丁（见[工具与审批](usage.md#工具与审批)）。用 provider 的 `tools.edit` 选择，并可在 `models[].tools.edit` 中为单个模型覆盖：

| 值 | 模型获得的工具 |
| --- | --- |
| `"edit"` | 只有 `edit`（默认） |
| `"apply_patch"` | 只有 `apply_patch` |
| `"both"` | `edit` 和 `apply_patch` |

无论哪种取值都会提供 `write`。没有模型会自动改用 `apply_patch`，需要为擅长这种补丁格式的模型（例如 OpenAI 的 GPT 和 Codex 模型）手动开启：

```json
{
  "providers": {
    "openai": {
      "dialect": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "tools": { "edit": "apply_patch" },
      "models": [{ "id": "my-other-model", "tools": { "edit": "both" } }]
    }
  }
}
```

该选择跟随当前模型：用 `/model` 切换到其他 provider 或模型后，使用那个模型自己的设置。子 agent 使用其所运行模型的设置。修改设置后需要重启 Amira。项目设置也可以设置 `tools.edit`。

`apply_patch` 只在工作目录内写入，路径在工作目录以下经过符号链接或 junction 时拒绝。有其他硬链接的文件（例如 Bun 或 pnpm 安装的依赖）会原地写入，所有链接都会看到变化，包括工作目录外的链接。Delete 只删除指定的那个链接；Move 写入一个新文件并删除旧名字，其他链接保留旧内容。同一个补丁不能通过两个不同的链接修改同一个文件。

各操作块按顺序执行，每块都基于前面各块的结果，因此同一个文件可以有多个 `*** Update File:` 块。Add 后 Update、Update 后 Delete、对 Move 的目标再 Update、连续 Move（`a` → `b` → `c`，或移回 `a`），以及先 Delete 再 Add（或反过来）都可以。执行到某块时，Update、Delete 和 Move 的源文件必须存在，Add 和 Move 的目标必须不存在，否则补丁失败并在错误中给出路径。同一个补丁里，一个路径不能既当文件又当目录。

写入任何内容之前会先检查所有块。如果写入失败，已改动的文件会恢复原来的字节（所有硬链接都恢复），新建的文件和文件夹会被删除；错误信息会说明回滚是否完整。补丁删除文件期间，旁边会有一个临时的 `.amira-patch-*` 文件夹保留一个链接用于回滚，结束时删除。这只防范出错，不防范崩溃；补丁执行期间其他程序可能看到中间状态。

相关文档：[快速开始](getting-started.md)、[使用与会话](usage.md)、[设置](settings.md)、[扩展](extensions.md)。
