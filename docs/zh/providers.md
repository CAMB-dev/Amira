# Provider 与模型

[English](../providers.md) · [日本語](../ja/providers.md) · [文档首页](../../README.zh-CN.md)

Provider 定义请求使用的协议、地址和凭据。发送第一个任务前需要添加一个；models.dev 目录提供服务商默认值，帮助你完成配置。模型使用 `provider/model` 格式选择，其中 provider 名称是你设置的 ID。

## 选择协议

| 协议 | 适用服务 | Base URL 示例 |
| --- | --- | --- |
| `openai-chat` | 兼容 OpenAI Chat Completions 的服务，包括许多代理和本地服务 | `https://api.openai.com/v1` |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |
| `google-gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` |

使用服务商为相应协议提供的 Base URL。兼容 Chat Completions 不代表同时支持 Responses 或 Anthropic 的功能。

## 添加、编辑与删除

在交互会话中，`/provider` 打开 provider 管理页面，显示 ID、协议、Base URL、模型数量、密钥来源和已知的连接测试结果。选择 **+ Add provider** 添加服务；选中 provider 后可选择 **Use a model from it**、**Edit**、**Set key**、**Test connection** 或 **Remove**。Esc 关闭页面。print（`-p`）和 RPC 中仍打印 provider 表格。

`/provider add` 直接打开单页表单，顶部是 **Vendor**。可在 **Popular** 和 **All vendors** 中按名称或 ID 搜索，或选择 **Custom (choose protocol)**。列表读取缓存的 models.dev 目录，不等待网络下载。选择服务商会预填 ID、协议、URL、密钥环境变量名和模型列表；之后切换服务商只更新未手动编辑的字段。协议始终可以在表单内修改，不再有单独的选择步骤。ID 重复时建议 `-2` 等后缀。仍可用 `/provider add deepseek` 或 `/provider add openai-chat` 预选服务商或协议。

确认 ID、协议、Base URL 和密钥来源。默认是保存 API 密钥，输入内容会被遮蔽。如果服务商列出的某个环境变量已经设置，表单会改为选择环境变量鉴权，只显示变量名，不显示值。否则，选择环境变量鉴权时，会预填第一个列出的变量名。

全屏表单在 Base URL 和凭据就绪后自动获取模型。HTTPS 和回环 HTTP 可直接获取；其他 HTTP 地址必须先明确同意以未加密方式发送凭据。编辑时，原模型列表为空也会自动获取。**Fetch models** 可手动刷新，刷新会保留自定义模型 ID 和已选模型。列表来自 provider，models.dev 补充上下文窗口和价格。逐项问答模式仍需明确选择获取。

在 **Models** 多选列表中直接输入，按 ID 和标签进行不区分大小写的子串过滤；Backspace 编辑 `filter:` 行。↑↓ 移动，空格切换勾选，**Ctrl+A** 全选所有匹配过滤条件的选项（若已全部选中则清空），**Ctrl+X** 反选这些选项，包括滚动区域中暂未显示的匹配行。过滤范围外的选择保持不变。标题显示 `selected 12/240`，过滤时另显示 `· 30 shown`。Esc 先清除非空过滤内容；再次 Esc 取消表单，已有改动时会确认是否丢弃。允许自定义值时，输入未列出的 ID 后按 Enter 添加。两个分别右对齐的信息列显示已知的上下文窗口和目录提供的输入/输出价格（每百万 token 的美元价格）。窄屏先隐藏价格，再隐藏上下文窗口；目录未知的模型仍保留在列表中，但不显示价格。

展开默认折叠的 **Advanced**，可设置请求头（每行 `Name=value`，支持 `${ENV}`）、有序的 API 密钥环境变量回退列表、协议兼容选项和每个模型的 `fast` 描述符。只提供设置架构支持的选项。编辑会保留未知设置和已有模型覆盖；改变密钥来源不会意外删除回退变量。

实时 **settings.json preview** 显示将写入的条目，请求头中的敏感值会遮蔽，并单独显示遮蔽的 **key → auth.json** 行。预览在字段下方的独立区域中横跨两列。按 Tab 聚焦 **Preview** 后，可用 ↑↓、PageUp/PageDown、Home 或 End 查看较长条目。添加和编辑表单使用居中卡片，以标签/控件两列网格排列，并保留清晰的输入区域。窄屏或较矮的终端回退为普通滚动表单；宽度不足时标签移至输入上方。

页脚集中显示 **Test**、**Save** 和 **Cancel**；**Test** 运行现有连接检查但不保存。**Save** 会用第一个已选模型发送一个极小的连接测试请求。付费或价格未知的模型需要先确认可能产生费用；已知免费的模型不显示计费警告。结果在表单内显示。失败后可选择 **Save anyway**，或修改字段后重试。保存后返回管理页面并高亮该 provider；**Use a model from it** 打开只显示该服务模型的选择器。对话框和非 TTY 命令行按相同顺序提问，最后显示遮蔽的摘要/预览并确认。依赖回调的表单在 RPC 中自动使用逐项问答，即使客户端请求原生静态表单。非 TTY 模式中，多行字段逐行输入，以单独一行 `.` 结束；直接结束保留原值，先输入空行再结束则清空。完整参数的非交互命令保持不变，不额外发送测试请求。

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

