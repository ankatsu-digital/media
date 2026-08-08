# Multicam Switcher(フォルダなし・全ファイルroot直下版)

複数のスマホカメラをWebRTCで1つの操作端末(PC/ブラウザ)に集め、
ライブでスイッチングしながら、その通りに録画・保存できるツールです。

GitHubへブラウザからドラッグ&ドロップでアップロードしやすいように、
全ファイルをフォルダなしで1階層に置いています。

```
camera.html    ← スマホ用(カメラ端末)
camera.js
operator.html  ← PC用(操作端末・スイッチャー)
operator.js
index.html     ← 入室画面(ルームコード入力)
style.css
config.js      ← シグナリングサーバーのURLをここで指定
server.js      ← シグナリングサーバー本体(Node.js)
package.json
package-lock.json
```

## GitHubへのアップロード

`node_modules` フォルダ以外の、上記ファイル全部をそのままリポジトリのルートに
アップロードしてください(ドラッグ&ドロップで個別ファイルを選んでもOKです。
フォルダがないので階層が壊れる心配がありません)。

## デプロイ構成(推奨)

1. **サーバー(server.js)を Render にデプロイ**
   - Renderで「New Web Service」→ このリポジトリを選択
   - Build Command: `npm install` / Start Command: `npm start`
   - デプロイ後に発行されるURL(例: `https://xxxx.onrender.com`)を控える
2. **`config.js` を書き換える**
   ```js
   const SIGNALING_SERVER_URL = 'https://xxxx.onrender.com';
   ```
   書き換えたら、GitHubへ再アップロード(上書き)する
3. **GitHub Pagesを有効化**
   - リポジトリの Settings → Pages
   - Source: `Deploy from a branch` → Branch: `main` / フォルダ: `/ (root)`
   - 数分後に `https://あなたのユーザー名.github.io/リポジトリ名/` が公開される

これでフロントエンド(画面)はGitHub Pages、シグナリングサーバーはRenderという
役割分担になります。Renderの無料プランはしばらく使われないとスリープするため、
本番の少し前に一度アクセスして起こしておくと安心です。

## ローカルで試す

```bash
npm install
npm start
# http://localhost:3000
```

## 使い方の流れ

1. 操作担当: `index.html` を開き、ルームコードを決めて「操作端末として開始」
2. 各カメラ担当: 同じURLで同じルームコード + カメラ名を入力して「カメラ端末として開始」
3. 操作端末の画面でタイルをクリックすると本線(ON AIR)が切り替わる
4. 「録画開始」→ 切り替えた通りの映像が録画される
5. 「録画停止」で `.webm` ファイルが自動的にダウンロードされる

## TURNサーバーについて(拠点をまたぐ場合は必須)

同じWi-Fi内ではなく、外出先の複数拠点(それぞれ別回線)をつなぐ場合、
STUNだけでは接続できない組み合わせが出やすいため、TURNサーバーの追加を推奨します。

`camera.js` と `operator.js` の中の `ICE_SERVERS` に追記してください。

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-server.example.com:3478',
    username: 'your-username',
    credential: 'your-password'
  }
];
```

自前で立てるなら [coturn](https://github.com/coturn/coturn)、
サービスを使うならTwilio Network Traversal Service / Xirsys などがあります。
