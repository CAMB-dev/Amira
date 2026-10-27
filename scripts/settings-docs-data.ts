import { documentedDefault } from "./settings-docs-defaults.ts"

// What the settings types cannot say, for gen-settings-docs.ts: each key's default as the code
// applies it, a description in English, Chinese and Japanese, and whether only the user file may set it.
// A key added to the types fails the generator until it has an entry here.

export interface Annotation {
  /** Markdown; one string when all languages read the same. */
  default: string | Text
  en: string
  zh: string
  ja: string
  /** Ignored, with a warning, in project files (load.ts), or read from the user file only. */
  userOnly?: boolean
}

type Text = { en: string; zh: string; ja: string }

const none: Text = { en: "none", zh: "无", ja: "なし" }
const unlimited: Text = { en: "unlimited", zh: "不限", ja: "無制限" }

/** Keys in the types that settings files cannot set: the schema ignores them, with a warning. */
export const omitted: Record<string, string> = {
  "providers.<id>.models[].provider": "set by Amira from the provider entry",
  "providers.<id>.models[].contextWindowSource": "set by Amira when it resolves the model",
}

/** Keys documented as one row: their fields repeat ones listed elsewhere. */
export const collapsed: string[] = ["providers.<id>.defaultModel"]

/** Named shapes documented separately, mapped to a valid sample for schema checks. */
export const opaqueTypes: Record<string, unknown> = { ShimmerEffect: "soft" }

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
    title: { en: "General", zh: "常规", ja: "一般" },
    keys: [
      "model",
      "thinking",
      "fastMode",
      "shell",
      "tools",
      "maxParallelTools",
      "agent",
      "backgroundJobs",
      "commandAliases",
      "sessions",
      "updates",
    ],
  },
  {
    title: { en: "Providers and models", zh: "Provider 与模型", ja: "プロバイダーとモデル" },
    intro: {
      en: "Amira has no built-in providers: an entry needs `dialect` and `baseUrl`, and `baseUrl` only counts in the user file. Model metadata is taken from `models`, then the models.dev catalog, then `defaultModel`, then the built-in fallbacks; `caps` merge key by key in the same order. See [Providers and models](providers.md) for the protocols, key precedence and the provider form.",
      zh: "Amira 没有内置 provider：每个条目都需要 `dialect` 和 `baseUrl`，其中 `baseUrl` 只能写在用户文件里。模型信息依次取自 `models`、models.dev 模型目录、`defaultModel`，最后是内置的兜底值；`caps` 按同样的顺序逐键合并。协议、密钥优先级和 provider 表单见 [Provider 与模型](providers.md)。",
      ja: "Amira に組み込みのプロバイダーはありません。各エントリーには `dialect` と `baseUrl` が必要で、`baseUrl` はユーザーファイルでのみ有効です。モデルのメタデータは `models`、models.dev カタログ、`defaultModel`、組み込みのフォールバック値の順に取得し、`caps` も同じ順でキーごとにマージします。プロトコル、キーの優先順位、プロバイダーのフォームについては[プロバイダーとモデル](providers.md)を参照してください。",
    },
    keys: ["providers"],
  },
  {
    title: { en: "Permissions", zh: "权限", ja: "権限" },
    intro: {
      en: "What the model may do without asking; see [Permissions](usage.md#permissions). A project file can only tighten them: its `mode` counts when it is stricter than the user's, its `ask` and `deny` rules always apply, and its `allow` rules only once the project is trusted (`amira ext trust`).",
      zh: "模型无需询问即可执行的操作，详见[权限](usage.md#权限)。项目文件只能收紧这些设置：它的 `mode` 只在比用户设置更严格时生效，它的 `ask` 和 `deny` 规则总是生效，`allow` 规则则要等项目受信任后（`amira ext trust`）才生效。",
      ja: "モデルが確認なしで実行できる操作を設定します。[権限](usage.md#権限)を参照してください。プロジェクトファイルでは制限を厳しくすることだけができます。`mode` はユーザー設定より厳しい場合に有効となり、`ask` と `deny` のルールは常に適用されます。`allow` のルールはプロジェクトが信頼された後（`amira ext trust`）にのみ適用されます。",
    },
    keys: ["permissions"],
  },
  {
    title: { en: "Compaction and retries", zh: "压缩与重试", ja: "圧縮と再試行" },
    keys: ["compact", "retry"],
  },
  {
    title: { en: "Remote runtime", zh: "远程运行时", ja: "リモートランタイム" },
    intro: {
      en: "Read from settings on the remote host, not the local client. These timeouts do not change provider request timeouts.",
      zh: "从远程主机上的设置读取，而非本地客户端。这些超时不会改变 provider 请求的超时。",
      ja: "ローカルクライアントではなく、リモートホストの設定から読み取ります。プロバイダーへのリクエストのタイムアウトとは別の設定です。",
    },
    keys: ["remote"],
  },
  {
    title: { en: "Context management", zh: "上下文管理", ja: "コンテキスト管理" },
    intro: {
      en: "What model requests carry of the history; the session file always keeps everything. See [Context management](usage.md#context-management).",
      zh: "模型请求携带历史中的哪些内容；会话文件始终完整保存。详见[上下文管理](usage.md#上下文管理)。",
      ja: "モデルリクエストに履歴のどの部分を含めるかを設定します。セッションファイルには常にすべてを保持します。[コンテキスト管理](usage.md#コンテキスト管理)を参照してください。",
    },
    keys: ["context"],
  },
  {
    title: { en: "File rewind", zh: "文件回退", ja: "ファイルの巻き戻し" },
    intro: {
      en: "Bytes the file tools change, kept so that rewind can restore them; see [Sessions](usage.md).",
      zh: "文件工具改动的字节内容，供回退时恢复，详见[会话](usage.md)。",
      ja: "巻き戻しで復元できるよう、ファイルツールが変更したバイト列を保持します。[セッション](usage.md)を参照してください。",
    },
    keys: ["fileRewind"],
  },
  {
    title: { en: "Web tools", zh: "网页工具", ja: "Web ツール" },
    intro: {
      en: "Settings for the `web_search` and `web_fetch` tools. Hide either tool with `tools.disabled`.",
      zh: "`web_search` 和 `web_fetch` 工具的设置。要隐藏其中一个工具，把它加入 `tools.disabled`。",
      ja: "`web_search` と `web_fetch` ツールの設定です。どちらのツールも `tools.disabled` で非表示にできます。",
    },
    keys: ["web"],
  },
  {
    title: { en: "Terminal UI", zh: "终端界面", ja: "端末 UI" },
    intro: {
      en: "[Keybindings](keybindings.md#terminal-settings) describes these in more detail. Keys themselves are changed in `keybindings.json`, not here.",
      zh: "[快捷键](keybindings.md#终端设置)一文对这些设置有更详细的说明。按键本身在 `keybindings.json` 中修改，而不是这里。",
      ja: "[キー割り当て](keybindings.md#端末の設定)に詳しい説明があります。キー自体の変更はここではなく、`keybindings.json` で行います。",
    },
    keys: ["tui"],
  },
  {
    title: { en: "Sub-agents", zh: "子 agent", ja: "サブエージェント" },
    intro: {
      en: "See [Sub-agents](subagents.md) for roles, the agent tree and worktree merges.",
      zh: "角色、agent 树和 worktree 合并见[子 agent](subagents.md)。",
      ja: "役割、エージェントツリー、worktree のマージについては[サブエージェント](subagents.md)を参照してください。",
    },
    keys: ["agents", "subagents", "budget", "merge"],
  },
  {
    title: { en: "MCP servers", zh: "MCP 服务器", ja: "MCP サーバー" },
    intro: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the MCP extension's own ${VAR} syntax
      en: "The MCP extension reads `mcpServers` from `.mcp.json` in the working directory, then from the user file, the project file and `settings.local.json`; a later entry of the same name replaces an earlier one. Strings may use `${VAR}` and `${VAR:-default}`. Servers from project files (`.mcp.json` included) are trusted only when the project directory, or a parent, is in `mcpTrustedProjects`: otherwise their stdio servers do not start, their HTTP servers get no environment variables, and they cannot replace a server the user file defines. `/reload` reads these files again: it starts servers you added, stops removed ones, restarts changed ones and leaves the others connected.",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the MCP extension's own ${VAR} syntax
      zh: "MCP 扩展依次从工作目录的 `.mcp.json`、用户文件、项目文件和 `settings.local.json` 读取 `mcpServers`，同名条目以后读到的为准。字符串中可以使用 `${VAR}` 和 `${VAR:-default}`。来自项目文件（包括 `.mcp.json`）的服务器，只有在项目目录或其上级目录列在 `mcpTrustedProjects` 中时才受信任；否则其中的 stdio 服务器不会启动，HTTP 服务器拿不到环境变量，也不能替换用户文件中定义的同名服务器。`/reload` 会重新读取这些文件：启动新增的服务器，停止已删除的服务器，重启有改动的服务器，其余服务器保持连接。",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the MCP extension's own ${VAR} syntax
      ja: "MCP 拡張機能は、作業ディレクトリの `.mcp.json`、ユーザーファイル、プロジェクトファイル、`settings.local.json` の順に `mcpServers` を読み取ります。同名のエントリーは後のものが前のものを置き換えます。文字列には `${VAR}` と `${VAR:-default}` を使えます。プロジェクトファイル（`.mcp.json` を含む）のサーバーは、プロジェクトディレクトリまたはその親が `mcpTrustedProjects` に含まれる場合にのみ信頼されます。それ以外では、stdio サーバーは起動せず、HTTP サーバーには環境変数を渡さず、ユーザーファイルが定義するサーバーを置き換えることもできません。`/reload` はこれらのファイルを再読み込みし、追加したサーバーを起動し、削除したサーバーを停止し、変更したサーバーを再起動します。それ以外のサーバーは接続を維持します。",
    },
    keys: ["mcpServers", "mcpTrustedProjects"],
  },
  {
    title: {
      en: "Extensions, packages and skills",
      zh: "扩展、包与技能",
      ja: "拡張機能、パッケージ、スキル",
    },
    intro: {
      en: "`amira ext` and `/ext` write the `packages` lists for you; see [Extensions](extensions.md).",
      zh: "`amira ext` 和 `/ext` 会替你维护 `packages` 下的列表，详见[扩展](extensions.md)。",
      ja: "`amira ext` と `/ext` は `packages` のリストを管理します。[拡張機能](extensions.md)を参照してください。",
    },
    keys: ["extensions", "packages", "skills"],
  },
]

