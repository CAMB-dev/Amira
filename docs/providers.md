# Providers and models

[简体中文](zh/providers.md) · [日本語](ja/providers.md) · [Documentation](../README.md)

A provider combines a protocol, an endpoint and credentials. Add one before sending your first task; vendor defaults from the models.dev catalog help you configure it. You choose models as `provider/model`, where the provider name is the ID you assigned.

## Choose a protocol

| Protocol | Use it for | Example base URL |
| --- | --- | --- |
| `openai-chat` | OpenAI-compatible chat completions, including many proxies and local servers | `https://api.openai.com/v1` |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |
| `google-gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` |

Use the base URL your service supplies for that protocol. A compatible chat endpoint does not automatically implement Responses or Anthropic features.

## Add, edit and remove

In an interactive session, `/provider` opens the provider management page. Each provider shows its ID, protocol, base URL, model count, key source and the last connection-test result for the saved configuration, if known. Choose **+ Add provider** to add one, or select a provider for **Use a model from it**, **Edit**, **Set key**, **Test connection** or **Remove**. Esc closes the page. In print (`-p`) and RPC contexts, bare `/provider` prints the provider table.

`/provider add` opens one form, with **Vendor** at the top. Search by name or ID in **Popular** and **All vendors**, or choose **Custom (choose protocol)**. The list comes from the cached models.dev catalog without waiting for a download. Choosing a vendor fills the ID, protocol, URL, key environment name and catalog models. Switching vendors later updates only fields you have not edited. Protocol remains editable; there is no separate protocol step. Duplicate IDs get a suggested suffix such as `-2`. You can preselect a vendor with `/provider add deepseek`, or a protocol with `/provider add openai-chat`.

Review the ID, protocol, base URL and key source. The default is a stored API key with a masked input. If one of the vendor's listed environment variables is set, the form instead selects environment authentication and shows only its name, not its value. Otherwise, the first listed variable name is prefilled when you choose environment authentication.

In the full-screen form, models are fetched once the base URL and credentials are ready. HTTPS and loopback HTTP are eligible immediately; other HTTP endpoints require explicit consent before sending credentials without encryption. Editing also fetches when the original model list is empty. **Fetch models** remains available for manual refresh. Custom model IDs and selections survive refreshes. The provider supplies the list; models.dev adds context windows and prices. One-question-at-a-time dialogs keep fetching explicit.

In the **Models** checklist, type to filter IDs and labels by a case-insensitive substring; Backspace edits the `filter:` line. ↑↓ moves, Space toggles, **Ctrl+A** selects all filtered options (or clears them if all are selected), and **Ctrl+X** inverts those options, including matching rows beyond the visible scroll window. Selections outside the filter are kept. The header shows `selected 12/240` and adds `· 30 shown` while filtering. Esc clears a non-empty filter first; another Esc cancels the form, with a discard confirmation for changed values. Enter adds an unlisted ID when custom values are allowed. Two independently right-aligned columns show context window and catalog input/output prices in USD per million tokens when known. Narrow screens drop price first, then context; models absent from the catalog remain listed without a price.

Open the collapsed **Advanced** section for request headers (`Name=value`, one per line, with `${ENV}` references), ordered API key environment fallbacks, protocol-specific compatibility settings and per-model `fast` descriptors. Only options supported by the settings schema are offered. Editing preserves unknown settings and existing model overrides; changing key source does not silently delete fallbacks.

A live **settings.json preview** shows the entry that will be written, with header secrets masked and a separate masked **key → auth.json** line. The preview spans both columns in its own section below the fields. Tab to **Preview**, then use ↑↓, PageUp/PageDown, Home or End to review long entries. The add/edit form uses a centred card with a two-column label/control grid and distinct input areas. Narrow or short terminals fall back to the plain scrolling form; labels stack above inputs when width is limited.

The footer keeps **Test**, **Save** and **Cancel** together; **Test** runs the existing connection check without saving. **Save** runs one tiny connection test against the first selected model. Paid or unknown-price models require confirmation of the possible charge; known free models do not show a billing warning. The result appears inline. If it fails, choose **Save anyway** or fix the fields and retry. After saving, the management page returns with that provider highlighted; **Use a model from it** opens a picker containing only its models. Dialogs and non-TTY shell setup ask the same fields in order, then show a masked summary/preview and ask for confirmation. Callback-dependent forms automatically use these dialogs over RPC, even when the client requests native static forms. In non-TTY setup, enter multiline fields one line at a time and finish with `.` alone; finish immediately to keep the existing value, or enter a blank line before `.` to clear it. Complete flags-only shell commands remain unattended and do not add a test call.

