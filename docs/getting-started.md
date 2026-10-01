# Getting started

[简体中文](zh/getting-started.md)

## Install and open a project

You need Bun and a terminal. In a checkout of Amira:

```sh
bun install
cd packages/cli
bun link
cd ../..
```

The CLI package declares the global `amira` executable. Make sure Bun's executable directory is on PATH. During development, `bun run amira` starts the same CLI from the repository root.

Change to the project you want Amira to work on, then run:

```sh
amira
```

The working directory is the current directory; `--cwd` can select another one. Amira opens a full-screen conversation with its banner, working directory, status area and `Message Amira` input. Use `--inline` if you prefer terminal scrollback. If the project has installed extensions, a trust prompt may appear before the main interface: extensions run code, so choose whether to load this project's packages. See [extensions](extensions.md).

With no configured provider, the welcome card reads:

```text
Welcome to Amira. Three steps to a first message:
1. Add a provider: /provider add
2. Pick one of its models: /model
3. Ask away: @ mentions files, /help lists the commands and keys
```

## Add your provider

Type `/provider add` and press Enter. The protocol picker asks `Which protocol does the provider speak?`. Select the API your endpoint implements: `openai-chat`, `openai-responses`, `anthropic-messages` or `google-gemini`. This opens the `Add a provider` form.

Fill in the `Id` (your local provider name), `Base URL`, and key source. For an environment key, select `Read it from an environment variable`, then fill `Environment variable`. The setting behind that field is `apiKeyEnv`; its value is the variable's name, never the secret itself. Set that variable in the shell before starting Amira. For a local server that needs no authentication, choose `No key (a local server)`.

In `Models`, choose `Fetch models` to ask the endpoint for its available models, or type the exact model IDs yourself. Fetching sends a request using the key specified in the form. The list supports custom IDs; Space selects a row, and typing an ID followed by Enter adds one. Model IDs and context windows must match your service. Expand `Defaults for models the catalog does not know` if you need to supply limits for uncatalogued models. `Test connection` is optional and sends a small model request; it may cost money. `Save` writes the provider to your user settings. Esc cancels without saving. See [providers](providers.md) for endpoint paths, key precedence and compatibility settings.

## Pick a model

Run `/model` to select from the configured models, or `/model provider/model` with your actual provider and model IDs. Saving the first provider with models can already select its first model; use `/model` to confirm or change it. Future launches use `--model`, then `AMIRA_MODEL`, then the `model` setting; otherwise the first model of the only configured provider is used. With several providers and no default, choose explicitly.

If no model is ready, sending a message leaves your draft in the input and explains what to configure. You can still run configuration commands.

## Complete a first task

Start with a request that has a clear result, for example:

```text
Read @README.md and the project configuration. Explain how to run the tests, then fix one failing test and verify the change.
```

Replace the example with files and a task from your project. Type `@` and part of a path to open the file picker; arrows choose a match, Tab or Enter inserts the path. A mention inserts text into your request; it does not automatically attach the file's contents. The agent can read it with a tool.

Enter sends your request. The conversation shows streamed replies and tool activity; answer any approval or question in the dialog. A confirmation has no initial selection: choose an option before Enter can confirm it. Esc on an approval denies that call and stops the turn. You can send additional guidance with Enter while it runs, or use the queue key shown below the input to send after it finishes. Esc interrupts; waiting messages then send together in their original order. Esc twice opens the rewind picker for stored sessions, without undoing edits on disk.

Use `/status` to inspect context use and reported cost. Run your project's tests and review its diff to check the actual result. `/quit` exits; Amira saves the conversation and prints a resume command. `amira -c` continues the most recent session in the same directory; `amira -r` opens the session picker.

## Explore next

With empty input, `?` opens the key reference. `/help` lists commands, and `/` opens command completion. `$` lists discovered skills; `$<name> [arguments]` runs one if available. These lists are empty when the corresponding extension or skill is absent.

Related: [usage and automation](usage.md), [keybindings](keybindings.md), [providers](providers.md), [sub-agents](subagents.md), [extensions](extensions.md), [settings reference](settings.md), [README](../README.md).