export const annotations: Record<string, Annotation> = {
  "remote.idleTimeoutMs": {
    default: documentedDefault("remote.idleTimeoutMs"),
    en: "Shut down the daemon after this many milliseconds with no controller or work. Turns, tools, jobs, monitors, runnable children, model calls, pending approvals/forms and queued work prevent idle shutdown. Whole number from 0 to 2147483647; 0 disables idle shutdown. Does not cancel pending approvals.",
    zh: "守护进程在没有控制端且没有工作达到此毫秒数后关闭。轮次、工具、后台任务、监视器、可运行的子 agent、模型调用、待处理的审批或表单以及排队工作都会阻止空闲关闭。取 0 到 2147483647 的整数；0 禁用空闲关闭。不会取消待处理的审批。",
    ja: "コントローラーも処理もない状態がこのミリ秒数続くとデーモンを終了します。ターン、ツール、ジョブ、モニター、実行可能な子エージェント、モデル呼び出し、未回答の承認・フォーム、待機中の処理がある間は終了しません。0〜2147483647 の整数。0 は自動終了を無効にします。未回答の承認は取り消しません。",
  },
  "remote.proxyReconnectTimeoutMs": {
    default: documentedDefault("remote.proxyReconnectTimeoutMs"),
    en: "Wait this many milliseconds for the authorized local model proxy to reconnect before failing the model call. Whole number from 0 to 2147483647; 0 waits indefinitely. Provider timeouts start only after the local proxy accepts execution.",
    zh: "等待已授权的本地模型代理重连的毫秒数，超时后模型调用失败。取 0 到 2147483647 的整数；0 表示无限等待。Provider 超时仅在本地代理接受执行后开始计时。",
    ja: "認可されたローカルモデルプロキシの再接続を待つミリ秒数。期限を過ぎるとモデル呼び出しは失敗します。0〜2147483647 の整数。0 は無期限に待機します。プロバイダーのタイムアウトは、ローカルプロキシが実行を受け付けてから開始します。",
  },
  "updates.auto": {
    default: documentedDefault("updates.auto"),
    en: "Check self-managed single-file installs in the background and install patch updates for the next start. Minor and major releases only show a notice. Package-manager and source installs never self-update.",
    zh: "在后台检查自管单文件安装，并安装补丁更新，在下次启动时生效。次版本和主版本仅显示提示。包管理器和源码安装不会自行更新。",
    ja: "自己管理の単一実行ファイル版をバックグラウンドで確認し、パッチ更新を次回起動用にインストールします。マイナー・メジャー更新は通知のみです。パッケージマネージャー版とソース版は自己更新しません。",
    userOnly: true,
  },
  "updates.channel": {
    default: documentedDefault("updates.channel"),
    en: "Release channel for update checks and `amira update`: `stable` or release candidates on `next`. Next-channel builds default to `next`. `--channel` overrides it for one command.",
    zh: "更新检查和 `amira update` 使用的发布渠道：`stable` 稳定版或 `next` 候选发布版。next 渠道构建默认使用 `next`。`--channel` 可为单次命令覆盖此设置。",
    ja: "更新確認と `amira update` のリリースチャネル。`stable` は安定版、`next` はリリース候補版です。next ビルドの既定は `next` です。`--channel` でコマンド単位で上書きできます。",
    userOnly: true,
  },
  "updates.minimumVersion": {
    default: none,
    en: "Minimum acceptable update or rollback target (SemVer), enforced under the update lock for rollback with no override. Never installs a release below this version; an older running version shows an update notice. Does not force a minor or major background update.",
    zh: "允许更新或回退的最低目标版本（SemVer）。回退在更新锁内检查此限制，不能绕过。不会安装低于此版本的发布；运行版本过旧时显示更新提示。不会强制在后台安装次版本或主版本更新。",
    ja: "更新またはロールバックを許可する最低バージョン（SemVer）。ロールバックは更新ロック内でこの制限を確認し、回避できません。これを下回るリリースはインストールしません。実行中のバージョンが古い場合は通知します。マイナー・メジャー更新を強制的にバックグラウンドで適用することはありません。",
    userOnly: true,
  },
  model: {
    default: none,
    en: 'Default model as `"provider/model"`. Without it, Amira uses the resumed session\'s model, or the first model of the only provider. `--model` and `AMIRA_MODEL` override it for one run; interactive `/model` changes save the model and thinking choice (see [Saving model and thinking choices](#saving-model-and-thinking-choices)).',
    zh: '默认模型，格式为 `"provider/model"`。未设置时，Amira 使用恢复的会话上次用的模型；只配置了一个 provider 时则用它的第一个模型。`--model` 和 `AMIRA_MODEL` 只在单次运行中覆盖；交互式 `/model` 的更改会保存模型和思考设置（见[保存模型与思考设置](#保存模型与思考设置)）。',
    ja: 'デフォルトのモデルを `"provider/model"` 形式で指定します。未設定の場合、Amira は再開したセッションのモデル、またはプロバイダーが 1 つだけならその最初のモデルを使用します。`--model` と `AMIRA_MODEL` は 1 回の実行に限って上書きします。対話中の `/model` による変更は、モデルと思考設定を保存します（[モデルと思考設定の保存](#モデルと思考設定の保存)を参照）。',
  },
  thinking: {
    default: none,
    en: 'Reasoning effort for main conversation requests on models with `caps.thinking`. Unset or `"default"` leaves effort to the server; it does not turn thinking off. `"default"` overrides earlier top-level layers. A model\'s `thinking` still overrides this; `--thinking` overrides both for one run. Interactive `/thinking` changes save the model and thinking choice; `/thinking default` saves `"default"`. Sub-agents inherit the parent\'s selected effort; titles and compaction do not.',
    zh: '对 `caps.thinking` 为真的模型，设置主对话请求的推理强度。未设置或设为 `"default"` 时沿用服务端默认强度，不会关闭思考。`"default"` 覆盖之前各层的顶层设置。模型的 `thinking` 仍优先于此项，`--thinking` 在单次运行中优先于两者。交互式 `/thinking` 的更改会保存模型和思考设置；`/thinking default` 保存 `"default"`。子 agent 继承父 agent 选中的档位；标题生成和上下文压缩不继承。',
    ja: '`caps.thinking` を持つモデルで、メインの会話リクエストに使う推論の強度です。未設定または `"default"` では強度をサーバーに任せます。思考を無効にするものではありません。`"default"` は、それより前のトップレベルの設定レイヤーを上書きします。モデルごとの `thinking` は引き続きこの設定より優先され、`--thinking` は 1 回の実行に限って両方を上書きします。対話中の `/thinking` による変更はモデルと思考設定を保存し、`/thinking default` は `"default"` を保存します。サブエージェントは親が選択した強度を引き継ぎますが、タイトル生成と圧縮には引き継がれません。',
  },
  fastMode: {
    default: none,
    en: "Request fast/priority serving on supported models and endpoints; off when unset. Interactive `/fast` changes are remembered; unsupported models retain the preference without sending it. Sub-agents inherit it. Changing speed may invalidate the prompt cache. Unknown premium prices use a clearly marked standard-rate estimate.",
    zh: "在支持的模型和端点上请求快速/优先服务；未设置时关闭。交互式 `/fast` 更改会保存；不支持的模型保留偏好但不发送该参数。子 agent 会继承此设置。切换速度可能使提示缓存失效。溢价未知时使用明确标注的标准价格估算。",
    ja: "対応するモデルとエンドポイントで高速/優先処理を要求します。未設定時は無効です。対話中の `/fast` による変更は保存され、非対応モデルでは送信せずに設定を保持します。サブエージェントも引き継ぎます。速度を変更するとプロンプトキャッシュが無効になる場合があります。追加料金が不明な場合は、標準料金による見積もりと明記します。",
  },
  shell: {
    default: documentedDefault("shell"),
    en: 'Which shell tools the model gets on Windows: `"auto"` offers both `bash` and `powershell`, `"bash"` or `"powershell"` hides the other one. Elsewhere only `bash` exists. `--shell` wins.',
    zh: 'Windows 上模型可用的 shell 工具：`"auto"` 同时提供 `bash` 和 `powershell`，`"bash"` 或 `"powershell"` 会隐藏另一个。其他平台只有 `bash`。`--shell` 优先。',
    ja: 'Windows でモデルに提供するシェルツールです。`"auto"` は `bash` と `powershell` の両方を提供し、`"bash"` または `"powershell"` はもう一方を非表示にします。他のプラットフォームでは `bash` のみです。`--shell` が優先されます。',
  },
  "tools.disabled": {
    default: documentedDefault("tools.disabled"),
    en: "Tool names to hide from the model. `--disable-tools` replaces the list for one run; `/tools` changes the current session only.",
    zh: "对模型隐藏的工具名。`--disable-tools` 在单次运行中替换这个列表，`/tools` 只修改当前会话。",
    ja: "モデルに表示しないツールの名前です。`--disable-tools` は 1 回の実行に限ってリストを置き換え、`/tools` は現在のセッションだけを変更します。",
  },
  commandAliases: {
    default: none,
    en: 'Slash command aliases: `{"ds": "model deepseek/deepseek-flash"}` makes `/ds` run `/model deepseek/deepseek-flash`, with anything typed after `/ds` appended. The value names a command, not another alias; commands and their own aliases win.',
    zh: '斜杠命令别名：`{"ds": "model deepseek/deepseek-flash"}` 让 `/ds` 执行 `/model deepseek/deepseek-flash`，`/ds` 后面输入的内容会追加在末尾。值必须是命令而不是另一个别名；与命令或命令自带的别名重名时，以命令为准。',
    ja: 'スラッシュコマンドのエイリアスです。`{"ds": "model deepseek/deepseek-flash"}` を指定すると、`/ds` で `/model deepseek/deepseek-flash` が実行され、`/ds` の後に入力した内容が末尾に追加されます。値はコマンドを指定するもので、別のエイリアスは指定できません。コマンドやその組み込みエイリアスが優先されます。',
  },
  maxParallelTools: {
    default: documentedDefault("maxParallelTools"),
    en: "Most tool calls running at once. Use a whole number of at least 1; invalid values warn and use the default, even over a valid value in a lower-precedence file.",
    zh: "同时运行的工具调用数上限。必须是至少为 1 的整数；无效值会发出警告并使用默认值，即使优先级较低的文件中已有有效值。",
    ja: "同時に実行できるツール呼び出しの最大数です。1 以上の整数を指定してください。無効な値には警告を表示し、優先順位の低いファイルに有効な値があってもデフォルトを使用します。",
  },
  "agent.maxSteps": {
    default: documentedDefault("agent.maxSteps"),
    en: "Maximum model calls per turn for the main agent. Use a nonnegative integer; `0` removes the step limit. `--max-steps <n>` overrides it for one run in interactive and print modes. Sub-agents do not inherit it. Aborts, budget limits and context errors still stop a turn.",
    zh: "主 agent 每轮调用模型的次数上限。使用非负整数；`0` 表示不限制步数。`--max-steps <n>` 在单次运行中覆盖此设置，适用于交互模式和打印模式。子 agent 不会继承。中止、预算限制和上下文错误仍会停止轮次。",
    ja: "メインエージェントが 1 ターンでモデルを呼び出せる最大回数です。0 以上の整数を指定し、`0` でステップ数を無制限にします。`--max-steps <n>` は対話モードと print モードで、1 回の実行に限って上書きします。サブエージェントには引き継がれません。中断、予算の上限、コンテキストエラーでは引き続きターンが停止します。",
  },
  "backgroundJobs.maxRunning": {
    default: documentedDefault("backgroundJobs.maxRunning"),
    en: "Background jobs (commands the shell tools start with `background: true`, such as dev servers and watchers) running at once.",
    zh: "同时运行的后台任务数上限（shell 工具以 `background: true` 启动的命令，如开发服务器和文件监视进程）。",
    ja: "同時に実行できるバックグラウンドジョブの最大数です。シェルツールが `background: true` で開始したコマンド（開発サーバーや監視プロセスなど）が対象です。",
  },
  "backgroundJobs.bufferChars": {
    default: documentedDefault("backgroundJobs.bufferChars"),
    en: "Characters of output each job keeps in memory for reading; at least 1000.",
    zh: "每个后台任务在内存中保留、供读取的输出字符数，最少 1000。",
    ja: "各ジョブが読み取り用にメモリに保持する出力の文字数です。最小値は 1000 です。",
  },
  "backgroundJobs.maxLogBytes": {
    default: documentedDefault("backgroundJobs.maxLogBytes"),
    en: "Bytes of each job's output written to its log file.",
    zh: "每个后台任务写入日志文件的输出字节数上限。",
    ja: "各ジョブのログファイルに書き込む出力のバイト数です。",
  },
  "backgroundJobs.printWaitMs": {
    default: documentedDefault("backgroundJobs.printWaitMs"),
    en: "How long print mode waits for top-level background jobs started during the run before stopping them on exit.",
    zh: "print 模式等待本次运行启动的顶层后台任务的时长，超时后退出时停止它们。",
    ja: "print モードで、実行中に開始したトップレベルのバックグラウンドジョブを待つ時間です。待機後、終了時にジョブを停止します。",
  },
  "sessions.autoTitle": {
    default: documentedDefault("sessions.autoTitle"),
    en: "Ask the model for a short session title in the background after the first turn (`compact.model` when set). `/rename` always wins.",
    zh: "第一个轮次结束后，在后台请模型为会话起一个简短标题（设置了 `compact.model` 时用它）。`/rename` 设置的名称始终优先。",
    ja: "最初のターンの後、バックグラウンドでモデルに短いセッションタイトルを生成させます。`compact.model` が設定されていればそのモデルを使います。`/rename` が常に優先されます。",
  },
  "permissions.mode": {
    default: documentedDefault("permissions.mode"),
    en: '`"auto"` runs everything without asking, except what rules and protected paths say; `"edits"` changes files without asking and asks before shell commands; `"plan"` is read-only. Shift+Tab cycles it in the UI; `--permission-mode` wins.',
    zh: '`"auto"` 除规则和受保护路径要求的以外，一律不询问直接执行；`"edits"` 修改文件不询问，执行 shell 命令前询问；`"plan"` 为只读。界面中按 Shift+Tab 切换；`--permission-mode` 优先。',
    ja: '`"auto"` は、ルールや保護されたパスによる制限を除き、確認なしで実行します。`"edits"` はファイルを確認なしで変更し、シェルコマンドの実行前に確認します。`"plan"` は読み取り専用です。UI では Shift+Tab で切り替えます。`--permission-mode` が優先されます。',
  },
  "permissions.rules": {
    default: documentedDefault("permissions.rules"),
    en: 'Rules for shell commands, matched against each command\'s words. When several match, `deny` wins over `ask` and `ask` over `allow`; `allow` only means "do not ask" and never lifts the mode or a protected path.',
    zh: "针对 shell 命令的规则，按每条命令的单词匹配。多条规则匹配时，`deny` 优先于 `ask`，`ask` 优先于 `allow`；`allow` 只表示“不询问”，不会解除模式或受保护路径的限制。",
    ja: "シェルコマンドに適用するルールです。各コマンドの単語と照合します。複数のルールに一致する場合、`deny` が `ask` より、`ask` が `allow` より優先されます。`allow` は「確認しない」という意味にすぎず、モードや保護されたパスの制限を解除しません。",
  },
  "permissions.rules[].command": {
    default: { en: "required", zh: "必填", ja: "必須" },
    en: 'The first words of the command, e.g. `["git", "push"]`. An `allow` rule must match the start of the command exactly; `ask` and `deny` rules also match with other words in between and ignore case.',
    zh: '命令开头的若干单词，例如 `["git", "push"]`。`allow` 规则必须与命令开头完全一致；`ask` 和 `deny` 规则在中间夹有其他单词时也能匹配，且不区分大小写。',
    ja: 'コマンドの先頭の単語です。例：`["git", "push"]`。`allow` ルールはコマンドの先頭と完全に一致する必要があります。`ask` と `deny` は、間に他の単語があっても一致し、大文字と小文字を区別しません。',
  },
  "permissions.rules[].decision": {
    default: { en: "required", zh: "必填", ja: "必須" },
    en: '`"allow"` runs it without asking, `"ask"` asks first, `"deny"` never runs it.',
    zh: '`"allow"` 不询问直接执行，`"ask"` 先询问，`"deny"` 永不执行。',
    ja: '`"allow"` は確認せずに実行し、`"ask"` は先に確認し、`"deny"` は実行しません。',
  },
  "permissions.rules[].reason": {
    default: none,
    en: "Shown with the question or the refusal.",
    zh: "随询问或拒绝一起显示。",
    ja: "確認や拒否のメッセージとともに表示する理由です。",
  },
  providers: {
    default: none,
    en: "Providers by the ID you choose; models are named `<id>/<model>`.",
    zh: "以你自定的 ID 为键的 provider；模型写作 `<id>/<model>`。",
    ja: "指定した ID をキーとするプロバイダーです。モデル名は `<id>/<model>` 形式です。",
  },
  "providers.<id>.dialect": {
    default: { en: "required", zh: "必填", ja: "必須" },
    en: "The protocol: `openai-chat`, `openai-responses`, `anthropic-messages` or `google-gemini`.",
    zh: "协议：`openai-chat`、`openai-responses`、`anthropic-messages` 或 `google-gemini`。",
    ja: "プロトコルです。`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini` のいずれかを指定します。",
  },
  "providers.<id>.baseUrl": {
    default: { en: "required", zh: "必填", ja: "必須" },
    en: "The endpoint requests go to.",
    zh: "请求发送到的地址。",
    ja: "リクエストの送信先エンドポイントです。",
    userOnly: true,
  },
  "providers.<id>.apiKeyEnv": {
    default: none,
    en: "Environment variable holding the API key (its name, not the key). Without a key in the environment, the key stored in `auth.json` is used.",
    zh: "存放 API 密钥的环境变量名（不是密钥本身）。环境变量中没有密钥时，使用 `auth.json` 中保存的密钥。",
    ja: "API キーを格納する環境変数の名前です。キーそのものではありません。環境変数にキーがなければ、`auth.json` に保存したキーを使用します。",
    userOnly: true,
  },
  "providers.<id>.apiKeyEnvFallbacks": {
    default: none,
    en: "Variables tried in order when `apiKeyEnv` is unset or empty.",
    zh: "`apiKeyEnv` 未设置或为空时，按顺序尝试的环境变量。",
    ja: "`apiKeyEnv` が未設定または空の場合に、順番に試す環境変数です。",
    userOnly: true,
  },
  "providers.<id>.keySource": {
    default: none,
    en: '`"auth"` reads `auth.json`; `"env"` uses only `apiKeyEnv` and `apiKeyEnvFallbacks`; `"none"` disables API-key lookup. Omit to keep legacy behavior: try environment variables, then `auth.json`.',
    zh: '`"auth"` 读取 `auth.json`；`"env"` 只使用 `apiKeyEnv` 和 `apiKeyEnvFallbacks`；`"none"` 不查找 API 密钥。省略时保留旧版行为：先尝试环境变量，再读取 `auth.json`。',
    ja: '`"auth"` は `auth.json` を読み、`"env"` は `apiKeyEnv` と `apiKeyEnvFallbacks` のみを使います。`"none"` は API キーの検索を無効にします。省略すると従来どおり、環境変数、次に `auth.json` の順に試します。',
    userOnly: true,
  },
  "providers.<id>.headers": {
    default: none,
    en: "Extra HTTP headers sent with every request.",
    zh: "每个请求附带的额外 HTTP 请求头。",
    ja: "すべてのリクエストに付ける追加の HTTP ヘッダーです。",
    userOnly: true,
  },
  "providers.<id>.compat.maxTokensField": {
    default: documentedDefault("providers.<id>.compat.maxTokensField"),
    en: "`openai-chat`: the field that carries the output token limit.",
    zh: "`openai-chat`：携带输出 token 上限的字段。",
    ja: "`openai-chat` で出力トークン数の上限を送るフィールドです。",
  },
  "providers.<id>.compat.webSearch": {
    default: {
      en: "on only at api.openai.com, Azure OpenAI, api.anthropic.com and generativelanguage.googleapis.com",
      zh: "仅在 api.openai.com、Azure OpenAI、api.anthropic.com 和 generativelanguage.googleapis.com 上开启",
      ja: "api.openai.com、Azure OpenAI、api.anthropic.com、generativelanguage.googleapis.com でのみ有効",
    },
    en: "`openai-responses`, `anthropic-messages`, `google-gemini`: offer the provider's hosted web search; the model then does not get the `web_search` tool (`web_fetch` stays). With Amira's tools, Gemini needs a Gemini 3 model. A model's `caps.webSearch` wins; `web.nativeSearch: false` turns it off everywhere.",
    zh: "`openai-responses`、`anthropic-messages`、`google-gemini`：使用 provider 托管的网页搜索，此时模型不再获得 `web_search` 工具（`web_fetch` 保留）。同时带有 Amira 的工具时，Gemini 需要 Gemini 3 模型。模型的 `caps.webSearch` 优先；`web.nativeSearch: false` 会全局关闭它。",
    ja: "`openai-responses`、`anthropic-messages`、`google-gemini` で、プロバイダーが提供するホスト型 Web 検索を有効にします。この場合、モデルに `web_search` ツールは提供されません（`web_fetch` は引き続き使えます）。Amira のツールと併用する場合、Gemini には Gemini 3 モデルが必要です。モデルの `caps.webSearch` が優先され、`web.nativeSearch: false` はすべてのモデルで無効にします。",
  },
  "providers.<id>.compat.streamUsage": {
    default: documentedDefault("providers.<id>.compat.streamUsage"),
    en: "`openai-chat`: ask for token usage in the stream.",
    zh: "`openai-chat`：在流式响应中请求 token 用量。",
    ja: "`openai-chat` でストリーム内のトークン使用量を要求します。",
  },
  "providers.<id>.compat.thinking": {
    default: documentedDefault("providers.<id>.compat.thinking"),
    en: '`anthropic-messages`: `"adaptive"` uses adaptive thinking with an optional effort; `"budget"` sends `budget_tokens`, for Claude 4.5 and older and compatible servers such as DeepSeek.',
    zh: '`anthropic-messages`：`"adaptive"` 使用自适应思考，可选 effort；`"budget"` 发送 `budget_tokens`，适用于 Claude 4.5 及更早的模型和 DeepSeek 等兼容服务。',
    ja: '`anthropic-messages` の `"adaptive"` は、必要に応じて推論の強度を指定できる適応型思考を使います。`"budget"` は `budget_tokens` を送信し、Claude 4.5 以前のモデルや DeepSeek などの互換サーバーに対応します。',
  },
  "providers.<id>.compat.thinkingDisplay": {
    default: {
      en: '`"summarized"` at api.anthropic.com; otherwise not sent',
      zh: 'api.anthropic.com 使用 `"summarized"`；其他地址不发送',
      ja: 'api.anthropic.com では `"summarized"`、それ以外では送信しません',
    },
    en: '`anthropic-messages`: request readable thinking summaries (`"summarized"`) or signed blocks without text (`"omitted"`), in adaptive and budget modes. Never sent with disabled thinking. Compatible servers and proxies must opt in; `models[].compat.thinkingDisplay` overrides it.',
    zh: '`anthropic-messages`：在 adaptive 和 budget 模式下请求可读的思考摘要（`"summarized"`），或仅含签名、不含文字的块（`"omitted"`）。禁用思考时不发送。兼容服务与代理需显式设置；`models[].compat.thinkingDisplay` 优先。',
    ja: '`anthropic-messages` の adaptive モードと budget モードで、読める思考の要約（`"summarized"`）、またはテキストを含まない署名付きブロック（`"omitted"`）を要求します。思考が無効な場合は送信しません。互換サーバーやプロキシでは明示的な有効化が必要です。`models[].compat.thinkingDisplay` がこの設定を上書きします。',
  },
  "providers.<id>.models[].compat.thinkingDisplay": {
    default: {
      en: "defaultModel, then the provider's",
      zh: "先取 defaultModel，再取 provider 设置",
      ja: "defaultModel、次にプロバイダーの設定",
    },
    en: "Thinking display for this model; overrides the provider's setting. Otherwise uses defaultModel, then the provider, then the endpoint default.",
    zh: "该模型的思考显示方式，优先于 provider 设置。未设置时依次取 defaultModel、provider、地址默认值。",
    ja: "このモデルの思考の表示方法です。プロバイダーの設定を上書きします。未設定の場合は defaultModel、プロバイダー、エンドポイントのデフォルトの順に使用します。",
  },
  "providers.<id>.compat.compaction": {
    default: documentedDefault("providers.<id>.compat.compaction"),
    en: 'Server-side (native) compaction, for `openai-responses` and `anthropic-messages`. `"auto"` uses it only at the vendor\'s own endpoints, `"on"` at any host (e.g. a proxy that forwards it), `"off"` never. It falls back to a text summary when it fails.',
    zh: '服务端（原生）压缩，适用于 `openai-responses` 和 `anthropic-messages`。`"auto"` 只在厂商自己的地址上使用，`"on"` 在任何地址上使用（例如会转发该功能的代理），`"off"` 从不使用。失败时退回文字摘要。',
    ja: '`openai-responses` と `anthropic-messages` のサーバー側（ネイティブ）圧縮です。`"auto"` はベンダー自身のエンドポイントでのみ使用し、`"on"` は任意のホスト（機能を転送するプロキシなど）で使用し、`"off"` は使用しません。失敗した場合はテキスト要約にフォールバックします。',
    userOnly: true,
  },
  "providers.<id>.catalogId": {
    default: {
      en: "the provider ID (a few are mapped)",
      zh: "provider ID（少数有内置映射）",
      ja: "プロバイダー ID（一部はマッピングされます）",
    },
    en: "The provider's ID in the models.dev catalog, when it differs from yours; `false` ignores the catalog. Built in: `gemini` → `google`, `moonshot` → `moonshotai`, `ollama` and `lmstudio` → `false`, and a few more.",
    zh: "该 provider 在 models.dev 模型目录中的 ID（与你的 ID 不同时设置）；`false` 表示不使用模型目录。内置映射包括 `gemini` → `google`、`moonshot` → `moonshotai`、`ollama` 和 `lmstudio` → `false` 等。",
    ja: "models.dev カタログでのプロバイダー ID が指定した ID と異なる場合に設定します。`false` はカタログを使いません。組み込みのマッピングには `gemini` → `google`、`moonshot` → `moonshotai`、`ollama` と `lmstudio` → `false` などがあります。",
  },
  "providers.<id>.tools.edit": {
    default: documentedDefault("providers.<id>.tools.edit"),
    en: 'Editing tools for this provider\'s models: `"edit"`, `"apply_patch"` or `"both"`. `write` is always offered. See [Editing tools](providers.md#editing-tools).',
    zh: '该 provider 的模型使用的编辑工具：`"edit"`、`"apply_patch"` 或 `"both"`。`write` 始终可用。见[编辑工具](providers.md#编辑工具)。',
    ja: 'このプロバイダーのモデルに提供する編集ツールです。`"edit"`、`"apply_patch"`、`"both"` のいずれかを指定します。`write` は常に提供されます。[編集ツール](providers.md#編集ツール)を参照してください。',
  },
  "providers.<id>.models": {
    default: none,
    en: "Models you describe. A listed model wins over the catalog.",
    zh: "你手动描述的模型。列出的模型优先于模型目录。",
    ja: "手動で記述するモデルです。ここに指定したモデルはカタログより優先されます。",
  },
  "providers.<id>.models[].id": {
    default: { en: "required", zh: "必填", ja: "必須" },
    en: "The model ID the endpoint expects.",
    zh: "服务端要求的模型 ID。",
    ja: "エンドポイントが受け付けるモデル ID です。",
  },
  "providers.<id>.models[].dialect": {
    default: { en: "the provider's", zh: "沿用 provider 的设置", ja: "プロバイダーの設定" },
    en: "A different protocol for this model.",
    zh: "为该模型单独指定协议。",
    ja: "このモデルに別のプロトコルを指定します。",
  },
  "providers.<id>.models[].contextWindow": {
    default: documentedDefault("providers.<id>.models[].contextWindow"),
    en: "Context window in tokens. Compaction and `/context` use it.",
    zh: "上下文窗口大小（token）。压缩和 `/context` 依据这个值。",
    ja: "コンテキストウィンドウのトークン数です。圧縮と `/context` で使用します。",
  },
  "providers.<id>.models[].maxOutput": {
    default: documentedDefault("providers.<id>.models[].maxOutput"),
    en: "Most output tokens per reply.",
    zh: "单次回复的输出 token 上限。",
    ja: "1 回の返信で出力できるトークン数の上限です。",
  },
  "providers.<id>.models[].cost.input": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million input tokens; `input` and `output` are required when `cost` is set.",
    zh: "每百万输入 token 的价格（美元）；设置 `cost` 时 `input` 和 `output` 必填。",
    ja: "入力 100 万トークンあたりの料金（USD）です。`cost` を設定する場合、`input` と `output` は必須です。",
  },
  "providers.<id>.models[].cost.output": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million output tokens.",
    zh: "每百万输出 token 的价格（美元）。",
    ja: "出力 100 万トークンあたりの料金（USD）です。",
  },
  "providers.<id>.models[].cost.cacheRead": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million tokens read from the prompt cache.",
    zh: "每百万缓存读取 token 的价格（美元）。",
    ja: "プロンプトキャッシュから読み取る 100 万トークンあたりの料金（USD）です。",
  },
  "providers.<id>.models[].cost.cacheWrite": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million tokens written to the prompt cache.",
    zh: "每百万缓存写入 token 的价格（美元）。",
    ja: "プロンプトキャッシュに書き込む 100 万トークンあたりの料金（USD）です。",
  },
  "providers.<id>.models[].cost.webSearch": {
    default: { en: "unknown", zh: "未知", ja: "不明" },
    en: "USD per hosted web search. Catalogs list no search fees, so without it a reply that searched shows its cost as unknown.",
    zh: "每次托管网页搜索的价格（美元）。模型目录不提供搜索费用，不设置时，搜索过的回复费用显示为未知。",
    ja: "ホスト型 Web 検索 1 回あたりの料金（USD）です。カタログには検索料金がないため、未設定の場合、検索した返信の料金は不明と表示されます。",
  },
  "providers.<id>.models[].cost.fast.input": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million fast input tokens; `input` and `output` are required when `cost.fast` is set. Used only for reported fast/priority usage. Optional: without verified premium rates, costs use standard-rate estimates and warn that premium pricing is unknown.",
    zh: "快速模式每百万输入 token 的价格（美元）；设置 `cost.fast` 时 `input` 和 `output` 必填。仅用于响应确认的快速/优先用量。此项可选：没有经核实的溢价费率时，按标准价格估算，并提示溢价未知。",
    ja: "高速入力 100 万トークンあたりの料金（USD）。`cost.fast` を指定する場合、`input` と `output` は必須です。報告された高速/優先処理の使用量だけに適用します。省略可能で、確認済みの追加料金がなければ標準料金で見積もり、追加料金が不明であることを表示します。",
  },
  "providers.<id>.models[].cost.fast.output": {
    default: { en: "catalog", zh: "取模型目录", ja: "カタログの値" },
    en: "USD per million fast output tokens.",
    zh: "快速模式每百万输出 token 的价格（美元）。",
    ja: "高速出力 100 万トークンあたりの料金（USD）です。",
  },
  "providers.<id>.models[].cost.fast.cacheRead": {
    default: { en: "input cache multiplier", zh: "输入缓存倍率", ja: "入力キャッシュ倍率" },
    en: "USD per million fast cache-read tokens; otherwise the standard cache/input ratio applies to the fast input price.",
    zh: "快速模式每百万缓存读取 token 的价格（美元）；否则将标准缓存与输入价格之比应用于快速输入价格。",
    ja: "高速キャッシュ読み取り 100 万トークンあたりの料金（USD）。未指定時は標準のキャッシュ対入力料金比率を高速入力料金に適用します。",
  },
  "providers.<id>.models[].cost.fast.cacheWrite": {
    default: { en: "input cache multiplier", zh: "输入缓存倍率", ja: "入力キャッシュ倍率" },
    en: "USD per million fast cache-write tokens; otherwise the standard cache/input ratio applies to the fast input price.",
    zh: "快速模式每百万缓存写入 token 的价格（美元）；否则将标准缓存与输入价格之比应用于快速输入价格。",
    ja: "高速キャッシュ書き込み 100 万トークンあたりの料金（USD）。未指定時は標準のキャッシュ対入力料金比率を高速入力料金に適用します。",
  },
  "providers.<id>.models[].cost.fast.maxInputTokens": {
    default: {
      en: "no limit, unless the preset sets one",
      zh: "不限，除非预设指定上限",
      ja: "プリセットで指定しない限り無制限",
    },
    en: "Largest prompt token count covered by these premium rates. Beyond it, mark premium pricing as unknown and use a standard-rate estimate instead of treating short-context rates as exact.",
    zh: "这些溢价费率适用的提示 token 数上限。超过时标记溢价未知，并按标准价格估算，不将短上下文费率视为精确费用。",
    ja: "この追加料金が適用されるプロンプトの最大トークン数です。超えた場合は追加料金を不明とし、短いコンテキスト向けの料金を正確な金額として扱わず、標準料金で見積もります。",
  },
  "providers.<id>.models[].fast": {
    default: { en: "endpoint/model preset", zh: "端点/模型预设", ja: "エンドポイント/モデルのプリセット" },
    en: 'Fast-serving request configuration; `false` disables the preset. Use `{ "kind": "anthropic-speed" }` for Claude speed, or `{ "kind": "service-tier", "value": "priority" }` for a compatible service tier. Set only for endpoints/models that support it; see [Fast mode](#fast-mode).',
    zh: '快速服务请求配置；`false` 禁用预设。Claude 速度参数使用 `{ "kind": "anthropic-speed" }`，兼容服务档位使用 `{ "kind": "service-tier", "value": "priority" }`。仅为支持的端点/模型设置；见[快速模式](#快速模式)。',
    ja: '高速処理のリクエスト設定です。`false` でプリセットを無効にします。Claude の速度指定には `{ "kind": "anthropic-speed" }`、互換サービス層には `{ "kind": "service-tier", "value": "priority" }` を使います。対応するエンドポイント/モデルだけに設定してください。[高速モード](#高速モード)を参照してください。',
  },
  "providers.<id>.models[].fast.kind": {
    default: none,
    en: '`"anthropic-speed"` sends Claude `speed: "fast"`; `"service-tier"` sends the configured `service_tier` value. Required when `fast` is an object.',
    zh: '`"anthropic-speed"` 发送 Claude 的 `speed: "fast"`；`"service-tier"` 发送配置的 `service_tier` 值。`fast` 为对象时必填。',
    ja: '`"anthropic-speed"` は Claude の `speed: "fast"` を送信し、`"service-tier"` は設定した `service_tier` の値を送信します。`fast` がオブジェクトの場合は必須です。',
  },
  "providers.<id>.models[].fast.value": {
    default: none,
    en: 'Requested service tier, usually `"priority"`; required only for `"service-tier"`. Actual usage comes from the response, not this value.',
    zh: '请求的服务档位，通常为 `"priority"`；仅 `"service-tier"` 必填。实际用量以响应为准，不根据此值推断。',
    ja: '要求するサービス層で、通常は `"priority"` です。`"service-tier"` の場合のみ必須です。実際の使用量はこの値ではなく、レスポンスに基づきます。',
  },
  "providers.<id>.models[].fast.textOnly": {
    default: "`false`",
    en: "Apply the service tier only to text-only requests; omit it when images are present. Used for xAI priority.",
    zh: "仅对纯文本请求应用该服务档位；含图片时不发送。用于 xAI 优先处理。",
    ja: "テキストのみのリクエストにサービス層を適用し、画像が含まれる場合は送信しません。xAI の優先処理で使用します。",
  },
  "providers.<id>.models[].fast.responseHeader": {
    default: none,
    en: 'HTTP response header reporting the tier actually served, such as Google `"x-gemini-service-tier"`; otherwise read the response body.',
    zh: '报告实际服务档位的 HTTP 响应头，例如 Google 的 `"x-gemini-service-tier"`；否则读取响应体。',
    ja: '実際に使用されたサービス層を報告する HTTP レスポンスヘッダーです。Google では `"x-gemini-service-tier"` を指定します。未指定時はレスポンス本文を読み取ります。',
  },
  "providers.<id>.models[].caps.tools": {
    default: documentedDefault("providers.<id>.models[].caps.tools"),
    en: '`"none"` for a model that cannot call tools.',
    zh: '模型不支持工具调用时设为 `"none"`。',
    ja: 'ツールを呼び出せないモデルには `"none"` を指定します。',
  },
  "providers.<id>.models[].caps.images": {
    default: documentedDefault("providers.<id>.models[].caps.images"),
    en: "The model accepts images.",
    zh: "模型接受图片输入。",
    ja: "モデルが画像入力を受け付けることを示します。",
  },
  "providers.<id>.models[].caps.thinking": {
    default: documentedDefault("providers.<id>.models[].caps.thinking"),
    en: "The model can reason; `anthropic-messages` asks for thinking only when this is set.",
    zh: "模型支持推理；`anthropic-messages` 只在设置了这一项时请求思考。",
    ja: "モデルが推論できることを示します。`anthropic-messages` は、この設定が有効な場合にのみ思考を要求します。",
  },
  "providers.<id>.models[].caps.promptCache": {
    default: documentedDefault("providers.<id>.models[].caps.promptCache"),
    en: "The endpoint supports prompt caching.",
    zh: "服务端支持提示缓存。",
    ja: "エンドポイントがプロンプトキャッシュに対応することを示します。",
  },
  "providers.<id>.models[].caps.parallelToolCalls": {
    default: documentedDefault("providers.<id>.models[].caps.parallelToolCalls"),
    en: "The model may call several tools in one reply.",
    zh: "模型可以在一次回复中调用多个工具。",
    ja: "モデルが 1 回の返信で複数のツールを呼び出せることを示します。",
  },
  "providers.<id>.models[].caps.webSearch": {
    default: { en: "from `compat.webSearch`", zh: "取 `compat.webSearch`", ja: "`compat.webSearch` の値" },
    en: "Offer the provider's hosted web search to this model.",
    zh: "为该模型启用 provider 托管的网页搜索。",
    ja: "このモデルにプロバイダーのホスト型 Web 検索を提供します。",
  },
  "providers.<id>.models[].thinking": {
    default: { en: "top-level `thinking`", zh: "顶层 `thinking`", ja: "トップレベルの `thinking`" },
    en: "Reasoning effort for this exact model id, unless overridden by `--thinking` or inherited from a parent agent.",
    zh: "仅针对该模型 ID 的推理强度，`--thinking` 或从父 agent 继承的档位优先。",
    ja: "このモデル ID に使う推論の強度です。ただし、`--thinking` による上書きや、親エージェントから引き継いだ強度が優先されます。",
  },
  "providers.<id>.models[].tools.edit": {
    default: {
      en: "the provider's `tools.edit`",
      zh: "沿用 provider 的 `tools.edit`",
      ja: "プロバイダーの `tools.edit`",
    },
    en: "Editing tools for this model only.",
    zh: "仅针对该模型的编辑工具设置。",
    ja: "このモデルだけに適用する編集ツールの設定です。",
  },
  "providers.<id>.defaultModel": {
    default: none,
    en: "Values for models neither `models` nor the catalog describes: the keys of `models[]` except `id`, `tools` and `thinking`.",
    zh: "既不在 `models` 中、模型目录也不认识的模型所用的值：键与 `models[]` 相同，但没有 `id`、`tools` 和 `thinking`。",
    ja: "`models` にもカタログにも記述されていないモデルに使う値です。`models[]` のキーのうち、`id`、`tools`、`thinking` を除くものを指定できます。",
  },
  "compact.threshold": {
    default: documentedDefault("compact.threshold"),
    en: "Share of the context window at which automatic compaction starts.",
    zh: "上下文占用达到上下文窗口的这个比例时，自动开始压缩。",
    ja: "自動圧縮を開始するコンテキストウィンドウの使用率です。",
  },
  "compact.model": {
    default: { en: "the session's model", zh: "会话当前的模型", ja: "セッションのモデル" },
    en: 'A `"provider/model"` that writes text summaries. Setting it always makes compaction a text summary, never server-side.',
    zh: '用来生成文字摘要的模型，格式为 `"provider/model"`。设置后压缩总是生成文字摘要，不再使用服务端压缩。',
    ja: 'テキスト要約を生成するモデルを `"provider/model"` 形式で指定します。設定すると圧縮は常にテキスト要約となり、サーバー側圧縮は使いません。',
  },
  "compact.layout": {
    default: documentedDefault("compact.layout"),
    en: 'Where a server-side checkpoint goes: `"tail"` keeps the last turns verbatim after it; `"recent-user"` compacts everything and puts the most recent user messages (up to about 64k tokens) before it, as Codex does. Text summaries always use `"tail"`.',
    zh: '服务端压缩检查点的位置：`"tail"` 在检查点之后原样保留最近几个轮次；`"recent-user"` 压缩全部历史，把最近的用户消息（约 64k token 以内）放在检查点之前，与 Codex 的做法相同。文字摘要始终使用 `"tail"`。',
    ja: 'サーバー側チェックポイントの配置です。`"tail"` は最近のターンをそのままチェックポイントの後に残します。`"recent-user"` はすべてを圧縮し、Codex と同様に、最近のユーザーメッセージ（最大約 64k トークン）をチェックポイントの前に配置します。テキスト要約は常に `"tail"` を使います。',
  },
  "fileRewind.enabled": {
    default: documentedDefault("fileRewind.enabled"),
    en: "Capture `write`, `edit` and `apply_patch` changes so rewind can restore them. Off: the rewind picker says files will not be restored.",
    zh: "记录 `write`、`edit` 和 `apply_patch` 的改动，供回退时恢复。关闭后回退选择器会提示不会恢复文件。",
    ja: "巻き戻しで復元できるよう、`write`、`edit`、`apply_patch` の変更を記録します。無効の場合、巻き戻しの選択画面にはファイルを復元しないことが表示されます。",
  },
  "fileRewind.maxFileBytes": {
    default: documentedDefault("fileRewind.maxFileBytes"),
    en: "Largest file, before or after a change, that can be captured; a larger write is refused while capture is on.",
    zh: "可记录的最大文件（改动前或改动后）；启用记录时，超过它的写入会被拒绝。",
    ja: "変更前または変更後に記録できるファイルの最大サイズです。記録が有効な間は、これを超える書き込みを拒否します。",
  },
  "fileRewind.quotaBytes": {
    default: documentedDefault("fileRewind.quotaBytes"),
    en: "Most bytes of unique file images one session keeps; past it, writes are refused until `/rewind-prune`.",
    zh: "每个会话最多保存的去重文件镜像字节数；超出后写入会被拒绝，直到执行 `/rewind-prune`。",
    ja: "1 セッションで保持する、重複を除いたファイルイメージの最大バイト数です。超えると、`/rewind-prune` を実行するまで書き込みを拒否します。",
  },
  "context.outputs.saveAbove": {
    default: documentedDefault("context.outputs.saveAbove"),
    en: "Tool output longer than this many characters (a Chinese, Japanese or Korean character counts as four) is saved whole as an artifact, and the model gets a preview; at least 4000.",
    zh: "超过这个字符数的工具输出（中文、日文、韩文字符每个按四个计）会作为 artifact 完整保存，模型收到的是预览；最少 4000。",
    ja: "この文字数を超えるツール出力はアーティファクトとして全体を保存し、モデルにはプレビューを渡します。中国語、日本語、韓国語の 1 文字は 4 文字として数えます。最小値は 4000 です。",
  },
  "context.outputs.previewChars": {
    default: documentedDefault("context.outputs.previewChars"),
    en: "Characters of the preview the model gets instead; at least 500, and never more than `saveAbove`.",
    zh: "模型收到的预览的字符数；最少 500，且不超过 `saveAbove`。",
    ja: "代わりにモデルに渡すプレビューの文字数です。最小値は 500 で、`saveAbove` を超えることはできません。",
  },
  "context.outputs.quotaMB": {
    default: documentedDefault("context.outputs.quotaMB"),
    en: "Most megabytes of artifacts one session keeps; past it, outputs are only previewed. `/prune` frees space.",
    zh: "每个会话最多保存的 artifact 大小（MB）；超出后输出只保留预览。`/prune` 可以释放空间。",
    ja: "1 セッションで保持するアーティファクトの最大サイズ（MB）です。超えると出力はプレビューのみになります。`/prune` で空き容量を確保できます。",
  },
  "context.dedupeReads": {
    default: documentedDefault("context.dedupeReads"),
    en: "A `read` that returns exactly what the latest read of the same range, still in the context, returned is sent as a short note pointing to it.",
    zh: "一次 `read` 返回的内容与上下文中仍保留的同一范围的最近一次读取完全相同时，改为发送一条指向它的简短说明。",
    ja: "`read` の結果が、コンテキストに残っている同じ範囲の最新の読み取り結果と完全に一致する場合、その結果を参照する短い説明だけを送ります。",
  },
  "context.aging.enabled": {
    default: documentedDefault("context.aging.enabled"),
    en: "Replace old tool results with short stubs when the context gets full, before compacting. Only where the provider allows rewriting history (no signed reasoning after the result).",
    zh: "上下文快满时，在压缩之前把较早的工具结果替换为简短的占位文本。只在 provider 允许改写历史时进行（结果之后没有签名的推理内容）。",
    ja: "コンテキストがいっぱいになると、圧縮の前に古いツール結果を短いプレースホルダーに置き換えます。プロバイダーが履歴の書き換えを許可する場合（結果の後に署名付き推論がない場合）に限ります。",
  },
  "context.aging.start": {
    default: documentedDefault("context.aging.start"),
    en: "Share of the context window the next request is expected to pass that starts an aging round.",
    zh: "预计下一次请求超过上下文窗口的这个比例时，开始一轮清理。",
    ja: "次のリクエストがコンテキストウィンドウのこの割合を超えると予測されたとき、古い結果の整理を開始します。",
  },
  "context.aging.target": {
    default: documentedDefault("context.aging.target"),
    en: "Share of the context window a round frees down to.",
    zh: "一轮清理把上下文降到窗口的这个比例。",
    ja: "1 回の整理でコンテキストの使用量をこの割合まで減らします。",
  },
  "context.aging.minSavedTokens": {
    default: documentedDefault("context.aging.minSavedTokens"),
    en: "A round that would free fewer tokens is skipped, so the prompt cache prefix stays (in a small window, at most the space between `start` and `target`).",
    zh: "一轮清理释放的 token 少于这个数时跳过，以保留提示缓存前缀（窗口较小时，最多取 `start` 与 `target` 之间的空间）。",
    ja: "解放できるトークン数がこの値より少ない整理はスキップし、プロンプトキャッシュのプレフィックスを保ちます。小さいウィンドウでは、最大でも `start` と `target` の間の容量になります。",
  },
  "context.aging.keepTurns": {
    default: documentedDefault("context.aging.keepTurns"),
    en: "Most recent user turns whose results are never cleared.",
    zh: "结果永不清理的最近用户回合数。",
    ja: "結果を整理の対象から除外する、直近のユーザーターン数です。",
  },
  "context.aging.keepSteps": {
    default: documentedDefault("context.aging.keepSteps"),
    en: "In a long current turn, its most recent model steps whose results are never cleared.",
    zh: "在很长的当前回合中，结果永不清理的最近模型步骤数。",
    ja: "現在のターンが長い場合に、結果を整理の対象から除外する直近のモデルステップ数です。",
  },
  "context.aging.afterTurns": {
    default: documentedDefault("context.aging.afterTurns"),
    en: "Experimental: also clear results older than this many user turns, whatever the pressure. `0` is off.",
    zh: "实验性：不管上下文压力，也清理早于这么多个用户回合的结果。`0` 表示关闭。",
    ja: "実験的な設定です。コンテキストの使用量に関係なく、このユーザーターン数より古い結果も整理します。`0` で無効になります。",
  },
  "retry.attempts": {
    default: documentedDefault("retry.attempts"),
    en: "Retries of a failed model request after the first try; `0` turns retrying off. A request is sent again only while nothing has streamed, so this covers provider errors and the first-content timeout.",
    zh: "模型请求失败后，在首次尝试之外的重试次数；`0` 表示不重试。只有尚未收到流式内容时才会重发，因此适用于 provider 错误和首个内容超时。",
    ja: "モデルリクエストが失敗したとき、初回の試行後に再試行する回数です。`0` で再試行を無効にします。ストリームの内容をまだ受け取っていない場合にのみ再送するため、プロバイダーのエラーと最初のコンテンツのタイムアウトが対象です。",
  },
  "retry.baseDelayMs": {
    default: documentedDefault("retry.baseDelayMs"),
    en: "Wait before the first retry, doubling each time; a server's `Retry-After` replaces it.",
    zh: "第一次重试前的等待时间（毫秒），之后每次翻倍；服务端给出 `Retry-After` 时以它为准。",
    ja: "最初の再試行までの待機時間です。以後は毎回 2 倍になります。サーバーの `Retry-After` がある場合はそちらを使います。",
  },
  "retry.maxDelayMs": {
    default: documentedDefault("retry.maxDelayMs"),
    en: "A wait longer than this is not waited out: the error is reported instead.",
    zh: "需要等待的时间超过这个值时不再等待，直接报告错误。",
    ja: "必要な待機時間がこの値を超える場合、待機せずにエラーを報告します。",
  },
  "retry.firstContentTimeoutMs": {
    default: documentedDefault("retry.firstContentTimeoutMs"),
    en: "Maximum time in milliseconds to wait for the first streamed content event (text, a reasoning-block start or delta, a tool call or a hosted search); the attempt is then retried. `0` disables this timeout; keep-alive comments do not count as content.",
    zh: "等待首个流式内容事件（文字、思考块开始或思考增量、工具调用或托管搜索）的最长时间（毫秒），超时后会重试这次请求。`0` 表示关闭；SSE 保活注释不算内容。",
    ja: "最初のストリームのコンテンツイベント（テキスト、推論ブロックの開始や差分、ツール呼び出し、ホスト型検索）を待つ最大時間（ミリ秒）です。超過すると再試行します。`0` でこのタイムアウトを無効にします。接続維持用のコメントはコンテンツに数えません。",
  },
  "retry.idleTimeoutMs": {
    default: documentedDefault("retry.idleTimeoutMs"),
    en: "Maximum silence in milliseconds between streamed content events after the first one. The reply then ends with a timeout error that keeps its partial text; it is not sent again, since that would repeat what was already shown (a reply that has only begun reasoning, with nothing shown yet, is retried). Type a message to continue, or press ↑ to resend. Plain print mode reports the error on stderr and exits non-zero. While a hosted web search runs, the limit is at least 10 minutes. `0` disables this timeout; keep-alive comments do not reset it.",
    zh: "首个内容事件之后，流式内容事件之间允许的最长静默时间（毫秒）。超时后回复以超时错误结束并保留已收到的文字；不会重发，因为那样会重复已经显示的内容（只开始了思考、尚未显示任何内容的回复会重试）。输入消息可继续，或按 ↑ 重发。普通打印模式在 stderr 上报告错误，并以非零退出码结束。托管网页搜索进行期间，这个上限至少为 10 分钟。`0` 表示关闭；SSE 保活注释不会重置计时。",
    ja: "最初のイベント以降、ストリームのコンテンツイベント間で許容する最大の無応答時間（ミリ秒）です。超過すると、受信済みのテキストを保持してタイムアウトエラーで返信を終了します。表示済みの内容を繰り返さないよう再送しません（推論が始まっただけで、まだ何も表示していない返信は再試行します）。続けるにはメッセージを入力するか、↑ を押して再送してください。通常の print モードでは stderr にエラーを報告し、非ゼロの終了コードで終了します。ホスト型 Web 検索の実行中は、上限は少なくとも 10 分になります。`0` でこのタイムアウトを無効にします。接続維持用のコメントではタイマーをリセットしません。",
  },
  "retry.nativeCompactionTimeoutMs": {
    default: documentedDefault("retry.nativeCompactionTimeoutMs"),
    en: "Deadline in milliseconds for server-side compaction, including all attempts and retry waits. On timeout, the native request is aborted and a text summary is written instead, with a notice. `0` disables this timeout; Esc still cancels compaction without writing a summary.",
    zh: "服务端压缩的总时限（毫秒），包括所有尝试及重试等待。超时后会中止服务端请求，改为生成文字摘要，并显示提示。`0` 表示关闭此超时；Esc 仍会取消压缩，不生成摘要。",
    ja: "サーバー側圧縮の全体の制限時間（ミリ秒）です。すべての試行と再試行の待機時間を含みます。タイムアウトするとネイティブリクエストを中止し、代わりにテキスト要約を生成して通知します。`0` でこのタイムアウトを無効にします。Esc では引き続き、要約を生成せずに圧縮をキャンセルできます。",
  },
  "web.nativeSearch": {
    default: documentedDefault("web.nativeSearch"),
    en: "`false`: never use a provider's hosted web search (`compat.webSearch`), so every model gets the `web_search` tool.",
    zh: "设为 `false` 时从不使用 provider 托管的网页搜索（`compat.webSearch`），所有模型都使用 `web_search` 工具。",
    ja: "`false` の場合、プロバイダーのホスト型 Web 検索（`compat.webSearch`）を使わず、すべてのモデルに `web_search` ツールを提供します。",
  },
  "web.search.backend": {
    default: documentedDefault("web.search.backend"),
    en: "Search backend. Exa's hosted MCP server needs no key.",
    zh: "搜索后端。Exa 托管的 MCP 服务无需密钥。",
    ja: "検索バックエンドです。Exa のホスト型 MCP サーバーにはキーが不要です。",
  },
  "web.search.fallback": {
    default: none,
    en: "Backends tried in order when the one before fails.",
    zh: "前一个后端失败时依次尝试的后端。",
    ja: "前のバックエンドが失敗した場合に、順番に試すバックエンドです。",
  },
  "web.search.maxResults": {
    default: documentedDefault("web.search.maxResults"),
    en: "Results returned when the call does not say; a call gets at most 20.",
    zh: "调用未指定数量时返回的结果数；单次调用最多 20 条。",
    ja: "呼び出しで件数を指定しない場合に返す結果数です。1 回の呼び出しで最大 20 件を返します。",
  },
  "web.search.timeoutMs": {
    default: documentedDefault("web.search.timeoutMs"),
    en: "Request timeout per backend, in milliseconds.",
    zh: "每个后端的请求超时（毫秒）。",
    ja: "バックエンドごとのリクエストのタイムアウト（ミリ秒）です。",
  },
  "web.search.exa.url": {
    default: documentedDefault("web.search.exa.url"),
    en: "Exa MCP endpoint.",
    zh: "Exa MCP 服务地址。",
    ja: "Exa MCP のエンドポイントです。",
    userOnly: true,
  },
  "web.search.exa.apiKeyEnv": {
    default: none,
    en: "Variable holding an Exa key, which raises the free rate limit.",
    zh: "存放 Exa 密钥的环境变量名；有密钥可提高免费额度的速率限制。",
    ja: "Exa のキーを格納する環境変数です。キーがあると無料枠のレート制限を引き上げられます。",
    userOnly: true,
  },
  "web.search.brave.apiKeyEnv": {
    default: documentedDefault("web.search.brave.apiKeyEnv"),
    en: "Variable holding the Brave Search key.",
    zh: "存放 Brave Search 密钥的环境变量名。",
    ja: "Brave Search のキーを格納する環境変数です。",
    userOnly: true,
  },
  "web.search.tavily.apiKeyEnv": {
    default: documentedDefault("web.search.tavily.apiKeyEnv"),
    en: "Variable holding the Tavily key.",
    zh: "存放 Tavily 密钥的环境变量名。",
    ja: "Tavily のキーを格納する環境変数です。",
    userOnly: true,
  },
  "web.search.tavily.searchDepth": {
    default: documentedDefault("web.search.tavily.searchDepth"),
    en: 'Tavily search depth: `"basic"` or `"advanced"`.',
    zh: 'Tavily 搜索深度：`"basic"` 或 `"advanced"`。',
    ja: 'Tavily の検索の深さです。`"basic"` または `"advanced"` を指定します。',
  },
  "web.search.searxng.url": {
    default: { en: "required for this backend", zh: "使用该后端时必填", ja: "このバックエンドでは必須" },
    en: "A SearXNG instance with the JSON format enabled.",
    zh: "已启用 JSON 格式的 SearXNG 实例地址。",
    ja: "JSON 形式が有効な SearXNG インスタンスです。",
    userOnly: true,
  },
  "web.fetch.maxChars": {
    default: documentedDefault("web.fetch.maxChars"),
    en: "Characters of converted text returned per call, when the call does not say.",
    zh: "调用未指定时，每次返回的转换后文本字符数。",
    ja: "呼び出しで指定しない場合に、1 回で返す変換後テキストの文字数です。",
  },
  "web.fetch.maxBytes": {
    default: documentedDefault("web.fetch.maxBytes"),
    en: "Largest text response body read, in bytes; longer bodies are cut.",
    zh: "读取的文本响应体上限（字节），超出部分被截断。",
    ja: "読み取るテキストレスポンス本文の最大バイト数です。超過した部分は切り捨てます。",
  },
  "web.fetch.maxBinaryBytes": {
    default: documentedDefault("web.fetch.maxBinaryBytes"),
    en: "Largest PDF or binary download saved in the session's outputs directory. Larger downloads fail and partial files are deleted. No-session hosts cannot save binaries. These files are not text artifacts: use other tools to read them; artifact quota and `/prune` do not manage them.",
    zh: "保存到会话输出目录的 PDF 或二进制下载上限。超限时下载失败并删除未完成的文件。没有会话目录的宿主无法保存二进制文件。这些文件不是文本工件：请用其他工具读取；工件配额和 `/prune` 不管理这些文件。",
    ja: "セッションの出力ディレクトリに保存する PDF またはバイナリの最大サイズです。超過した場合は失敗し、未完成のファイルを削除します。セッションディレクトリのないホストでは保存できません。テキストのアーティファクトではないため、他のツールで読み取ってください。アーティファクトの容量制限と `/prune` の対象外です。",
  },
  "web.fetch.timeoutMs": {
    default: documentedDefault("web.fetch.timeoutMs"),
    en: "Request timeout in milliseconds.",
    zh: "请求超时（毫秒）。",
    ja: "リクエストのタイムアウト（ミリ秒）です。",
  },
  "web.fetch.allowPrivateNetwork": {
    default: documentedDefault("web.fetch.allowPrivateNetwork"),
    en: "Allow localhost and private-network addresses.",
    zh: "允许访问 localhost 和私有网络地址。",
    ja: "localhost とプライベートネットワークのアドレスへのアクセスを許可します。",
    userOnly: true,
  },
  agents: {
    default: none,
    en: "Settings per sub-agent role, by role name.",
    zh: "按角色名配置的子 agent 设置。",
    ja: "役割名をキーとする、サブエージェントの役割ごとの設定です。",
  },
  "agents.<role>.model": {
    default: {
      en: "the role file's, else the parent's",
      zh: "取角色文件中的设置，否则沿用父 agent 的模型",
      ja: "役割ファイルの設定、なければ親のモデル",
    },
    en: 'The `"provider/model"` the role runs on. A model named in the task wins.',
    zh: '该角色使用的模型，格式为 `"provider/model"`。任务中指定的模型优先。',
    ja: '役割が使用するモデルを `"provider/model"` 形式で指定します。タスクで指定したモデルが優先されます。',
  },
  "subagents.maxDepth": {
    default: documentedDefault("subagents.maxDepth"),
    en: "How deep sub-agents may nest.",
    zh: "子 agent 的最大嵌套深度。",
    ja: "サブエージェントの最大のネスト深度です。",
  },
  "subagents.maxConcurrent": {
    default: documentedDefault("subagents.maxConcurrent"),
    en: "Sub-agents running at once in the whole agent tree; the rest wait their turn. Use a whole number of at least 1; invalid values warn and use the default, even over a valid value in a lower-precedence file.",
    zh: "整个 agent 树中同时运行的子 agent 数上限，其余的排队等待。必须是至少为 1 的整数；无效值会发出警告并使用默认值，即使优先级较低的文件中已有有效值。",
    ja: "エージェントツリー全体で同時に実行できるサブエージェントの数です。残りは順番を待ちます。1 以上の整数を指定してください。無効な値には警告を表示し、優先順位の低いファイルに有効な値があってもデフォルトを使用します。",
  },
  "subagents.background": {
    default: documentedDefault("subagents.background"),
    en: "The main session's `agent` tool runs sub-agents in the background unless the call says otherwise; their results come back as a message.",
    zh: "除非调用另有说明，主会话的 `agent` 工具在后台运行子 agent，结果以消息形式返回。",
    ja: "呼び出しで指定しない限り、メインセッションの `agent` ツールはサブエージェントをバックグラウンドで実行します。結果はメッセージとして返ります。",
  },
  "budget.tokens": {
    default: unlimited,
    en: "Tokens the whole agent tree may use: input, output, and cache reads and writes.",
    zh: "整个 agent 树可用的 token 总数，包括输入、输出以及缓存读写。",
    ja: "エージェントツリー全体で使えるトークン数です。入力、出力、キャッシュの読み取りと書き込みを含みます。",
  },
  "budget.costUsd": {
    default: unlimited,
    en: "Cost in USD the whole agent tree may spend, where prices are known.",
    zh: "整个 agent 树可花费的金额（美元），按已知价格计算。",
    ja: "料金がわかるものについて、エージェントツリー全体で使える金額（USD）です。",
  },
  "merge.reviewThreshold.lines": {
    default: none,
    en: "A clean worktree merge that changes more lines than this is reviewed too. Without a threshold only conflicts are.",
    zh: "worktree 合并即使没有冲突，改动行数超过这个值时也要审阅。未设置时只审阅有冲突的合并。",
    ja: "競合のない worktree のマージでも、変更行数がこの値を超える場合はレビューします。しきい値がなければ、競合のあるマージのみをレビューします。",
  },
  "merge.reviewThreshold.files": {
    default: none,
    en: "Likewise for the number of changed files.",
    zh: "同上，按改动的文件数计算。",
    ja: "同様のしきい値を、変更したファイル数で指定します。",
  },
  "tui.mode": {
    default: documentedDefault("tui.mode"),
    en: 'Deprecated and ignored: the interactive TUI always runs fullscreen and prints the conversation to the normal screen on exit. For one release, `"inline"` and `--inline` are accepted with the notice: "inline mode was removed; running fullscreen. Use -p for plain output." `--fullscreen` is accepted as a no-op.',
    zh: '已弃用并忽略：交互式 TUI 始终使用全屏模式，退出时将对话打印到普通屏幕。在一个过渡版本内，仍接受 `"inline"` 和 `--inline`，并提示："inline mode was removed; running fullscreen. Use -p for plain output." `--fullscreen` 仍被接受，但不执行任何操作。',
    ja: '非推奨で無視されます。対話型 TUI は常に全画面で動作し、終了時に会話を通常画面へ出力します。移行期間の 1 リリースでは `"inline"` と `--inline` を受け付け、"inline mode was removed; running fullscreen. Use -p for plain output." と通知します。`--fullscreen` は受け付けますが、何も変更しません。',
  },
  "tui.margin": {
    default: documentedDefault("tui.margin"),
    en: "Side margin in cells (integer 0–12). Narrow terminals shrink it to keep at least 60 content columns when possible. Set this and `tui.marginRows` to `0` for the edge-to-edge layout.",
    zh: "左右留白宽度，单位为字符格（整数 0–12）。窄终端会自动缩小留白，尽可能保留至少 60 列内容。与 `tui.marginRows` 一起设为 `0` 可恢复贴边布局。",
    ja: "左右の余白幅をセル数（整数 0–12）で指定します。狭い端末では、可能な限りコンテンツの幅を 60 列以上確保するために余白を縮めます。この値と `tui.marginRows` を `0` にすると、端まで使うレイアウトになります。",
  },
  "tui.marginRows": {
    default: documentedDefault("tui.marginRows"),
    en: "Empty rows above the header and below the key-hint line (integer 0–2). Terminals shorter than 24 rows omit them.",
    zh: "标题栏上方和按键提示行下方的空行数（整数 0–2）。终端不足 24 行时自动取消。",
    ja: "ヘッダーの上とキー操作のヒント行の下に設ける空行数（整数 0–2）です。24 行未満の端末では空行を省きます。",
  },
  "tui.theme": {
    default: documentedDefault("tui.theme"),
    en: 'A theme name, or `"auto"` for Amira following the terminal background (dark if unknown). `"dark"` and `"light"` select Amira explicitly; `"terminal"` uses the terminal\'s own ANSI colors. `/theme` previews and saves a named theme.',
    zh: '主题名称，或 `"auto"`：Amira 根据终端背景选择配色（无法判断时使用深色）。`"dark"` 和 `"light"` 指定 Amira 配色；`"terminal"` 使用终端自身的 ANSI 颜色。`/theme` 可预览并保存主题。',
    ja: 'テーマ名、または端末の背景に合わせる `"auto"` を指定します（判別できない場合はダーク）。`"dark"` と `"light"` は Amira の配色を明示的に選び、`"terminal"` は端末自身の ANSI カラーを使います。`/theme` で名前付きテーマをプレビューし、保存できます。',
  },
  "tui.themeVariant": {
    default: documentedDefault("tui.themeVariant"),
    en: 'For named themes, `"auto"` follows the terminal background; `"dark"` or `"light"` forces that variant. A missing variant uses the default Amira palette.',
    zh: '命名主题的配色版本：`"auto"` 根据终端背景选择；`"dark"` 或 `"light"` 强制指定版本。缺少的版本使用默认 Amira 配色。',
    ja: '名前付きテーマでは、`"auto"` は端末の背景に合わせます。`"dark"` または `"light"` は指定したバリアントを強制します。そのバリアントがなければ、Amira のデフォルトパレットを使います。',
  },
  "tui.shimmer": {
    default: {
      en: 'theme’s effect, else `"soft"`',
      zh: '主题的动画，否则为 `"soft"`',
      ja: 'テーマのエフェクト、なければ `"soft"`',
    },
    en: "Activity-label animation: `off`, `soft`, `sharp`, `wide`, `bounce`, `pulse`, `wave` or `reveal`. An object overrides only its supplied knobs; see [Shimmer animation](themes.md#shimmer-animation) for ranges and colors.",
    zh: "活动标签动画：`off`、`soft`、`sharp`、`wide`、`bounce`、`pulse`、`wave` 或 `reveal`。对象只覆盖明确指定的参数；范围与颜色见[微光动画](themes.md#微光动画)。",
    ja: "アクティビティラベルのアニメーションです。`off`、`soft`、`sharp`、`wide`、`bounce`、`pulse`、`wave`、`reveal` を指定できます。オブジェクトでは指定したパラメーターだけを上書きします。範囲や色については[シマーアニメーション](themes.md#シマーアニメーション)を参照してください。",
  },
  "tui.colorDepth": {
    default: documentedDefault("tui.colorDepth"),
    en: 'Color depth: `"auto"` detects terminal support; `"truecolor"`, `"256"` and `"16"` override it. Values are strings, including `"256"` and `"16"`.',
    zh: '颜色深度：`"auto"` 检测终端支持情况；`"truecolor"`、`"256"` 和 `"16"` 手动指定。所有值均为字符串，包括 `"256"` 和 `"16"`。',
    ja: '色深度です。`"auto"` は端末の対応状況を検出し、`"truecolor"`、`"256"`、`"16"` はそれを上書きします。`"256"` と `"16"` を含め、値はすべて文字列です。',
  },
  "tui.bell": {
    default: documentedDefault("tui.bell"),
    en: "Ring once per wait when the terminal is unfocused and a turn ends or a dialog needs input. With unknown focus, completed turns never ring; only permission/question dialogs alert. Set to `false` to disable BEL; desktop alerts are controlled separately by `tui.notify`.",
    zh: "终端失去焦点时，轮次结束或对话框需要输入，每次等待只响铃一次。焦点未知时，轮次结束从不响铃，仅权限或提问对话框提醒。设为 `false` 可关闭 BEL 响铃；桌面通知由 `tui.notify` 单独控制。",
    ja: "端末にフォーカスがないとき、ターンの終了時やダイアログが入力を必要とするときに、待機 1 回につき 1 度だけベルを鳴らします。フォーカスが不明な場合、ターン終了では鳴らさず、権限や質問のダイアログだけで通知します。`false` で BEL を無効にします。デスクトップ通知は `tui.notify` で別に設定します。",
  },
  "tui.notify": {
    default: documentedDefault("tui.notify"),
    en: '`"auto"` sends desktop alerts once per wait under the same focus rules as `tui.bell`: OSC 9 for iTerm2/Ghostty, OSC 777 for WezTerm, OSC 99 for kitty. Windows Terminal uses BEL/taskbar alerts only, not a desktop-notification OSC. Unknown terminals, dumb terminals and tmux/screen get no notification OSC. Terminal/OS notification settings still apply. `"off"` disables desktop alerts without changing the bell.',
    zh: '`"auto"` 按 `tui.bell` 相同的焦点规则，每次等待发送一次桌面通知：iTerm2/Ghostty 使用 OSC 9，WezTerm 使用 OSC 777，kitty 使用 OSC 99。Windows Terminal 仅使用 BEL/任务栏提醒，不发送桌面通知 OSC。未知终端、dumb 终端及 tmux/screen 不发送通知 OSC。通知仍受终端和操作系统设置限制。`"off"` 关闭桌面通知，不影响响铃。',
    ja: '`"auto"` は `tui.bell` と同じフォーカスのルールで、待機 1 回につき 1 度デスクトップ通知を送ります。iTerm2/Ghostty では OSC 9、WezTerm では OSC 777、kitty では OSC 99 を使います。Windows Terminal では BEL/タスクバー通知のみを使い、デスクトップ通知の OSC は送りません。不明な端末、dumb 端末、tmux/screen には通知の OSC を送りません。端末や OS の通知設定も引き続き適用されます。`"off"` はベルを変更せずにデスクトップ通知を無効にします。',
  },
  "tui.title": {
    default: documentedDefault("tui.title"),
    en: "Set the title to `Amira · session title`, falling back to the cwd name when untitled. Markdown markers are stripped. `●` marks running work; `✓` marks a turn finished while you were away and clears when the terminal regains focus; `◆` marks a dialog waiting for your answer or confirmation, remains even when focused, and takes priority over `✓`. No marker means idle/seen. Waiting-state transitions and final status update immediately; other running-title updates occur at most once per second.",
    zh: "标题设为 `Amira · 会话标题`，无标题时使用当前目录名，并去除 Markdown 标记。`●` 表示运行中；`✓` 表示终端失去焦点期间轮次已结束，终端重新获得焦点后清除；`◆` 表示对话框等待回答或确认，即使终端有焦点也保留，且优先于 `✓`。无标记表示空闲或已查看。等待状态切换和最终状态立即更新，其他运行中的标题每秒最多更新一次。",
    ja: "タイトルを `Amira · session title` に設定し、タイトルがなければ cwd の名前を使います。Markdown の記号は除去します。`●` は実行中を示します。`✓` は端末から離れている間にターンが完了したことを示し、端末にフォーカスが戻ると消えます。`◆` はダイアログが回答や確認を待っていることを示し、フォーカスがあっても残り、`✓` より優先されます。記号がなければアイドルまたは確認済みです。待機状態の切り替えと最終状態は即座に更新し、それ以外の実行中タイトルの更新は最大で 1 秒に 1 回です。",
  },
  "tui.progress": {
    default: documentedDefault("tui.progress"),
    en: "Show work on the tab and taskbar progress indicator (OSC 9;4).",
    zh: "在标签页和任务栏进度指示器上显示工作状态（OSC 9;4）。",
    ja: "タブとタスクバーの進捗インジケーター（OSC 9;4）に作業状況を表示します。",
  },
  "tui.tokenSpeed": {
    default: documentedDefault("tui.tokenSpeed"),
    en: "Show live token speed on the right of the status bar: `~N tok/s` estimates visible reply text and tool arguments, `thinking Ns` shows thinking time, and reported usage replaces the estimate with the exact output speed after the request. The last speed stays while idle; this item hides first when space is tight. Set to `false` to hide it.",
    zh: "在状态栏右侧显示实时 token 速度：`~N tok/s` 根据可见回复文字和工具参数估算，`thinking Ns` 显示思考时长；请求结束后，若有用量报告则改为精确的输出速度。空闲时保留上次速度，空间不足时优先隐藏此项。设为 `false` 可关闭。",
    ja: "ステータスバーの右側にリアルタイムのトークン速度を表示します。`~N tok/s` は表示される返信テキストとツール引数から推定し、`thinking Ns` は思考時間を示します。リクエスト後に使用量が報告されると、推定値を正確な出力速度に置き換えます。待機中は直前の速度を保持し、表示幅が足りないときは最初にこの項目を非表示にします。`false` で非表示にできます。",
  },
  "tui.clock": {
    default: documentedDefault("tui.clock"),
    en: 'Timestamp hour cycle: `"auto"` follows the system locale, `"12h"` forces 12-hour time (`8:19 PM`) and `"24h"` forces 24-hour time (`20:19`). `"12h"` always uses English wording, whatever the locale.',
    zh: '时间戳的小时制：`"auto"` 跟随系统区域设置，`"12h"` 强制 12 小时制（`8:19 PM`），`"24h"` 强制 24 小时制（`20:19`）。`"12h"` 始终使用与英文界面一致的写法，不随区域设置变化。',
    ja: 'タイムスタンプの時間表記です。`"auto"` はシステムのロケールに従い、`"12h"` は 12 時間表記（`8:19 PM`）、`"24h"` は 24 時間表記（`20:19`）に固定します。`"12h"` はロケールにかかわらず、常に英語の UI と同じ表記になります。',
  },
  "tui.reflow": {
    default: documentedDefault("tui.reflow"),
    en: "Deprecated and ignored: fullscreen redraws the conversation at the current terminal width.",
    zh: "已弃用并忽略：全屏模式会按当前终端宽度重新绘制对话。",
    ja: "非推奨で無視されます。全画面モードは現在の端末の幅で会話を描画し直します。",
  },
  "tui.submitWhileWorking": {
    default: documentedDefault("tui.submitWhileWorking"),
    en: 'What Enter does while a turn runs: `"steer"` sends the message into the running turn, `"queue"` sends it after the turn. The queue key does the other.',
    zh: '轮次进行中按 Enter 的行为：`"steer"` 把消息发进正在进行的轮次（引导），`"queue"` 让消息排队到轮次结束后发送。排队键执行另一种行为。',
    ja: 'ターンの実行中に Enter を押したときの動作です。`"steer"` は実行中のターンにメッセージを送り、`"queue"` はターンの終了後に送ります。キュー用のキーはもう一方の動作を行います。',
  },
  "tui.images": {
    default: documentedDefault("tui.images"),
    en: 'Draw images in replies (with the `images` extension): `"auto"` where the terminal supports it, `"on"` everywhere, `"off"` never.',
    zh: '在回复中显示图片（需安装 `images` 扩展）：`"auto"` 在终端支持时显示，`"on"` 总是显示，`"off"` 从不显示。',
    ja: '`images` 拡張機能で返信内の画像を表示します。`"auto"` は端末が対応する場合、`"on"` は常に表示し、`"off"` は表示しません。',
  },
  "tui.shellOutputLines": {
    default: documentedDefault("tui.shellOutputLines"),
    en: "Last output lines shown under a shell command that succeeded; `0` shows none.",
    zh: "成功的 shell 命令在结果下方显示的最后几行输出；`0` 表示不显示。",
    ja: "成功したシェルコマンドの下に表示する、出力の末尾の行数です。`0` では表示しません。",
  },
  mcpServers: {
    default: none,
    en: "MCP servers by name.",
    zh: "以名称为键的 MCP 服务器。",
    ja: "名前をキーとする MCP サーバーです。",
  },
  "mcpServers.<name>.type": {
    default: {
      en: '`"http"` if `url` is set, else `"stdio"`',
      zh: '设置了 `url` 时为 `"http"`，否则为 `"stdio"`',
      ja: '`url` があれば `"http"`、なければ `"stdio"`',
    },
    en: 'Transport. `"streamable-http"` and `"streamableHttp"` mean `"http"`; the legacy `"sse"` is not supported.',
    zh: '传输方式。`"streamable-http"` 和 `"streamableHttp"` 等同于 `"http"`；不支持旧的 `"sse"`。',
    ja: '通信方式です。`"streamable-http"` と `"streamableHttp"` は `"http"` を意味します。従来の `"sse"` は非対応です。',
  },
  "mcpServers.<name>.command": {
    default: { en: "required for stdio", zh: "stdio 必填", ja: "stdio では必須" },
    en: "The program to start.",
    zh: "要启动的程序。",
    ja: "起動するプログラムです。",
  },
  "mcpServers.<name>.args": {
    default: documentedDefault("mcpServers.<name>.args"),
    en: "Its arguments.",
    zh: "程序参数。",
    ja: "プログラムに渡す引数です。",
  },
  "mcpServers.<name>.env": {
    default: none,
    en: "Environment variables for the program.",
    zh: "传给程序的环境变量。",
    ja: "プログラムに渡す環境変数です。",
  },
  "mcpServers.<name>.cwd": {
    default: none,
    en: "Working directory for the program.",
    zh: "程序的工作目录。",
    ja: "プログラムの作業ディレクトリです。",
  },
  "mcpServers.<name>.url": {
    default: { en: "required for http", zh: "http 必填", ja: "http では必須" },
    en: "The server's streamable HTTP endpoint.",
    zh: "服务器的 streamable HTTP 地址。",
    ja: "サーバーの streamable HTTP エンドポイントです。",
  },
  "mcpServers.<name>.headers": {
    default: none,
    en: "HTTP headers sent to the server.",
    zh: "发给服务器的 HTTP 请求头。",
    ja: "サーバーに送る HTTP ヘッダーです。",
  },
  "mcpServers.<name>.timeout": {
    default: none,
    en: "Milliseconds a tool call may take.",
    zh: "单次工具调用的超时（毫秒）。",
    ja: "ツール呼び出しに許容する時間（ミリ秒）です。",
  },
  "mcpServers.<name>.disabled": {
    default: documentedDefault("mcpServers.<name>.disabled"),
    en: "`true` switches the server off, including an entry of the same name from an earlier file.",
    zh: "设为 `true` 时停用该服务器，也会停用之前文件中的同名条目。",
    ja: "`true` はサーバーを無効にします。前のファイルにある同名のエントリーも無効になります。",
  },
  mcpTrustedProjects: {
    default: documentedDefault("mcpTrustedProjects"),
    en: "Project directories (and their subdirectories) whose own MCP servers may run.",
    zh: "允许运行自带 MCP 服务器的项目目录（包括其子目录）。",
    ja: "そのプロジェクトの MCP サーバーの実行を許可するプロジェクトディレクトリです。サブディレクトリも含みます。",
    userOnly: true,
  },
  extensions: {
    default: none,
    en: 'Settings of installed extensions, by extension name, e.g. `{"workflow": {"enabled": "always"}}`. Each extension documents and checks its own section.',
    zh: '已安装扩展的设置，以扩展名为键，例如 `{"workflow": {"enabled": "always"}}`。各扩展自行说明并校验自己的部分。',
    ja: '拡張機能名をキーとする、インストール済み拡張機能の設定です。例：`{"workflow": {"enabled": "always"}}`。各拡張機能が自身のセクションを説明し、検証します。',
  },
  "packages.disabled": {
    default: documentedDefault("packages.disabled"),
    en: "Packages not to load, of either scope; the lock files keep them. Set by `amira ext disable` and `enable`.",
    zh: "不加载的包（用户和项目范围均适用），锁文件中仍保留它们。由 `amira ext disable` 和 `enable` 设置。",
    ja: "ユーザーとプロジェクトのどちらのスコープでも読み込まないパッケージです。ロックファイルには残ります。`amira ext disable` と `enable` で設定します。",
    userOnly: true,
  },
  "packages.trustedProjects": {
    default: documentedDefault("packages.trustedProjects"),
    en: "Project directories whose own packages (`.amira/packages`) may load.",
    zh: "允许加载自带包（`.amira/packages`）的项目目录。",
    ja: "そのプロジェクトのパッケージ（`.amira/packages`）の読み込みを許可するプロジェクトディレクトリです。",
    userOnly: true,
  },
  "packages.untrustedProjects": {
    default: documentedDefault("packages.untrustedProjects"),
    en: "Project directories whose packages you chose not to load.",
    zh: "你选择不加载其自带包的项目目录。",
    ja: "そのプロジェクトのパッケージを読み込まないことを選択したプロジェクトディレクトリです。",
    userOnly: true,
  },
  "skills.dirs": {
    default: none,
    en: "Extra skill directories, searched after `.amira/skills` and `~/.amira/skills` and before `.agents/skills` and `.claude/skills`. `~` is your home directory; relative paths start from the working directory.",
    zh: "额外的技能目录，搜索顺序在 `.amira/skills` 和 `~/.amira/skills` 之后、`.agents/skills` 和 `.claude/skills` 之前。`~` 表示用户主目录；相对路径从工作目录算起。",
    ja: "追加のスキルディレクトリです。`.amira/skills` と `~/.amira/skills` の後、`.agents/skills` と `.claude/skills` の前に検索します。`~` はホームディレクトリを指し、相対パスは作業ディレクトリを基準にします。",
  },
}
