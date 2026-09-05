# はじめに

9Routerを5分で起動し、AIリクエストをインテリジェントにルーティングし始めましょう。

---

## クイックスタート

### 1. インストール

```bash
npm install -g 9router
```

**要件:** Node.js 20+ ([インストール詳細](installation.md))

### 2. 起動

```bash
9router
```

🎉 **ダッシュボードが自動的に開きます** (`http://localhost:20128`)

- デフォルトパスワード: `123456` (ダッシュボードで変更)
- APIキーは自動生成
- プロバイダー接続の準備完了

### 3. プロバイダーを接続

プロバイダーを接続する方法は3つあります:

#### オプションA: OAuth(サブスクリプションプロバイダー)

**最適:** Claude Code、Codex、Antigravity、GitHub Copilot

```
Dashboard → Providers → Connect [Provider]
→ OAuthログイン → トークン自動更新
→ クォータトラッキング有効化
```

**例: Claude Code**
1. 「Connect Claude Code」をクリック
2. Claudeアカウントでログイン
3. 9Routerを認可
4. ✅ 完了! モデルを使用: `cc/claude-opus-5`

#### オプションB: APIキー(低価格プロバイダー)

**最適:** GLM、MiniMax、Kimi、OpenRouter

```
Dashboard → Providers → Add API Key
→ プロバイダーを選択
→ APIキーを貼り付け
→ 保存
```

