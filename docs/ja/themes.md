# テーマ

[English](../themes.md) · [简体中文](../zh/themes.md) · [ドキュメント](../../README.ja.md)

テーマは、端末自体の背景色や前景色を変えずに、用途別の色と記号を変更します。組み込みテーマには、`amira`（デフォルトのシアン系パレット）、`amber`、`burnt`、`lavender`、`mono`（控えめなアクセント色と色付きの状態表示）、`ascii`（デフォルトの色と ASCII のグリフ）があります。組み込みの定義は [`packages/cli/themes`](../../packages/cli/themes) にあります。

## テーマの選択

`/theme` でテーマの選択画面を開くと、各テーマの名前、提供元、説明が表示されます。一覧には最初に `amira`、`amber`、`burnt`、`lavender`、`mono`、`ascii`、その後にカスタムテーマ、最後に `terminal` が並びます。現在のテーマには印が付きます。上下矢印キーでテーマをすぐにプレビューできます。Tab（または Shift+Tab）で Appearance と Shimmer の間のフォーカスを切り替え、左右矢印キーでフォーカス中の項目を変更します。Appearance は `auto`、`dark`、`light` の順に切り替わります。Shimmer の最初の選択肢は `theme` で、`theme (pulse)` のように継承したエフェクトも表示され、その後にアニメーションのプリセットが続きます。ユーザーによる上書きがなければ、選択画面は `theme` を選択した状態で開きます。Shimmer にフォーカスがある間も、上下矢印キーはテーマ一覧を移動します。Shimmer で Enter を押すと小さなカスタマイズパネルが開きます。上下で調整項目を選び、左右で変更します。Enter を押すと Shimmer にフォーカスが戻り、`enter back` のヒントが表示されます。次に Enter を押すと選択内容を適用します。色の選択肢は、`theme` と組み込みテーマのダーク・ライト用のグラデーションの組を順に切り替わります。Appearance から Enter を押すと、すべての選択内容をまとめて適用します。状態行には、待機中でもエフェクトのプレビューをリアルタイムで表示します。Esc を押すと保存せずに元のテーマ、表示モード、Shimmer に戻ります。これは、プレビュー中にテーマの定義が再読み込みされた場合も同じです。

