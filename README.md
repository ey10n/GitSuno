# GitSuno

Sunoの楽曲(共有リンク)ごとに、元曲・曲調・状態・ToDo・メモ・外部公開済みかどうかを管理する静的Webアプリです。

- **アプリ本体**(このリポジトリ)は公開リポジトリとして GitHub Pages で配信します。データやトークンは一切含みません。
- **データ**は別の**非公開リポジトリ**に `data/songs.json` として保存されます。
- どちらも GitHub の無料プランで利用できます。

## セットアップ

> 公開済みのアプリを使うだけの方は、アプリ内の「はじめての方へ」(`guide.html`)の手順で準備できます(下記の手順3は不要です)。

1. **データ用の非公開リポジトリを作る**
   GitHub で新規リポジトリを作成します(例: `gitsuno-data`)。**Private** を選び、「Add a README」にチェックを入れます(空のリポジトリだと書き込めないため)。

2. **Fine-grained アクセストークンを作る**
   GitHub の Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Repository access: **Only select repositories** → `gitsuno-data` だけを選ぶ
   - Permissions → Repository permissions → **Contents: Read and write**(Metadata: Read は自動で付きます)
   - Expiration: 期限を設定する(例: 90日)。期限が切れたら作り直してください。

3. **アプリを GitHub Pages で公開する**
   このリポジトリを公開リポジトリとして push し、Settings → Pages → Branch を `main` / `(root)` に設定します。

4. 公開されたページを開き、「設定」でデータ用リポジトリの所有者・リポジトリ名・トークンを入力します。

## 使い方

Sunoで曲の「…」→「曲を共有する」でリンクをコピーし、アプリの入力欄に貼り付けて「追加」します。
変更は約1.5秒後に自動で非公開リポジトリへコミットされます。

## セキュリティ上の設計

| 対策 | 内容 |
|---|---|
| データの非公開 | 曲リンク・メモは非公開リポジトリにのみ保存されます。データ用リポジトリが public の場合、アプリは使用を拒否します。 |
| トークンの扱い | ブラウザ内(localStorage または sessionStorage)にのみ保存され、`api.github.com` にだけ送信されます。コードやリポジトリには書き込みません。 |
| 最小権限 | トークンの権限は、データ用リポジトリの Contents に限定します。漏洩した場合でも、被害はそのリポジトリ内に留まります。 |
| XSS対策 | 外部スクリプトを読み込みません。CSP で通信先を `api.github.com` に限定しています。データは `textContent` でのみ表示し、リンクは Suno の URL だけを許可しています。 |
| その他 | `noindex` で検索エンジンへの登録を抑制し、iframe への埋め込みを拒否し、リファラーを送信しません。 |

### 注意

- **共用PCでは「トークンを記憶する」をオフにしてください**(タブを閉じると消えます)。使い終わったら「トークンを削除」を押してください。
- トークンが漏れた疑いがある場合は、GitHub 上でトークンを削除(Revoke)してください。
- **データ用リポジトリを public に変更しないでください。** Git の履歴を含め、すべてのデータが公開されます。
- 2台の端末で同時に編集した場合は、曲ごとに更新日時が新しい方が採用されます。

## ファイル構成

```
index.html   画面
guide.html   はじめての方へ(利用者向けの設定手順)
app.js       ロジック(GitHub Contents API で読み書き)
style.css    スタイル
```
