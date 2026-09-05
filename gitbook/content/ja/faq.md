# よくある質問

9Routerに関する一般的な質問。

---

## 9Routerとは?

**9Routerは、サブスクリプションの価値を最大化し、コストを最小限に抑えるAIモデルルーターです。**

3階層フォールバックシステムを使用して、複数のAIプロバイダー間でリクエストをインテリジェントにルーティングします:
1. **サブスクリプション階層** - すでに支払っているClaude Code、Codex、Geminiのクォータを最大化
2. **低価格階層** - 超低価格な代替手段(100万トークンあたり$0.20〜$0.60)
3. **無料階層** - 無制限の無料モデルによる緊急バックアップ

**主な利点:**
- サブスクリプションのクォータを無駄にしない
- クォータ消費時の自動フォールバック
- リアルタイムクォータトラッキング
- 直接API利用に対して90%のコスト削減

---

## 料金体系はどうなっていますか?

**9Routerは3階層の料金戦略を使用します:**

### Tier 1: サブスクリプション(最初に最大化)
- **Claude Code** (Pro/Max): 月$20〜100 - 5時間 + 週次クォータ
- **OpenAI Codex** (Plus/Pro): 月$20〜200 - 5時間 + 週次クォータ
- **GitHub Copilot**: 月$10〜19 - 月次リセット
- **Antigravity**: 無料 - Gemini 3.8 Flash + Claude、日次/月次クォータ

**目標:** リセット前にクォータを余すことなく使用!

### Tier 2: 低価格(バックアップ)
- **GLM-4.7**: 100万トークンあたり$0.60/$2.20 - 毎日午前10時リセット
- **MiniMax M2.1**: 100万トークンあたり$0.20/$1.00 - 5時間ローリング
- **Kimi K2**: 月$9固定(1000万トークン)

**目標:** ChatGPT API(100万あたり$20)より90%安い!

### Tier 3: 無料(緊急時)
- **Kiro**: 6モデル無料(月約50クレジット - Claude Sonnet 4.5、Haiku 4.5、GLM 5、Qwen3 Coder Next...)
- **OpenCode Free**: ログイン不要、無制限パススルー
- **Vertex AI**: $300の無料GCPクレジット(90日間)

> 注意: iFlowは2026年から有料化、Qwen Codeの無料OAuthは2026-04-15に終了しました。

**目標:** 他のすべてがクォータ制限に達した時のゼロコストフォールバック!

---

## 9Routerは無料ですか?

**はい、9Router自体は100%無料でオープンソースです。**

**利用可能な無料階層プロバイダー:**
- **Kiro** - Claude Sonnet 4.5/Haiku 4.5 + 4つの追加モデル(月約50クレジット、無料AWS Builder ID)
- **OpenCode Free** - ログイン不要、モデルリスト自動取得
- **Vertex AI** - $300無料クレジット(90日間)
- **Antigravity** - Googleアカウントで無料(Gemini CLIの後継)

**無料階層プロバイダーのみを使用して永久に無料でコーディングできます!**

**オプションの有料プロバイダー:**
- すでに持っている可能性のあるサブスクリプションサービス(Claude Code、Codex、Copilot)
- 超低価格な代替手段(100万トークンあたり$0.20〜$0.60)

---

## どのプロバイダーがサポートされていますか?

### サブスクリプションプロバイダー
- **Claude Code** (Pro/Max) - Claude Opus 5 / Sonnet 5 / Haiku 4.5
- **OpenAI Codex** (Plus/Pro) - GPT 5.6 Sol、GPT 5.5
- **GitHub Copilot** - GPT-5.4、Claude Sonnet 4.6、Gemini 3.1
- **Antigravity** (Google) - Gemini 3.8 Flash、Claude Sonnet 4.6

### 低価格プロバイダー
- **GLM** (Zhipu AI) - GLM 4.7、GLM 4.6V Vision
- **MiniMax** - MiniMax M2.1
- **Kimi** (Moonshot AI) - Kimi Latest
- **OpenRouter** - 任意のOpenRouterモデルへのパススルー

### 無料プロバイダー
- **Kiro** - 6モデル(Claude Sonnet 4.5、Haiku 4.5、GLM 5、MiniMax M2.5、Qwen3 Coder Next、DeepSeek 3.2)
- **OpenCode Free** - 自動取得モデルリスト、ログイン不要
- **Vertex AI** - Gemini 3.1 Pro + パートナーモデル($300無料クレジット)

