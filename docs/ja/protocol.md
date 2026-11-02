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
- **ワークスペースごとにコントローラー 1 つと、最大 8 つのビューアー。**daemon が同時に受け入れるコントローラーは 1 つだけです。あるクライアントがコントローラーを保持している間（および切断後最大 30 秒間）、他のコントローラーは `controller_busy` で拒否されます。他のクライアントは読み取り専用のビューアーとして接続するか、明示的に制御を引き継げます（[コントローラーとビューアー](#コントローラーとビューアー)を参照）。ビューアーが daemon を起動することはなく、daemon を動かし続ける理由にもなりません。
- **モデルの経路。**デフォルトの local-proxy モードで起動した daemon（`welcome.capabilities` に `model.proxy`）は、端末クライアントが内部の model チャネルでモデル呼び出しを処理するのを待ちます。サードパーティのクライアントにはそれができず、ターンは最大 `remote.proxyReconnectTimeoutMs` 待ったあと失敗します。リモートの認証情報を使う daemon（`model.remote-key`）、つまり `amira-server attach --remote-key` で起動した daemon に接続してください。
- **変更記録。**daemon は、再試行したリクエストが二重に実行されないよう変更操作を記録します（[再試行と変更記録](#再試行と変更記録)を参照）。同時に保持する変更操作は最大 128 個で、その params と結果は合計最大 32 MiB です。実行中のものと、完了後最大 10 分間のものが含まれます。いっぱいになると、最も古い完了済みの結果が早めに破棄されます。実行中の変更操作だけで埋まっているときに限り、新しい変更操作は `limit_exceeded` で失敗します。また、1 つの接続でリクエスト id を 65,536 個使うと、daemon はその接続を `limit_exceeded` で閉じます。

## 接続

クライアントが daemon のソケットを自分で開くことはありません。中継コマンドを起動し、その stdin と stdout でプロトコルをやり取りします。

```sh
# On the Linux host itself
"$HOME/.amira/remote/bin/amira-server" attach --remote-key
# From another computer
ssh -T devbox '"$HOME/.amira/remote/bin/amira-server" attach --remote-key'
```

`amira remote add` はランチャーを `$HOME/.amira/remote/bin/amira-server` にインストールします。中継は次のように動きます。

1. 最初の行を 5 秒以内に読みます。これは `hello` フレーム全体（チャンク不可）でなければなりません。時間内に届かなければ、コード `invalid_frame` の `reject` を書き出して終了します。
2. `hello.workspace`（ホスト上に存在する絶対パス）を正規のパスに解決します。そのパスは `welcome.workspace` で返されます。
3. ワークスペースを所有する daemon を探すか、起動します。`--remote-key` は中継が新しい daemon を起動するときだけ有効で、動作中の daemon は起動時のモデルモードのままです。
4. バイトを中継する前に daemon を確認します。`/tmp/amira-<uid>-workspaces/` の検出用ファイルと `$XDG_RUNTIME_DIR/amira/`（または `/tmp` の代替場所）のソケットはユーザー専用でなければならず（ディレクトリ `0700`、ファイル `0600`、ユーザー所有、シンボリックリンクなし）、接続したソケットの相手は記録された daemon プロセス（同じユーザー ID、PID、プロセス開始時刻）でなければなりません。
5. どちらかが閉じるまで双方向にバイトをコピーします。中継を閉じると切断になるだけで、daemon やその作業が止まることはありません。

中継の stdout にはプロトコルフレームしか流れません。接続できない場合は `reject` フレームを 1 つ書いて終了します。詳細はプライベートなログにだけ残り、stdout には出ません。

ホスト上のその他のコマンド：

- `amira-server list` は `{"v":1,"workspaces":[...]}` を 1 行で出力します（schema の `ServerListOutput`）。ユーザーが所有する動作中の各 daemon について、ワークスペースのパス、`protocol`、サーバーの `release`、`daemonEpoch` を示します。
- `amira-server stop --cwd <workspace>` は daemon とそのすべての作業を停止します。切断ではありません。

ワークスペース内の保存済み会話は、接続後に `sessions.list` 操作で一覧できます。

## フレーム形式

- 各フレームは UTF-8 でエンコードした 1 つの JSON オブジェクトで、後に `\n` が続きます（直前の `\r` は許容されます）。バイトオーダーマークや他の区切りはありません。
- 改行の前の 1 行は最大 `lineBytes` = 262,144 バイトです。それより大きいフレーム（画像付きのプロンプトや大きなスナップショットなど）は `chunk` フレームで送ります。フレームをシリアライズし、バイト列を 131,072 バイトずつに分け、各部分を base64 にして順番に送ります。どの部分にも同じ新しい `transferId`、その `index`、部分の総数 `total`、全体のバイト長 `bytes`、全体のバイト列の 16 進 SHA-256 を付けます。受信側は再構成してハッシュを確認し、内側のフレームを処理します。チャンクの中にチャンクを入れることはできません。また `chunk` の `channel` は内側のフレームのチャネルと同じでなければならず、公開フレームではすべて `control` です。
- 論理的な制限：1 フレームは最大 `logicalBytes` = 67,108,864 バイト、JSON の入れ子は最大 64 段、JSON 値は最大 1,000,000 個、数値は有限でなければなりません。同時に進行できるチャンク転送は 4 つまで、保留中のリクエストは各方向 128 個までです。
- オブジェクト内のプロパティの順序に意味はありません。サーバーは `kind`、`type`、`op` などのタグを先頭に置くとは限らないので、順序に依存しないでください。
- クライアントのフレームは**厳密に**検証されます。未知のフィールド、必須フィールドの欠落、型の誤り、schema の範囲外の値があると接続が閉じられます。ハンドシェイク後、サーバーは先にエラーを送らず、単に接続を閉じます。schema にないフィールドは決して送らないでください。

## ハンドシェイク

クライアントは最初に `hello` を送り、`welcome`（または `reject`）を受け取るまで他に何も送ってはいけません。

| `hello` のフィールド | 意味 |
| --- | --- |
| `v` | 常に `1`。 |
| `clientId` | この接続の識別子。`[A-Za-z0-9_.:-]` の 1〜128 文字。クライアントのプロセスが起動するたびに新しいランダムな値（UUID など）を選び、そのプロセスの再接続では同じ値を使い、再起動をまたいで保存しないでください（[再試行と変更記録](#再試行と変更記録)を参照）。 |
| `workspace` | ホスト上のワークスペースの絶対パス。 |
| `release` | クライアント自身の `version`、`buildId`、`target`。サーバーは解釈しません。クライアントの識別に使えます（例：`"buildId": "my-gui"`）。 |
| `limits` | 正確に `{ "lineBytes": 262144, "logicalBytes": 67108864 }`。 |
| `capabilities` | 理解できるオプションの動作（下記参照）。未知の文字列は無視されます。 |
| `resume` | 任意。再接続のため、以前の `welcome` の `daemonEpoch`、`after`（最後に適用したイベントの `seq`）、`controllerToken`。 |
| `snapshot` | 任意。`true` にすると、再開時でも `reset` スナップショットを要求します。 |

`welcome` は、サーバーの `release`、正規の `workspace` とその `workspaceId`、`daemonEpoch`、`controllerGeneration`、`sessionGeneration`、再接続用の `controllerToken`（秘密にしてください）、同じ `limits`、サーバーの `capabilities`、そしてロール文字列を送ったクライアントにはその接続の `role`（`controller` または `viewer`）を返します。

| ケイパビリティ | 意味 |
| --- | --- |
| `frontend.v1` | このページの control チャネル操作。 |
| `replay`、`controller`、`mutation.ledger` | 再開時のイベント再送、コントローラーのリース、再試行されたリクエストの重複排除。 |
| `jobs`、`conversations` | `jobs.*` と `conversations.*` 操作。 |
| `files`、`images` | 内部の files チャネル。 |
| `model.remote-key` / `model.proxy` | daemon がどこでモデル呼び出しを行うか（[現在の制限](#現在の制限)を参照）。 |
| `context-window-source.provider` | クライアントのケイパビリティでもあります。[バージョンと互換性](#バージョンと互換性)を参照。 |
| `attach.roles` | 接続のロール。クライアントが下記のロール文字列のいずれかを送った場合にだけ含まれます。 |

バージョンのネゴシエーションはありません。`v` が異なる `hello` は `reject` のコード `incompatible_protocol` で拒否され、別のプロトコルバージョンで動作中の daemon に接続した場合も同様です。クライアントは `welcome.v` が `1` であることを確認し、そうでなければ接続を閉じなければなりません。

**接続の意図。**ロールを理解するクライアントは、`hello.capabilities` に次の文字列のいずれかを加えます。どれも `attach.roles` を含意します。送るのは 1 つだけにしてください。複数ある場合は `attach.take` が `attach.role.viewer` より、`attach.role.viewer` が `attach.role.auto` より優先されます。

| 文字列 | 結果 |
| --- | --- |
| `attach.roles` | ロールがない場合と同じく、コントローラーになるか `controller_busy` です。クライアントは `welcome.role`、`attachment` フレーム、`not_controller`、`welcome` の後の最後の `reject` も理解します。 |
| `attach.role.viewer` | ビューアー。この `clientId` の現在のコントローラートークンを持つ `resume` を付けると、リースもすぐに終わり、30 秒の予約は残りません。コントローラーはこうして制御を返します。 |
| `attach.role.auto` | ワークスペースが空いていて hello に `resume` がない場合、または `resume` がこのクライアント自身のリースを再開する場合はコントローラー、それ以外はビューアーです。拒否された再開が新しいコントローラーになることはありません。 |
| `attach.take` | すぐに制御を引き継ぎます（[制御の引き継ぎ](#制御の引き継ぎ)を参照）。ユーザーが明示的に操作したときだけ送ってください。 |

これらの文字列がなければ、ハンドシェイクはロールが導入される前とまったく同じに動作し、クライアントが `welcome.role` や `attachment` フレームを受け取ることはありません。

`clientId` ごとに有効な接続は最大 1 つです。hello が受け入れられると、同じ `clientId` の古い接続は閉じられます。拒否された hello（`controller_busy` など）は何も閉じません。個別に接続するウィンドウごとに別の `clientId` を使ってください。

ロール導入前の daemon はこれらの文字列を無視します。その場合ビューアーの意図はコントローラーとして接続するか `controller_busy` になり、`welcome.capabilities` に `attach.roles` はありません。ビューアーを接続する前に `amira-server list` で daemon の `release` を確認してください。見るだけのつもりのクライアントがそれでもコントローラーになった場合は、閉じるたびにワークスペースが 30 秒予約されるため、ユーザーが閉じるまで接続したまま変更操作を送らないでください。

`reject` のコード：`controller_busy`、`incompatible_protocol`、`incompatible_build`、`invalid_frame`（中継が 5 秒以内に `hello` を受け取れなかった場合も）、`invalid_workspace`、`workspace_busy`、`unsupported_capability`、`permission_denied`（再接続用の認証情報の期限切れや、変更記録が忘れた `clientId` など）、`startup_failed`、`limit_exceeded`、`disconnected`、`cancelled`、`unsupported_operation`、`operation_failed`、そして `controller_taken`（[制御の引き継ぎ](#制御の引き継ぎ)を参照）。`workspace_busy` は、今スナップショットを読み込み中のビューアーが多すぎるという意味の場合もあります。少し待って再試行してください。`limit_exceeded` は、ワークスペースにすでに 8 つのビューアーがいるという意味の場合もあります。この一覧は拡張されることがあり、知らないコードは `operation_failed` として扱ってください。`reject` の後、接続は閉じられます。`welcome` の後に `reject` を受け取りうるのは、ロール文字列を送ったクライアントだけです。

## リクエストとレスポンス

`request` は `channel`（`"control"`）、クライアントが選ぶ `id`、`op`、`params`、そしてリクエストの対象となる `daemonEpoch`、`controllerGeneration`、`sessionGeneration` を持ちます。`welcome` の値を使い、セッションが変わったら各スナップショットから新しい `sessionGeneration`（`frontend.sessionGeneration`）を取ります。`daemonEpoch` は必ず送ってください。これがない、または別の epoch のリクエストは `outcome_unknown` で失敗します。リクエスト id は `[A-Za-z0-9_.:-]` の 1〜128 文字で、同じ接続で繰り返してはいけません。さらに変更操作の id は、再接続をまたいで `daemonEpoch` 全体を通して `clientId` ごとに一意でなければなりません。daemon はすべての接続の変更操作を `clientId`、`daemonEpoch`、`id` をキーに記録します。UUID か、同じプロセスの再接続をまたいで続く連番を使ってください。同じ `clientId` で再開したあと連番を `"1"` からやり直してはいけません。再利用した id が再び実行されることはありません。何が返るかは[再試行と変更記録](#再試行と変更記録)を参照してください。

サーバーは各リクエストに、同じ `id` と `op` を持つ `response` をちょうど 1 つ返します。`"ok": true` と `result`、または `"ok": false` と `error: { code, message }` のどちらかです。レスポンスは任意の順序で、イベントの間に届くこともあります。schema の `x-operations` は各操作をその params と result の定義に対応付けています。

レスポンスは次の順序でデコードします。まず `id` で保留中のリクエストを探します。未知の `id` のレスポンスはキャンセルしたリクエストへの遅れた返信なので無視します。`op` がそのリクエストの `op` と一致することを確認し、一致しなければ接続を閉じます。次に `ok` で分岐し、`false` なら `error` を `Fault` として、そうでなければ `result` を `x-operations[op].result` でデコードします。schema の `ResponseFrame` ユニオンには単一のタグがないので、直接デコードしないでください。デコード専用の `ResponseEnvelope` 定義が最初の手順を表します。

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

### 再試行と変更記録

読み取りだけの操作（`*.read`、`*.list`、`jobs.output`、`jobs.wait`、`conversations.history`、`commands.describe`、`commands.complete`、`session.planRewind`）はそのまま実行されます。`form.evaluate` も記録されません。毎回新しい `id` で送ってください。同じエディターとリビジョンなら、ホストは同じ評価結果を返します。それ以外の操作はすべて変更操作です。`clientId` が C、`daemonEpoch` が E、`id` が X の変更操作について、クライアントが頼れるのは次のとおりです。

1. **最大 1 回。**どの接続でも (C, E, X) の再送で X が再び実行されることはありません。ただし再送が届いた時点で、X の後に受け入れられた C の他の変更 id が 4,096 個未満であることが条件です。再接続の直後、新しい変更操作を送る前に保留中の id を再送すれば、この条件は必ず満たされます。
2. **結果。**X の結果が保持されている間は、同じ params の再送はその結果を返し、異なる params の再送は `operation_conflict` で失敗します。結果は X の完了後最大 10 分間保持され、より新しい変更操作が場所を必要とするとき（128 件または 32 MiB、[現在の制限](#現在の制限)を参照）に限り早めに破棄されます。その後の再送はすべて `operation_expired` で失敗します。いずれの場合も X は再実行されません。保持できないほど大きな結果も元のリクエストには届き、その後の再送は `operation_expired` で失敗します。
3. **忘れられたクライアント。**C がコントローラーのリースを持たず（接続中、または切断後 30 秒以内なら持っています）、24 時間変更操作を送りも完了もしていない場合、または C の不在中に多くの他クライアントが書き込んだ場合（記録した id が合計 65,536 個を超えた場合）、daemon は C を忘れます。以後 C の `hello` と変更操作は `permission_denied` で失敗します。新しい `clientId` で接続し、スナップショットから再同期し、C の保留中の変更操作は結果不明として扱ってください。
4. **プロセスごとに新しい `clientId` を使ってください。クライアントの再起動をまたいで `clientId` を保存しないでください。**保存した id はすでに忘れられている可能性があり、その場合は daemon が再起動するまで拒否されます。
5. **変更操作の `limit_exceeded` は、それが実行されなかったことを意味します。**
6. **id は引き続き一意**（`clientId` と `daemonEpoch` ごと）でなければなりません。UUID か、再接続をまたいで続く連番を使ってください。
7. 別の `daemonEpoch` のリクエストは `outcome_unknown` で失敗します。daemon が再起動しており、以前の epoch の id については何もわかりません。スナップショットから再同期してください。
8. コード `controller_taken` の `reject` の後、保留中の変更操作の結果は不明です。ビューアーはそれらを再送できないため、代わりに状態を読んでください。

変更操作を送るのはコントローラーだけなので、ビューアーが変更記録を使うことはありません。

### エラー

`error.code` は安定した機械可読なコードで、`message` は表示用のテキストで変わることがあります。コードの集合は拡張されることがあり（`Fault.code` の `x-known-codes` に文書化されたコードの一覧があります）、知らないコードは `operation_failed` として扱ってください。クライアントが扱うべきコード：

| コード | 意味 |
| --- | --- |
| `agent_busy` | エージェントが今は受け付けられません。ターンや圧縮の実行中などです。 |
| `stale_session` | `sessionGeneration` がもう現在の値ではありません。最新のスナップショットから更新してください。 |
| `stale_operation` | 対象（UI リクエスト、フォーム、会話）がもう保留中でないか、現在のものではありません。 |
| `stale_controller` | `controllerGeneration` がもう現在の値ではありません。この接続は置き換えられました。 |
| `not_controller` | ビューアーが、コントローラーだけが実行できる操作を呼び出しました。 |
| `outcome_unknown` | リクエストが別の `daemonEpoch` のものです。daemon が再起動しました。再同期してください。 |
| `operation_conflict` | 同じ `id` が異なる params で再利用されました。 |
| `operation_expired` | 再試行した変更操作の元の結果がもう保持されていません。再実行はされていません。 |
| `permission_denied` | 変更記録がこの `clientId` を忘れました。新しい `clientId` で接続してください。 |
| `unsupported_operation` | この操作はここでは使えません。 |
| `cancelled`、`disconnected` | リクエストがキャンセルされたか、ワークスペースが切り離しました。 |
| `limit_exceeded`、`invalid_frame` | 制限超過または検証の失敗。これで拒否された変更操作は実行されていません。 |
| `operation_failed` | その他の失敗。詳細はホストに残ります。 |

## コントローラーとビューアー

各接続は、その存続期間を通じて 1 つのロールを保ちます。**コントローラー**か**ビューアー**です。ロールの変更は常に新しい接続です。ビューアーになれるのは、ロール文字列を送ったクライアント（[ハンドシェイク](#ハンドシェイク)を参照）だけです。

ビューアーの `welcome` は `role: "viewer"` と `controllerGeneration: 0` を持ち、その `controllerToken` は何の権限も与えません。ビューアーのリクエストとキャンセルでは `controllerGeneration: 0` を送ってください。それ以外の値は `stale_controller` で失敗します。ビューアーは、コントローラーが受け取るすべてのイベント、スナップショット、UI リクエストを自分のカーソルから受け取ります。呼び出せるのは次の操作だけです（`x-operations` の `x-access.viewer`）：`state.read`、`transcript.read`、`status.read`、`models.list`、`commands.describe`、`sessions.list`、`sessions.read`、`session.planRewind`、`jobs.list`、`jobs.output`、`jobs.wait`、`conversations.list`、`conversations.history`。それ以外の操作はすべて `not_controller` で失敗します。`turn.abort`、`commands.complete`、`form.evaluate` も同じです。

- ビューアーが同時に実行できる `jobs.wait`、`jobs.output`、`conversations.history` のリクエストは最大 8 つです。それを超えると `limit_exceeded` で失敗します。
- ビューアーが読めるのは、コントローラーがフォーカスした会話だけです。
- 1 つのワークスペースが受け入れるビューアーは最大 8 つで、それ以上のビューアーの hello はコード `limit_exceeded` の `reject` を受け取ります。最初のスナップショットを同時に読み込めるビューアーは最大 2 つで、それ以上は `workspace_busy` を受け取るので、少し待って再試行してください。
- 1,024 フレームまたは 16 MiB 遅れたビューアーは `limit_exceeded` で閉じられます。再接続してカーソルから再開してください。
- ビューアーは daemon を動かし続ける理由になりません。ビューアーが接続していても、daemon はアイドルになると停止し、準備済みの更新はそれを置き換えます。`attach.role.viewer` を持つ中継の hello が daemon を起動することはありません。動いている daemon がなければ、中継はコード `disconnected` の `reject` を書き出します。

### attachment フレーム

ロール文字列を送ったクライアントは `attachment` フレームも受け取ります。`welcome` の後（その接続の初期再送の後）に 1 つ、その後は変化のたびに 1 つです。これはイベントではありません。`seq` を持たず、再送も確認応答もされません。各フレームは現在の状態全体を運ぶので、最新のものだけを保持してください。

- `controller.state` は `attached`、`detached`（保持者が切断しており、`graceRemainingMs` ミリ秒以内なら再接続できる）、`none` のいずれかです。知らない値は `none` として扱ってください。`controller.client` は保持者を示します。
- `viewers` は最大 8 つのビューアーを `client` と `attachedMs` 付きで列挙します。自分がビューアーなら、自分の接続も含まれます。

`client` は、そのクライアントが `hello.release` で自己申告した `buildId` と `target` で、`version` は単純な `[0-9A-Za-z.+-]` のテキストである場合だけ含まれます。これは表示用のテキストにすぎません。すべてのクライアントが同じユーザーとして動くので認証されておらず、`clientId` を含むこともありません。それでも表示する前に制御文字を取り除いてください。

### 制御の引き継ぎ

`attach.take` を持つ hello は、次の場合にクライアントをコントローラーにします。

| リース | 結果 |
| --- | --- |
| 空いている、または同じ `clientId` が保持している（接続中または猶予期間中） | 新しい generation とトークンでコントローラーになります。 |
| 別のクライアントが 30 秒の猶予期間中に保持している | コントローラーになり、予約は終わります。 |
| ロール文字列を送らなかったクライアントが接続したまま保持している | コード `controller_busy` の `reject`。理由を伝えられないクライアントが引き継がれることはありません。 |
| ロール文字列を送ったクライアントが接続したまま保持している | コントローラーになります。以前の保持者はコード `controller_taken` の最後の `reject` を受け取り、閉じられます。 |
| コントローラーが変わってから 1 秒未満 | コード `controller_busy` の `reject`。 |
| daemon が `model.proxy` を使い、接続中の保持者がモデルを提供していて、引き継ぐ側が `model.proxy` を送らなかった | コード `unsupported_capability` の `reject`。 |

引き継ぎで変わるのは、誰が操作できるかだけです。実行中のターン、バックグラウンドジョブ、サブエージェントは続き、保留中の UI リクエストは新しいコントローラーを待ち、以前の保持者がすでに送った変更操作は実行を続けます。それらのレスポンスは古い接続とともに失われるため、結果は不明として扱い、状態を読んでください。`controller_taken` の後は `attach.role.viewer` と自分のカーソルで再接続し、別のクライアントが制御を引き継いだことをユーザーに伝えてください。

`effect` 通知は、そのコマンドを実行したコントローラーのものです。ビューアーはすべての `effect` イベントを無視します。新しいコントローラーは、初期再送（`replay: true`）に含まれる `effect` イベントを無視します。ただし、直前の接続もコントローラーだった場合は除きます。

ビューアーは権限が低いのであって、信頼の度合いが低いわけではありません。中継を実行できる同じユーザーのプロセスなら、ワークスペース全体を見ることも、制御を引き継ぐことも、`amira-server stop` で daemon を止めることもできます。また daemon は、128 ソケットを超えた接続を理由を示さずに閉じます。

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

確認結果は `accepted`、`cancelled`、`settled`（回答済み）、`invalid`、`disconnected` のいずれかです。`ui.resolved` イベントは、リクエストが閉じたことをすべてのフロントエンドに知らせます。保留中のリクエストはすべての接続から見えますが、回答できるのはコントローラーだけです。ビューアーの `ui.respond`、`ui.cancel`、`form.*` は `not_controller` で失敗します。

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

- タグ付きユニオンの各分岐は、タグの値を 1 つだけ持つ独立した名前付き定義です（`TextDelta`、`DetachEffect`、`AcceptedUiAck` など）。そのため各分岐は 1 つの派生型に対応します。ある型と `null` のユニオンは null 許容型に対応します。それ以外のタグのないユニオンはすべて、カスタムコンバーターか `JsonElement` が必要です。オブジェクトでは `EventPayload`（上記）や `UiAnswer`（JSON の型とプロパティで区別）、フィールドでは JSON の型が混在するもの、たとえば文字列または `UserMessage` の `message`、`FormValue`、`writesFiles`（`true`、`false`、`"paths"`）がその例です。`ResponseFrame` は `ResponseEnvelope` を通してデコードします（[リクエストとレスポンス](#リクエストとレスポンス)を参照）。
- タグは最初のプロパティとは限りません。`System.Text.Json` のポリモーフィズムを使う場合は `JsonSerializerOptions.AllowOutOfOrderMetadataProperties = true`（.NET 9 以降）を設定するか、先に `JsonDocument` からタグを読んで型を選ぶコンバーターを書いてください。
- `x-decode-only` の付いた定義（`ResponseEnvelope` と、`amira-server list` の出力行を表す `ServerListOutput`）は、ルートの `x-decode-only` 配列に列挙されています。これらがフレームになることはありません。
- `Fault.code` は拡張されうる文字列です。`x-known-codes` に文書化された値の一覧があり、それ以外は `operation_failed` として扱ってください。
- `x-operations` の各エントリは `x-access` を持ちます。`ledger`（記録される変更操作）と `viewer`（ビューアーが呼び出せる）です。あるケイパビリティを持つクライアントにだけ送られる定義とプロパティには `x-capability` が付きます。たとえば `attach.roles` の `AttachmentFrame` と `WelcomeFrame.role` です。`x-known-values` は、`AttachmentController.state` のような拡張されうる文字列について、文書化された値を列挙します。

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
