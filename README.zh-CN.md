# Amira

[English](README.md)

Amira 是用 TypeScript 和 Bun 开发的轻量终端编程 agent。它可以读取和修改项目文件、运行工具、把任务交给子 agent。你可以自行配置模型 provider，在终端中交互使用，也可以通过 print 或 RPC 模式接入脚本。

> 项目仍在开发中。

## 从源码安装

先安装 [Bun](https://bun.sh)，然后在本仓库的本地副本中执行：

```sh
bun install
cd packages/cli
bun link
cd ../..
```

CLI 包提供全局 `amira` 命令；请确认 Bun 的可执行文件目录已加入 PATH。在仓库根目录也可以用 `bun run amira` 启动。

## 第一次使用

在项目目录运行 `amira`。输入 `/provider add`，选择协议并填写服务地址、模型和密钥来源，再用 `/model` 选择模型。内置协议包括 `openai-chat`、`openai-responses`、`anthropic-messages` 和 `google-gemini`，没有预配置的 provider。使用环境变量存放密钥时，在表单中选择 `Read it from an environment variable`，填入变量名（`apiKeyEnv`），并在启动 Amira 的 shell 中设置该变量。

输入需求后按 Enter 发送。默认情况下，轮次运行期间 Enter 用于引导，Alt+Enter 把消息排队到下一轮次（Windows 可能使用 Ctrl+Q，以界面提示为准）。Esc 中断当前轮次；若有等待中的消息，会立即发送。连续按两次 Esc 可以回退已保存会话中的消息；回退只改变对话，不恢复文件。输入 `@` 选择文件路径，`$` 选择 skill，`/` 浏览命令；输入框为空时按 `?` 查看快捷键。`/ext` 用于浏览、安装和管理扩展。

## 文档

- [快速开始](docs/zh/getting-started.md)
- [Provider 与 API 密钥](docs/zh/providers.md)
- [日常使用、会话与自动化](docs/zh/usage.md)
- [子 agent 与 worktree](docs/zh/subagents.md)
- [使用和编写扩展](docs/zh/extensions.md)
- [快捷键](docs/zh/keybindings.md)
- [设置参考](docs/zh/settings.md)

## 许可证

Apache License 2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。分发 Amira 或基于 Amira 的产品时，请一并保留 NOTICE 文件。