**合計: 15以上のプロバイダー、50以上のモデル**

詳細は[プロバイダードキュメント](providers/subscription.md)を参照。

---

## 複数のプロバイダーを使用できますか?

**はい! これは9Routerのコア機能です。**

**コンボにより、複数のプロバイダーを自動フォールバック付きで連鎖させることができます:**

```
コンボ例: "premium-coding"
1. cc/claude-opus-5 (サブスクリプション優先)
2. glm/glm-4.7 (低価格バックアップ)
3. kr/claude-sonnet-4.5 (無料緊急時)

→ クォータ消費時に自動切替
→ コーディングが止まらない
→ 最小の追加コスト
```

**コンボの作成方法:**
```
Dashboard → Combos → Create New
→ 優先順位順にモデルを追加
→ CLIでコンボ名を使用: "premium-coding"
```

**利点:**
- クォータ切れ時のダウンタイムゼロ
- 自動コスト最適化
- すべてのツール用の単一モデル名

例については[コンボドキュメント](features/combos.md)を参照。

---

## クォータトラッキングはどのように機能しますか?

**9Routerはすべてのプロバイダーのクォータをリアルタイムで追跡します:**

**機能:**
- **トークン消費** - リクエストごとの入出力トークン
- **リセットカウントダウン** - クォータが更新されるまでの時間
- **使用統計** - 日次/週次/月次レポート
- **コスト見積もり** - 予測支出(有料階層)
- **クォータアラート** - クォータが少ない時の通知

**クォータタイプ:**
- **5時間ローリング** - Claude Code、Codex、MiniMax
- **日次リセット** - Antigravity、GLM(午前10時)
- **週次リセット** - Claude Code、Codex(追加クォータ)
- **月次リセット** - GitHub Copilot(1日)、Antigravity

**クォータを表示:**
```
Dashboard → Providers → Quota Tracking
→ リアルタイム使用量 + リセットカウントダウン
```

詳細は[クォータトラッキングドキュメント](features/quota-tracking.md)を参照。

---

## 9RouterはCursorで動作しますか?

**はい、ただしCursorはクラウドエンドポイントが必要です。**

**問題:** Cursor IDEはlocalhostエンドポイントをサポートしていません。

**解決策:** 9Routerクラウドデプロイメントを使用:

```
Cursor Settings → Models → Advanced:
  OpenAI API Base URL: https://9router.com/v1
  OpenAI API Key: [ダッシュボードから取得]
  Model: cc/claude-opus-5
```

**代替案:** パブリックドメインでVPSにセルフホスト:
```bash
# VPSへデプロイ
git clone https://github.com/vibecoder11200/9router.git
cd 9router
npm install && npm run build
npm start

# Nginxリバースプロキシを設定
# Cursorを向ける: https://your-domain.com/v1
```

**他のCLIツールはlocalhostで動作:**
- Cline ✅
- Claude Desktop ✅
- Codex CLI ✅
- Continue ✅
- RooCode ✅

詳細は[Cursor統合ガイド](integration/cursor.md)を参照。

---

## 9Routerをセルフホストできますか?

**はい! 9Routerは複数のデプロイメントオプションをサポートします:**

### Localhost(デフォルト)
```bash
npm install -g 9router
9router
→ Dashboard: http://localhost:3000
→ API: http://localhost:20128/v1
```

### VPS/クラウド
```bash
git clone https://github.com/vibecoder11200/9router.git
cd 9router
npm install && npm run build

export JWT_SECRET="your-secure-secret"
export INITIAL_PASSWORD="your-password"
export NODE_ENV="production"

npm start
```

### Docker
```bash
docker build -t 9router .
docker run -d \
  -p 20128:20128 \
  -e JWT_SECRET="your-secret" \
  -v 9router-data:/app/data \
  9router
```

### Cloudflare Workers
```bash
cd 9router
npm run deploy:cloudflare
```

**環境変数:**
- `JWT_SECRET` - **本番環境で必ず変更!**
- `DATA_DIR` - データベース保存パス(デフォルト: `~/.9router`)
- `INITIAL_PASSWORD` - ダッシュボードログイン(デフォルト: `123456`)
- `NODE_ENV` - デプロイ時は`production`に設定

