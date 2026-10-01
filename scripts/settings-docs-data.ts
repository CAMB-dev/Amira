// What the settings types cannot say, for gen-settings-docs.ts: each key's default as the code
// applies it, a description in English and Chinese, and whether only the user file may set it.
// A key added to the types fails the generator until it has an entry here.

export interface Annotation {
  /** Markdown; one string when both languages read the same. */
  default: string | { en: string; zh: string }
  en: string
  zh: string
  /** Ignored, with a warning, in project files (load.ts), or read from the user file only. */
  userOnly?: boolean
}

type Text = { en: string; zh: string }

const none: Text = { en: "none", zh: "无" }
const unlimited: Text = { en: "unlimited", zh: "不限" }

/** Keys in the types that settings files cannot set: the schema ignores them, with a warning. */
export const omitted: Record<string, string> = {
  "providers.<id>.models[].provider": "set by Amira from the provider entry",
  "providers.<id>.models[].contextWindowSource": "set by Amira when it resolves the model",
}

/** Keys documented as one row: their fields repeat ones listed elsewhere. */
export const collapsed: string[] = ["providers.<id>.defaultModel"]

/** Keys whose shape belongs to an extension (the MCP extension reads mcpServers itself). */
export const extraRows: { key: string; type: string }[] = [
  { key: "mcpServers.<name>.type", type: '"stdio" | "http"' },
  { key: "mcpServers.<name>.command", type: "string" },
  { key: "mcpServers.<name>.args", type: "string[]" },
  { key: "mcpServers.<name>.env", type: "Record<string, string>" },
  { key: "mcpServers.<name>.cwd", type: "string" },
  { key: "mcpServers.<name>.url", type: "string" },
  { key: "mcpServers.<name>.headers", type: "Record<string, string>" },
  { key: "mcpServers.<name>.timeout", type: "number" },
  { key: "mcpServers.<name>.disabled", type: "boolean" },
]

export const sections: { title: Text; intro?: Text; keys: string[] }[] = [
  {
    title: { en: "General", zh: "常规" },
    keys: ["model", "shell", "tools", "maxParallelTools", "backgroundJobs", "commandAliases", "sessions"],
  },
  {
    title: { en: "Providers and models", zh: "Provider 与模型" },
    intro: {
      en: "Amira has no built-in providers: an entry needs `dialect` and `baseUrl`, and `baseUrl` only counts in the user file. Model metadata is taken from `models`, then the models.dev catalog, then `defaultModel`, then the built-in fallbacks; `caps` merge key by key in the same order. See [Providers and models](providers.md) for the protocols, key precedence and the provider form.",
      zh: "Amira 没有内置 provider：每个条目都需要 `dialect` 和 `baseUrl`，其中 `baseUrl` 只能写在用户文件里。模型信息依次取自 `models`、models.dev 模型目录、`defaultModel`，最后是内置的兜底值；`caps` 按同样的顺序逐键合并。协议、密钥优先级和 provider 表单见 [Provider 与模型](providers.md)。",
    },
    keys: ["providers"],
  },
  {
    title: { en: "Permissions", zh: "权限" },
    intro: {
      en: "What the model may do without asking; see [Permissions](usage.md#permissions). A project file can only tighten them: its `mode` counts when it is stricter than the user's, its `ask` and `deny` rules always apply, and its `allow` rules only once the project is trusted (`amira ext trust`).",
      zh: "模型无需询问即可执行的操作，详见[权限](usage.md#权限)。项目文件只能收紧这些设置：它的 `mode` 只在比用户设置更严格时生效，它的 `ask` 和 `deny` 规则总是生效，`allow` 规则则要等项目受信任后（`amira ext trust`）才生效。",
    },
    keys: ["permissions"],
  },
  { title: { en: "Compaction and retries", zh: "压缩与重试" }, keys: ["compact", "retry"] },
  {
    title: { en: "Context management", zh: "上下文管理" },
    intro: {
      en: "What model requests carry of the history; the session file always keeps everything. See [Context management](usage.md#context-management).",
      zh: "模型请求携带历史中的哪些内容；会话文件始终完整保存。详见[上下文管理](usage.md#上下文管理)。",
    },
    keys: ["context"],
  },
  {
    title: { en: "File rewind", zh: "文件回退" },
    intro: {
      en: "Bytes the file tools change, kept so that rewind can restore them; see [Sessions](usage.md).",
      zh: "文件工具改动的字节内容，供回退时恢复，详见[会话](usage.md)。",
    },
    keys: ["fileRewind"],
  },
  {
    title: { en: "Web tools", zh: "网页工具" },
    intro: {
      en: "Settings for the `web_search` and `web_fetch` tools. Hide either tool with `tools.disabled`.",
      zh: "`web_search` 和 `web_fetch` 工具的设置。要隐藏其中一个工具，把它加入 `tools.disabled`。",
    },
    keys: ["web"],
  },
  {
    title: { en: "Terminal UI", zh: "终端界面" },
    intro: {
      en: "[Keybindings](keybindings.md#terminal-settings) describes these in more detail. Keys themselves are changed in `keybindings.json`, not here.",
      zh: "[快捷键](keybindings.md#终端设置)一文对这些设置有更详细的说明。按键本身在 `keybindings.json` 中修改，而不是这里。",
    },
    keys: ["tui"],
  },
  {
    title: { en: "Sub-agents", zh: "子 agent" },
    intro: {
      en: "See [Sub-agents](subagents.md) for roles, the agent tree and worktree merges.",
      zh: "角色、agent 树和 worktree 合并见[子 agent](subagents.md)。",
    },
    keys: ["agents", "subagents", "budget", "merge"],
  },
  {
    title: { en: "MCP servers", zh: "MCP 服务器" },
    intro: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the MCP extension's own ${VAR} syntax
      en: "The MCP extension reads `mcpServers` from `.mcp.json` in the working directory, then from the user file, the project file and `settings.local.json`; a later entry of the same name replaces an earlier one. Strings may use `${VAR}` and `${VAR:-default}`. Servers from project files (`.mcp.json` included) are trusted only when the project directory, or a parent, is in `mcpTrustedProjects`: otherwise their stdio servers do not start, their HTTP servers get no environment variables, and they cannot replace a server the user file defines. `/reload` reads these files again: it starts servers you added, stops removed ones, restarts changed ones and leaves the others connected.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the MCP extension's own ${VAR} syntax
      zh: "MCP 扩展依次从工作目录的 `.mcp.json`、用户文件、项目文件和 `settings.local.json` 读取 `mcpServers`，同名条目以后读到的为准。字符串中可以使用 `${VAR}` 和 `${VAR:-default}`。来自项目文件（包括 `.mcp.json`）的服务器，只有在项目目录或其上级目录列在 `mcpTrustedProjects` 中时才受信任；否则其中的 stdio 服务器不会启动，HTTP 服务器拿不到环境变量，也不能替换用户文件中定义的同名服务器。`/reload` 会重新读取这些文件：启动新增的服务器，停止已删除的服务器，重启有改动的服务器，其余服务器保持连接。",
    },
    keys: ["mcpServers", "mcpTrustedProjects"],
  },
  {
    title: { en: "Extensions, packages and skills", zh: "扩展、包与技能" },
    intro: {
      en: "`amira ext` and `/ext` write the `packages` lists for you; see [Extensions](extensions.md).",
      zh: "`amira ext` 和 `/ext` 会替你维护 `packages` 下的列表，详见[扩展](extensions.md)。",
    },
    keys: ["extensions", "packages", "skills"],
  },
]