`/theme <name>` は、選択済みの表示モードを維持したままテーマを直接選択します。従来のコマンド `/theme auto`、`/theme dark`、`/theme light` は、その表示モードで Amira を選択します。従来の設定も引き続き使え、選択画面では現在の Amira テーマとして表示されます。対話型での選択は、モデルの選択と同じように `tui.theme`、`tui.themeVariant`、`tui.shimmer` に保存します。`theme` を選ぶと Shimmer の上書き設定を削除します。`soft` を含む名前付きプリセットは明示的に保存します。`soft` を省略するのは、現在のテーマがすでに標準の soft エフェクトになる場合だけです。`/theme <name>` で直接選択した場合は、Shimmer の設定を維持します。選択内容はユーザー設定に保存し、許可されている場合はプロジェクトの `settings.local.json` にも保存します。プロジェクトへの保存に関する制約は、[設定リファレンス](settings.md#モデルと思考設定の保存)を参照してください。

`settings.json` に名前を設定することもできます。

```json
{
  "tui": {
    "theme": "ascii",
    "themeVariant": "auto"
  }
}
```

`tui.themeVariant` には `auto`、`dark`、`light` を指定できます。`auto` は検出した端末の背景に従い、背景が不明な場合はダークをデフォルトとします。`dark` または `light` は、その表示モードを強制します。選択した表示モードで省略されている色には、その表示モードの Amira のデフォルト値を使います。テーマが `dark` だけを提供している場合、`light` を選ぶとテーマのダーク用の色ではなく、デフォルトのライト用パレットを使います。ただし、グリフの上書きは引き続き適用します。ライト用しかないテーマでも、逆の方向に同じルールが適用されます。

実行中に変更すると、全画面の会話記録をすぐに再描画します。

既存の `tui.theme` の選択肢も引き続き有効です。`auto` は Amira のパレットで端末に合わせ、`dark` と `light` は Amira のパレットを明示的に選択し、`terminal` は端末の ANSI 色を使います。名前付きテーマは truecolor を強制しません。色深度の設定とモノクロ時の動作も引き続き適用されます。

## ファイルと優先順位

各 JSON ファイルには一つのテーマを定義し、ファイル名ではなく `name` で識別します。レイヤーは次の順序で読み込みます。同じ名前の定義が後から現れると、前の定義全体を置き換え、通知を表示します。

1. CLI に同梱されている組み込みテーマ。
2. `~/.amira/themes/*.json`。`AMIRA_HOME` が設定されている場合は `$AMIRA_HOME/themes/*.json`。
3. 起動時の作業ディレクトリにある `<cwd>/.amira/themes/*.json`。Git ルートではありません。
4. 有効なパッケージのマニフェストの `themes` リストにある JSON のパス。無効なパッケージと、信頼されていないプロジェクトパッケージは除外します。
5. 拡張機能が `api.registerTheme` で登録したテーマ。

ディレクトリ内のファイル名は、ロケールに依存せず辞書順で並べます。パッケージのパスは、有効なパッケージの順序と、各マニフェストで宣言された順序に従います。テーマディレクトリの直下にある `.json` ファイルだけを読み込み、サブディレクトリは走査しません。ディレクトリが存在しなくても問題ありません。読み込めないファイル、不正な JSON、不正な定義がある場合は、起動を止めずに通知を表示し、ほかのファイルは引き続き読み込みます。未知のフィールドやトークンは報告して無視します。不正なグリフの上書きは個別に無視し、デフォルト値を維持します。

テーマファイルやパッケージからのテーマ提供を変更した後は、Amira を再起動するか、待機中に `/reload` を実行してください。再読み込みではファイルのスナップショットを置き換えるため、削除したファイルからのテーマ登録はなくなります。拡張機能による登録は、引き続きファイルのレイヤーより優先されます。拡張機能をアンロードすると、その下にある定義が復元されます。

## テーマの形式

形式は [`ThemeDefinition`](../../packages/api/src/themes.ts) で定義されています。`name` は必須で、空であってはならず、前後の空白や制御文字を含めることもできません。`description`、`dark`、`light`、`glyphs`、`shimmerEffect` は任意です。色には、不透明な `#RGB` または `#RRGGBB` の 16 進数文字列を使います。`cyan` などの色名、CSS 関数、アルファチャンネル、ANSI エスケープシーケンスは使えません。

パレットは一部の色を上書きするもので、すべてのデフォルト色を置き換えるものではありません。`bg` と `fg` は表示領域の基準色であり、端末を塗り直す指定ではありません。`shimmer` と `shimmerEnd` は独立したグラデーションの色で、省略すると、その表示モードの Amira のデフォルトグラデーションを継承します。次の完全なファイル例には、すべてのパレットキーといくつかのグリフの上書きを示しています。`~/.amira/themes/my-theme.json` として保存してください。

```json
{
  "name": "my-theme",
  "description": "Default colors with simple list and code-frame symbols",
  "dark": {
    "bg": "#121212",
    "fg": "#e4e4e4",
    "accent": "#78dbe2",
    "heading1": "#6fb3e8",
    "heading": "#78dbe2",
    "path": "#9ab8f0",
    "command": "#a8e6ea",
    "fg2": "#bdbdbd",
    "muted": "#727272",
    "dim": "#4a4a4a",
    "border": "#333333",
    "borderFocused": "#565656",
    "success": "#8fc46a",
    "error": "#e5737a",
    "warning": "#e2b356",
    "thinking": "#a8927a",
    "userBg": "#202020",
    "codeBg": "#191919",
    "diffAddedBg": "#0f3a12",
    "diffRemovedBg": "#47141a",
    "diffAddedWordBg": "#17551c",
    "diffRemovedWordBg": "#66212a",
    "keyword": "#6fb3e8",
    "string": "#8dd8bd",
    "number": "#b5b4ee",
    "shimmer": "#78dbe2",
    "shimmerEnd": "#6fb3e8"
  },
  "light": {
    "bg": "#f6f5f2",
    "fg": "#222222",
    "accent": "#157c84",
    "heading1": "#1f6aa8",
    "heading": "#126f76",
    "path": "#3f5fb0",
    "command": "#1a6a70",
    "fg2": "#444444",
    "muted": "#8a8a8a",
    "dim": "#bdbab4",
    "border": "#d2cfc8",
    "borderFocused": "#9d9a93",
    "success": "#3f8a2a",
    "error": "#c23b47",
    "warning": "#a87412",
    "thinking": "#8d7a63",
    "userBg": "#e8e6e1",
    "codeBg": "#efede9",
    "diffAddedBg": "#d6f0cf",
    "diffRemovedBg": "#f6d5d8",
    "diffAddedWordBg": "#bce5b1",
    "diffRemovedWordBg": "#edb5bd",
    "keyword": "#1f6aa8",
    "string": "#23765d",
    "number": "#6356a6",
    "shimmer": "#157c84",
    "shimmerEnd": "#1f6aa8"
  },
  "glyphs": {
    "bullets": ["*", "-", "+"],
    "codeTop": "+-",
    "codeSide": "|",
    "codeBottom": "`-",
    "image": "[]"
  }
}
```

エディター用のスキーマは、英語版のリファレンスと同じ場所にある [`themes.schema.json`](../themes.schema.json) です。テーマの JSON ファイルに関連付けるようエディターを設定してください。実行時の検証では、JSON Schema では表現できない端末のセル幅も確認します。

### シマーアニメーション

`shimmerEffect` は、動作状況を示すラベルのアニメーションを設定します。プリセット名（`off`、`soft`、`sharp`、`wide`、`bounce`、`pulse`、`wave`、`reveal`）か、任意の調整項目を持つオブジェクトを使ってください。

```json
{
  "name": "quiet-wave",
  "shimmerEffect": {
    "preset": "wave",
    "period": 2400,
    "width": 8,
    "colors": {
      "dark": ["#78dbe2", "#6fb3e8"],
      "light": ["#157c84", "#1f6aa8"]
    }
  }
}
```

| 調整項目 | 値 | デフォルト値（`soft`） |
| --- | --- | --- |
| `preset` | `off`、`soft`、`sharp`、`wide`、`bounce`、`pulse`、`wave`、`reveal` | `soft` |
| `style` | `off`、`sweep`、`bounce`、`pulse`、`wave`、`reveal` | `sweep` |
| `width` | 端末の 1～20 セル。整数に丸めます | `6` |
| `period` | 1 周期あたり 400～5000 ミリ秒 | `1800` |
| `edge` | `soft`、`linear`、`hard` | `soft` |
| `direction` | `ltr` または `rtl` | `ltr` |
| `colors` | 16 進数の色を二つ、または `dark` と `light` の両方の色の組を含むオブジェクト | テーマの `shimmer` / `shimmerEnd` トークン |

`soft` は従来と同じ、幅 6 セル、周期 1.8 秒で、境界が柔らかい光が横切るアニメーションです。`sharp` は幅 3 セル、周期 1.1 秒で、境界がくっきりした光が横切ります。`wide` は幅 12 セル、周期 2.6 秒で、境界が柔らかい光が横切ります。`bounce` は往復し、`pulse` はラベル全体の明るさを変え、`wave` はグラデーションを動かし、`reveal` はラベルを順に強調します。`off` はラベルを静止した状態に保ちます。オブジェクト形式では、`soft` の別名として `preset: "sweep"` も受け付けます。単独の文字列 `"sweep"` はプリセットではありません。

設定の解決は `soft` から始め、テーマの `shimmerEffect`、次に設定の `tui.shimmer` を適用します。各レイヤーでは、プリセットがアニメーションの全調整項目を指定した後に、明示したフィールドで上書きします。ユーザーが `width` だけを上書きした場合は、テーマのスタイル、周期、色を維持します。ユーザーのプリセットはテーマのアニメーションの調整項目を置き換えますが、新しい色を指定しない限り、テーマの色を維持します。`wave` を含むすべてのスタイルは、デフォルトでは虹色のパレットではなく、選択した表示モードのテーマのグラデーションを使います。

不正なフィールドは個別に無視します。範囲外の有限の数値は、範囲内に収めます。不正なブロックがある場合は、テーマのほかの部分を破棄せずに、一つの通知を表示します。選択したテーマとは独立にエフェクトを無効にするには、`tui.shimmer: "off"` を使ってください。`/reload` は、編集した `tui.theme`、`tui.themeVariant`、`tui.shimmer` の設定を、テーマファイルとともに実行中に適用します。端末が必要な色表示に対応していない場合、アニメーションは無効のままです。

### グリフのキーと幅

`glyphs` は、二つのグリフモジュールのフラットなキーを使います。`tui` や `markdown` のオブジェクトをネストしないでください。各値は、タブ、改行、制御文字、エスケープ文字を含まない、単一行のプレーンテキストです。`bullets` は空でない配列で、ネストの深さをインデックスとして使います。配列より深い階層では、最後の箇条書き記号を繰り返します。

上書きするグリフは、デフォルト値の表示セル幅と一致する必要があります。幅は文字列の長さではなく、Amira のテキスト幅ライブラリで測定します。警告のグリフは、警告の表示配置で幅を測定するため、異なる幅でも使えます。端末やフォントによって描画は異なる場合があるので、使う端末で記号をテストしてください。

| 幅 | キー |
| --- | --- |
| 1 セル | `bullets` の各要素。`quoteBar`、`rule`、`codeSide`、`tableColumn`、`tableRule`、`tableCross`、`boxTopLeft`、`boxTopRight`、`boxBottomLeft`、`boxBottomRight`、`user`、`toolDone`、`toolRunning`、`toolFailed`、`toolInterrupted`、`toolBlocked`、`toolUnknown`、`toolInvalid`、`result`、`treeBranch`、`output`、`subagent`、`subagentDone`、`subagentFailed`、`subagentAborted`、`thought`、`question`、`dialogBar`、`choice`、`info`、`success`、`error`、`interrupted`、`more`、`pointer`、`search`、`searchPrompt`、`working`、`branch`、`separator` |
| 2 セル | `assistant`（デフォルトでは空白二つ）、`codeTop`、`codeBottom`、`image` |
| 3 セル | `taskOpen`、`taskDone`、`checked`、`unchecked` |
| 個別に測定 | `warning`（デフォルトでは 2 セル幅の絵文字） |

ASCII では、2 セル幅を保つために `image: "[]"`、`codeTop: "+-"`、``codeBottom: "`-"`` を使ってください。`more: "..."` は無効です。デフォルト値は 1 セルなので、`"."` を使います。組み込みの [`ascii.json`](../../packages/cli/themes/ascii.json) は、ASCII グリフの完全な例です。