`amira provider add <vendor-or-protocol>` 接受目录中的服务商 ID 或协议名；名称冲突时，协议名优先。对于支持的服务商，下面的命令会使用其默认值，不提出交互问题：

```sh
amira provider add deepseek --key-env DEEPSEEK_API_KEY
```

用 `--id`、`--base-url` 和 `--model` 覆盖服务商默认的 ID、URL 和模型。不支持的服务商需要明确指定协议和 URL。原有的协议流程不变：无需交互的添加方式要指定协议、ID、URL 和一种密钥来源。下面的地址和模型请替换成实际服务的值：

```sh
amira provider add openai-chat --id my-provider --base-url https://api.example.com/v1 --key-env MY_PROVIDER_API_KEY --model my-model
```

模型选项可重复，添加多个模型。其他密钥选项是 `--key-stdin`（从管道读取）和 `--no-key`（服务无需密钥）。删除时，`--yes` 跳过确认，`--keep-key` 保留已保存的密钥；无人值守删除未加后者时，也会删除已有密钥。

## 凭据与设置

API 密钥可以保存在 `~/.amira/auth.json`，也可以从环境变量读取，或不使用密钥。不支持 OAuth。交互表单的密钥输入会被遮蔽。`AMIRA_HOME` 可以更改用户目录，设置文件和凭据文件的位置也随之改变。

API 密钥字段为空或仅含空白时，表示不替换密钥：测试和保存继续使用当前已配置的凭据，空白保存不会写入新密钥。已配置 provider 的连接测试与普通请求共用当前内存中的凭据解析器；其他进程修改或删除 auth.json，不会切换运行中会话用于测试的凭据。明确改变草稿的密钥来源或输入非空新密钥，仍会在测试中生效。

使用环境变量时，在启动 Amira 前设置好变量。配置的 `apiKeyEnv` 只保存变量名。请求先读取该变量，再按顺序尝试 `apiKeyEnvFallbacks`，最后使用该 provider 已保存的密钥。交互保存始终保留所选的 `keySource`，包括 **No key** 和环境变量鉴权，与回退列表是否为空无关。清空回退列表不会在重启后意外启用保留的 auth.json 密钥。完整参数的非交互命令保持原有设置格式。按服务商配置时，会提供目录中列出的环境变量名；自定义协议配置需要你自行填写变量名。

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

通过 `catalogId` 指定 models.dev 中用于获取模型信息（上下文窗口、能力和价格）的 provider；设为 `false` 则停用该 provider 的目录信息。对于 `my-gateway` 这样的自定义 provider，`"catalogId": "llmgateway"` 只借用目录中对应模型的信息，不会把网关的其他模型加入模型选择器、`/model` 列表或补全候选。请在 `models` 中列出服务实际提供的模型。如果目录 ID 与 provider ID 相同，或属于内置映射（如 `gemini` → `google`），仍会将该目录的模型加入这些列表。

添加或编辑时，`/provider` 可能根据模型 ID 推断 `catalogId`。借用其他目录时，保存摘要会显示 “Model details from …”。目录信息不能验证端点是否提供该模型；保存时的连接测试检查第一个已选模型。

## 兼容选项与原生功能

兼容选项放在 provider 的 `compat` 对象中：

| 选项 | 行为 |
| --- | --- |
| `maxTokensField` | Chat 输出限制字段，默认 `max_tokens`，也可用 `max_completion_tokens` |
| `streamUsage` | 请求 Chat 流中的用量信息，默认 `true` |
| `thinking` | Anthropic 思考模式，默认 `adaptive`；需要 token 预算的兼容服务使用 `budget` |
| `thinkingDisplay` | Anthropic 思考文字：`summarized` 或 `omitted`；`api.anthropic.com` 默认使用 `summarized`，其他地址需显式设置才发送。可用 `models[].compat.thinkingDisplay` 为单个模型覆盖 |
| `webSearch` | 提供服务端搜索（Responses、Anthropic Messages、Gemini），模型的 `caps.webSearch` 优先 |
| `compaction` | 原生压缩模式：`auto`、`on` 或 `off`，默认 `auto` |

思考显示方式不改变计费 token 数。使用 `omitted` 时，带签名的思考块仍原样传回，仅隐藏可读文字。对于默认开启思考的 Claude 5.x，即使未设置强度，Amira 也请求摘要，并保留服务端默认强度。`/thinking default` 表示使用服务端默认强度，不是关闭思考。详见 [Anthropic 思考文档](https://platform.claude.com/docs/en/build-with-claude/thinking)。DeepSeek 和 MiniMax 未明确说明支持 `display`，因此未设置此选项时，它们的请求保持不变。

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
