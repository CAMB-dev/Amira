# Providers and models

[简体中文](zh/providers.md) · [Documentation](../README.md)

A provider combines a protocol, an endpoint and credentials. Amira has no built-in providers: add one before sending your first task. You choose models as `provider/model`, where the provider name is the ID you assigned.

## Choose a protocol

| Protocol | Use it for | Example base URL |
| --- | --- | --- |
| `openai-chat` | OpenAI-compatible chat completions, including many proxies and local servers | `https://api.openai.com/v1` |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` |
| `google-gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` |

Use the base URL your service supplies for that protocol. A compatible chat endpoint does not automatically implement Responses or Anthropic features.

## Add, edit and remove

In an interactive session, `/provider` lists configured providers and their key availability. `/provider add` asks for a protocol, then opens the provider form. You can preselect it with `/provider add openai-chat`.

Fill in the ID, base URL and key source. Choose **Fetch models** to request a model list, or enter model IDs yourself. Choose **Test connection** to send a small request with the first selected model. These two actions contact the provider; opening or saving the form does not test it. **Save** writes the provider to the user settings and makes it available immediately.

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

For setup without questions, provide a protocol, ID, URL and exactly one key option. This example uses an environment variable; replace the endpoint and model with your service's values:

```sh
amira provider add openai-chat --id my-provider --base-url https://api.example.com/v1 --key-env MY_PROVIDER_API_KEY --model my-model
```

Repeat the model option to list multiple models. The other key options are `--key-stdin` for a piped key and `--no-key` for a server that needs none. Removal accepts `--yes` to skip questions and `--keep-key` to retain the stored key. Without the latter, unattended removal also deletes an existing stored key.

## Credentials and settings

You can store a key in `~/.amira/auth.json`, read it from an environment variable, or use no key. The interactive key field is masked. `AMIRA_HOME` changes the user directory, including the locations of settings and stored credentials.

For an environment key, set the variable in the process environment before starting Amira. The configuration stores its name in `apiKeyEnv`, not its value. Requests try that variable, then the variables in `apiKeyEnvFallbacks` in order, then the stored key for that provider. No vendor-specific environment variable is assumed automatically.

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

Use `catalogId` to select a catalog provider when your own provider ID differs; set it to `false` to ignore the catalog for this provider. Selecting or describing a model does not by itself verify that the endpoint serves it. **Test connection** is the explicit check.

## Compatibility and native features

Set compatibility options under a provider's `compat` object:

| Option | Behavior |
| --- | --- |
| `maxTokensField` | Chat output limit field: `max_tokens` by default, or `max_completion_tokens` |
| `streamUsage` | Request usage in chat streams; defaults to `true` |
| `thinking` | Anthropic thinking mode: `adaptive` by default, or `budget` for compatible servers that expect a token budget |
| `webSearch` | Offer hosted web search (Responses, Anthropic Messages, Gemini); a model's `caps.webSearch` takes precedence |
| `compaction` | Native compaction: `auto`, `on` or `off`; defaults to `auto` |

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

The choice follows the current model: after `/model` switches to another provider or model, its own setting applies. Sub-agents use the setting of the model they run on. Restart Amira after changing the setting. Project settings may set `tools.edit` as well. The patch tool only writes inside the working directory, refuses paths that pass through a symbolic link or junction below it, refuses files with other hard links (common in `node_modules` installed by Bun or pnpm), and rejects a patch that changes the same file twice.

Related: [Getting started](getting-started.md), [Usage and sessions](usage.md), [Settings](settings.md), [Extensions](extensions.md).