## パッケージのテーマ

パッケージは、拡張機能のコードを実行せずに JSON を提供できます。パスはパッケージディレクトリからの相対パスで、その内部に収まる必要があります。`themes` のデフォルト値は `[]` です。テーマだけのパッケージには、`index.ts` や明示的な空の `extensions` リストは不要です。

`amira-package.json`:

```json
{
  "name": "my-theme-pack",
  "version": "1.0.0",
  "themes": ["themes/my-theme.json"]
}
```

`amira ext install ./my-theme-pack` でインストールし、その後に再起動するか `/reload` を実行してください。同じ `themes` リストを `package.json` の `amira` オブジェクトに配置することもできます。パッケージの有効化・無効化とプロジェクトの信頼は、ほかのパッケージからの機能提供と同じようにテーマにも適用されます。

## 拡張機能からテーマを登録する

`api.registerTheme` は、JSON ファイルと同じ定義形式と検証を使います。

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  api.registerTheme({
    name: "extension-blue",
    description: "Blue accents with default status and surface colors",
    dark: { accent: "#8cbcff", heading1: "#a5cfff", heading: "#8cbcff", path: "#a5baff" },
    light: { accent: "#245fa8", heading1: "#1c4e8c", heading: "#245fa8", path: "#3f5fb0" },
  })
})
```

`registerTheme` は、登録をすぐに解除するための関数を返します。登録はその拡張機能に属し、拡張機能のアンロードや再読み込み時に削除されます。後からの登録を優先し、優先されている拡張機能をアンロードすると、前のテーマが再び現れます。拡張機能からのテーマ登録だけでは、テーマの選択や保存は行いません。`/theme` または `tui.theme` で選択してください。
