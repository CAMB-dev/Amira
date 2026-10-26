# 設定リファレンス

[English](../settings.md) · [简体中文](../zh/settings.md) · [ドキュメント](../../README.ja.md)

Amira は起動時に JSON ファイルから設定を読み込みます。すべてのキーは任意です。省略したキーには、以下に記載するデフォルト値を使います。

## ファイルと優先順位

| ファイル | 適用範囲 |
| --- | --- |
| `~/.amira/settings.json` | すべてのプロジェクトに適用するユーザー設定 |
| `<project>/.amira/settings.json` | プロジェクト設定。通常はリポジトリにコミットします |
| `<project>/.amira/settings.local.json` | このプロジェクトで使う個人の設定。通常はコミットしません |

`<project>` は Amira を起動した作業ディレクトリ（cwd）であり、Git のルートではありません。ホーム/ユーザースコープにはプロジェクトはありません。リポジトリ外のディレクトリで、既存の `.amira` ディレクトリもない場合も、プロジェクトはありません。`AMIRA_HOME` でユーザーディレクトリを変更できます。設定すると、ユーザー設定は `$AMIRA_HOME/settings.json` になり、`auth.json`、`keybindings.json`、セッション、インストール済みパッケージと同じディレクトリに置かれます。

設定レイヤーは、組み込みのデフォルト、ユーザーファイル、プロジェクトファイル、`settings.local.json`、`--model` や `--disable-tools` などのコマンドラインフラグの順に適用され、後のものが前のものを上書きします。オブジェクトはキーごとにマージします。リストやその他の値は前のレイヤーの値を置き換えるため、プロジェクトの `tools.disabled` はユーザーのリストに追加するのではなく、リスト全体を置き換えます。

ファイルが有効な JSON でない場合や、キーの値の型が正しくない場合、Amira はファイル名とキー名を示すエラーを出して停止します。ただし、`maxParallelTools` と `subagents.maxConcurrent` の無効な値には警告を表示し、デフォルトを使用します。不明なキーは警告を出して無視するだけなので、新しいバージョンの設定ファイルも読み込めます。`$schema` キーも使用できます。API キーは設定ファイルに記載しないでください。`/provider` または `amira provider` で保存する（`auth.json` に保存されます）か、`apiKeyEnv` で指定した環境変数から読み込んでください。

## モデルと思考設定の保存

対話型セッションでは、`/model` でモデルの選択画面を開き、モデルが思考に対応していれば、続いて思考の選択画面を開きます。`/model provider/model` や `/thinking` も使えます（選択画面を開くか、レベルを明示的に指定します）。モデルまたは思考設定が実際に変わるたびに、現在の両方の設定をユーザーファイル（`$AMIRA_HOME/settings.json`、デフォルトでは `~/.amira/settings.json`）に保存し、プロジェクトがある場合は `<cwd>/.amira/settings.local.json` にも保存します。現在の値を選んだ場合や選択画面をキャンセルした場合は保存しません。保存をスキップした場合や保存に失敗した場合でも、変更はセッションに適用されます。

`--model`、`AMIRA_MODEL`、`--thinking` は 1 回の実行に限る上書きであり、デフォルト設定としては保存しません。その後、対話中にモデルや思考設定を変更すると、フラグや環境変数で最初に指定した値も含め、現在の両方の設定を保存します。print モード、RPC、子エージェント、拡張機能による変更では、これらのデフォルト設定を保存しません。

プロジェクトへの保存には cwd を使い、Git のルートは使いません。リポジトリ内では、`settings.local.json` が Git の無視対象で、かつ追跡されていない必要があります。そうでなければ、Amira はプロジェクトへの保存をスキップし、セッションごとに 1 回警告します。Git のチェックは最初の保存時に非同期で実行し、そのセッション中は結果をキャッシュします。ユーザーファイルはすぐに保存し、プロジェクトへの書き込みは変更順に行います。無視や追跡のルールを変更した後は、新しいセッションを開始してください。Amira が無視ファイルを編集することはありません。リポジトリ外では、既存の `.amira` ディレクトリがあればプロジェクトに保存できます。なければ、ユーザーファイルだけに保存します。ホーム/ユーザースコープでも、ユーザーファイルだけに保存します。

既存のファイルは厳密な JSON である必要があります。無効なファイルは警告を出してそのまま残し、上書きしません。保存はアトミックに行い、無関係な設定、書式、キーの順序を保持します。空のオブジェクトや 1 行のオブジェクトにキーを追加する場合は、既存の改行コードを保持し、通常の 2 スペースインデントの複数行レイアウトを使います。編集後のテキストは書き込み前に検証します。意図した設定と一致しない場合、Amira はオブジェクト全体を書き直します。

`/thinking default` は、トップレベルに `"thinking": "default"` という特別な値を保存します。これは、それより前のトップレベルの設定レイヤーで指定した推論の強度を上書きし、明示的な強度を送らずにサーバーに任せます。思考を無効にするものではありません。モデルごとの `thinking` は、引き続き従来の優先順位でトップレベルの設定より優先されます。

## 高速モード