Use `/model` to choose a model from the configured list, or `/model <provider/model>` to select one directly. The list is a convenience: an unlisted model ID can also be selected. After saving the first provider, Amira selects its first model if the session has no model yet and the provider has a model list.

| In-session command | Purpose |
| --- | --- |
| `/provider edit <id>` | Edit the endpoint, key source, model list and defaults |
| `/provider key <id>` | Store or replace its API key |
| `/provider remove <id>` | Confirm removal, with a separate choice to delete a stored key |

Switch away with `/model` before removing a provider currently in use.

The same forms are available from the shell:

```sh
amira provider add
amira provider edit <id>
amira provider key <id>
amira provider remove <id>
amira provider help
```

`amira provider add <vendor-or-protocol>` accepts a catalog vendor ID or a protocol; protocol names win if the names clash. For a supported vendor, this command uses its defaults without asking questions:

```sh
amira provider add deepseek --key-env DEEPSEEK_API_KEY
```

Use `--id`, `--base-url` and `--model` to override the vendor's ID, URL and models. Unsupported vendors require an explicit protocol and URL. The existing protocol flow is unchanged: for setup without questions, provide a protocol, ID, URL and exactly one key option. Replace the endpoint and model below with your service's values:

```sh
amira provider add openai-chat --id my-provider --base-url https://api.example.com/v1 --key-env MY_PROVIDER_API_KEY --model my-model
```

Repeat the model option to list multiple models. The other key options are `--key-stdin` for a piped key and `--no-key` for a server that needs none. Removal accepts `--yes` to skip questions and `--keep-key` to retain the stored key. Without the latter, unattended removal also deletes an existing stored key.

## Credentials and settings

You can store an API key in `~/.amira/auth.json`, read it from an environment variable, or use no key. OAuth is not supported. The interactive key field is masked. `AMIRA_HOME` changes the user directory, including the locations of settings and stored credentials.

An empty or whitespace-only API key field means no replacement key: probes and saves keep the current configured credential, and blank saves do not write a new key. Configured-provider tests share normal requests' live, in-memory credential resolver; an independent edit or deletion of auth.json does not switch a running session's test credential. Deliberate draft key-source changes and nonempty replacement keys still take effect in the test.

For an environment key, set the variable in the process environment before starting Amira. The configuration stores its name in `apiKeyEnv`, not its value. Requests try that variable, then the variables in `apiKeyEnvFallbacks` in order, then the stored key for that provider. Interactive saves always persist the selected `keySource`, including **No key** and environment authentication, independently of fallback-list length. Clearing fallbacks cannot reactivate a retained auth.json key after restart. Complete flags-only commands preserve the legacy settings shape. Vendor setup offers the environment variable names listed in the catalog; custom protocol setup requires you to supply the name.

For example, in PowerShell:

```powershell
$env:MY_PROVIDER_API_KEY = "replace-with-your-key"
amira
```

Or in a POSIX shell:

```sh
export MY_PROVIDER_API_KEY="replace-with-your-key"
amira
```

You can also add providers directly to the user settings. This illustrative entry includes a model-specific context window:

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

Project settings can adjust model metadata, but the endpoint, key variable, fallback variables and headers are accepted only from the user settings. See the [settings reference](settings.md) for merging and user-only fields.

## Model metadata and context windows

Amira uses a models.dev catalog to describe models. Explicit entries in `models` take precedence over catalog metadata; catalog metadata takes precedence over `defaultModel`. Without any metadata, the context window defaults to 128,000 tokens and the output limit to 8,192. Those fallback numbers are estimates, so configure the real limits for an unknown model.

The provider form's defaults apply to models the catalog does not describe. For a particular model, set its `contextWindow`, `maxOutput` or `caps` in settings. A capability configured under `caps` describes what the server supports; it does not add that capability to a model.

Use `catalogId` to select a models.dev provider for model details (context window, capabilities and pricing); set it to `false` to ignore the catalog for this provider. For a custom provider such as `my-gateway`, `"catalogId": "llmgateway"` borrows metadata for its models without adding the gateway's other models to the picker, `/model` list or completions. List the models your endpoint serves in `models`. A provider's own catalog—matching its ID or a built-in mapping such as `gemini` → `google`—still adds catalog models to these lists.

When you add or edit a provider, `/provider` may infer `catalogId` from the model IDs. If it borrows another provider's catalog, the save summary names it as “Model details from …”. Catalog metadata does not verify that the endpoint serves a model; the connection test on Save checks the first selected model.

## Compatibility and native features

Set compatibility options under a provider's `compat` object:

