# Amira

[简体中文](README.zh-CN.md) · [日本語](README.ja.md)

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

Nightly executable prereleases are available on [GitHub Releases](https://github.com/CAMB-dev/Amira/releases). See [building Amira](docs/building.md) for local builds and diagnostics.

## First run

Run `amira` in your project. Add a provider with `/provider add`, search for a vendor by name or ID in the models.dev catalog, then review its prefilled settings, models and key source. Choose `Custom` for a local or unlisted service, or if the catalog is unavailable offline, and select its protocol and base URL manually. The built-in protocols are `openai-chat`, `openai-responses`, `anthropic-messages` and `google-gemini`. For environment-based keys, select `Environment variable`, enter the variable name (`apiKeyEnv`), and set it in the shell that launches Amira. Then pick a model with `/model`. See [providers](docs/providers.md) for setup details.

Type a request and press Enter. By default, during a turn Enter steers it and Alt+Enter queues a message for the next turn (Windows may use Ctrl+Q; follow the hint line). Esc interrupts; if messages are waiting, they are sent immediately. Esc twice opens rewind for stored sessions; rewind changes the conversation, not files. Type `@` to pick a file path, `$` to select a skill, `/` to browse commands, or `?` with an empty input to see the keys. `/ext` browses, installs and manages extensions. `/provider` opens provider management; Enter offers edit, key, connection test and removal, and Esc closes it. In model checklists, type to filter, Ctrl+A selects all/none matching the filter, and Ctrl+X inverts those selections.

## Documentation

- [Getting started](docs/getting-started.md)
- [Providers and API keys](docs/providers.md)
- [Everyday use, sessions and automation](docs/usage.md)
- [Sub-agents and worktrees](docs/subagents.md)
- [Using and writing extensions](docs/extensions.md)
- [Keybindings](docs/keybindings.md)
- [Themes](docs/themes.md)
- [Settings reference](docs/settings.md)

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). If you distribute Amira or a product built on it, keep the NOTICE file with it.