`fastMode` は真偽値で、デフォルトはオフです。対応するモデルとエンドポイントに高速/優先処理を要求し、モデルや思考の強度は変更しません。まずは `"fastMode": true` と[高速モード](usage.md#高速モード)で説明するエンドポイント/モデルのプリセットを使ってください。すべてのモデルに上書きを追加する必要はありません。

`/fast` は要求を切り替え、`/fast on` と `/fast off` は明示的に設定します。`/fast status` は、要求、適用状況、最後の実際のサービス層または Claude の速度、利用できない理由や料金不明の注意を表示します。非対応のモデル/プロバイダーでは要求を保持しますが、適用しません。対話中の変更は、上記のユーザーファイルと保存が許可されたプロジェクトローカルファイルに `fastMode` を保存します。print モード、RPC、拡張機能による変更では保存しません。モードを切り替えるとプロンプトキャッシュが無効になる場合があります。

プリセットを上書きするには `providers.<id>.models[].fast` を、プロバイダー共通のデフォルトには `defaultModel.fast` を設定します。`false` は無効化、`{ "kind": "anthropic-speed" }` は Claude の速度指定、`{ "kind": "service-tier", "value": "priority" }` はサービス層の要求です。サービス層には `textOnly`（画像を含むリクエストを除外）と `responseHeader`（指定した HTTP レスポンスヘッダーから実際の層を取得）も指定できます。カタログのモデル名と一致するだけでは、任意の互換エンドポイントで有効にはなりません。

以下は**設定済み**のプロバイダーに加える上書き設定です。自身のプロバイダー ID と実際に対応するモデル ID に置き換えてください。使用するすべてのモデルが対応する場合だけプロバイダー共通のデフォルトを使い、それ以外は個々のモデルに `fast` を設定してください。DeepInfra では対応タグのあるモデルだけで優先処理を有効にします。ゲートウェイは選択したリクエスト形式に対応している必要があります。

```json
{
  "fastMode": true,
  "providers": {
    "deepinfra": {
      "defaultModel": {
        "fast": { "kind": "service-tier", "value": "priority" }
      }
    },
    "xai": {
      "defaultModel": {
        "fast": { "kind": "service-tier", "value": "priority", "textOnly": true }
      }
    },
    "google": {
      "defaultModel": {
        "fast": { "kind": "service-tier", "value": "priority", "responseHeader": "x-gemini-service-tier" }
      }
    },
    "claude-gateway": {
      "models": [
        { "id": "supported-opus-id", "fast": { "kind": "anthropic-speed" } },
        { "id": "unsupported-model-id", "fast": false }
      ]
    }
  }
}
```

モデルの `cost.fast` は任意で、`input`、`output`、`cacheRead`、`cacheWrite` に高速層の 100 万トークン当たりの米ドル料金を指定します。設定する場合、`input` と `output` は必須です。組み込みの追加料金は、確認済みの Claude 高速料金だけです。その他は `cost.fast` を設定するまで不明として扱います。プロバイダーに確認した料金だけを入力してください。例には未確認の料金を含めていません。高速/優先処理の使用が報告されても追加料金が不明な場合、標準料金で見積もり、料金不明のフラグを付けます。`/cost` は報告された高速と標準の使用量を分け、対象金額と合計を見積もりと表示し、追加料金が不明であることを明記します。標準料金の見積もりは正確な高速料金ではありません。実際の層、正規化した速度、料金の不確実性は使用量/セッションのメタデータであり、設定キーではありません。

## ユーザーファイル専用のキー

プロジェクトファイルはクローンしたリポジトリに付属するため、リクエストや API キーの送信先を決めたり、会話を別の形式でエンドポイントに送るサーバー側圧縮を有効にしたり、読み込むパッケージや信頼するプロジェクトを決めたりすることはできません。以下のキーは、プロジェクトファイルと `settings.local.json` では警告を出して無視します。

- `providers.<id>.baseUrl`、`apiKeyEnv`、`apiKeyEnvFallbacks`、`headers`、`compat.compaction`
- `web.search.exa.url`、`web.search.exa.apiKeyEnv`、`web.search.brave.apiKeyEnv`、`web.search.tavily.apiKeyEnv`、`web.search.searxng.url`、`web.fetch.allowPrivateNetwork`
- `packages.disabled`、`packages.trustedProjects`、`packages.untrustedProjects`
- `mcpTrustedProjects`（ユーザーファイルからのみ読み取ります）

プロジェクトファイルでも、プロバイダーのモデル、メタデータ、その他の `compat` オプションを追加したり、モデルを選択したりすることはできます。

## 例

環境変数からキーを読み取るプロバイダーを追加します。最初の変数が未設定または空の場合は、2 番目の変数を試します。

```json
{
  "model": "my-provider/my-model",
  "providers": {
    "my-provider": {
      "dialect": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MY_PROVIDER_API_KEY",
      "apiKeyEnvFallbacks": ["MY_PROVIDER_KEY"],
      "models": [{ "id": "my-model" }]
    }
  }
}
```

カタログにないモデルや、カタログの値が正しくないモデルに、コンテキストウィンドウと出力上限を設定します。ユーザーファイルで定義したプロバイダーに対しては、プロジェクトファイルでも設定できます。

```json
{
  "providers": {
    "my-provider": {
      "models": [{ "id": "my-model", "contextWindow": 200000, "maxOutput": 16384 }]
    }
  }
}
```

ホスト型 Web 検索とサーバー側圧縮を転送するプロキシ経由で、これらの機能を使います（デフォルトでは、どちらもベンダー自身のエンドポイントでのみ有効です）。

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

Brave で検索し、失敗した場合は Exa、SearXNG インスタンスの順にフォールバックします。

```json
{
  "web": {
    "search": {
      "backend": "brave",
      "fallback": ["exa", "searxng"],
      "brave": { "apiKeyEnv": "BRAVE_API_KEY" },
      "searxng": { "url": "http://localhost:8080" }
    }
  }
}
```

コンテキストウィンドウの使用率が 70% に達した時点で、早めに圧縮します。

```json
{
  "compact": { "threshold": 0.7 }
}
```

キー操作はここでは設定しません。ユーザーディレクトリの `keybindings.json` で設定します。[キー割り当て](keybindings.md)を参照してください。

<!-- settings:generated:start -->
<!-- Generated by scripts/gen-settings-docs.ts; edit that or its data. -->

## 一般

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `model` | `string` | なし | デフォルトのモデルを `"provider/model"` 形式で指定します。未設定の場合、Amira は再開したセッションのモデル、またはプロバイダーが 1 つだけならその最初のモデルを使用します。`--model` と `AMIRA_MODEL` は 1 回の実行に限って上書きします。対話中の `/model` による変更は、モデルと思考設定を保存します（[モデルと思考設定の保存](#モデルと思考設定の保存)を参照）。 |  |
| `thinking` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "default"` | なし | `caps.thinking` を持つモデルで、メインの会話リクエストに使う推論の強度です。未設定または `"default"` では強度をサーバーに任せます。思考を無効にするものではありません。`"default"` は、それより前のトップレベルの設定レイヤーを上書きします。モデルごとの `thinking` は引き続きこの設定より優先され、`--thinking` は 1 回の実行に限って両方を上書きします。対話中の `/thinking` による変更はモデルと思考設定を保存し、`/thinking default` は `"default"` を保存します。サブエージェントは親が選択した強度を引き継ぎますが、タイトル生成と圧縮には引き継がれません。 |  |
| `fastMode` | `boolean` | なし | 対応するモデルとエンドポイントで高速/優先処理を要求します。未設定時は無効です。対話中の `/fast` による変更は保存され、非対応モデルでは送信せずに設定を保持します。サブエージェントも引き継ぎます。速度を変更するとプロンプトキャッシュが無効になる場合があります。追加料金が不明な場合は、標準料金による見積もりと明記します。 |  |
| `shell` | `"auto" \| "bash" \| "powershell"` | `"auto"` | Windows でモデルに提供するシェルツールです。`"auto"` は `bash` と `powershell` の両方を提供し、`"bash"` または `"powershell"` はもう一方を非表示にします。他のプラットフォームでは `bash` のみです。`--shell` が優先されます。 |  |
| `tools.disabled` | `string[]` | `[]` | モデルに表示しないツールの名前です。`--disable-tools` は 1 回の実行に限ってリストを置き換え、`/tools` は現在のセッションだけを変更します。 |  |
| `maxParallelTools` | `number` | `8` | 同時に実行できるツール呼び出しの最大数です。1 以上の整数を指定してください。無効な値には警告を表示し、優先順位の低いファイルに有効な値があってもデフォルトを使用します。 |  |
| `agent.maxSteps` | `number` | `500` | メインエージェントが 1 ターンでモデルを呼び出せる最大回数です。0 以上の整数を指定し、`0` でステップ数を無制限にします。`--max-steps <n>` は対話モードと print モードで、1 回の実行に限って上書きします。サブエージェントには引き継がれません。中断、予算の上限、コンテキストエラーでは引き続きターンが停止します。 |  |
| `backgroundJobs.maxRunning` | `number` | `8` | 同時に実行できるバックグラウンドジョブの最大数です。シェルツールが `background: true` で開始したコマンド（開発サーバーや監視プロセスなど）が対象です。 |  |
| `backgroundJobs.bufferChars` | `number` | `1000000` | 各ジョブが読み取り用にメモリに保持する出力の文字数です。最小値は 1000 です。 |  |
| `backgroundJobs.maxLogBytes` | `number` | `52428800` (50 MiB) | 各ジョブのログファイルに書き込む出力のバイト数です。 |  |
| `backgroundJobs.printWaitMs` | `number` | `30000` (30 s) | print モードで、実行中に開始したトップレベルのバックグラウンドジョブを待つ時間です。待機後、終了時にジョブを停止します。 |  |
| `commandAliases` | `Record<string, string>` | なし | スラッシュコマンドのエイリアスです。`{"ds": "model deepseek/deepseek-flash"}` を指定すると、`/ds` で `/model deepseek/deepseek-flash` が実行され、`/ds` の後に入力した内容が末尾に追加されます。値はコマンドを指定するもので、別のエイリアスは指定できません。コマンドやその組み込みエイリアスが優先されます。 |  |
| `sessions.autoTitle` | `boolean` | `true` | 最初のターンの後、バックグラウンドでモデルに短いセッションタイトルを生成させます。`compact.model` が設定されていればそのモデルを使います。`/rename` が常に優先されます。 |  |
| `updates.auto` | `boolean` | `true` | 自己管理の単一実行ファイル版をバックグラウンドで確認し、パッチ更新を次回起動用にインストールします。マイナー・メジャー更新は通知のみです。パッケージマネージャー版とソース版は自己更新しません。 | はい |
| `updates.channel` | `"stable" \| "next"` | `"stable"` | 更新確認と `amira update` のリリースチャネル。`stable` は安定版、`next` はリリース候補版です。next ビルドの既定は `next` です。`--channel` でコマンド単位で上書きできます。 | はい |
| `updates.minimumVersion` | `string` | なし | 更新またはロールバックを許可する最低バージョン（SemVer）。ロールバックは更新ロック内でこの制限を確認し、回避できません。これを下回るリリースはインストールしません。実行中のバージョンが古い場合は通知します。マイナー・メジャー更新を強制的にバックグラウンドで適用することはありません。 | はい |

## プロバイダーとモデル

Amira に組み込みのプロバイダーはありません。各エントリーには `dialect` と `baseUrl` が必要で、`baseUrl` はユーザーファイルでのみ有効です。モデルのメタデータは `models`、models.dev カタログ、`defaultModel`、組み込みのフォールバック値の順に取得し、`caps` も同じ順でキーごとにマージします。プロトコル、キーの優先順位、プロバイダーのフォームについては[プロバイダーとモデル](providers.md)を参照してください。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `providers` | `Record<string, object>` | なし | 指定した ID をキーとするプロバイダーです。モデル名は `<id>/<model>` 形式です。 |  |
| `providers.<id>.dialect` | `string` | 必須 | プロトコルです。`openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini` のいずれかを指定します。 |  |
| `providers.<id>.baseUrl` | `string` | 必須 | リクエストの送信先エンドポイントです。 | はい |
| `providers.<id>.apiKeyEnv` | `string` | なし | API キーを格納する環境変数の名前です。キーそのものではありません。環境変数にキーがなければ、`auth.json` に保存したキーを使用します。 | はい |
| `providers.<id>.apiKeyEnvFallbacks` | `string[]` | なし | `apiKeyEnv` が未設定または空の場合に、順番に試す環境変数です。 | はい |
| `providers.<id>.keySource` | `"auth" \| "env" \| "none"` | なし | `"auth"` は `auth.json` を読み、`"env"` は `apiKeyEnv` と `apiKeyEnvFallbacks` のみを使います。`"none"` は API キーの検索を無効にします。省略すると従来どおり、環境変数、次に `auth.json` の順に試します。 | はい |
| `providers.<id>.headers` | `Record<string, string>` | なし | すべてのリクエストに付ける追加の HTTP ヘッダーです。 | はい |
| `providers.<id>.compat.maxTokensField` | `"max_tokens" \| "max_completion_tokens"` | `"max_tokens"` | `openai-chat` で出力トークン数の上限を送るフィールドです。 |  |
| `providers.<id>.compat.webSearch` | `boolean` | api.openai.com、Azure OpenAI、api.anthropic.com、generativelanguage.googleapis.com でのみ有効 | `openai-responses`、`anthropic-messages`、`google-gemini` で、プロバイダーが提供するホスト型 Web 検索を有効にします。この場合、モデルに `web_search` ツールは提供されません（`web_fetch` は引き続き使えます）。Amira のツールと併用する場合、Gemini には Gemini 3 モデルが必要です。モデルの `caps.webSearch` が優先され、`web.nativeSearch: false` はすべてのモデルで無効にします。 |  |
| `providers.<id>.compat.streamUsage` | `boolean` | `true` | `openai-chat` でストリーム内のトークン使用量を要求します。 |  |
| `providers.<id>.compat.thinking` | `"adaptive" \| "budget"` | `"adaptive"` | `anthropic-messages` の `"adaptive"` は、必要に応じて推論の強度を指定できる適応型思考を使います。`"budget"` は `budget_tokens` を送信し、Claude 4.5 以前のモデルや DeepSeek などの互換サーバーに対応します。 |  |
| `providers.<id>.compat.thinkingDisplay` | `"summarized" \| "omitted"` | api.anthropic.com では `"summarized"`、それ以外では送信しません | `anthropic-messages` の adaptive モードと budget モードで、読める思考の要約（`"summarized"`）、またはテキストを含まない署名付きブロック（`"omitted"`）を要求します。思考が無効な場合は送信しません。互換サーバーやプロキシでは明示的な有効化が必要です。`models[].compat.thinkingDisplay` がこの設定を上書きします。 |  |
| `providers.<id>.compat.compaction` | `"auto" \| "on" \| "off"` | `"auto"` | `openai-responses` と `anthropic-messages` のサーバー側（ネイティブ）圧縮です。`"auto"` はベンダー自身のエンドポイントでのみ使用し、`"on"` は任意のホスト（機能を転送するプロキシなど）で使用し、`"off"` は使用しません。失敗した場合はテキスト要約にフォールバックします。 | はい |
| `providers.<id>.catalogId` | `string \| false` | プロバイダー ID（一部はマッピングされます） | models.dev カタログでのプロバイダー ID が指定した ID と異なる場合に設定します。`false` はカタログを使いません。組み込みのマッピングには `gemini` → `google`、`moonshot` → `moonshotai`、`ollama` と `lmstudio` → `false` などがあります。 |  |
| `providers.<id>.tools.edit` | `"edit" \| "apply_patch" \| "both"` | `"edit"` | このプロバイダーのモデルに提供する編集ツールです。`"edit"`、`"apply_patch"`、`"both"` のいずれかを指定します。`write` は常に提供されます。[編集ツール](providers.md#編集ツール)を参照してください。 |  |
| `providers.<id>.models` | `object[]` | なし | 手動で記述するモデルです。ここに指定したモデルはカタログより優先されます。 |  |
| `providers.<id>.models[].id` | `string` | 必須 | エンドポイントが受け付けるモデル ID です。 |  |
| `providers.<id>.models[].dialect` | `string` | プロバイダーの設定 | このモデルに別のプロトコルを指定します。 |  |
| `providers.<id>.models[].contextWindow` | `number` | カタログの値、なければ `128000` | コンテキストウィンドウのトークン数です。圧縮と `/context` で使用します。 |  |
| `providers.<id>.models[].maxOutput` | `number` | カタログの値、なければ `8192` | 1 回の返信で出力できるトークン数の上限です。 |  |
| `providers.<id>.models[].compat.thinkingDisplay` | `"summarized" \| "omitted"` | defaultModel、次にプロバイダーの設定 | このモデルの思考の表示方法です。プロバイダーの設定を上書きします。未設定の場合は defaultModel、プロバイダー、エンドポイントのデフォルトの順に使用します。 |  |
| `providers.<id>.models[].fast` | `object \| false` | エンドポイント/モデルのプリセット | 高速処理のリクエスト設定です。`false` でプリセットを無効にします。Claude の速度指定には `{ "kind": "anthropic-speed" }`、互換サービス層には `{ "kind": "service-tier", "value": "priority" }` を使います。対応するエンドポイント/モデルだけに設定してください。[高速モード](#高速モード)を参照してください。 |  |
| `providers.<id>.models[].fast.kind` | `"anthropic-speed" \| "service-tier"` | なし | `"anthropic-speed"` は Claude の `speed: "fast"` を送信し、`"service-tier"` は設定した `service_tier` の値を送信します。`fast` がオブジェクトの場合は必須です。 |  |
| `providers.<id>.models[].fast.value` | `string` | なし | 要求するサービス層で、通常は `"priority"` です。`"service-tier"` の場合のみ必須です。実際の使用量はこの値ではなく、レスポンスに基づきます。 |  |
| `providers.<id>.models[].fast.textOnly` | `boolean` | `false` | テキストのみのリクエストにサービス層を適用し、画像が含まれる場合は送信しません。xAI の優先処理で使用します。 |  |
| `providers.<id>.models[].fast.responseHeader` | `string` | なし | 実際に使用されたサービス層を報告する HTTP レスポンスヘッダーです。Google では `"x-gemini-service-tier"` を指定します。未指定時はレスポンス本文を読み取ります。 |  |
| `providers.<id>.models[].cost.input` | `number` | カタログの値 | 入力 100 万トークンあたりの料金（USD）です。`cost` を設定する場合、`input` と `output` は必須です。 |  |
| `providers.<id>.models[].cost.output` | `number` | カタログの値 | 出力 100 万トークンあたりの料金（USD）です。 |  |
| `providers.<id>.models[].cost.cacheRead` | `number` | カタログの値 | プロンプトキャッシュから読み取る 100 万トークンあたりの料金（USD）です。 |  |
| `providers.<id>.models[].cost.cacheWrite` | `number` | カタログの値 | プロンプトキャッシュに書き込む 100 万トークンあたりの料金（USD）です。 |  |
| `providers.<id>.models[].cost.webSearch` | `number` | 不明 | ホスト型 Web 検索 1 回あたりの料金（USD）です。カタログには検索料金がないため、未設定の場合、検索した返信の料金は不明と表示されます。 |  |
| `providers.<id>.models[].cost.fast.input` | `number` | カタログの値 | 高速入力 100 万トークンあたりの料金（USD）。`cost.fast` を指定する場合、`input` と `output` は必須です。報告された高速/優先処理の使用量だけに適用します。省略可能で、確認済みの追加料金がなければ標準料金で見積もり、追加料金が不明であることを表示します。 |  |
| `providers.<id>.models[].cost.fast.output` | `number` | カタログの値 | 高速出力 100 万トークンあたりの料金（USD）です。 |  |
| `providers.<id>.models[].cost.fast.cacheRead` | `number` | 入力キャッシュ倍率 | 高速キャッシュ読み取り 100 万トークンあたりの料金（USD）。未指定時は標準のキャッシュ対入力料金比率を高速入力料金に適用します。 |  |
| `providers.<id>.models[].cost.fast.cacheWrite` | `number` | 入力キャッシュ倍率 | 高速キャッシュ書き込み 100 万トークンあたりの料金（USD）。未指定時は標準のキャッシュ対入力料金比率を高速入力料金に適用します。 |  |
| `providers.<id>.models[].cost.fast.maxInputTokens` | `number` | プリセットで指定しない限り無制限 | この追加料金が適用されるプロンプトの最大トークン数です。超えた場合は追加料金を不明とし、短いコンテキスト向けの料金を正確な金額として扱わず、標準料金で見積もります。 |  |
| `providers.<id>.models[].caps.tools` | `"native" \| "none"` | `"native"` | ツールを呼び出せないモデルには `"none"` を指定します。 |  |
| `providers.<id>.models[].caps.images` | `boolean` | `false` | モデルが画像入力を受け付けることを示します。 |  |
| `providers.<id>.models[].caps.thinking` | `boolean` | `false` | モデルが推論できることを示します。`anthropic-messages` は、この設定が有効な場合にのみ思考を要求します。 |  |
| `providers.<id>.models[].caps.promptCache` | `boolean` | `false` | エンドポイントがプロンプトキャッシュに対応することを示します。 |  |
| `providers.<id>.models[].caps.parallelToolCalls` | `boolean` | `true` | モデルが 1 回の返信で複数のツールを呼び出せることを示します。 |  |
| `providers.<id>.models[].caps.webSearch` | `boolean` | `compat.webSearch` の値 | このモデルにプロバイダーのホスト型 Web 検索を提供します。 |  |
| `providers.<id>.models[].thinking` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | トップレベルの `thinking` | このモデル ID に使う推論の強度です。ただし、`--thinking` による上書きや、親エージェントから引き継いだ強度が優先されます。 |  |
| `providers.<id>.models[].tools.edit` | `"edit" \| "apply_patch" \| "both"` | プロバイダーの `tools.edit` | このモデルだけに適用する編集ツールの設定です。 |  |
| `providers.<id>.defaultModel` | `object` | なし | `models` にもカタログにも記述されていないモデルに使う値です。`models[]` のキーのうち、`id`、`tools`、`thinking` を除くものを指定できます。 |  |

## 権限

モデルが確認なしで実行できる操作を設定します。[権限](usage.md#権限)を参照してください。プロジェクトファイルでは制限を厳しくすることだけができます。`mode` はユーザー設定より厳しい場合に有効となり、`ask` と `deny` のルールは常に適用されます。`allow` のルールはプロジェクトが信頼された後（`amira ext trust`）にのみ適用されます。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `permissions.mode` | `"plan" \| "edits" \| "auto"` | `"auto"` | `"auto"` は、ルールや保護されたパスによる制限を除き、確認なしで実行します。`"edits"` はファイルを確認なしで変更し、シェルコマンドの実行前に確認します。`"plan"` は読み取り専用です。UI では Shift+Tab で切り替えます。`--permission-mode` が優先されます。 |  |
| `permissions.rules` | `object[]` | `[]` | シェルコマンドに適用するルールです。各コマンドの単語と照合します。複数のルールに一致する場合、`deny` が `ask` より、`ask` が `allow` より優先されます。`allow` は「確認しない」という意味にすぎず、モードや保護されたパスの制限を解除しません。 |  |
| `permissions.rules[].command` | `string[]` | 必須 | コマンドの先頭の単語です。例：`["git", "push"]`。`allow` ルールはコマンドの先頭と完全に一致する必要があります。`ask` と `deny` は、間に他の単語があっても一致し、大文字と小文字を区別しません。 |  |
| `permissions.rules[].decision` | `"allow" \| "ask" \| "deny"` | 必須 | `"allow"` は確認せずに実行し、`"ask"` は先に確認し、`"deny"` は実行しません。 |  |
| `permissions.rules[].reason` | `string` | なし | 確認や拒否のメッセージとともに表示する理由です。 |  |

## 圧縮と再試行

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `compact.threshold` | `number` | `0.8` | 自動圧縮を開始するコンテキストウィンドウの使用率です。 |  |
| `compact.model` | `string` | セッションのモデル | テキスト要約を生成するモデルを `"provider/model"` 形式で指定します。設定すると圧縮は常にテキスト要約となり、サーバー側圧縮は使いません。 |  |
| `compact.layout` | `"tail" \| "recent-user"` | `"tail"` | サーバー側チェックポイントの配置です。`"tail"` は最近のターンをそのままチェックポイントの後に残します。`"recent-user"` はすべてを圧縮し、Codex と同様に、最近のユーザーメッセージ（最大約 64k トークン）をチェックポイントの前に配置します。テキスト要約は常に `"tail"` を使います。 |  |
| `retry.attempts` | `number` | `3` | モデルリクエストが失敗したとき、初回の試行後に再試行する回数です。`0` で再試行を無効にします。ストリームの内容をまだ受け取っていない場合にのみ再送するため、プロバイダーのエラーと最初のコンテンツのタイムアウトが対象です。 |  |
| `retry.baseDelayMs` | `number` | `1000` | 最初の再試行までの待機時間です。以後は毎回 2 倍になります。サーバーの `Retry-After` がある場合はそちらを使います。 |  |
| `retry.maxDelayMs` | `number` | `60000` | 必要な待機時間がこの値を超える場合、待機せずにエラーを報告します。 |  |
| `retry.firstContentTimeoutMs` | `number` | `150000` (150 s) | 最初のストリームのコンテンツイベント（テキスト、推論ブロックの開始や差分、ツール呼び出し、ホスト型検索）を待つ最大時間（ミリ秒）です。超過すると再試行します。`0` でこのタイムアウトを無効にします。接続維持用のコメントはコンテンツに数えません。 |  |
| `retry.idleTimeoutMs` | `number` | `100000` (100 s) | 最初のイベント以降、ストリームのコンテンツイベント間で許容する最大の無応答時間（ミリ秒）です。超過すると、受信済みのテキストを保持してタイムアウトエラーで返信を終了します。表示済みの内容を繰り返さないよう再送しません（推論が始まっただけで、まだ何も表示していない返信は再試行します）。続けるにはメッセージを入力するか、↑ を押して再送してください。通常の print モードでは stderr にエラーを報告し、非ゼロの終了コードで終了します。ホスト型 Web 検索の実行中は、上限は少なくとも 10 分になります。`0` でこのタイムアウトを無効にします。接続維持用のコメントではタイマーをリセットしません。 |  |
| `retry.nativeCompactionTimeoutMs` | `number` | `300000`（5 分） | サーバー側圧縮の全体の制限時間（ミリ秒）です。すべての試行と再試行の待機時間を含みます。タイムアウトするとネイティブリクエストを中止し、代わりにテキスト要約を生成して通知します。`0` でこのタイムアウトを無効にします。Esc では引き続き、要約を生成せずに圧縮をキャンセルできます。 |  |

## リモートランタイム

ローカルクライアントではなく、リモートホストの設定から読み取ります。プロバイダーへのリクエストのタイムアウトとは別の設定です。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `remote.idleTimeoutMs` | `number` | `1800000`（30 分） | コントローラーも処理もない状態がこのミリ秒数続くとデーモンを終了します。ターン、ツール、ジョブ、モニター、実行可能な子エージェント、モデル呼び出し、未回答の承認・フォーム、待機中の処理がある間は終了しません。0〜2147483647 の整数。0 は自動終了を無効にします。未回答の承認は取り消しません。 |  |
| `remote.proxyReconnectTimeoutMs` | `number` | `600000`（10 分） | 認可されたローカルモデルプロキシの再接続を待つミリ秒数。期限を過ぎるとモデル呼び出しは失敗します。0〜2147483647 の整数。0 は無期限に待機します。プロバイダーのタイムアウトは、ローカルプロキシが実行を受け付けてから開始します。 |  |

## コンテキスト管理

モデルリクエストに履歴のどの部分を含めるかを設定します。セッションファイルには常にすべてを保持します。[コンテキスト管理](usage.md#コンテキスト管理)を参照してください。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `context.outputs.saveAbove` | `number` | `16000` | この文字数を超えるツール出力はアーティファクトとして全体を保存し、モデルにはプレビューを渡します。中国語、日本語、韓国語の 1 文字は 4 文字として数えます。最小値は 4000 です。 |  |
| `context.outputs.previewChars` | `number` | `8000` | 代わりにモデルに渡すプレビューの文字数です。最小値は 500 で、`saveAbove` を超えることはできません。 |  |
| `context.outputs.quotaMB` | `number` | `256` | 1 セッションで保持するアーティファクトの最大サイズ（MB）です。超えると出力はプレビューのみになります。`/prune` で空き容量を確保できます。 |  |
| `context.dedupeReads` | `boolean` | `true` | `read` の結果が、コンテキストに残っている同じ範囲の最新の読み取り結果と完全に一致する場合、その結果を参照する短い説明だけを送ります。 |  |
| `context.aging.enabled` | `boolean` | `true` | コンテキストがいっぱいになると、圧縮の前に古いツール結果を短いプレースホルダーに置き換えます。プロバイダーが履歴の書き換えを許可する場合（結果の後に署名付き推論がない場合）に限ります。 |  |
| `context.aging.start` | `number` | `0.7` | 次のリクエストがコンテキストウィンドウのこの割合を超えると予測されたとき、古い結果の整理を開始します。 |  |
| `context.aging.target` | `number` | `0.6` | 1 回の整理でコンテキストの使用量をこの割合まで減らします。 |  |
| `context.aging.minSavedTokens` | `number` | `8000` | 解放できるトークン数がこの値より少ない整理はスキップし、プロンプトキャッシュのプレフィックスを保ちます。小さいウィンドウでは、最大でも `start` と `target` の間の容量になります。 |  |
| `context.aging.keepTurns` | `number` | `2` | 結果を整理の対象から除外する、直近のユーザーターン数です。 |  |
| `context.aging.keepSteps` | `number` | `2` | 現在のターンが長い場合に、結果を整理の対象から除外する直近のモデルステップ数です。 |  |
| `context.aging.afterTurns` | `number` | `0` | 実験的な設定です。コンテキストの使用量に関係なく、このユーザーターン数より古い結果も整理します。`0` で無効になります。 |  |

## ファイルの巻き戻し

巻き戻しで復元できるよう、ファイルツールが変更したバイト列を保持します。[セッション](usage.md)を参照してください。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `fileRewind.enabled` | `boolean` | `true` | 巻き戻しで復元できるよう、`write`、`edit`、`apply_patch` の変更を記録します。無効の場合、巻き戻しの選択画面にはファイルを復元しないことが表示されます。 |  |
| `fileRewind.maxFileBytes` | `number` | `10485760` | 変更前または変更後に記録できるファイルの最大サイズです。記録が有効な間は、これを超える書き込みを拒否します。 |  |
| `fileRewind.quotaBytes` | `number` | `268435456` | 1 セッションで保持する、重複を除いたファイルイメージの最大バイト数です。超えると、`/rewind-prune` を実行するまで書き込みを拒否します。 |  |

## Web ツール

`web_search` と `web_fetch` ツールの設定です。どちらのツールも `tools.disabled` で非表示にできます。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `web.nativeSearch` | `boolean` | `true` | `false` の場合、プロバイダーのホスト型 Web 検索（`compat.webSearch`）を使わず、すべてのモデルに `web_search` ツールを提供します。 |  |
| `web.search.backend` | `"exa" \| "brave" \| "tavily" \| "searxng"` | `"exa"` | 検索バックエンドです。Exa のホスト型 MCP サーバーにはキーが不要です。 |  |
| `web.search.fallback` | `("exa" \| "brave" \| "tavily" \| "searxng")[]` | なし | 前のバックエンドが失敗した場合に、順番に試すバックエンドです。 |  |
| `web.search.maxResults` | `number` | `8` | 呼び出しで件数を指定しない場合に返す結果数です。1 回の呼び出しで最大 20 件を返します。 |  |
| `web.search.timeoutMs` | `number` | `20000` | バックエンドごとのリクエストのタイムアウト（ミリ秒）です。 |  |
| `web.search.exa.url` | `string` | `https://mcp.exa.ai/mcp` | Exa MCP のエンドポイントです。 | はい |
| `web.search.exa.apiKeyEnv` | `string` | なし | Exa のキーを格納する環境変数です。キーがあると無料枠のレート制限を引き上げられます。 | はい |
| `web.search.brave.apiKeyEnv` | `string` | `BRAVE_API_KEY` | Brave Search のキーを格納する環境変数です。 | はい |
| `web.search.tavily.apiKeyEnv` | `string` | `TAVILY_API_KEY` | Tavily のキーを格納する環境変数です。 | はい |
| `web.search.tavily.searchDepth` | `"basic" \| "advanced"` | `"basic"` | Tavily の検索の深さです。`"basic"` または `"advanced"` を指定します。 |  |
| `web.search.searxng.url` | `string` | このバックエンドでは必須 | JSON 形式が有効な SearXNG インスタンスです。 | はい |
| `web.fetch.maxChars` | `number` | `20000` | 呼び出しで指定しない場合に、1 回で返す変換後テキストの文字数です。 |  |
| `web.fetch.maxBytes` | `number` | `5242880` (5 MiB) | 読み取るテキストレスポンス本文の最大バイト数です。超過した部分は切り捨てます。 |  |
| `web.fetch.maxBinaryBytes` | `number` | `52428800` (50 MiB) | セッションの出力ディレクトリに保存する PDF またはバイナリの最大サイズです。超過した場合は失敗し、未完成のファイルを削除します。セッションディレクトリのないホストでは保存できません。テキストのアーティファクトではないため、他のツールで読み取ってください。アーティファクトの容量制限と `/prune` の対象外です。 |  |
| `web.fetch.timeoutMs` | `number` | `30000` | リクエストのタイムアウト（ミリ秒）です。 |  |
| `web.fetch.allowPrivateNetwork` | `boolean` | `false` | localhost とプライベートネットワークのアドレスへのアクセスを許可します。 | はい |

## 端末 UI

[キー割り当て](keybindings.md#端末の設定)に詳しい説明があります。キー自体の変更はここではなく、`keybindings.json` で行います。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `tui.mode` | `"fullscreen" \| "inline"` | `"fullscreen"` | 非推奨で無視されます。対話型 TUI は常に全画面で動作し、終了時に会話を通常画面へ出力します。移行期間の 1 リリースでは `"inline"` と `--inline` を受け付け、"inline mode was removed; running fullscreen. Use -p for plain output." と通知します。`--fullscreen` は受け付けますが、何も変更しません。 |  |
| `tui.margin` | `number` | `3` | 左右の余白幅をセル数（整数 0–12）で指定します。狭い端末では、可能な限りコンテンツの幅を 60 列以上確保するために余白を縮めます。この値と `tui.marginRows` を `0` にすると、端まで使うレイアウトになります。 |  |
| `tui.marginRows` | `number` | `1` | ヘッダーの上とキー操作のヒント行の下に設ける空行数（整数 0–2）です。24 行未満の端末では空行を省きます。 |  |
| `tui.theme` | `string` | `"auto"` | テーマ名、または端末の背景に合わせる `"auto"` を指定します（判別できない場合はダーク）。`"dark"` と `"light"` は Amira の配色を明示的に選び、`"terminal"` は端末自身の ANSI カラーを使います。`/theme` で名前付きテーマをプレビューし、保存できます。 |  |
| `tui.themeVariant` | `"auto" \| "dark" \| "light"` | `"auto"` | 名前付きテーマでは、`"auto"` は端末の背景に合わせます。`"dark"` または `"light"` は指定したバリアントを強制します。そのバリアントがなければ、Amira のデフォルトパレットを使います。 |  |
| `tui.shimmer` | `ShimmerEffect` | テーマのエフェクト、なければ `"soft"` | アクティビティラベルのアニメーションです。`off`、`soft`、`sharp`、`wide`、`bounce`、`pulse`、`wave`、`reveal` を指定できます。オブジェクトでは指定したパラメーターだけを上書きします。範囲や色については[シマーアニメーション](themes.md#シマーアニメーション)を参照してください。 |  |
| `tui.colorDepth` | `"auto" \| "truecolor" \| "256" \| "16"` | `"auto"` | 色深度です。`"auto"` は端末の対応状況を検出し、`"truecolor"`、`"256"`、`"16"` はそれを上書きします。`"256"` と `"16"` を含め、値はすべて文字列です。 |  |
| `tui.bell` | `boolean` | `true` | 端末にフォーカスがないとき、ターンの終了時やダイアログが入力を必要とするときに、待機 1 回につき 1 度だけベルを鳴らします。フォーカスが不明な場合、ターン終了では鳴らさず、権限や質問のダイアログだけで通知します。`false` で BEL を無効にします。デスクトップ通知は `tui.notify` で別に設定します。 |  |
| `tui.notify` | `"auto" \| "off"` | `"auto"` | `"auto"` は `tui.bell` と同じフォーカスのルールで、待機 1 回につき 1 度デスクトップ通知を送ります。iTerm2/Ghostty では OSC 9、WezTerm では OSC 777、kitty では OSC 99 を使います。Windows Terminal では BEL/タスクバー通知のみを使い、デスクトップ通知の OSC は送りません。不明な端末、dumb 端末、tmux/screen には通知の OSC を送りません。端末や OS の通知設定も引き続き適用されます。`"off"` はベルを変更せずにデスクトップ通知を無効にします。 |  |
| `tui.title` | `boolean` | `true` | タイトルを `Amira · session title` に設定し、タイトルがなければ cwd の名前を使います。Markdown の記号は除去します。`●` は実行中を示します。`✓` は端末から離れている間にターンが完了したことを示し、端末にフォーカスが戻ると消えます。`◆` はダイアログが回答や確認を待っていることを示し、フォーカスがあっても残り、`✓` より優先されます。記号がなければアイドルまたは確認済みです。待機状態の切り替えと最終状態は即座に更新し、それ以外の実行中タイトルの更新は最大で 1 秒に 1 回です。 |  |
| `tui.progress` | `boolean` | `true` | タブとタスクバーの進捗インジケーター（OSC 9;4）に作業状況を表示します。 |  |
| `tui.tokenSpeed` | `boolean` | `true` | ステータスバーの右側にリアルタイムのトークン速度を表示します。`~N tok/s` は表示される返信テキストとツール引数から推定し、`thinking Ns` は思考時間を示します。リクエスト後に使用量が報告されると、推定値を正確な出力速度に置き換えます。待機中は直前の速度を保持し、表示幅が足りないときは最初にこの項目を非表示にします。`false` で非表示にできます。 |  |
| `tui.clock` | `"auto" \| "12h" \| "24h"` | `"auto"` | タイムスタンプの時間表記です。`"auto"` はシステムのロケールに従い、`"12h"` は 12 時間表記（`8:19 PM`）、`"24h"` は 24 時間表記（`20:19`）に固定します（英語の UI に合わせた表記）。 |  |
| `tui.reflow` | `"auto" \| "on" \| "off"` | `"auto"` | 非推奨で無視されます。全画面モードは現在の端末の幅で会話を描画し直します。 |  |
| `tui.submitWhileWorking` | `"steer" \| "queue"` | `"steer"` | ターンの実行中に Enter を押したときの動作です。`"steer"` は実行中のターンにメッセージを送り、`"queue"` はターンの終了後に送ります。キュー用のキーはもう一方の動作を行います。 |  |
| `tui.images` | `"auto" \| "on" \| "off"` | `"auto"` | `images` 拡張機能で返信内の画像を表示します。`"auto"` は端末が対応する場合、`"on"` は常に表示し、`"off"` は表示しません。 |  |
| `tui.shellOutputLines` | `number` | `3` | 成功したシェルコマンドの下に表示する、出力の末尾の行数です。`0` では表示しません。 |  |

## サブエージェント

役割、エージェントツリー、worktree のマージについては[サブエージェント](subagents.md)を参照してください。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `agents` | `Record<string, object>` | なし | 役割名をキーとする、サブエージェントの役割ごとの設定です。 |  |
| `agents.<role>.model` | `string` | 役割ファイルの設定、なければ親のモデル | 役割が使用するモデルを `"provider/model"` 形式で指定します。タスクで指定したモデルが優先されます。 |  |
| `subagents.maxDepth` | `number` | `2` | サブエージェントの最大のネスト深度です。 |  |
| `subagents.maxConcurrent` | `number` | `4` | エージェントツリー全体で同時に実行できるサブエージェントの数です。残りは順番を待ちます。1 以上の整数を指定してください。無効な値には警告を表示し、優先順位の低いファイルに有効な値があってもデフォルトを使用します。 |  |
| `subagents.background` | `boolean` | `true` | 呼び出しで指定しない限り、メインセッションの `agent` ツールはサブエージェントをバックグラウンドで実行します。結果はメッセージとして返ります。 |  |
| `budget.tokens` | `number` | 無制限 | エージェントツリー全体で使えるトークン数です。入力、出力、キャッシュの読み取りと書き込みを含みます。 |  |
| `budget.costUsd` | `number` | 無制限 | 料金がわかるものについて、エージェントツリー全体で使える金額（USD）です。 |  |
| `merge.reviewThreshold.lines` | `number` | なし | 競合のない worktree のマージでも、変更行数がこの値を超える場合はレビューします。しきい値がなければ、競合のあるマージのみをレビューします。 |  |
| `merge.reviewThreshold.files` | `number` | なし | 同様のしきい値を、変更したファイル数で指定します。 |  |

## MCP サーバー

MCP 拡張機能は、作業ディレクトリの `.mcp.json`、ユーザーファイル、プロジェクトファイル、`settings.local.json` の順に `mcpServers` を読み取ります。同名のエントリーは後のものが前のものを置き換えます。文字列には `${VAR}` と `${VAR:-default}` を使えます。プロジェクトファイル（`.mcp.json` を含む）のサーバーは、プロジェクトディレクトリまたはその親が `mcpTrustedProjects` に含まれる場合にのみ信頼されます。それ以外では、stdio サーバーは起動せず、HTTP サーバーには環境変数を渡さず、ユーザーファイルが定義するサーバーを置き換えることもできません。`/reload` はこれらのファイルを再読み込みし、追加したサーバーを起動し、削除したサーバーを停止し、変更したサーバーを再起動します。それ以外のサーバーは接続を維持します。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `mcpServers` | `Record<string, Record<string, unknown>>` | なし | 名前をキーとする MCP サーバーです。 |  |
| `mcpServers.<name>.type` | `"stdio" \| "http"` | `url` があれば `"http"`、なければ `"stdio"` | 通信方式です。`"streamable-http"` と `"streamableHttp"` は `"http"` を意味します。従来の `"sse"` は非対応です。 |  |
| `mcpServers.<name>.command` | `string` | stdio では必須 | 起動するプログラムです。 |  |
| `mcpServers.<name>.args` | `string[]` | `[]` | プログラムに渡す引数です。 |  |
| `mcpServers.<name>.env` | `Record<string, string>` | なし | プログラムに渡す環境変数です。 |  |
| `mcpServers.<name>.cwd` | `string` | なし | プログラムの作業ディレクトリです。 |  |
| `mcpServers.<name>.url` | `string` | http では必須 | サーバーの streamable HTTP エンドポイントです。 |  |
| `mcpServers.<name>.headers` | `Record<string, string>` | なし | サーバーに送る HTTP ヘッダーです。 |  |
| `mcpServers.<name>.timeout` | `number` | なし | ツール呼び出しに許容する時間（ミリ秒）です。 |  |
| `mcpServers.<name>.disabled` | `boolean` | `false` | `true` はサーバーを無効にします。前のファイルにある同名のエントリーも無効になります。 |  |
| `mcpTrustedProjects` | `string[]` | `[]` | そのプロジェクトの MCP サーバーの実行を許可するプロジェクトディレクトリです。サブディレクトリも含みます。 | はい |

## 拡張機能、パッケージ、スキル

`amira ext` と `/ext` は `packages` のリストを管理します。[拡張機能](extensions.md)を参照してください。

| キー | 型 | デフォルト | 説明 | ユーザーファイルのみ |
| --- | --- | --- | --- | --- |
| `extensions` | `Record<string, Record<string, unknown>>` | なし | 拡張機能名をキーとする、インストール済み拡張機能の設定です。例：`{"workflow": {"enabled": "always"}}`。各拡張機能が自身のセクションを説明し、検証します。 |  |
| `packages.disabled` | `string[]` | `[]` | ユーザーとプロジェクトのどちらのスコープでも読み込まないパッケージです。ロックファイルには残ります。`amira ext disable` と `enable` で設定します。 | はい |
| `packages.trustedProjects` | `string[]` | `[]` | そのプロジェクトのパッケージ（`.amira/packages`）の読み込みを許可するプロジェクトディレクトリです。 | はい |
| `packages.untrustedProjects` | `string[]` | `[]` | そのプロジェクトのパッケージを読み込まないことを選択したプロジェクトディレクトリです。 | はい |
| `skills.dirs` | `string[]` | なし | 追加のスキルディレクトリです。`.amira/skills` と `~/.amira/skills` の後、`.agents/skills` と `.claude/skills` の前に検索します。`~` はホームディレクトリを指し、相対パスは作業ディレクトリを基準にします。 |  |

<!-- settings:generated:end -->

## シマーの設定

`settings.json` で、プリセットを使う（`"shimmer": "pulse"`）、アニメーションを無効にする（`"shimmer": "off"`）、テーマの個々のパラメーターを上書きすることができます。

```json
{
  "tui": {
    "shimmer": { "preset": "bounce", "width": 8, "period": 2400 }
  }
}
```

`"shimmer": { "width": 4 }` は、テーマのスタイル、周期、色を保持します。任意の色設定には、共通の色のペア（`"colors": ["#78dbe2", "#6fb3e8"]`）か、`dark`/`light` 別の色のペアを指定できます。無効なフィールドは個別にフォールバックし、数値は許容範囲に収めます。無効なブロックごとに 1 回通知します。すべてのパラメーターとマージのルールについては[シマーアニメーション](themes.md#シマーアニメーション)を参照してください。`/theme` の選択画面で変更をプレビューし、保存できます。`theme` を選ぶとユーザーの上書き設定を削除します。`soft` を含む名前付きプリセットは保存します。ただし、`soft` が現在のテーマの通常の soft エフェクトとすでに一致する場合は保存しません。`/reload` は 3 つのテーマ設定をすべて即座に適用します。

既知の制限：シマーで `theme` を選んでも、追跡されているプロジェクトファイル（`.amira/settings.json`）の上書き設定は削除できません。そのため、`/reload` や再起動後には、その上書き設定が再び適用されます。

関連ドキュメント：[はじめに](getting-started.md) · [プロバイダー](providers.md) · [使い方](usage.md) · [サブエージェント](subagents.md) · [拡張機能](extensions.md) · [キー割り当て](keybindings.md)。
