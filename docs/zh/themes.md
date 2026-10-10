# 主题

[English](../themes.md) · [文档](../../README.zh-CN.md)

主题改变语义颜色和符号，不改变终端自身的背景或前景。内置主题有 `amira`（默认青色配色）、`amber`、`burnt`、`lavender`、`mono`（中性色强调，保留彩色状态提示）和 `ascii`（默认颜色及 ASCII 符号）。内置定义位于 [`packages/cli/themes`](../../packages/cli/themes)。

## 选择主题

输入 `/theme` 打开主题选择器，查看名称、来源和描述。列表先显示 `amira`、`amber`、`burnt`、`lavender`、`mono`、`ascii`，然后显示自定义主题，最后是 `terminal`；当前主题会标注。上下方向键立即预览主题，Tab 或左右方向键在独立的外观控制中循环选择 `auto`、`dark`、`light`（Shift+Tab 反向循环）。Enter 同时应用主题和外观；Esc 恢复两者且不保存，即使预览期间重新加载了主题定义。

`/theme <name>` 可直接选择主题并保留外观。旧命令 `/theme auto`、`/theme dark`、`/theme light` 选择 Amira 及对应外观；旧设置仍有效，在选择器中映射为当前的 Amira 主题。交互选择同时保存 `tui.theme` 和 `tui.themeVariant`，方式与模型选择相同：写入用户设置，以及允许保存时的项目 `settings.local.json`。项目保存限制见[设置参考](settings.md#保存模型与思考设置)。

也可以在 `settings.json` 中指定名称：

```json
{
  "tui": {
    "theme": "ascii",
    "themeVariant": "auto"
  }
}
```

`tui.themeVariant` 接受 `auto`、`dark` 和 `light`。`auto` 根据检测到的终端背景选择，无法判断时使用深色；`dark` 或 `light` 强制指定外观。所选变体缺少的颜色继承该外观的默认 Amira 配色。如果主题只提供 `dark`，选择 `light` 时使用默认浅色配色，而不是主题的深色颜色；符号覆盖仍然生效。只提供浅色变体的主题也遵循相同规则。

运行时切换立即重绘全屏对话和行内模式的活动区域。已写入行内滚动缓冲区的输出保留原来的样式。

原有 `tui.theme` 选项仍然有效：`auto` 使用 Amira 配色并跟随终端，`dark` 和 `light` 显式选择 Amira 深浅配色，`terminal` 使用终端的 ANSI 颜色。命名主题不会强制开启 truecolor；颜色深度设置和单色模式仍然有效。

## 文件与优先级

每个 JSON 文件包含一个主题，用 `name` 标识，而不是文件名。按以下顺序加载；后加载的同名定义会替换整个先前定义，并产生提示：

1. 随 CLI 打包的内置主题。
2. `~/.amira/themes/*.json`；设置了 `AMIRA_HOME` 时改为 `$AMIRA_HOME/themes/*.json`。
3. 启动工作目录中的 `<cwd>/.amira/themes/*.json`，不是 Git 根目录。
4. 已启用包清单的 `themes` 路径。禁用的包和未获信任的项目包不加载。
5. 扩展通过 `api.registerTheme` 注册的主题。

目录文件名按不依赖区域设置的字典顺序排列。包的主题路径按已启用包的顺序及各清单中的声明顺序加载。主题目录中只读取直接位于该目录下的 `.json` 文件，不扫描子目录。目录不存在不算错误。文件不可读、JSON 无效或定义无效时会产生提示，不会中止启动；其他文件仍继续加载。未知字段和颜色键会提示并忽略。无效的符号覆盖逐项忽略，继续使用默认符号。

修改主题文件或包的主题后，重启 Amira，或在空闲时运行 `/reload`。重载会替换文件快照，已删除文件不再注册主题。扩展注册仍然位于文件层之上；卸载扩展会恢复下层定义。

## 主题格式

格式见 [`ThemeDefinition`](../../packages/api/src/themes.ts)。`name` 必填，不能为空，不能有首尾空白或控制字符。`description`、`dark`、`light` 和 `glyphs` 均可省略。颜色必须是不带透明度的 `#RGB` 或 `#RRGGBB` 十六进制字符串；不接受 `cyan` 等颜色名称、CSS 函数、alpha 通道或 ANSI 转义序列。

配色是部分覆盖，不必替换全部默认颜色。`bg` 和 `fg` 是计算表面颜色的参考值，不会重设终端背景。`shimmer` 和 `shimmerEnd` 是独立的渐变起止颜色；省略时继承该外观的默认 Amira 渐变。下面是包含全部颜色键及部分符号覆盖的完整文件，可保存为 `~/.amira/themes/my-theme.json`：

```json
{
  "name": "my-theme",
  "description": "Default colors with simple list and code-frame symbols",
  "dark": {
    "bg": "#121212",
    "fg": "#e4e4e4",
    "accent": "#78dbe2",
    "heading1": "#6fb3e8",
    "heading": "#78dbe2",
    "path": "#9ab8f0",
    "command": "#a8e6ea",
    "fg2": "#bdbdbd",
    "muted": "#727272",
    "dim": "#4a4a4a",
    "border": "#333333",
    "borderFocused": "#565656",
    "success": "#8fc46a",
    "error": "#e5737a",
    "warning": "#e2b356",
    "thinking": "#a8927a",
    "userBg": "#202020",
    "codeBg": "#191919",
    "diffAddedBg": "#0f3a12",
    "diffRemovedBg": "#47141a",
    "diffAddedWordBg": "#17551c",
    "diffRemovedWordBg": "#66212a",
    "keyword": "#6fb3e8",
    "string": "#8dd8bd",
    "number": "#b5b4ee",
    "shimmer": "#78dbe2",
    "shimmerEnd": "#6fb3e8"
  },
  "light": {
    "bg": "#f6f5f2",
    "fg": "#222222",
    "accent": "#157c84",
    "heading1": "#1f6aa8",
    "heading": "#126f76",
    "path": "#3f5fb0",
    "command": "#1a6a70",
    "fg2": "#444444",
    "muted": "#8a8a8a",
    "dim": "#bdbab4",
    "border": "#d2cfc8",
    "borderFocused": "#9d9a93",
    "success": "#3f8a2a",
    "error": "#c23b47",
    "warning": "#a87412",
    "thinking": "#8d7a63",
    "userBg": "#e8e6e1",
    "codeBg": "#efede9",
    "diffAddedBg": "#d6f0cf",
    "diffRemovedBg": "#f6d5d8",
    "diffAddedWordBg": "#bce5b1",
    "diffRemovedWordBg": "#edb5bd",
    "keyword": "#1f6aa8",
    "string": "#23765d",
    "number": "#6356a6",
    "shimmer": "#157c84",
    "shimmerEnd": "#1f6aa8"
  },
  "glyphs": {
    "bullets": ["*", "-", "+"],
    "codeTop": "+-",
    "codeSide": "|",
    "codeBottom": "`-",
    "image": "[]"
  }
}
```

编辑器 schema 是本参考旁的 [`themes.schema.json`](../themes.schema.json)。在编辑器中将它关联到主题 JSON 文件即可。运行时还会检查终端单元格宽度，这是 JSON Schema 无法表达的约束。

### 符号键与宽度

`glyphs` 合并两个符号模块，使用平铺的键名；不要嵌套 `tui` 或 `markdown` 对象。值必须是单行纯文本，不能包含制表符、换行或控制／转义字符。`bullets` 是非空数组，按列表嵌套深度取值；更深层级重复最后一个符号。

覆盖值必须与默认符号的显示单元格宽度相同，按 Amira 的文本宽度库计算，不是按字符串长度。警告符号可以使用不同宽度，因为警告布局会单独测量。终端和字体的实际渲染仍可能不同，请在你使用的终端中测试。

| 宽度 | 键 |
| --- | --- |
| 1 格 | 每个 `bullets` 元素；`quoteBar`、`rule`、`codeSide`、`tableColumn`、`tableRule`、`tableCross`、`boxTopLeft`、`boxTopRight`、`boxBottomLeft`、`boxBottomRight`、`user`、`toolDone`、`toolRunning`、`toolFailed`、`toolInterrupted`、`toolBlocked`、`toolUnknown`、`toolInvalid`、`result`、`treeBranch`、`output`、`subagent`、`subagentDone`、`subagentFailed`、`subagentAborted`、`thought`、`question`、`dialogBar`、`choice`、`info`、`success`、`error`、`interrupted`、`more`、`pointer`、`search`、`searchPrompt`、`working`、`branch`、`separator` |
| 2 格 | `assistant`（默认为两个空格）、`codeTop`、`codeBottom`、`image` |
| 3 格 | `taskOpen`、`taskDone`、`checked`、`unchecked` |
| 单独测量 | `warning`（默认为两格 emoji） |

ASCII 中用 `image: "[]"`、`codeTop: "+-"` 和 ``codeBottom: "`-"`` 保持两格宽度。`more: "..."` 无效：默认只占一格，应使用 `"."`。内置 [`ascii.json`](../../packages/cli/themes/ascii.json) 提供完整的 ASCII 符号示例。