**例: GLM-4.7**
1. [Zhipu AI](https://open.bigmodel.cn/)でサインアップ
2. Coding PlanからAPIキーを取得
3. Dashboard → Add API Key → Provider: `glm` → キーを貼り付け
4. ✅ 完了! モデルを使用: `glm/glm-4.7`

#### オプションC: 無料プロバイダー(コストなし)

**最適:** Kiro、OpenCode Free、Vertex AI

```
Dashboard → Providers → Connect [Free Provider]
→ OAuth (Kiro) またはログイン不要 (OpenCode Free)
→ 無料クォータ / 無制限パススルー
```

**例: Kiro**
1. 「Connect Kiro」をクリック
2. AWS Builder IDでログイン (またはGoogle/GitHub)
3. 認可
4. ✅ 完了! 6モデルを使用: `kr/claude-sonnet-4.5`、`kr/qwen3-coder-next`など

---

## 4. CLIツールで使用

コーディングツールを9Routerに向けます:

### Cursor IDE

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [9routerダッシュボードから取得]
  Model: cc/claude-opus-5
```

### Claude Desktop

`~/.claude/config.json`を編集:

```json
{
  "anthropic_api_base": "http://localhost:20128/v1",
  "anthropic_api_key": "your-9router-api-key"
}
```

### Cline / Continue / RooCode

```
Provider: OpenAI Compatible
Base URL: http://localhost:20128/v1
API Key: [ダッシュボードから取得]
Model: cc/claude-opus-5
```

### Codex CLI

```bash
export OPENAI_BASE_URL="http://localhost:20128"
export OPENAI_API_KEY="your-9router-api-key"

codex "your prompt"
```

---

## 5. スマートコンボを作成(オプション)

コンボはモデル間の自動フォールバックを可能にします:

```
Dashboard → Combos → Create New

Name: premium-coding
Models:
  1. cc/claude-opus-5 (サブスクリプション優先)
  2. glm/glm-4.7 (低価格バックアップ、100万あたり$0.6)
  3. kr/claude-sonnet-4.5 (無料フォールバック)

CLIで使用: premium-coding
```

**動作:**
1. 最初にClaude Opusを試行(サブスクリプション)
2. クォータ消費時 → GLM-4.7(超低価格)
3. 予算上限時 → Kiro(無料)
4. ダウンタイムゼロ、自動切替!

---

## 利用可能なモデル

### サブスクリプションモデル(最初に最大化)

**Claude Code (`cc/`)** - Pro/Maxサブスクリプション:
- `cc/claude-opus-5` - Claude Opus 5
- `cc/claude-sonnet-5` - Claude Sonnet 5
- `cc/claude-haiku-4-5-20251001` - Claude 4.5 Haiku

**Codex (`cx/`)** - Plus/Proサブスクリプション:
- `cx/gpt-5.6-sol` - GPT 5.6 Sol
- `cx/gpt-5.5` - GPT 5.5

**Antigravity (`ag/`)** - Googleアカウントで無料:
- `ag/gemini-3-flash` - Gemini 3 Flash
- `ag/claude-sonnet-4-6` - Claude Sonnet 4.6

**GitHub Copilot (`gh/`)** - サブスクリプション:
- `gh/gpt-5.4` - GPT-5.4
- `gh/claude-sonnet-4.6` - Claude Sonnet 4.6

### 低価格モデル(バックアップ)

**GLM (`glm/`)** - 100万あたり$0.6/$2.2:
- `glm/glm-4.7` - GLM 4.7(毎日午前10時リセット)

**MiniMax (`minimax/`)** - 100万あたり$0.20/$1.00:
- `minimax/MiniMax-M2.1` - MiniMax M2.1(5時間リセット)

**Kimi (`kimi/`)** - 月$9(1000万トークン):
- `kimi/kimi-latest` - Kimi Latest

### 無料モデル(緊急時)

**Kiro (`kr/`)** - 6モデル無料 (月約50クレジット):
- `kr/claude-sonnet-4.5` - Claude Sonnet 4.5
- `kr/claude-haiku-4.5` - Claude Haiku 4.5
- `kr/glm-5` - GLM 5
- `kr/MiniMax-M2.5` - MiniMax M2.5
- `kr/qwen3-coder-next` - Qwen3 Coder Next
- `kr/deepseek-3.2` - DeepSeek 3.2

**OpenCode Free (`oc/`)** - ログイン不要:
- `oc/<auto>` - モデルリスト自動取得

**Vertex AI (`vertex/`)** - $300無料クレジット:
- `vertex/gemini-3.1-pro-preview` - Gemini 3.1 Pro Preview
- `vertex/gemini-3-flash-preview` - Gemini 3 Flash Preview

---

## コスト最適化戦略

### 月予算: $10〜20/月

```
1. クイックタスクにAntigravity無料階層(Googleアカウント)を使用
2. Claude Codeサブスクリプションのクォータを完全利用(すでに支払い済み)
3. クォータ切れ時はGLM(100万あたり$0.6)へフォールバック
4. 緊急時: MiniMax M2.1(100万あたり$0.20)またはKiro(無料)

実例(月1億トークン):
  Antigravity経由で6000万: $0(無料階層)
  Claude Code経由で3000万: $0(既存サブスクリプション)
  GLM経由で800万: $4.80
  MiniMax経由で200万: $0.40
  合計: 月$5.20 + 既存サブスクリプション
```

### クォータリセット戦略

```
日課:
1. 朝: Claude Codeの新しいクォータ(5時間リセット)
2. 午後: Antigravityへ切替(無料日次クォータ)
3. 夕方: GLM日次クォータ(翌朝10時リセット)
4. 深夜: MiniMax(5時間ローリング)またはKiro(無料)

→ 最小の追加コストで24時間コーディング!
```

---

## 次のステップ

- [インストール詳細](installation.md) - 要件、トラブルシューティング
- [機能](../features/smart-routing.md) - クォータトラッキング、コンボ、デプロイを確認
- [FAQ](../faq.md) - よくある質問と回答
- [トラブルシューティング](../troubleshooting.md) - 一般的な問題の修正

---

## ヘルプが必要?

- **ウェブサイト**: [9router.com](https://9router.com)
- **GitHub**: [github.com/vibecoder11200/9router](https://github.com/vibecoder11200/9router)
- **Issues**: [github.com/vibecoder11200/9router/issues](https://github.com/vibecoder11200/9router/issues)