| Option | Behavior |
| --- | --- |
| `maxTokensField` | Chat output limit field: `max_tokens` by default, or `max_completion_tokens` |
| `streamUsage` | Request usage in chat streams; defaults to `true` |
| `thinking` | Anthropic thinking mode: `adaptive` by default, or `budget` for compatible servers that expect a token budget |
| `thinkingDisplay` | Anthropic thinking text: `summarized` or `omitted`; defaults to `summarized` at `api.anthropic.com`, not sent to other hosts unless configured. Override per model with `models[].compat.thinkingDisplay` |
| `webSearch` | Offer hosted web search (Responses, Anthropic Messages, Gemini); a model's `caps.webSearch` takes precedence |
| `compaction` | Native compaction: `auto`, `on` or `off`; defaults to `auto` |

Thinking display does not change billed tokens. With `omitted`, signed thinking blocks still round-trip unchanged; only the readable text is hidden. On default-on Claude 5.x models, Amira requests summaries even without an explicit effort and leaves the server's effort default unchanged. `/thinking default` means server-default effort, not thinking off. See [Anthropic's thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking). DeepSeek and MiniMax do not document `display` support, so their requests remain unchanged unless you set this option.

Hosted web search is implemented for `openai-responses`, `anthropic-messages` and `google-gemini`. It defaults on for the vendor endpoints: OpenAI and URLs Amira recognizes as Azure OpenAI, `api.anthropic.com`, and `generativelanguage.googleapis.com`; it defaults off for other hosts. Gemini combines Google Search with Amira's tools only on Gemini 3 models, so older Gemini models keep client search. When active, Amira hides its client `web_search` tool from that model; `web_fetch` remains available. Set `web.nativeSearch` to `false` to use client search instead. This is separate from choosing a client search backend in the web settings. Model catalogs list no search fees, so a reply that searched shows its cost as unknown unless the model's `cost.webSearch` (USD per search) is set.

Native compaction is implemented for `openai-responses` and `anthropic-messages`. With `auto`, it is enabled only for their recognized vendor endpoints: OpenAI/Azure OpenAI and Anthropic respectively. Automatic compaction and plain `/compact` try it first and fall back to a text summary if it fails. A configured `compact.model` or instructions supplied to `/compact` request a text summary instead.

For a proxy that actually forwards hosted search and native compaction, opt in explicitly:

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

For a local chat server, choose `openai-chat`, its local base URL and `--no-key` when adding it through the CLI. Enter the model IDs it exposes and set their real limits. Enable only the capabilities the server implements.

## Editing tools

Amira has two tools for changing existing files: `edit`, which replaces exact text, and `apply_patch`, which applies a multi-file patch in the format OpenAI's Codex uses (see [Tools and approvals](usage.md#tools-and-approvals)). Choose per provider with `tools.edit`, and override it for a single model under `models[].tools.edit`:

| Value | Tools the model gets |
| --- | --- |
| `"edit"` | `edit` only (the default) |
| `"apply_patch"` | `apply_patch` only |
| `"both"` | `edit` and `apply_patch` |

`write` is offered in every case. No model switches to `apply_patch` automatically; opt in for models that handle the patch format well, such as OpenAI's GPT and Codex models:

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

The choice follows the current model: after `/model` switches to another provider or model, its own setting applies. Sub-agents use the setting of the model they run on. Restart Amira after changing the setting. Project settings may set `tools.edit` as well.

`apply_patch` only writes inside the working directory and refuses paths that pass through a symbolic link or junction below it. Files with other hard links, such as dependencies installed by Bun or pnpm, are written in place, so every link sees the change, including links outside the working directory. Delete removes only the named link, and Move writes a new file and removes the old name, so other links keep the old content. One patch may not reach the same file through two different links.

Blocks apply in order, each against the result of the earlier ones, so one file can have several `*** Update File:` blocks. Update after Add, Delete after Update, Update of a Move destination, chained Moves (`a` → `b` → `c`, or back to `a`), and Delete followed by Add (or the reverse) all work. Update, Delete and Move need the source to exist at that point, and Add and Move need the destination to be absent; otherwise the patch fails with an error naming the path. A path cannot be used as both a file and a directory in one patch.

Every block is checked before anything is written. If a write fails, the files already changed get their original bytes back (through every hard link), and new files and folders are removed; the error says whether the rollback was complete. While a patch deletes a file, a temporary `.amira-patch-*` folder next to it keeps a link for rollback and is removed at the end. This protects against errors, not crashes, and other programs may see the intermediate state while the patch runs.

Related: [Getting started](getting-started.md), [Usage and sessions](usage.md), [Settings](settings.md), [Extensions](extensions.md).
