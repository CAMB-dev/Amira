# Amira

[简体中文](README.zh-CN.md)

Amira is a lightweight, extensible coding agent for the terminal, built with TypeScript and Bun. It reads and edits project files, runs tools, and delegates tasks to sub-agents. Choose your own model provider and use it interactively or through print and RPC modes.

> Work in progress.

## Install from source

Install [Bun](https://bun.sh), then run these commands in a checkout of this repository:

```sh
bun install
cd packages/cli
bun link
cd ../..
```

The CLI package provides the global `amira` command; make sure Bun's executable directory is on your PATH. You can also run `bun run amira` from the repository root.

## First run

Run `amira` in your project. Add a provider with `/provider add`, choose its protocol, base URL, models and key source, then pick a model with `/model`. The built-in protocols are `openai-chat`, `openai-responses`, `anthropic-messages` and `google-gemini`. For environment-based keys, select `Read it from an environment variable`, enter the variable name (`apiKeyEnv`), and set it in the shell that launches Amira. There are no preconfigured providers.

Type a request and press Enter. By default, during a turn Enter steers it and Alt+Enter queues a message for the next turn (Windows may use Ctrl+Q; follow the hint line). Esc interrupts; if messages are waiting, they are sent immediately. Esc twice opens rewind for stored sessions; rewind changes the conversation, not files. Type `@` to pick a file path, `$` to select a skill, `/` to browse commands, or `?` with an empty input to see the keys.

## Documentation

- [Getting started](docs/getting-started.md)
- [Providers and API keys](docs/providers.md)
- [Everyday use, sessions and automation](docs/usage.md)
- [Sub-agents and worktrees](docs/subagents.md)
- [Using and writing extensions](docs/extensions.md)
- [Keybindings](docs/keybindings.md)
- [Settings reference](docs/settings.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you distribute Amira or a product built on it, keep the NOTICE file with it.
