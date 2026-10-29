# フロントエンドプロトコル

[English](../protocol.md) · [简体中文](../zh/protocol.md) · [ドキュメント](../../README.ja.md)

このページは、Amira のワークスペース daemon 向けに独自のフロントエンド（デスクトップ GUI など）を作る人のためのものです。[リモートワークスペース](remote-workspaces.md)の全画面端末 UI も同じプロトコルを使います。ここではプロトコルバージョン **1** を説明します。

機械可読な契約は JSON Schema [protocol/frontend-v1.schema.json](../protocol/frontend-v1.schema.json)（draft 2020-12）です。これは `scripts/gen-protocol-schema.ts` が Amira の実行時バリデーターから生成するため、daemon が実際に受け付けて送る内容とずれることはありません。送るフレームは `$defs/ClientFrame` で、受け取るフレームは `$defs/ServerFrame` で検証します。

## 公開範囲

安定して文書化されているのは、フロントエンドが使う **control チャネル**です。ハンドシェイク、以下の操作のリクエストとレスポンス、キャンセル、イベントとスナップショット、UI リクエストとフォーム、ハートビート、チャンク分割が含まれます。schema ファイルの内容はすべて[バージョンと互換性](#バージョンと互換性)のルールの対象です。

次の部分は**内部実装**です。同じ接続上に存在しますが、ここでは説明せず、schema にも含まれず、プロトコルバージョンを変えずにどのリリースでも変わる可能性があります。サードパーティのクライアントは使ってはいけません。

- `model` チャネル（`model.open`、`model.stream`、`model.compact`、および `model.event` と `model.frame` フレーム）と、`proxy.describe` / `proxy.bind` 操作。これらは端末クライアントのローカルなプロバイダーキーを通じてモデル呼び出しを中継します。
- `files` チャネル：`files.*`、`images.*`、`artifacts.*`、`uploads.*`。
- daemon のプライベートソケット、そのプレリュード、検出用ファイル。クライアントは代わりに `amira-server attach` を通じて接続します（[接続](#接続)を参照）。

## 現在の制限

クライアントを計画する前に読んでください。これはワイヤーフォーマットではなく、現在の daemon の性質です。

- **daemon は Linux でのみ動きます。**`amira remote add` がインストールするサーバー（glibc Linux、x64 または ARM64）がそれです。Windows と macOS にはローカルの daemon がありません。端末 UI は自分のプロセス内でエージェントを動かすため、これらの OS の GUI は SSH 経由で Linux のワークスペースにしか接続できません。
- **ワークスペースごとにコントローラーは 1 つです。**daemon が同時に受け入れる接続中フロントエンドは 1 つだけです。あるクライアントがコントローラーを保持している間（および切断後最大 30 秒間）、他のクライアントは `controller_busy` で拒否されます。GUI と端末 UI を同じワークスペースに同時に接続することはできず、読み取り専用のビューアーもありません。
- **モデルの経路。**デフォルトの local-proxy モードで起動した daemon（`welcome.capabilities` に `model.proxy`）は、端末クライアントが内部の model チャネルでモデル呼び出しを処理するのを待ちます。サードパーティのクライアントにはそれができず、ターンは最大 `remote.proxyReconnectTimeoutMs` 待ったあと失敗します。リモートの認証情報を使う daemon（`model.remote-key`）、つまり `amira-server attach --remote-key` で起動した daemon に接続してください。
- **変更記録の上限。**daemon は再試行で一度だけ実行するために変更操作を記録します（[リクエストとレスポンス](#リクエストとレスポンス)を参照）。daemon の稼働期間中、全クライアント合計で受け入れる変更 id は最大 4,096 個、同時に保持する変更操作（実行中、または直近 10 分以内に完了したもの）は最大 128 個です。どちらかを超えると、新しい変更操作は `limit_exceeded` で失敗します。daemon を再起動する（新しい `daemonEpoch`）とリセットされます。また、1 つの接続でリクエスト id を 65,536 個使うと、daemon はその接続を `limit_exceeded` で閉じます。

## 接続

クライアントが daemon のソケットを自分で開くことはありません。中継コマンドを起動し、その stdin と stdout でプロトコルをやり取りします。

```sh
# On the Linux host itself
"$HOME/.amira/remote/bin/amira-server" attach --remote-key
# From another computer
ssh -T devbox '"$HOME/.amira/remote/bin/amira-server" attach --remote-key'
```

`amira remote add` はランチャーを `$HOME/.amira/remote/bin/amira-server` にインストールします。中継は次のように動きます。

1. 最初の行を 5 秒以内に読みます。これは `hello` フレームでなければなりません。
2. `hello.workspace`（ホスト上に存在する絶対パス）を正規のパスに解決します。そのパスは `welcome.workspace` で返されます。
3. ワークスペースを所有する daemon を探すか、起動します。`--remote-key` は中継が新しい daemon を起動するときだけ有効で、動作中の daemon は起動時のモデルモードのままです。
4. バイトを中継する前に daemon を確認します。`/tmp/amira-<uid>-workspaces/` の検出用ファイルと `$XDG_RUNTIME_DIR/amira/`（または `/tmp` の代替場所）のソケットはユーザー専用でなければならず（ディレクトリ `0700`、ファイル `0600`、ユーザー所有、シンボリックリンクなし）、接続したソケットの相手は記録された daemon プロセス（同じユーザー ID、PID、プロセス開始時刻）でなければなりません。
5. どちらかが閉じるまで双方向にバイトをコピーします。中継を閉じると切断になるだけで、daemon やその作業が止まることはありません。

中継の stdout にはプロトコルフレームしか流れません。接続できない場合は `reject` フレームを 1 つ書いて終了します。詳細はプライベートなログにだけ残り、stdout には出ません。

ホスト上のその他のコマンド：

- `amira-server list` は `{"v":1,"workspaces":[...]}` を 1 行で出力します。ユーザーが所有する動作中の各 daemon について、ワークスペースのパス、`protocol`、サーバーの `release`、`daemonEpoch` を示します。
- `amira-server stop --cwd <workspace>` は daemon とそのすべての作業を停止します。切断ではありません。

ワークスペース内の保存済み会話は、接続後に `sessions.list` 操作で一覧できます。

## フレーム形式

- 各フレームは UTF-8 でエンコードした 1 つの JSON オブジェクトで、後に `\n` が続きます（直前の `\r` は許容されます）。バイトオーダーマークや他の区切りはありません。
- 改行の前の 1 行は最大 `lineBytes` = 262,144 バイトです。それより大きいフレーム（画像付きのプロンプトや大きなスナップショットなど）は `chunk` フレームで送ります。フレームをシリアライズし、バイト列を 131,072 バイトずつに分け、各部分を base64 にして順番に送ります。どの部分にも同じ新しい `transferId`、その `index`、部分の総数 `total`、全体のバイト長 `bytes`、全体のバイト列の 16 進 SHA-256 を付けます。受信側は再構成してハッシュを確認し、内側のフレームを処理します。チャンクの中にチャンクを入れることはできません。
- 論理的な制限：1 フレームは最大 `logicalBytes` = 67,108,864 バイト、JSON の入れ子は最大 64 段、JSON 値は最大 1,000,000 個、数値は有限でなければなりません。同時に進行できるチャンク転送は 4 つまで、保留中のリクエストは各方向 128 個までです。
- クライアントのフレームは**厳密に**検証されます。未知のフィールド、必須フィールドの欠落、型の誤り、schema の範囲外の値があると接続が閉じられます。ハンドシェイク後、サーバーは先にエラーを送らず、単に接続を閉じます。schema にないフィールドは決して送らないでください。

## ハンドシェイク

クライアントは最初に `hello` を送り、`welcome`（または `reject`）を受け取るまで他に何も送ってはいけません。

| `hello` のフィールド | 意味 |
| --- | --- |
| `v` | 常に `1`。 |
| `clientId` | この接続の識別子。`[A-Za-z0-9_.:-]` の 1〜128 文字。接続ごとにランダムな値を選び、再開時には同じ値を使います。 |
| `workspace` | ホスト上のワークスペースの絶対パス。 |
| `release` | クライアント自身の `version`、`buildId`、`target`。サーバーは解釈しません。クライアントの識別に使えます（例：`"buildId": "my-gui"`）。 |
| `limits` | 正確に `{ "lineBytes": 262144, "logicalBytes": 67108864 }`。 |
| `capabilities` | 理解できるオプションの動作（下記参照）。未知の文字列は無視されます。 |
| `resume` | 任意。再接続のため、以前の `welcome` の `daemonEpoch`、`after`（最後に適用したイベントの `seq`）、`controllerToken`。 |
| `snapshot` | 任意。`true` にすると、再開時でも `reset` スナップショットを要求します。 |

`welcome` は、サーバーの `release`、正規の `workspace` とその `workspaceId`、`daemonEpoch`、`controllerGeneration`、`sessionGeneration`、再接続用の `controllerToken`（秘密にしてください）、同じ `limits`、サーバーの `capabilities` を返します。

| ケイパビリティ | 意味 |
| --- | --- |
| `frontend.v1` | このページの control チャネル操作。 |
| `replay`、`controller`、`mutation.ledger` | 再開時のイベント再送、コントローラーのリース、再試行されたリクエストの重複排除。 |
| `jobs`、`conversations` | `jobs.*` と `conversations.*` 操作。 |
| `files`、`images` | 内部の files チャネル。 |
| `model.remote-key` / `model.proxy` | daemon がどこでモデル呼び出しを行うか（[現在の制限](#現在の制限)を参照）。 |
| `context-window-source.provider` | クライアントのケイパビリティでもあります。[バージョンと互換性](#バージョンと互換性)を参照。 |

バージョンのネゴシエーションはありません。`v` が異なる `hello` は `reject` のコード `incompatible_protocol` で拒否され、別のプロトコルバージョンで動作中の daemon に接続した場合も同様です。クライアントは `welcome.v` が `1` であることを確認し、そうでなければ接続を閉じなければなりません。

`reject` のコード：`controller_busy`、`incompatible_protocol`、`invalid_frame`、`invalid_workspace`、`permission_denied`（再接続用の認証情報の期限切れなど）、`startup_failed`、`limit_exceeded`、`disconnected`、`unsupported_operation`、`operation_failed`。`reject` の後、接続は閉じられます。

## リクエストとレスポンス

`request` は `channel`（`"control"`）、クライアントが選ぶ `id`、`op`、`params`、そしてリクエストの対象となる `daemonEpoch`、`controllerGeneration`、`sessionGeneration` を持ちます。`welcome` の値を使い、セッションが変わったら各スナップショットから新しい `sessionGeneration`（`frontend.sessionGeneration`）を取ります。`daemonEpoch` は必ず送ってください。これがない、または別の epoch のリクエストは `outcome_unknown` で失敗します。リクエスト id は `[A-Za-z0-9_.:-]` の 1〜128 文字で、同じ接続で繰り返してはいけません。さらに変更操作の id は、再接続をまたいで `daemonEpoch` 全体を通して `clientId` ごとに一意でなければなりません。daemon はすべての接続の変更操作を `clientId`、`daemonEpoch`、`id` をキーに記録し、id を解放しません。UUID か、再接続後も続く連番を使ってください。同じ `clientId` で再開したあと連番を `"1"` からやり直してはいけません。再利用した id は、以前に保持された結果を返す（params が同じ）か、`operation_conflict` で失敗する（params が異なる）か、`operation_expired` で失敗し（10 分の保持期間後）、新しいリクエストは実行されません。

サーバーは各リクエストに、同じ `id` と `op` を持つ `response` をちょうど 1 つ返します。`"ok": true` と `result`、または `"ok": false` と `error: { code, message }` のどちらかです。レスポンスは任意の順序で、イベントの間に届くこともあります。schema の `x-operations` は各操作をその params と result の定義に対応付けています。

`cancel`（同じ `channel`、`id`、`controllerGeneration`、`sessionGeneration`）は保留中のリクエストを中止します。キャンセルしたリクエストにはレスポンスが来ないことがあり、遅れて届いたものは無視します。

`sessionGeneration` が現在の値でないと、読み取り操作は `stale_session` で失敗します。変更操作は `clientId` と `id` ごとに記録されます。レスポンスが届く前に接続が切れたら、`resume` で再接続し、**同じ** `id` と元の `daemonEpoch` で同じリクエストを再送してください。daemon は二重に実行せず、元の結果を返します。

| 分野 | 操作 |
| --- | --- |
| 状態 | `state.read`、`transcript.read`、`status.read`、`models.list`、`permissions.cycle`、`model.set`、`thinking.set`、`fastMode.set` |
| ターン | `turn.prompt`、`turn.steer`、`turn.abort` |
| コマンド | `command.run`、`skill.run`、`input.run`、`commands.describe`、`commands.complete` |
| セッション | `sessions.list`、`sessions.read`、`session.resume`、`session.clear`、`session.fork`、`session.rewind`、`session.planRewind` |
| サブエージェントと会話 | `conversations.list`、`conversations.history`、`conversations.focus`、`conversations.unfocus`、`conversations.control`、`conversation.send`、`conversation.stop` |
| バックグラウンドジョブ | `jobs.list`、`jobs.output`、`jobs.stop`、`jobs.wait` |
| UI リクエストとフォーム | `ui.respond`、`ui.cancel`、`form.open`、`form.evaluate`、`form.action`、`form.submit`、`form.cancel` |

`turn.prompt` と `turn.steer` は文字列、またはテキストブロックと画像ブロックを内容に持つユーザーメッセージを受け取ります。`command.run` は `/clear` などのスラッシュコマンド行を実行し、`commands.describe` と `commands.complete` はコマンド一覧と補完を返します。

### エラー

`error.code` は安定した機械可読なコードで、`message` は表示用のテキストで変わることがあります。クライアントが扱うべきコード：

| コード | 意味 |
| --- | --- |
| `agent_busy` | エージェントが今は受け付けられません。ターンや圧縮の実行中などです。 |
| `stale_session` | `sessionGeneration` がもう現在の値ではありません。最新のスナップショットから更新してください。 |
| `stale_operation` | 対象（UI リクエスト、フォーム、会話）がもう保留中でないか、現在のものではありません。 |
| `stale_controller` | `controllerGeneration` がもう現在の値ではありません。この接続は置き換えられました。 |
| `outcome_unknown` | リクエストが別の `daemonEpoch` のものです。daemon が再起動しました。再同期してください。 |
| `operation_conflict` | 同じ `id` が異なる params で再利用されました。 |
| `operation_expired` | 再試行した変更操作の元の結果がもう保持されていません。 |
| `unsupported_operation` | この操作はここでは使えません。 |
| `cancelled`、`disconnected` | リクエストがキャンセルされたか、ワークスペースが切り離しました。 |
| `limit_exceeded`、`invalid_frame` | 制限超過または検証の失敗。 |
| `operation_failed` | その他の失敗。詳細はホストに残ります。 |

## イベント

サーバーは `event` フレームを送り続けます。`seq` は 1 つの `daemonEpoch` 内のイベントを数え、ちょうど 1 ずつ増えます。適用済みの `seq` のイベントは無視し、欠番は接続断として扱ってください。`replay: true` は再開時に再送されたイベントを示します。

`reset` は完全な `WorkspaceSnapshot` を運び、クライアントの状態をすべて置き換えます。次のイベントの `seq` は `reset.seq` より大きくなります。新規の接続は必ず `reset`（`reason: "fresh"`）から始まります。再開時、サーバーは `resume.after` より後のイベントを再送するか、次の場合に `reset` を送ります：epoch が変わった（`epoch_changed`）、カーソルが再送の保持範囲（32 MiB または 50,000 イベント）から外れた（`cursor_expired`）、カーソルが先に進みすぎている（`future_cursor`）、取得に失敗した（`capture_failed`）。

イベントの `payload` は、**コアイベント**（`type` を持つ。例：`turn.start`、`message.delta`、`tool.execute.end`、`ui.request`。その中の `seq` はセッションごとの番号で、フレームの `seq` とは無関係）か、**ワークスペース通知**（`kind` を持つ）のどちらかです。

| `kind` | 意味 |
| --- | --- |
| `snapshot` | 変更のたびに送られる完全なフロントエンドスナップショット（状態と会話記録）。 |
| `error` | 表示状態が利用できません（`invalid_snapshot`）。 |
| `semantic` | ステータス行の項目、モデル、サブエージェント、グループ。 |
| `jobs` | バックグラウンドジョブの一覧。 |
| `inputQueue`、`steering`、`noticeInbox`、`noticeRetry`、`hold` | セッションごとの待機中の入力と通知の状態。 |
| `effect` | コマンドが要求したフロントエンドの動作：`detach`、`rewind`、`unfocus`、`view`、`focus`。 |
| `startup` | ワークスペースの起動時イベント。 |

クライアントは、`id` に `daemonEpoch`、`seq` に最後に適用したイベントを入れた `ack` を送れます。最後に受け取った `seq` を超えてはならず、戻ってもいけません。

サーバーは 15 秒ごとに `id: "heartbeat"` の `ping` を送ります。毎回同じ `id` の `pong` で応答してください。応答がないと、サーバーは 45〜60 秒後に接続を閉じます。クライアントから ping を送ることもでき、サーバーは `pong` で応答します。

## UI リクエスト

エージェントが回答を必要とするとき（ツールの承認、質問、フォーム、拡張機能の設定）、サーバーは `ui.request` コアイベントを送ります。保留中のリクエストはすべてのスナップショットの `pendingRequests` にも載ります。`ui.respond { requestId, value }` で回答するか、`ui.cancel` で閉じます。

| `kind` | `value` |
| --- | --- |
| `select` | `options` のいずれか。選択肢のセクションがキーを定義している場合は `{ "option", "key" }` も可。 |
| `confirm` | `true` または `false`。`always` が設定されていれば `"always"`、`other` が設定されていれば `{ "other": text }` も可。 |
| `input` | 文字列。 |
| `diff-review` | `options` のいずれか。 |
| `ask` | 質問ごとに 1 つの回答：`{ "selected": [labels], "other"?: text }`。 |
| `extension-settings` | `{ "values": {...}, "scope": "user" \| "project" }`。 |
| `form` | `ui.respond` は使いません。`form.open` でエディターとリビジョンを取得し、編集中は `form.evaluate`、アクションフィールドには `form.action` を使い、最後に `form.submit` または `form.cancel` を送ります。 |

確認結果は `accepted`、`cancelled`、`settled`（回答済み）、`invalid`、`disconnected` のいずれかです。`ui.resolved` イベントは、リクエストが閉じたことをすべてのフロントエンドに知らせます。接続しているのはコントローラーだけなので、回答するのはその 1 つのフロントエンドです。

## バージョンと互換性

プロトコルバージョン 1 の範囲では：

- サーバーが新しい操作、イベント、通知の種類、任意のフィールド、列挙値を追加するのは、ケイパビリティの裏に限られます。それらは `hello.capabilities` にそのケイパビリティを挙げたクライアントにだけ送られます。例：コンテキストウィンドウの取得元の値 `"provider"`（`status.read` とセマンティック状態内）は、`context-window-source.provider` を通知したクライアントにだけ送られ、他のクライアントではそのフィールドが省かれます。schema はそのような値を `description` に記載しています。
- 新しいサーバーケイパビリティは `welcome.capabilities` に現れます。クライアントは、任意の操作をそのケイパビリティを確認してから使います。
- クライアントのフレームは厳密に検証されます。クライアントは、接続先のサーバーバージョンの schema にないフィールドや値を、任意のものであっても、それを導入するケイパビリティをサーバーが通知していない限り決して送ってはいけません。
- 互換性を壊す変更（何かの削除や名前変更、型の変更、任意フィールドの必須化、順序や対応付けのルールの変更）には、新しいプロトコルバージョンと新しい schema ファイル `frontend-v2.schema.json` が必要です。daemon は別バージョンのクライアントを `incompatible_protocol` で拒否します。古いクライアントは、クライアントかサーバーの更新が必要だとユーザーに伝えます。ダウングレードモードはありません。
- バージョン 1 向けのクライアントは、より新しいバージョン 1 のサーバーでも動き続けます。要求していないフィールドを見ることはなく、`welcome` の未知のケイパビリティは無視できます。

堅牢性のため、生成コードは受け取ったオブジェクトの未知のプロパティを許容するべきですが、サーバーがそれを通知していないバージョン 1 クライアントに送ることはありません。

### schema の使い方

schema は 1 つのバンドルです。すべての型は `$defs` の下の名前付きエントリで、ローカルの `$ref` だけで参照されるため、コードジェネレーター（例：`System.Text.Json` を使う C# 向け）はファイルをまたいだ解決を必要とせず、安定した型名が得られます。ルートは `ClientFrame` と `ServerFrame` です。ユニオンは検証に使われない `x-discriminator` キーワードでタグ（`kind`、`type`、`op`、`role`、`status`、`state`、`action`）を示します。`EventPayload` は `type`（コアイベント）と `kind` のどちらを持つかで区別します。`x-operations` は各操作名をその `params` と `result` の定義に対応付けます。整数は負でない安全な整数（最大 2^53 - 1）です。文字列の長さとパターンは JSON Schema のルールに従います。

## やり取りの例

モックモデルを使う daemon との一連のやり取りです。ワイヤー上では JSON オブジェクトが 1 行に 1 つです（ここでは読みやすく整形し、一部のイベントを省いたため `seq` は飛んでいます）。Amira のテストは以下のすべてのフレームを schema で検証します。

<!-- protocol-example:start -->

<!-- client -->

```json
{
  "v": 1,
  "kind": "hello",
  "clientId": "example-gui-1",
  "workspace": "/home/dev/project",
  "release": {
    "version": "0.1.0",
    "buildId": "example-gui",
    "target": "win32-x64"
  },
  "limits": {
    "lineBytes": 262144,
    "logicalBytes": 67108864
  },
  "capabilities": [
    "context-window-source.provider"
  ]
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "welcome",
  "release": {
    "version": "0.0.1",
    "buildId": "0123456789abcdef0123456789abcdef01234567",
    "target": "bun-linux-x64-baseline"
  },
  "workspace": "/home/dev/project",
  "workspaceId": "1afbf223bb0b58ba08766ec87173ebd68e0507d66983531a95b52ff9b529c7db",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "controllerToken": "9c1f000000000000000000000000000000000000000000000000000000000000",
  "sessionGeneration": 1,
  "limits": {
    "lineBytes": 262144,
    "logicalBytes": 67108864
  },
  "capabilities": [
    "context-window-source.provider",
    "frontend.v1",
    "replay",
    "controller",
    "mutation.ledger",
    "files",
    "images",
    "jobs",
    "conversations",
    "model.remote-key"
  ]
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "reset",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 2,
  "reason": "fresh",
  "snapshot": {
    "frontend": {
      "sessionGeneration": 1,
      "state": {
        "sessionId": "s_689ca598",
        "cwd": "/home/dev/project",
        "resumed": false,
        "status": "idle",
        "model": {
          "provider": "mock",
          "id": "test",
          "contextWindow": 128000,
          "caps": {
            "images": false
          }
        },
        "permissionMode": "auto",
        "fastMode": {
          "requested": false,
          "applied": false
        },
        "children": 0
      },
      "transcript": {
        "messages": [],
        "displays": []
      }
    },
    "owners": {
      "s_689ca598": {
        "status": "idle",
        "busy": false,
        "turnId": null,
        "hold": null,
        "inputQueue": [],
        "steering": [],
        "noticeInbox": {
          "queue": [],
          "expected": 0
        },
        "noticeRetry": null
      }
    },
    "pendingRequests": [],
    "jobs": [],
    "startupEvents": [],
    "activity": {
      "events": [
        {
          "seq": 1,
          "ts": 1793271055136,
          "sessionId": "s_689ca598",
          "type": "session.start",
          "data": {
            "reason": "startup",
            "cwd": "/home/dev/project",
            "model": {
              "provider": "mock",
              "model": "test"
            }
          }
        }
      ]
    },
    "semantic": {
      "status": {
        "info": {
          "id": "s_689ca598",
          "cwd": "/home/dev/project",
          "model": {
            "provider": "mock",
            "model": "test"
          },
          "supportsThinking": false,
          "fastMode": {
            "requested": false,
            "applied": false
          },
          "contextWindow": 128000,
          "contextWindowSource": "default",
          "busy": false,
          "shell": "auto",
          "permissions": {
            "mode": "auto",
            "rules": 0
          }
        },
        "items": [],
        "usage": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0
        }
      },
      "models": [
        {
          "ref": "mock/test",
          "provider": "mock",
          "id": "test",
          "contextWindow": 128000,
          "maxOutput": 8192,
          "caps": {
            "tools": "native",
            "images": false,
            "thinking": false,
            "promptCache": false,
            "parallelToolCalls": true
          },
          "available": true
        }
      ],
      "subagents": [],
      "groups": []
    }
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "request",
  "channel": "control",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "sessionGeneration": 1,
  "id": "1",
  "op": "state.read",
  "params": {}
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "response",
  "channel": "control",
  "id": "1",
  "op": "state.read",
  "ok": true,
  "result": {
    "sessionId": "s_689ca598",
    "cwd": "/home/dev/project",
    "resumed": false,
    "status": "idle",
    "model": {
      "provider": "mock",
      "id": "test",
      "contextWindow": 128000,
      "caps": {
        "images": false
      }
    },
    "permissionMode": "auto",
    "fastMode": {
      "requested": false,
      "applied": false
    },
    "children": 0
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "request",
  "channel": "control",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "sessionGeneration": 1,
  "id": "2",
  "op": "turn.prompt",
  "params": {
    "message": "Say hello."
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 3,
  "payload": {
    "seq": 2,
    "ts": 1793271055197,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "turn.start",
    "data": {
      "prompt": {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Say hello."
          }
        ]
      }
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "response",
  "channel": "control",
  "id": "2",
  "op": "turn.prompt",
  "ok": true,
  "result": {
    "sessionGeneration": 1
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 10,
  "payload": {
    "seq": 5,
    "ts": 1793271055215,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "message.delta",
    "data": {
      "kind": "text",
      "text": "Hello fr"
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 15,
  "payload": {
    "seq": 10,
    "ts": 1793271055221,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "message.end",
    "data": {
      "message": {
        "role": "assistant",
        "content": [
          {
            "type": "text",
            "text": "Hello from the mock model."
          }
        ],
        "model": {
          "provider": "mock",
          "model": "test"
        },
        "usage": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0
        },
        "stopReason": "end"
      }
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 19,
  "payload": {
    "seq": 12,
    "ts": 1793271055226,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "turn.end",
    "data": {
      "reason": "done",
      "steps": 1
    }
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "ack",
  "channel": "control",
  "id": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 19
}
```

<!-- protocol-example:end -->

`turn.end` の後もサーバーは送信を続けます。状態が `idle` に戻り、最後の `snapshot` 通知がアシスタントの返答を含む会話記録を運びます。