## 包提供的主题

包可以只提供 JSON，不运行扩展代码。路径相对于包目录，必须位于包目录内。`themes` 默认为 `[]`；纯主题包不需要 `index.ts`，也不必显式写空的 `extensions` 列表。

`amira-package.json`：

```json
{
  "name": "my-theme-pack",
  "version": "1.0.0",
  "themes": ["themes/my-theme.json"]
}
```

使用 `amira ext install ./my-theme-pack` 安装后，重启或运行 `/reload`。也可以把相同的 `themes` 列表放在 `package.json` 的 `amira` 对象中。包的启用／禁用和项目信任规则对主题同样生效。

## 从扩展注册主题

`api.registerTheme` 使用与 JSON 文件相同的定义格式和校验：

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  api.registerTheme({
    name: "extension-blue",
    description: "Blue accents with default status and surface colors",
    dark: { accent: "#8cbcff", heading1: "#a5cfff", heading: "#8cbcff", path: "#a5baff" },
    light: { accent: "#245fa8", heading1: "#1c4e8c", heading: "#245fa8", path: "#3f5fb0" },
  })
})
```

`registerTheme` 返回取消注册函数，调用后立即移除该注册。注册属于对应扩展，卸载或重载时会移除。后注册者优先；卸载当前同名主题会恢复先前定义。注册本身不会选择或保存主题；请使用 `/theme` 或 `tui.theme` 选择。