詳細は[デプロイメントガイド](getting-started/installation.md#deployment)を参照。

---

## データは安全ですか?

**はい、9Routerはセキュリティとプライバシーを優先します:**

**ローカルストレージ:**
- すべてのデータは`~/.9router`(またはカスタム`DATA_DIR`)にローカル保存
- 9Routerサーバーへのデータ送信なし
- OAuthトークンはJWTで暗号化

**テレメトリなし:**
- 使用状況追跡なし
- アナリティクスなし
- フォンホームなし

**オープンソース:**
- 完全なソースコードがGitHubで利用可能
- 自分でセキュリティを監査可能
- コミュニティレビュー済み

**ハードニングの要点 (v0.6.36+):**
- APIキーは**保存時にハッシュ化**(インストールごとのシークレットによるHMAC-SHA256)。平文保存なし。一覧は `sk-{keyId}-••••{last4}` のみ表示
- キーのハッシュ化とMITM sudo暗号化にインストールごとのランダムシークレットを使用。マシン由来のフォールバックキーなし
- 外向きfetch経路すべてにSSRFガード(手動リダイレクト、ホップごとのDNS再検証)
- リクエストログはverboseモードでも資格情報をマスク
- トンネル経由のダッシュボードアクセスはオプトイン。デフォルトパスワードはホスト自身からのみ有効
- DBのエクスポート/インポートにはインストール固有のCLIトークンが必要

**ベストプラクティス:**
- 本番環境で強力な`JWT_SECRET`を設定
- 強力な`INITIAL_PASSWORD`を使用し、初回ログインで変更
- クラウドデプロイでHTTPSを有効化
- APIキーを定期的にローテーション

**9Routerが保存するもの:**
- プロバイダーOAuthトークン(暗号化)
- APIキー(ハッシュ化 — HMAC-SHA256、インストールごとのシークレット)
- 使用統計(ローカルのみ)
- コンボ設定

**9Routerが保存しないもの:**
- プロンプトやレスポンス
- 生成したコード
- 個人情報

---

## 9Routerを更新するには?

**更新方法はインストールタイプによって異なります:**

### グローバルNPMインストール
```bash
npm update -g 9router
```

### ソースから
```bash
cd 9router
git pull origin master
npm install
npm run build
npm start
```

### Docker
```bash
docker pull vibecoder11200/9router:latest
docker stop 9router
docker rm 9router
docker run -d \
  -p 20128:20128 \
  -v 9router-data:/app/data \
  vibecoder11200/9router:latest
```

**バージョンを確認:**
```bash
9router --version
```

**破壊的変更:**
- [CHANGELOG.md](https://github.com/vibecoder11200/9router/blob/main/CHANGELOG.md)を確認
- メジャー更新前に`~/.9router`をバックアップ
- メジャーバージョンの移行ガイドを確認

---

## どのように貢献できますか?

**貢献を歓迎します!**

### 貢献方法:

1. **バグを報告:**
   - [GitHub Issues](https://github.com/vibecoder11200/9router/issues)
   - エラーログ、再現手順を含める

2. **機能をリクエスト:**
   - [GitHub Discussions](https://github.com/vibecoder11200/9router/discussions)
   - ユースケースと利点を説明

3. **コードを提出:**
   ```bash
   # リポジトリをフォーク
   git clone https://github.com/YOUR_USERNAME/9router.git
   cd 9router
   
   # ブランチを作成
   git checkout -b feature/your-feature
   
   # 変更を加える
   npm install
   npm run dev
   
   # テスト
   npm test
   
   # コミットしてプッシュ
   git add .
   git commit -m "Add your feature"
   git push origin feature/your-feature
   
   # GitHubでPull Requestを作成
   ```

4. **ドキュメントを改善:**
   - 誤字の修正、例の追加
   - 他言語への翻訳
   - チュートリアルの執筆

5. **プロバイダーを追加:**
   - 新しいプロバイダーアダプターを実装
   - 例については`app/lib/providers/`を参照

**貢献ガイドライン:**
- 既存のコードスタイルに従う
- 新機能にはテストを追加
- ドキュメントを更新
- コミットは小さく、わかりやすく

詳細は[CONTRIBUTING.md](https://github.com/vibecoder11200/9router/blob/main/CONTRIBUTING.md)を参照。

---

## さらにヘルプが必要?

- **ドキュメント:** [9router.com/docs](https://9router.com/docs)
- **GitHub:** [github.com/vibecoder11200/9router](https://github.com/vibecoder11200/9router)
- **Issues:** [github.com/vibecoder11200/9router/issues](https://github.com/vibecoder11200/9router/issues)
- **トラブルシューティング:** [troubleshooting.md](troubleshooting.md)
