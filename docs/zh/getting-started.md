# 快速开始

[English](../getting-started.md) · [文档首页](../../README.zh-CN.md)

## 安装并进入项目

准备好 Bun 和终端，在 Amira 仓库的本地副本中执行：

```sh
bun install
cd packages/cli
bun link
cd ../..
```

CLI 包提供全局 `amira` 命令，请确认 Bun 的可执行文件目录已加入 PATH。开发时，在仓库根目录运行 `bun run amira` 也会启动同一个 CLI。

进入你想处理的项目目录，再运行：

```sh
amira
```

当前目录就是工作目录，也可以用 `--cwd` 指定。Amira 默认打开全屏界面，显示标题、工作目录、状态区域和 `Message Amira` 输入框。偏好终端原生滚动历史时，可以加 `--inline`。若项目安装了扩展，进入主界面前可能出现信任确认；扩展会执行代码，由你决定是否加载当前项目的包。详见[扩展](extensions.md)。

没有配置 provider 时，会看到以下欢迎提示：

```text
Welcome to Amira. Three steps to a first message:
1. Add a provider: /provider add
2. Pick one of its models: /model
3. Ask away: @ mentions files, /help lists the commands and keys
```

## 添加 provider

输入 `/provider add` 并按 Enter。协议选择器会询问 `Which protocol does the provider speak?`。根据服务端实现，选择 `openai-chat`、`openai-responses`、`anthropic-messages` 或 `google-gemini`，随后进入 `Add a provider` 表单。

填写 `Id`（本地使用的 provider 名称）、`Base URL` 和密钥来源。使用环境变量时，选择 `Read it from an environment variable`，在 `Environment variable` 中填变量名。对应设置是 `apiKeyEnv`，这里填写的是变量名，不是密钥内容；请在启动 Amira 的 shell 中提前设置该变量。不需要鉴权的本地服务可以选择 `No key (a local server)`。

在 `Models` 中点击 `Fetch models`，向服务端查询模型列表，也可以自己填入准确的模型 ID。查询会使用表单指定的密钥发送请求。Space 勾选模型；输入列表中没有的 ID 后按 Enter 可以添加。模型 ID 和上下文窗口应与服务端一致。目录没有收录模型时，可以展开 `Defaults for models the catalog does not know`，补充模型限制。`Test connection` 会发送一个小型模型请求，可能产生费用，可以跳过。`Save` 把 provider 保存到用户设置；Esc 取消而不保存。服务地址、密钥优先级和兼容选项见[provider 文档](providers.md)。

## 选择模型

运行 `/model` 从已配置的模型中选择，或用 `/model provider/model` 指定真实的 provider 和模型 ID。第一次保存包含模型的 provider 时，可能已经自动选中第一个模型；仍可用 `/model` 确认或切换。后续启动按 `--model`、`AMIRA_MODEL`、`model` 设置的顺序确定模型；都未指定时，只有一个 provider 才会使用其第一个模型。配置了多个 provider 时，请明确选择。

模型尚未就绪时，发送消息会保留输入草稿，并提示需要完成的配置。配置命令仍可使用。

## 完成第一个任务

先给出一个结果明确的需求，例如：

```text
Read @README.md and the project configuration. Explain how to run the tests, then fix one failing test and verify the change.
```

请根据自己的项目替换文件和任务。输入 `@` 和部分路径会打开文件选择器，方向键选择，Tab 或 Enter 插入路径。文件引用只是写入消息中的路径文本，不会自动附上文件内容；agent 可以通过工具读取文件。

按 Enter 发送。对话记录会显示流式回复和工具活动；出现授权或提问时，在对话框中作答。确认对话框默认不选中任何选项，先选择再按 Enter 才能确认。授权对话框中的 Esc 会拒绝该调用并停止轮次。运行期间，Enter 可以发送引导消息；输入框下方提示的排队键会让消息等到当前轮次结束。Esc 中断轮次后，等待中的消息会按输入顺序合并发送。连续按两次 Esc 可以回退已保存会话的消息，但不会撤销磁盘上的修改。

`/status` 可以查看上下文使用情况和已报告的费用。运行项目测试并检查 diff，确认实际修改。`/quit` 退出后，会话会保存，终端会打印恢复命令。在同一目录运行 `amira -c` 继续最近的会话，或用 `amira -r` 打开会话选择器。

## 接下来

输入框为空时按 `?` 查看快捷键，`/help` 列出命令，输入 `/` 打开命令补全。`$` 列出已发现的 skill，`$<name> [arguments]` 运行对应 skill；未安装相关扩展或没有 skill 时，对应列表可能为空。

相关文档：[日常使用与自动化](usage.md)、[快捷键](keybindings.md)、[provider](providers.md)、[子 agent](subagents.md)、[扩展](extensions.md)、[设置参考](settings.md)、[README](../../README.zh-CN.md)。