export const annotations: Record<string, Annotation> = {
  model: {
    default: none,
    en: 'Default model as `"provider/model"`. Without it, Amira uses the resumed session\'s model, or the first model of the only provider. `--model` and `/model` choose another.',
    zh: '默认模型，格式为 `"provider/model"`。未设置时，Amira 使用恢复的会话上次用的模型；只配置了一个 provider 时则用它的第一个模型。`--model` 和 `/model` 可以另选。',
  },
  shell: {
    default: '`"auto"`',
    en: 'Which shell tools the model gets on Windows: `"auto"` offers both `bash` and `powershell`, `"bash"` or `"powershell"` hides the other one. Elsewhere only `bash` exists. `--shell` wins.',
    zh: 'Windows 上模型可用的 shell 工具：`"auto"` 同时提供 `bash` 和 `powershell`，`"bash"` 或 `"powershell"` 会隐藏另一个。其他平台只有 `bash`。`--shell` 优先。',
  },
  "tools.disabled": {
    default: "`[]`",
    en: "Tool names to hide from the model. `--disable-tools` replaces the list for one run; `/tools` changes the current session only.",
    zh: "对模型隐藏的工具名。`--disable-tools` 在单次运行中替换这个列表，`/tools` 只修改当前会话。",
  },
  commandAliases: {
    default: none,
    en: 'Slash command aliases: `{"ds": "model deepseek/deepseek-flash"}` makes `/ds` run `/model deepseek/deepseek-flash`, with anything typed after `/ds` appended. The value names a command, not another alias; commands and their own aliases win.',
    zh: '斜杠命令别名：`{"ds": "model deepseek/deepseek-flash"}` 让 `/ds` 执行 `/model deepseek/deepseek-flash`，`/ds` 后面输入的内容会追加在末尾。值必须是命令而不是另一个别名；与命令或命令自带的别名重名时，以命令为准。',
  },
  maxParallelTools: {
    default: "`8`",
    en: "Most tool calls running at once.",
    zh: "同时运行的工具调用数上限。",
  },
  "backgroundJobs.maxRunning": {
    default: "`8`",
    en: "Background jobs (commands the shell tools start with `background: true`, such as dev servers and watchers) running at once.",
    zh: "同时运行的后台任务数上限（shell 工具以 `background: true` 启动的命令，如开发服务器和文件监视进程）。",
  },
  "backgroundJobs.bufferChars": {
    default: "`1000000`",
    en: "Characters of output each job keeps in memory for reading; at least 1000.",
    zh: "每个后台任务在内存中保留、供读取的输出字符数，最少 1000。",
  },
  "backgroundJobs.maxLogBytes": {
    default: "`52428800` (50 MiB)",
    en: "Bytes of each job's output written to its log file.",
    zh: "每个后台任务写入日志文件的输出字节数上限。",
  },
  "backgroundJobs.printWaitMs": {
    default: "`30000` (30 s)",
    en: "How long print mode waits for top-level background jobs started during the run before stopping them on exit.",
    zh: "print 模式等待本次运行启动的顶层后台任务的时长，超时后退出时停止它们。",
  },
  "sessions.autoTitle": {
    default: "`true`",
    en: "Ask the model for a short session title in the background after the first turn (`compact.model` when set). `/rename` always wins.",
    zh: "第一个轮次结束后，在后台请模型为会话起一个简短标题（设置了 `compact.model` 时用它）。`/rename` 设置的名称始终优先。",
  },
  "permissions.mode": {
    default: '`"auto"`',
    en: '`"auto"` runs everything without asking, except what rules and protected paths say; `"edits"` changes files without asking and asks before shell commands; `"plan"` is read-only. Shift+Tab cycles it in the UI; `--permission-mode` wins.',
    zh: '`"auto"` 除规则和受保护路径要求的以外，一律不询问直接执行；`"edits"` 修改文件不询问，执行 shell 命令前询问；`"plan"` 为只读。界面中按 Shift+Tab 切换；`--permission-mode` 优先。',
  },
  "permissions.rules": {
    default: "`[]`",
    en: 'Rules for shell commands, matched against each command\'s words. When several match, `deny` wins over `ask` and `ask` over `allow`; `allow` only means "do not ask" and never lifts the mode or a protected path.',
    zh: "针对 shell 命令的规则，按每条命令的单词匹配。多条规则匹配时，`deny` 优先于 `ask`，`ask` 优先于 `allow`；`allow` 只表示“不询问”，不会解除模式或受保护路径的限制。",
  },
  "permissions.rules[].command": {
    default: { en: "required", zh: "必填" },
    en: 'The first words of the command, e.g. `["git", "push"]`. An `allow` rule must match the start of the command exactly; `ask` and `deny` rules also match with other words in between and ignore case.',
    zh: '命令开头的若干单词，例如 `["git", "push"]`。`allow` 规则必须与命令开头完全一致；`ask` 和 `deny` 规则在中间夹有其他单词时也能匹配，且不区分大小写。',
  },
  "permissions.rules[].decision": {
    default: { en: "required", zh: "必填" },
    en: '`"allow"` runs it without asking, `"ask"` asks first, `"deny"` never runs it.',
    zh: '`"allow"` 不询问直接执行，`"ask"` 先询问，`"deny"` 永不执行。',
  },
  "permissions.rules[].reason": {
    default: none,
    en: "Shown with the question or the refusal.",
    zh: "随询问或拒绝一起显示。",
  },
  providers: {
    default: none,
    en: "Providers by the ID you choose; models are named `<id>/<model>`.",
    zh: "以你自定的 ID 为键的 provider；模型写作 `<id>/<model>`。",
  },
  "providers.<id>.dialect": {
    default: { en: "required", zh: "必填" },
    en: "The protocol: `openai-chat`, `openai-responses`, `anthropic-messages` or `google-gemini`.",
    zh: "协议：`openai-chat`、`openai-responses`、`anthropic-messages` 或 `google-gemini`。",
  },
  "providers.<id>.baseUrl": {
    default: { en: "required", zh: "必填" },
    en: "The endpoint requests go to.",
    zh: "请求发送到的地址。",
    userOnly: true,
  },
  "providers.<id>.apiKeyEnv": {
    default: none,
    en: "Environment variable holding the API key (its name, not the key). Without a key in the environment, the key stored in `auth.json` is used.",
    zh: "存放 API 密钥的环境变量名（不是密钥本身）。环境变量中没有密钥时，使用 `auth.json` 中保存的密钥。",
    userOnly: true,
  },
  "providers.<id>.apiKeyEnvFallbacks": {
    default: none,
    en: "Variables tried in order when `apiKeyEnv` is unset or empty.",
    zh: "`apiKeyEnv` 未设置或为空时，按顺序尝试的环境变量。",
    userOnly: true,
  },
  "providers.<id>.headers": {
    default: none,
    en: "Extra HTTP headers sent with every request.",
    zh: "每个请求附带的额外 HTTP 请求头。",
    userOnly: true,
  },
  "providers.<id>.compat.maxTokensField": {
    default: '`"max_tokens"`',
    en: "`openai-chat`: the field that carries the output token limit.",
    zh: "`openai-chat`：携带输出 token 上限的字段。",
  },
  "providers.<id>.compat.webSearch": {
    default: {
      en: "on only at api.openai.com, Azure OpenAI, api.anthropic.com and generativelanguage.googleapis.com",
      zh: "仅在 api.openai.com、Azure OpenAI、api.anthropic.com 和 generativelanguage.googleapis.com 上开启",
    },
    en: "`openai-responses`, `anthropic-messages`, `google-gemini`: offer the provider's hosted web search; the model then does not get the `web_search` tool (`web_fetch` stays). With Amira's tools, Gemini needs a Gemini 3 model. A model's `caps.webSearch` wins; `web.nativeSearch: false` turns it off everywhere.",
    zh: "`openai-responses`、`anthropic-messages`、`google-gemini`：使用 provider 托管的网页搜索，此时模型不再获得 `web_search` 工具（`web_fetch` 保留）。同时带有 Amira 的工具时，Gemini 需要 Gemini 3 模型。模型的 `caps.webSearch` 优先；`web.nativeSearch: false` 会全局关闭它。",
  },
  "providers.<id>.compat.streamUsage": {
    default: "`true`",
    en: "`openai-chat`: ask for token usage in the stream.",
    zh: "`openai-chat`：在流式响应中请求 token 用量。",
  },
  "providers.<id>.compat.thinking": {
    default: '`"adaptive"`',
    en: '`anthropic-messages`: `"adaptive"` sends an effort, as current Claude models require; `"budget"` sends `budget_tokens`, for Claude 4.5 and older and compatible servers such as DeepSeek.',
    zh: '`anthropic-messages`：`"adaptive"` 发送 effort，当前的 Claude 模型要求这种方式；`"budget"` 发送 `budget_tokens`，适用于 Claude 4.5 及更早的模型和 DeepSeek 等兼容服务。',
  },
  "providers.<id>.compat.compaction": {
    default: '`"auto"`',
    en: 'Server-side (native) compaction, for `openai-responses` and `anthropic-messages`. `"auto"` uses it only at the vendor\'s own endpoints, `"on"` at any host (e.g. a proxy that forwards it), `"off"` never. It falls back to a text summary when it fails.',
    zh: '服务端（原生）压缩，适用于 `openai-responses` 和 `anthropic-messages`。`"auto"` 只在厂商自己的地址上使用，`"on"` 在任何地址上使用（例如会转发该功能的代理），`"off"` 从不使用。失败时退回文字摘要。',
    userOnly: true,
  },
  "providers.<id>.catalogId": {
    default: { en: "the provider ID (a few are mapped)", zh: "provider ID（少数有内置映射）" },
    en: "The provider's ID in the models.dev catalog, when it differs from yours; `false` ignores the catalog. Built in: `gemini` → `google`, `moonshot` → `moonshotai`, `ollama` and `lmstudio` → `false`, and a few more.",
    zh: "该 provider 在 models.dev 模型目录中的 ID（与你的 ID 不同时设置）；`false` 表示不使用模型目录。内置映射包括 `gemini` → `google`、`moonshot` → `moonshotai`、`ollama` 和 `lmstudio` → `false` 等。",
  },
  "providers.<id>.tools.edit": {
    default: '`"edit"`',
    en: 'Editing tools for this provider\'s models: `"edit"`, `"apply_patch"` or `"both"`. `write` is always offered. See [Editing tools](providers.md#editing-tools).',
    zh: '该 provider 的模型使用的编辑工具：`"edit"`、`"apply_patch"` 或 `"both"`。`write` 始终可用。见[编辑工具](providers.md#编辑工具)。',
  },
  "providers.<id>.models": {
    default: none,
    en: "Models you describe. A listed model wins over the catalog.",
    zh: "你手动描述的模型。列出的模型优先于模型目录。",
  },
  "providers.<id>.models[].id": {
    default: { en: "required", zh: "必填" },
    en: "The model ID the endpoint expects.",
    zh: "服务端要求的模型 ID。",
  },
  "providers.<id>.models[].dialect": {
    default: { en: "the provider's", zh: "沿用 provider 的设置" },
    en: "A different protocol for this model.",
    zh: "为该模型单独指定协议。",
  },
  "providers.<id>.models[].contextWindow": {
    default: { en: "catalog, else `128000`", zh: "取模型目录，否则为 `128000`" },
    en: "Context window in tokens. Compaction and `/context` use it.",
    zh: "上下文窗口大小（token）。压缩和 `/context` 依据这个值。",
  },
  "providers.<id>.models[].maxOutput": {
    default: { en: "catalog, else `8192`", zh: "取模型目录，否则为 `8192`" },
    en: "Most output tokens per reply.",
    zh: "单次回复的输出 token 上限。",
  },
  "providers.<id>.models[].cost.input": {
    default: { en: "catalog", zh: "取模型目录" },
    en: "USD per million input tokens; `input` and `output` are required when `cost` is set.",
    zh: "每百万输入 token 的价格（美元）；设置 `cost` 时 `input` 和 `output` 必填。",
  },
  "providers.<id>.models[].cost.output": {
    default: { en: "catalog", zh: "取模型目录" },
    en: "USD per million output tokens.",
    zh: "每百万输出 token 的价格（美元）。",
  },
  "providers.<id>.models[].cost.cacheRead": {
    default: { en: "catalog", zh: "取模型目录" },
    en: "USD per million tokens read from the prompt cache.",
    zh: "每百万缓存读取 token 的价格（美元）。",
  },
  "providers.<id>.models[].cost.cacheWrite": {
    default: { en: "catalog", zh: "取模型目录" },
    en: "USD per million tokens written to the prompt cache.",
    zh: "每百万缓存写入 token 的价格（美元）。",
  },
  "providers.<id>.models[].cost.webSearch": {
    default: { en: "unknown", zh: "未知" },
    en: "USD per hosted web search. Catalogs list no search fees, so without it a reply that searched shows its cost as unknown.",
    zh: "每次托管网页搜索的价格（美元）。模型目录不提供搜索费用，不设置时，搜索过的回复费用显示为未知。",
  },
  "providers.<id>.models[].caps.tools": {
    default: '`"native"`',
    en: '`"none"` for a model that cannot call tools.',
    zh: '模型不支持工具调用时设为 `"none"`。',
  },
  "providers.<id>.models[].caps.images": {
    default: "`false`",
    en: "The model accepts images.",
    zh: "模型接受图片输入。",
  },
  "providers.<id>.models[].caps.thinking": {
    default: "`false`",
    en: "The model can reason; `anthropic-messages` asks for thinking only when this is set.",
    zh: "模型支持推理；`anthropic-messages` 只在设置了这一项时请求思考。",
  },
  "providers.<id>.models[].caps.promptCache": {
    default: "`false`",
    en: "The endpoint supports prompt caching.",
    zh: "服务端支持提示缓存。",
  },
  "providers.<id>.models[].caps.parallelToolCalls": {
    default: "`true`",
    en: "The model may call several tools in one reply.",
    zh: "模型可以在一次回复中调用多个工具。",
  },
  "providers.<id>.models[].caps.webSearch": {
    default: { en: "from `compat.webSearch`", zh: "取 `compat.webSearch`" },
    en: "Offer the provider's hosted web search to this model.",
    zh: "为该模型启用 provider 托管的网页搜索。",
  },
  "providers.<id>.models[].tools.edit": {
    default: { en: "the provider's `tools.edit`", zh: "沿用 provider 的 `tools.edit`" },
    en: "Editing tools for this model only.",
    zh: "仅针对该模型的编辑工具设置。",
  },
  "providers.<id>.defaultModel": {
    default: none,
    en: "Values for models neither `models` nor the catalog describes: the keys of `models[]` except `id` and `tools`.",
    zh: "既不在 `models` 中、模型目录也不认识的模型所用的值：键与 `models[]` 相同，但没有 `id` 和 `tools`。",
  },
  "compact.threshold": {
    default: "`0.8`",
    en: "Share of the context window at which automatic compaction starts.",
    zh: "上下文占用达到上下文窗口的这个比例时，自动开始压缩。",
  },
  "compact.model": {
    default: { en: "the session's model", zh: "会话当前的模型" },
    en: 'A `"provider/model"` that writes text summaries. Setting it always makes compaction a text summary, never server-side.',
    zh: '用来生成文字摘要的模型，格式为 `"provider/model"`。设置后压缩总是生成文字摘要，不再使用服务端压缩。',
  },
  "compact.layout": {
    default: '`"tail"`',
    en: 'Where a server-side checkpoint goes: `"tail"` keeps the last turns verbatim after it; `"recent-user"` compacts everything and puts the most recent user messages (up to about 64k tokens) before it, as Codex does. Text summaries always use `"tail"`.',
    zh: '服务端压缩检查点的位置：`"tail"` 在检查点之后原样保留最近几个轮次；`"recent-user"` 压缩全部历史，把最近的用户消息（约 64k token 以内）放在检查点之前，与 Codex 的做法相同。文字摘要始终使用 `"tail"`。',
  },
  "fileRewind.enabled": {
    default: "`true`",
    en: "Capture `write`, `edit` and `apply_patch` changes so rewind can restore them. Off: the rewind picker says files will not be restored.",
    zh: "记录 `write`、`edit` 和 `apply_patch` 的改动，供回退时恢复。关闭后回退选择器会提示不会恢复文件。",
  },
  "fileRewind.maxFileBytes": {
    default: "`10485760`",
    en: "Largest file, before or after a change, that can be captured; a larger write is refused while capture is on.",
    zh: "可记录的最大文件（改动前或改动后）；启用记录时，超过它的写入会被拒绝。",
  },
  "fileRewind.quotaBytes": {
    default: "`268435456`",
    en: "Most bytes of unique file images one session keeps; past it, writes are refused until `/rewind-prune`.",
    zh: "每个会话最多保存的去重文件镜像字节数；超出后写入会被拒绝，直到执行 `/rewind-prune`。",
  },
  "context.outputs.saveAbove": {
    default: "`16000`",
    en: "Tool output longer than this many characters (a Chinese, Japanese or Korean character counts as four) is saved whole as an artifact, and the model gets a preview; at least 4000.",
    zh: "超过这个字符数的工具输出（中文、日文、韩文字符每个按四个计）会作为 artifact 完整保存，模型收到的是预览；最少 4000。",
  },
  "context.outputs.previewChars": {
    default: "`8000`",
    en: "Characters of the preview the model gets instead; at least 500, and never more than `saveAbove`.",
    zh: "模型收到的预览的字符数；最少 500，且不超过 `saveAbove`。",
  },
  "context.outputs.quotaMB": {
    default: "`256`",
    en: "Most megabytes of artifacts one session keeps; past it, outputs are only previewed. `/prune` frees space.",
    zh: "每个会话最多保存的 artifact 大小（MB）；超出后输出只保留预览。`/prune` 可以释放空间。",
  },
  "context.dedupeReads": {
    default: "`true`",
    en: "A `read` that returns exactly what the latest read of the same range, still in the context, returned is sent as a short note pointing to it.",
    zh: "一次 `read` 返回的内容与上下文中仍保留的同一范围的最近一次读取完全相同时，改为发送一条指向它的简短说明。",
  },
  "context.aging.enabled": {
    default: "`true`",
    en: "Replace old tool results with short stubs when the context gets full, before compacting. Only where the provider allows rewriting history (no signed reasoning after the result).",
    zh: "上下文快满时，在压缩之前把较早的工具结果替换为简短的占位文本。只在 provider 允许改写历史时进行（结果之后没有签名的推理内容）。",
  },
  "context.aging.start": {
    default: "`0.7`",
    en: "Share of the context window the next request is expected to pass that starts an aging round.",
    zh: "预计下一次请求超过上下文窗口的这个比例时，开始一轮清理。",
  },
  "context.aging.target": {
    default: "`0.6`",
    en: "Share of the context window a round frees down to.",
    zh: "一轮清理把上下文降到窗口的这个比例。",
  },
  "context.aging.minSavedTokens": {
    default: "`8000`",
    en: "A round that would free fewer tokens is skipped, so the prompt cache prefix stays (in a small window, at most the space between `start` and `target`).",
    zh: "一轮清理释放的 token 少于这个数时跳过，以保留提示缓存前缀（窗口较小时，最多取 `start` 与 `target` 之间的空间）。",
  },
  "context.aging.keepTurns": {
    default: "`2`",
    en: "Most recent user turns whose results are never cleared.",
    zh: "结果永不清理的最近用户回合数。",
  },
  "context.aging.keepSteps": {
    default: "`2`",
    en: "In a long current turn, its most recent model steps whose results are never cleared.",
    zh: "在很长的当前回合中，结果永不清理的最近模型步骤数。",
  },
  "context.aging.afterTurns": {
    default: "`0`",
    en: "Experimental: also clear results older than this many user turns, whatever the pressure. `0` is off.",
    zh: "实验性：不管上下文压力，也清理早于这么多个用户回合的结果。`0` 表示关闭。",
  },
  "retry.attempts": {
    default: "`3`",
    en: "Retries of a failed model request after the first try; `0` turns retrying off. A request is retried only while nothing has streamed yet.",
    zh: "模型请求失败后，在首次尝试之外的重试次数；`0` 表示不重试。只有在尚未收到任何流式内容时才会重试。",
  },
  "retry.baseDelayMs": {
    default: "`1000`",
    en: "Wait before the first retry, doubling each time; a server's `Retry-After` replaces it.",
    zh: "第一次重试前的等待时间（毫秒），之后每次翻倍；服务端给出 `Retry-After` 时以它为准。",
  },
  "retry.maxDelayMs": {
    default: "`60000`",
    en: "A wait longer than this is not waited out: the error is reported instead.",
    zh: "需要等待的时间超过这个值时不再等待，直接报告错误。",
  },
  "web.nativeSearch": {
    default: "`true`",
    en: "`false`: never use a provider's hosted web search (`compat.webSearch`), so every model gets the `web_search` tool.",
    zh: "设为 `false` 时从不使用 provider 托管的网页搜索（`compat.webSearch`），所有模型都使用 `web_search` 工具。",
  },
  "web.search.backend": {
    default: '`"exa"`',
    en: "Search backend. Exa's hosted MCP server needs no key.",
    zh: "搜索后端。Exa 托管的 MCP 服务无需密钥。",
  },
  "web.search.fallback": {
    default: none,
    en: "Backends tried in order when the one before fails.",
    zh: "前一个后端失败时依次尝试的后端。",
  },
  "web.search.maxResults": {
    default: "`8`",
    en: "Results returned when the call does not say; a call gets at most 20.",
    zh: "调用未指定数量时返回的结果数；单次调用最多 20 条。",
  },
  "web.search.timeoutMs": {
    default: "`20000`",
    en: "Request timeout per backend, in milliseconds.",
    zh: "每个后端的请求超时（毫秒）。",
  },
  "web.search.exa.url": {
    default: "`https://mcp.exa.ai/mcp`",
    en: "Exa MCP endpoint.",
    zh: "Exa MCP 服务地址。",
    userOnly: true,
  },
  "web.search.exa.apiKeyEnv": {
    default: none,
    en: "Variable holding an Exa key, which raises the free rate limit.",
    zh: "存放 Exa 密钥的环境变量名；有密钥可提高免费额度的速率限制。",
    userOnly: true,
  },
  "web.search.brave.apiKeyEnv": {
    default: "`BRAVE_API_KEY`",
    en: "Variable holding the Brave Search key.",
    zh: "存放 Brave Search 密钥的环境变量名。",
    userOnly: true,
  },
  "web.search.tavily.apiKeyEnv": {
    default: "`TAVILY_API_KEY`",
    en: "Variable holding the Tavily key.",
    zh: "存放 Tavily 密钥的环境变量名。",
    userOnly: true,
  },
  "web.search.tavily.searchDepth": {
    default: '`"basic"`',
    en: 'Tavily search depth: `"basic"` or `"advanced"`.',
    zh: 'Tavily 搜索深度：`"basic"` 或 `"advanced"`。',
  },
  "web.search.searxng.url": {
    default: { en: "required for this backend", zh: "使用该后端时必填" },
    en: "A SearXNG instance with the JSON format enabled.",
    zh: "已启用 JSON 格式的 SearXNG 实例地址。",
    userOnly: true,
  },
  "web.fetch.maxChars": {
    default: "`20000`",
    en: "Characters of converted text returned per call, when the call does not say.",
    zh: "调用未指定时，每次返回的转换后文本字符数。",
  },
  "web.fetch.maxBytes": {
    default: "`5242880` (5 MiB)",
    en: "Largest response body read, in bytes; longer bodies are cut.",
    zh: "读取的响应体上限（字节），超出部分被截断。",
  },
  "web.fetch.timeoutMs": {
    default: "`30000`",
    en: "Request timeout in milliseconds.",
    zh: "请求超时（毫秒）。",
  },
  "web.fetch.allowPrivateNetwork": {
    default: "`false`",
    en: "Allow localhost and private-network addresses.",
    zh: "允许访问 localhost 和私有网络地址。",
    userOnly: true,
  },
  agents: {
    default: none,
    en: "Settings per sub-agent role, by role name.",
    zh: "按角色名配置的子 agent 设置。",
  },
  "agents.<role>.model": {
    default: { en: "the role file's, else the parent's", zh: "取角色文件中的设置，否则沿用父 agent 的模型" },
    en: 'The `"provider/model"` the role runs on. A model named in the task wins.',
    zh: '该角色使用的模型，格式为 `"provider/model"`。任务中指定的模型优先。',
  },
  "subagents.maxDepth": {
    default: "`2`",
    en: "How deep sub-agents may nest.",
    zh: "子 agent 的最大嵌套深度。",
  },
  "subagents.maxConcurrent": {
    default: "`4`",
    en: "Sub-agents running at once in the whole agent tree; the rest wait their turn.",
    zh: "整个 agent 树中同时运行的子 agent 数上限，其余的排队等待。",
  },
  "subagents.background": {
    default: "`true`",
    en: "The main session's `agent` tool runs sub-agents in the background unless the call says otherwise; their results come back as a message.",
    zh: "除非调用另有说明，主会话的 `agent` 工具在后台运行子 agent，结果以消息形式返回。",
  },
  "budget.tokens": {
    default: unlimited,
    en: "Tokens the whole agent tree may use: input, output, and cache reads and writes.",
    zh: "整个 agent 树可用的 token 总数，包括输入、输出以及缓存读写。",
  },
  "budget.costUsd": {
    default: unlimited,
    en: "Cost in USD the whole agent tree may spend, where prices are known.",
    zh: "整个 agent 树可花费的金额（美元），按已知价格计算。",
  },
  "merge.reviewThreshold.lines": {
    default: none,
    en: "A clean worktree merge that changes more lines than this is reviewed too. Without a threshold only conflicts are.",
    zh: "worktree 合并即使没有冲突，改动行数超过这个值时也要审阅。未设置时只审阅有冲突的合并。",
  },
  "merge.reviewThreshold.files": {
    default: none,
    en: "Likewise for the number of changed files.",
    zh: "同上，按改动的文件数计算。",
  },
  "tui.mode": {
    default: '`"fullscreen"`',
    en: '`"fullscreen"` keeps the conversation on the alternate screen, scrolled and searched by Amira; `"inline"` leaves finished output in the terminal\'s scrollback. `--inline` and `--fullscreen` win.',
    zh: '`"fullscreen"` 在终端备用屏幕上显示对话，由 Amira 负责滚动和搜索；`"inline"` 把已完成的输出留在终端滚动缓冲区。`--inline` 和 `--fullscreen` 优先。',
  },
  "tui.bell": {
    default: "`true`",
    en: "Ring the bell when a turn ends or a dialog opens while the terminal is in the background.",
    zh: "终端在后台时，轮次结束或弹出对话框时响铃。",
  },
  "tui.title": {
    default: "`true`",
    en: "Set the terminal title to the folder, session title when present, and branch, marked while working.",
    zh: "把终端标题设为目录名、存在时的会话标题和分支名，工作中会加标记。",
  },
  "tui.progress": {
    default: "`true`",
    en: "Show work on the tab and taskbar progress indicator (OSC 9;4).",
    zh: "在标签页和任务栏进度指示器上显示工作状态（OSC 9;4）。",
  },
  "tui.reflow": {
    default: '`"auto"`',
    en: '`"off"` for terminals that do not re-wrap lines when they get narrower (legacy conhost, some tmux setups).',
    zh: '终端在变窄时不会重新折行（旧版 conhost、部分 tmux 配置）时设为 `"off"`。',
  },
  "tui.submitWhileWorking": {
    default: '`"steer"`',
    en: 'What Enter does while a turn runs: `"steer"` sends the message into the running turn, `"queue"` sends it after the turn. The queue key does the other.',
    zh: '轮次进行中按 Enter 的行为：`"steer"` 把消息发进正在进行的轮次（引导），`"queue"` 让消息排队到轮次结束后发送。排队键执行另一种行为。',
  },
  "tui.images": {
    default: '`"auto"`',
    en: 'Draw images in replies (with the `images` extension): `"auto"` where the terminal supports it, `"on"` everywhere, `"off"` never.',
    zh: '在回复中显示图片（需安装 `images` 扩展）：`"auto"` 在终端支持时显示，`"on"` 总是显示，`"off"` 从不显示。',
  },
  "tui.shellOutputLines": {
    default: "`3`",
    en: "Last output lines shown under a shell command that succeeded; `0` shows none.",
    zh: "成功的 shell 命令在结果下方显示的最后几行输出；`0` 表示不显示。",
  },
  mcpServers: {
    default: none,
    en: "MCP servers by name.",
    zh: "以名称为键的 MCP 服务器。",
  },
  "mcpServers.<name>.type": {
    default: {
      en: '`"http"` if `url` is set, else `"stdio"`',
      zh: '设置了 `url` 时为 `"http"`，否则为 `"stdio"`',
    },
    en: 'Transport. `"streamable-http"` and `"streamableHttp"` mean `"http"`; the legacy `"sse"` is not supported.',
    zh: '传输方式。`"streamable-http"` 和 `"streamableHttp"` 等同于 `"http"`；不支持旧的 `"sse"`。',
  },
  "mcpServers.<name>.command": {
    default: { en: "required for stdio", zh: "stdio 必填" },
    en: "The program to start.",
    zh: "要启动的程序。",
  },
  "mcpServers.<name>.args": {
    default: "`[]`",
    en: "Its arguments.",
    zh: "程序参数。",
  },
  "mcpServers.<name>.env": {
    default: none,
    en: "Environment variables for the program.",
    zh: "传给程序的环境变量。",
  },
  "mcpServers.<name>.cwd": {
    default: none,
    en: "Working directory for the program.",
    zh: "程序的工作目录。",
  },
  "mcpServers.<name>.url": {
    default: { en: "required for http", zh: "http 必填" },
    en: "The server's streamable HTTP endpoint.",
    zh: "服务器的 streamable HTTP 地址。",
  },
  "mcpServers.<name>.headers": {
    default: none,
    en: "HTTP headers sent to the server.",
    zh: "发给服务器的 HTTP 请求头。",
  },
  "mcpServers.<name>.timeout": {
    default: none,
    en: "Milliseconds a tool call may take.",
    zh: "单次工具调用的超时（毫秒）。",
  },
  "mcpServers.<name>.disabled": {
    default: "`false`",
    en: "`true` switches the server off, including an entry of the same name from an earlier file.",
    zh: "设为 `true` 时停用该服务器，也会停用之前文件中的同名条目。",
  },
  mcpTrustedProjects: {
    default: "`[]`",
    en: "Project directories (and their subdirectories) whose own MCP servers may run.",
    zh: "允许运行自带 MCP 服务器的项目目录（包括其子目录）。",
    userOnly: true,
  },
  extensions: {
    default: none,
    en: 'Settings of installed extensions, by extension name, e.g. `{"workflow": {"enabled": "always"}}`. Each extension documents and checks its own section.',
    zh: '已安装扩展的设置，以扩展名为键，例如 `{"workflow": {"enabled": "always"}}`。各扩展自行说明并校验自己的部分。',
  },
  "packages.disabled": {
    default: "`[]`",
    en: "Packages not to load, of either scope; the lock files keep them. Set by `amira ext disable` and `enable`.",
    zh: "不加载的包（用户和项目范围均适用），锁文件中仍保留它们。由 `amira ext disable` 和 `enable` 设置。",
    userOnly: true,
  },
  "packages.trustedProjects": {
    default: "`[]`",
    en: "Project directories whose own packages (`.amira/packages`) may load.",
    zh: "允许加载自带包（`.amira/packages`）的项目目录。",
    userOnly: true,
  },
  "packages.untrustedProjects": {
    default: "`[]`",
    en: "Project directories whose packages you chose not to load.",
    zh: "你选择不加载其自带包的项目目录。",
    userOnly: true,
  },
  "skills.dirs": {
    default: none,
    en: "Extra skill directories, searched after `.amira/skills` and `~/.amira/skills` and before `.agents/skills` and `.claude/skills`. `~` is your home directory; relative paths start from the working directory.",
    zh: "额外的技能目录，搜索顺序在 `.amira/skills` 和 `~/.amira/skills` 之后、`.agents/skills` 和 `.claude/skills` 之前。`~` 表示用户主目录；相对路径从工作目录算起。",
  },
}
