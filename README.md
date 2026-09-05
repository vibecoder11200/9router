<div align="center">
  <img src="./images/9router.png?1" alt="9Router Dashboard" width="800"/>
  
  # 9Router - FREE AI Router & Token Saver
  
  **Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**
  
  **Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**
  
  [![npm](https://img.shields.io/npm/v/9router.svg)](https://www.npmjs.com/package/9router)
  [![Downloads](https://img.shields.io/npm/dm/9router.svg)](https://www.npmjs.com/package/9router)
  [![Docker Pulls](https://img.shields.io/docker/pulls/vibecoder11200/9router.svg?logo=docker&label=Docker%20pulls)](https://hub.docker.com/r/vibecoder11200/9router)
  [![GHCR](https://img.shields.io/badge/GHCR-vibecoder11200%2F9router-blue?logo=github)](https://github.com/vibecoder11200/9router/pkgs/container/9router)
  [![License](https://img.shields.io/npm/l/9router.svg)](https://github.com/vibecoder11200/9router/blob/main/LICENSE)

<a href="https://trendshift.io/repositories/22628" target="_blank"><img src="https://trendshift.io/api/badge/repositories/22628" alt="vibecoder11200%2F9router | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

[🚀 Quick Start](#-quick-start) • [💡 Features](#-key-features) • [📖 Setup](#-setup-guide) • [🌐 Website](https://9router.com)

[🇧🇷 Português (Brasil)](./i18n/README.pt-BR.md) • [🇻🇳 Tiếng Việt](./i18n/README.vi.md) • [🇨🇳 中文](./i18n/README.zh-CN.md) • [🇯🇵 日本語](./i18n/README.ja-JP.md) • [🇷🇺 Русский](./i18n/README.ru.md) • [🇹🇭 ไทย](./i18n/README.th.md) • [🇮🇷 فارسی](./i18n/README.fa_IR.md) • [🇮🇩 Indonesia](./i18n/README.id-ID.md) • [🇪🇸 Español](./i18n/README.es.md) • [🇫🇷 Français](./i18n/README.fr.md)

> 🔀 **This is a feature-enhanced fork** of [decolua/9router](https://github.com/decolua/9router), adding a **managed V2Ray/Xray proxy** (v2go), **DeepSeek Web (DS2API) sidecar**, **rotating proxy pools**, **Genspark/Gemini web-cookie providers**, **external tunnel URL**, and more. Distributed via [GitHub Releases](https://github.com/vibecoder11200/9router/releases) (not npm). See [⭐ Fork Features](#-fork-features) below.

</div>

---

## 🤔 Why 9Router?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)
- ❌ Manual switching between providers

**9Router solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result content, save 20-40% tokens per request
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with Claude Code, Codex, Cursor, Cline, any CLI tool

---

## 🔄 How It Works

```
┌─────────────┐
│  Your CLI   │  (Claude Code, Codex, OpenClaw, Cursor, Cline...)
│   Tool      │
└──────┬──────┘
       │ http://localhost:20128/v1
       ↓
┌─────────────────────────────────────────────┐
│           9Router (Smart Router)            │
│  • RTK Token Saver (cut tool_result tokens) │
│  • Format translation (OpenAI ↔ Claude)     │
│  • Quota tracking                           │
│  • Auto token refresh                       │
└──────┬──────────────────────────────────────┘
       │
       ├─→ [Tier 1: SUBSCRIPTION] Claude Code, Codex, GitHub Copilot
       │   ↓ quota exhausted
       ├─→ [Tier 2: CHEAP] GLM ($0.6/1M), MiniMax ($0.2/1M)
       │   ↓ budget limit
       └─→ [Tier 3: FREE] Kiro, OpenCode Free, Vertex ($300 credits)

Result: Never stop coding, minimal cost + 20-40% token savings via RTK
```

---

## ⭐ Fork Features

> Additions in **this fork** (`vibecoder11200/9router`) on top of upstream. All are optional and ship disabled by default.

| Feature | What it adds | Where to enable |
| --- | --- | --- |
| 🛰️ **V2Ray Proxy (v2go)** | Managed local **Xray-core** client that turns V2Ray share links (VLESS/VMess/Trojan/SS) from [v2go](https://github.com/Danialsamadi/v2go) into a SOCKS5/HTTP proxy 9Router can route through. Auto-syncs ~1,000+ working configs hourly, per-server latency testing, zero-downtime blue-green auto-rotation (flaky-node + edge-banned-IP quarantine), and a **Model Proxy Filter** that finds the configs a given model actually works through. Bundles the Xray-core binary (auto-download per OS/arch). Creates a managed Proxy Pool you can assign to any connection. *(v0.6.0+)* | Dashboard → **V2Ray Proxy** |
| 🐬 **DeepSeek Web (DS2API)** | Runs a local Go sidecar that turns your DeepSeek Web session into an OpenAI-compatible endpoint. Managed start/stop/install/**update**, per-account proxies + **rotating proxy groups** (round-robin/random/failover). Engine pulled from [`vibecoder11200/ds2api`](https://github.com/vibecoder11200/ds2api) `v4.6.2-rotation`. | Dashboard → **DeepSeek Web** |
| 🔀 **Proxy Pools & Rotating Groups** | Single-proxy pools **or** rotating groups (many proxies + optional "direct" server-IP slot). Per-request rotation: **on-error** (LRU) / **round-robin** / **random**. All protocols (http, https, socks5/5h/4/4a). Batch import. `strictProxy` fail-hard. Auto-cooldown (60s rate-limit, 30s 5xx). Bind to any provider connection. | Dashboard → **Proxy Pools** |
| 🌐 **No-auth provider rotation** | Free no-auth providers (OpenCode Free, mimo-free…) can be bound to a rotating pool group from their provider page — set **Rotation Strategy** to round-robin/random (needs ≥2 active pools) to spread requests across IPs. | Provider page → **Proxy / Rotation** card |
| 🤖 **Genspark Web** | Cookie-based Genspark Copilot MOA backend. Chat + **image generation** (`COPILOT_MOA_IMAGE`). Append `-search` to any model for web grounding. Prefix `genspark-web/` (`gspark`). | Dashboard → Providers → **Genspark Web** |
| ♊ **Gemini Web** | Cookie-based `gemini.google.com` (internal `StreamGenerate` RPC). Cookie pool up to 5, round-robin, 15-min health checks, auto-disable dead cookies. LLM + image + video + audio. Prefix `gemini-web/` (`gweb`). | Dashboard → Providers → **Gemini Web** |
| 🐟 **TOTU AI Auto-Fetch (Lấy acc)** | One-click account farming for the TOTU AI free NewAPI gateway: creates a temp mail.tm mailbox, captures the email OTP, registers + logs in, and saves the `sk-` key (with the dashboard login token) as a provider connection — plus a **per-account $ balance** view (shared with TokenRouter). Optional scheduler auto-fetches on an interval (default off; 15/30/60 min). *(v0.6.29+)* | Dashboard → Providers → **TOTU AI** → **Lấy acc** |
| 🔗 **External Tunnel URL** | Register a tunnel the app does **not** manage (e.g. `cloudflared` via systemd, or any reverse proxy). Combined with *Allow dashboard access via tunnel*, local-only actions (DS2API install/start/stop, tunnel controls, Headroom, MITM) run over that tunnel after login. Setting `externalTunnelUrl`. | Dashboard → Endpoint → **External tunnel URL** |

> Plus everything from **upstream** (regularly merged): PXPipe multimodal token saver, Grok CLI, Perplexity Agent API, Featherless, self-hosted STT/TTS/embedding providers, Headroom extras — all documented in their sections below.

<details>
<summary><b>📖 How the two proxy-group systems differ</b></summary>

This fork has **two independent** proxy-group systems. They are easy to confuse:

- **9Router Proxy Pools** (Dashboard → Proxy Pools) — 9Router's own. Modes: `on-error` / `round-robin` / `random`. Applies to **any** provider connection. Cools down failing entries and tries another entry on the **same account** before account fallback. Code: `src/lib/network/proxyRotation.js`.
- **DS2API proxy groups** (Dashboard → DeepSeek Web) — managed **inside the DS2API Go sidecar** and surfaced through the dashboard. Modes: `round-robin` / `random` / `failover` (+ `sticky` count). Applies **only** to DeepSeek Web accounts. Code: `temp/ds2api/internal/config`.

</details>

---

## ⚡ Quick Start

**1. Install globally:**

> This fork is **distributed via GitHub Releases**, not the npm registry.
> Pick the one-liner for your platform (Node.js >= 18 required):

```bash
# macOS / Linux / WSL
curl -fsSL https://github.com/vibecoder11200/9router/raw/master/install.sh | bash

# Windows (PowerShell)
powershell -c "irm https://github.com/vibecoder11200/9router/raw/master/install.ps1 | iex"

# …or install the latest release tarball directly:
npm install -g https://github.com/vibecoder11200/9router/releases/latest/download/9router.tgz
```

```bash
9router
```

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (~50 credits/month free: Claude 4.5 + GLM-5 + MiniMax) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key: [copy from dashboard]
  Model: kr/claude-sonnet-4.5
```

**That's it!** Start coding with FREE AI models.

**Alternative: run from source (this repository):**

This repository package is private (`9router-app`), so source/Docker execution is the expected local development path.

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

Production mode:

```bash
npm run build
PORT=20128 HOSTNAME=0.0.0.0 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run start
```

Default URLs:

- Dashboard: `http://localhost:20128/dashboard`
- OpenAI-compatible API: `http://localhost:20128/v1`

### 🔄 Update / Nâng cấp

This fork ships via **GitHub Releases** (not npm). The dashboard checks for new
releases automatically on the fork's [GitHub Releases](https://github.com/vibecoder11200/9router/releases)
and shows an **"↑ New version available"** badge in the sidebar when one is
found — click it to copy the upgrade command and shut the server down safely.

To upgrade manually, re-run the install one-liner (it always pulls `latest`):

```bash
# macOS / Linux / WSL
curl -fsSL https://github.com/vibecoder11200/9router/raw/master/install.sh | bash

# Windows (PowerShell)
powershell -c "irm https://github.com/vibecoder11200/9router/raw/master/install.ps1 | iex"

# …or install the latest release tarball directly:
npm install -g https://github.com/vibecoder11200/9router/releases/latest/download/9router.tgz
```

The CLI launcher also checks for updates on start and prints the exact upgrade
command when a newer release exists (run `9router` and watch the menu).

> **Note:** Do **not** run `npm i -g 9router` / `npm i -g 9router@latest` — that
> installs the upstream `decolua` package from npm, not this fork. Always use the
> GitHub Releases tarball URL or the install scripts above.

---

## Video Guides

<div align="center">

<table>
  <tr>
    <td width="50%" align="center"><a href="https://www.youtube.com/watch?v=X69n5Lm06Yw"><img src="https://img.youtube.com/vi/X69n5Lm06Yw/hqdefault.jpg" alt="Tiết kiệm chi phí LLM với 9Router" width="360"/></a></td>
    <td width="50%" align="center"><a href="https://www.youtube.com/watch?v=G-5A_D5Pm6Y"><img src="https://img.youtube.com/vi/G-5A_D5Pm6Y/hqdefault.jpg" alt="Cài đặt OpenClaw Free A-Z" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇻🇳 <b>Tiết kiệm chi phí LLM cho OpenClaw với 9Router</b><br/>by <a href="https://www.youtube.com/c/M%C3%ACAIblog">Mì AI</a></sub></td>
    <td align="center"><sub>🇻🇳 <b>Cài Đặt OpenClaw Free Từ A-Z + 9Router</b><br/>by <a href="https://www.youtube.com/@maigia">Mai Gia</a></sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.youtube.com/watch?v=hPusYX-5Pmw"><img src="https://img.youtube.com/vi/hPusYX-5Pmw/hqdefault.jpg" alt="Bot Zalo AI" width="360"/></a></td>
    <td align="center"><a href="https://www.youtube.com/watch?v=raEyZPg5xE0"><img src="https://img.youtube.com/vi/raEyZPg5xE0/hqdefault.jpg" alt="9Router + Claude Code FREE Setup" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇻🇳 <b>Setup OpenClaw + 9Router: Bot Zalo AI Tự Động A-Z</b><br/>by <a href="https://github.com/tuanminhhole">tuanminhhole</a></sub></td>
    <td align="center"><sub>🇺🇸 <b>9Router + Claude Code FREE Setup</b><br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.youtube.com/watch?v=o3qYCyjrFYg"><img src="https://img.youtube.com/vi/o3qYCyjrFYg/hqdefault.jpg" alt="Claude Code FREE Forever" width="360"/></a></td>
    <td align="center"><a href="https://www.youtube.com/watch?v=Ttpc26m39Dw"><img src="https://img.youtube.com/vi/Ttpc26m39Dw/hqdefault.jpg" alt="Claude CLI Free Setup" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇺🇸 <b>Claude Code FREE Forever — Unlimited Models</b><br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub></td>
    <td align="center"><sub>🇺🇸 <b>Claude CLI Free Setup with 9Router</b><br/>by <a href="https://www.youtube.com/@CodeVerseSoban">CodeVerse Soban</a></sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://youtu.be/VQAw612S27Y"><img src="https://img.youtube.com/vi/VQAw612S27Y/hqdefault.jpg" alt="9Router + Claude Code FREE Setup" width="360"/></a></td>
    <td align="center"><a href="https://www.youtube.com/watch?v=JXmg8_gccgE"><img src="https://img.youtube.com/vi/JXmg8_gccgE/hqdefault.jpg" alt="FREE OpenClaw + Claude Opus" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇵🇰 <b>9Router + Claude Code FREE Unlimited Setup</b><br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub></td>
    <td align="center"><sub>🇺🇸 <b>FREE OpenClaw + Claude Opus 4.6</b><br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.youtube.com/watch?v=3dF5GIYMrcQ"><img src="https://img.youtube.com/vi/3dF5GIYMrcQ/hqdefault.jpg" alt="9Router Setup Tutorial" width="360"/></a></td>
    <td align="center"><a href="https://www.youtube.com/watch?v=CkVZZUSTXAI"><img src="https://img.youtube.com/vi/CkVZZUSTXAI/hqdefault.jpg" alt="Koding 24 Jam Anti Rate Limit" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇺🇸 <b>9Router + Claude Code FREE Setup</b><br/>by <a href="https://www.youtube.com/@BuildAIWithHamid">Build AI With Hamid</a></sub></td>
    <td align="center"><sub>🇮🇩 <b>Koding 24 Jam Anti Rate Limit! Hemat Token AI 65%</b><br/>by <a href="https://www.youtube.com/@krisswuh">Krisswuh</a></sub></td>
  </tr>
  <tr>
    <td align="center"><a href="https://www.youtube.com/watch?v=TXGv4eofe1I"><img src="https://img.youtube.com/vi/TXGv4eofe1I/hqdefault.jpg" alt="Deploy 9Router di Hugging Face" width="360"/></a></td>
    <td align="center"><a href="https://www.youtube.com/watch?v=GyX-DLvePW8"><img src="https://img.youtube.com/vi/GyX-DLvePW8/hqdefault.jpg" alt="Persian tutorial" width="360"/></a></td>
  </tr>
  <tr>
    <td align="center"><sub>🇮🇩 <b>Deploy 9Router di Hugging Face GRATIS Non-Stop</b><br/>by <a href="https://www.youtube.com/@krisswuh">Krisswuh</a></sub></td>
    <td align="center"><sub dir="rtl">🇮🇷 <b>این شکلی از هر API ای استفاده کن برای هوش مصنوعی</b><br/>by <a href="https://www.youtube.com/@Matin_SenPai">Matin SenPai</a></sub></td>
  </tr>
</table>

</div>

> 🎬 **Made a video about 9Router?** Submit a [Pull Request](https://github.com/vibecoder11200/9router/pulls) adding your video to this section — we'll merge it!

---

## 🛠️ Supported CLI Tools

9Router works seamlessly with all major AI coding tools:

<div align="center">
  <table>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/claude.png" width="60" alt="Claude Code"/><br/>
        <b>Claude-Code</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/openclaw.png" width="60" alt="OpenClaw"/><br/>
        <b>OpenClaw</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/codex.png" width="60" alt="Codex"/><br/>
        <b>Codex</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/opencode.png" width="60" alt="OpenCode"/><br/>
        <b>OpenCode</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/cursor.png" width="60" alt="Cursor"/><br/>
        <b>Cursor</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/antigravity.png" width="60" alt="Antigravity"/><br/>
        <b>Antigravity</b>
      </td>
    </tr>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/cline.png" width="60" alt="Cline"/><br/>
        <b>Cline</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/continue.png" width="60" alt="Continue"/><br/>
        <b>Continue</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/droid.png" width="60" alt="Droid"/><br/>
        <b>Droid</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/roo.png" width="60" alt="Roo"/><br/>
        <b>Roo</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/copilot.png" width="60" alt="Copilot"/><br/>
        <b>Copilot</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/kilocode.png" width="60" alt="Kilo Code"/><br/>
        <b>Kilo Code</b>
      </td>
    </tr>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/opendesign.png" width="60" alt="OpenDesign"/><br/>
        <b>OpenDesign</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/jcode.png" width="60" alt="jcode"/><br/>
        <b>jcode</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/grok-cli.png" width="60" alt="Grok Build"/><br/>
        <b>Grok Build</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/devin-cli.png" width="60" alt="Devin CLI"/><br/>
        <b>Devin CLI</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/deepseek-tui.png" width="60" alt="DeepSeek TUI"/><br/>
        <b>DeepSeek TUI</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/qwen.png" width="60" alt="Qwen Code"/><br/>
        <b>Qwen Code</b>
      </td>
    </tr>
  </table>
</div>

---

## 🌐 Supported Providers

### 🔐 OAuth Providers

<div align="center">
  <table>
    <tr>
      <td align="center" width="120">
        <img src="./public/providers/claude.png" width="60" alt="Claude Code"/><br/>
        <b>Claude-Code</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/antigravity.png" width="60" alt="Antigravity"/><br/>
        <b>Antigravity</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/codex.png" width="60" alt="Codex"/><br/>
        <b>Codex</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/github.png" width="60" alt="GitHub"/><br/>
        <b>GitHub</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/cursor.png" width="60" alt="Cursor"/><br/>
        <b>Cursor</b>
      </td>
      <td align="center" width="120">
        <img src="./public/providers/kimchi.png" width="60" alt="Kimchi"/><br/>
        <b>Kimchi</b>
      </td>
    </tr>
  </table>
</div>

### 🆓 Free Providers

<div align="center">
  <table>
    <tr>
      <td align="center" width="150">
        <img src="./public/providers/kiro.png" width="70" alt="Kiro"/><br/>
        <b>Kiro AI</b><br/>
        <sub>Claude 4.5 + GLM-5 + MiniMax<br/>50 credits/month free</sub>
      </td>
      <td align="center" width="150">
        <img src="./public/providers/opencode.png" width="70" alt="OpenCode Free"/><br/>
        <b>OpenCode Free</b><br/>
        <sub>No auth • Auto-fetch models<br/>Free (model list varies)</sub>
      </td>
      <td align="center" width="150">
        <img src="./public/providers/gemini.png" width="70" alt="Vertex AI"/><br/>
        <b>Vertex AI</b><br/>
        <sub>Gemini 3 Pro + GLM-5 + DeepSeek<br/>$300 credits free</sub>
      </td>
    </tr>
  </table>
</div>

> **Note:** iFlow, Qwen Code and Gemini CLI free tiers were discontinued in 2026. Use Kiro / OpenCode Free / Vertex instead.
>
> **Kiro AI** moved to a paid model in Sep 2025 — the free tier is now capped at **50 credits/month** (plus 500 trial credits for new accounts in the first 30 days). Paid tiers: Pro $20/mo (1,000 credits), Pro+ $40/mo (2,000), Pro Max $100/mo (5,000), Power $200/mo (10,000).
> **OpenCode Free** model list fluctuates over time (some models free only for limited promos) — subject to change without notice.
> **Vertex AI**: the $300 free credit for new GCP accounts is still valid, but since Mar 2026 the **Gemini API endpoint no longer consumes these credits** — call the **Vertex AI Studio** endpoint instead.

### 🍪 Web-Cookie Providers · *fork*

> Authenticate with a browser **session cookie** instead of an API key — turns web-only AI into an OpenAI-compatible endpoint. *Added by this fork.*

| Provider | Prefix | What you get |
| --- | --- | --- |
| **Gemini Web** | `gemini-web/` (`gweb`) | `gemini.google.com` via internal RPC. LLM + image + video + audio. Cookie pool (up to 5, round-robin, 15-min health checks, auto-disable dead cookies). |
| **Genspark Web** | `genspark-web/` (`gspark`) | Genspark Copilot MOA chat + **image generation** (`COPILOT_MOA_IMAGE`). Append `-search` to any model for web grounding. |
| **DeepSeek Web** | `ds2api/` | Your DeepSeek Web session, via a managed local sidecar. See [⭐ Fork Features](#-fork-features). |

**Setup:** open the provider in Dashboard → Providers, paste the session cookie (JSON from a cookie editor, or the bare `session_id` value), and the models appear automatically.

### 🔑 API Key Providers (40+)

<div align="center">
  <table>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/openrouter.png" width="50" alt="OpenRouter"/><br/>
        <sub>OpenRouter</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/glm.png" width="50" alt="GLM"/><br/>
        <sub>GLM</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/kimi.png" width="50" alt="Kimi"/><br/>
        <sub>Kimi</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/minimax.png" width="50" alt="MiniMax"/><br/>
        <sub>MiniMax</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/openai.png" width="50" alt="OpenAI"/><br/>
        <sub>OpenAI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/anthropic.png" width="50" alt="Anthropic"/><br/>
        <sub>Anthropic</sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/gemini.png" width="50" alt="Gemini"/><br/>
        <sub>Gemini</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/deepseek.png" width="50" alt="DeepSeek"/><br/>
        <sub>DeepSeek</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/groq.png" width="50" alt="Groq"/><br/>
        <sub>Groq</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/xai.png" width="50" alt="xAI"/><br/>
        <sub>xAI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/mistral.png" width="50" alt="Mistral"/><br/>
        <sub>Mistral</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/perplexity.png" width="50" alt="Perplexity"/><br/>
        <sub>Perplexity</sub>
      </td>
    </tr>
    <tr>
      <td align="center" width="100">
        <img src="./public/providers/together.png" width="50" alt="Together"/><br/>
        <sub>Together AI</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/fireworks.png" width="50" alt="Fireworks"/><br/>
        <sub>Fireworks</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/cerebras.png" width="50" alt="Cerebras"/><br/>
        <sub>Cerebras</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/cohere.png" width="50" alt="Cohere"/><br/>
        <sub>Cohere</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/nvidia.png" width="50" alt="NVIDIA"/><br/>
        <sub>NVIDIA</sub>
      </td>
      <td align="center" width="100">
        <img src="./public/providers/siliconflow.png" width="50" alt="SiliconFlow"/><br/>
        <sub>SiliconFlow</sub>
      </td>
    </tr>
  </table>
  <p><i>...and 20+ more providers including Grok CLI (OAuth), Perplexity Agent API, Featherless, Cloudflare AI, Nebius, Chutes, Hyperbolic, Venice AI, TokenRouter, OrcaRouter, TOTU AI, and custom OpenAI/Anthropic compatible endpoints</i></p>
</div>

### 🏠 Self-hosted Providers

For speech and embeddings served from **your own** machine — whisper.cpp,
faster-whisper, Speaches, Kokoro-FastAPI, openedai-speech, llama.cpp/llama-server,
vLLM, Infinity, text-embeddings-inference, or anything else that speaks the OpenAI
shape.

| Provider | Endpoint used | Typical server |
| --- | --- | --- |
| **Self-hosted STT** | `/v1/audio/transcriptions` | whisper.cpp, faster-whisper |
| **Self-hosted TTS** | `/v1/audio/speech` | Kokoro-FastAPI, openedai-speech |
| **Self-hosted Embedding** | `/v1/embeddings` | llama-server, vLLM, Infinity |

Every other speech provider is a named cloud service with a fixed endpoint. These
three read their address from **each connection**, so one provider can front
several machines and load-balance across them like any other.

Set it on the connection as `providerSpecificData.baseUrl`:

| Provider | Give it | Result |
| --- | --- | --- |
| Self-hosted STT | the full URL — `http://host:8080/v1/audio/transcriptions` | used as-is |
| Self-hosted TTS | the server root — `http://host:8880` | `+ /v1/audio/speech` |
| Self-hosted Embedding | the **OpenAI base**, `/v1` included — `http://host:8080/v1` | `+ /embeddings` |

> **Mind the `/v1` on embeddings.** The adapter appends `/embeddings`, so
> `http://host:8080` resolves to `http://host:8080/embeddings` and misses the
> OpenAI route — llama-server answers **501**. Give it the same base URL an OpenAI
> client would use. A full `.../v1/embeddings` is also accepted, so a value pasted
> from a `curl` example works too.

The API key is not checked by most local servers, but the field must be non-empty:
it is what gives the connection a credentials record, and `baseUrl` lives there.
Any placeholder works.

Self-hosted Embedding has **no cloud fallback by design** — a connection saved
without a `baseUrl` is reported as a configuration error rather than quietly
falling back to `api.openai.com`, which would send your input text and API key to
a third party under a provider named "Self-hosted".

---

## 💡 Key Features

| Feature                                                                           | What It Does                                                                             | Why It Matters                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 🚀 **RTK Token Saver** ([RTK](https://github.com/rtk-ai/rtk) ⭐40K)               | Compress tool outputs (`git diff`, `grep`, `ls`, `tree`...) before sending to LLM        | Save **20-40% input tokens** per request          |
| 🧠 **Headroom Token Saver** ([Headroom](https://github.com/chopratejas/headroom)) | Optional external `/v1/compress` proxy before provider routing                           | Save more context tokens without changing clients |
| 🖼️ **PXPipe Token Saver**                                                         | **In-process** multimodal compression — re-renders Claude-format context as dense images (Anthropic bills images by pixels, not text length) | Save context tokens on long Claude requests |
| 🪨 **Caveman Mode** ([Caveman](https://github.com/JuliusBrussee/caveman) ⭐52K)   | Inject caveman-speak prompt → LLM replies terse, technical substance preserved           | Save **up to 65% output tokens**                  |
| 🐴 **Ponytail** ([Ponytail](https://github.com/DietrichGebert/ponytail))          | Inject "lazy senior dev" prompt → LLM writes minimal, YAGNI-first code (Lite/Full/Ultra) | **Fewer output tokens, less refactoring**         |
| 🛰️ **V2Ray Proxy (v2go)** · *fork*                                                | Managed Xray-core client → SOCKS5/HTTP proxy from free V2Ray share links (auto-synced)   | Premium-grade proxies for any provider, free      |
| 🐬 **DeepSeek Web (DS2API)** · *fork*                                             | Local Go sidecar turns your DeepSeek Web session into an OpenAI endpoint                 | Use DeepSeek Web from any CLI tool                |
| 🔀 **Proxy Pools & Rotating Groups** · *fork*                                     | Single-proxy pools **or** rotating groups (on-error/round-robin/random + direct slot)    | Spread load, beat IP rate-limits                  |
| 🤖 **Web-Cookie Providers** · *fork*                                              | Genspark (MOA + image), Gemini Web (multimodal, cookie pool)                             | Access web-only AI in any CLI tool                |
| 🎯 **Smart 3-Tier Fallback**                                                      | Auto-route: Subscription → Cheap → Free                                                  | Never stop coding, zero downtime                  |
| 📊 **Real-Time Quota Tracking**                                                   | Live token count + reset countdown                                                       | Maximize subscription value                       |
| 🔄 **Format Translation**                                                         | OpenAI ↔ Claude ↔ Gemini ↔ Cursor ↔ Kiro ↔ Vertex                                        | Works with any CLI tool                           |
| 👥 **Multi-Account Support**                                                      | Multiple accounts per provider                                                           | Load balancing + redundancy                       |
| 🔄 **Auto Token Refresh**                                                         | OAuth tokens refresh automatically                                                       | No manual re-login needed                         |
| 🎨 **Custom Combos**                                                              | Create unlimited model combinations                                                      | Tailor fallback to your needs                     |
| 📝 **Request Logging**                                                            | Debug mode with full request/response logs                                               | Troubleshoot issues easily                        |
| 💾 **Cloud Sync**                                                                 | Sync config across devices                                                               | Same setup everywhere                             |
| 📊 **Usage Analytics**                                                            | Track tokens, cost, trends over time                                                     | Optimize spending                                 |
| 🌐 **Deploy Anywhere**                                                            | Localhost, VPS, Docker, Cloudflare Workers                                               | Flexible deployment options                       |

Set `X-9Router-Token-Saver: off` to bypass all token savers for one chat request.

<details>
<summary><b>📖 Feature Details</b></summary>

### 🚀 RTK Token Saver

Tool outputs (`git diff`, `grep`, `find`, `ls`, `tree`, log dumps...) often eat 30-50% of your prompt budget. RTK detects them and applies smart, lossless compression **before** the request hits the LLM:

- **Filters:** `git-diff`, `git-status`, `grep`, `find`, `ls`, `tree`, `dedup-log`, `smart-truncate`, `read-numbered`, `search-list`
- **Auto-detect:** No config needed — RTK peeks the first 1KB of each `tool_result` and picks the right filter.
- **Safe by design:** If a filter fails, throws, or makes output bigger, RTK silently keeps the original text. Errors never break your request.
- **Universal:** Works across all formats (OpenAI, Claude, Gemini, Cursor, Kiro, OpenAI Responses) because it runs **before** any format translation.
- **Default ON:** Toggle anytime in Dashboard → Endpoint settings.

```
Without RTK: 47K tokens sent to LLM
With RTK:    28K tokens sent to LLM   (40% saved · same context · same answer)
```

### 🧠 Headroom Token Saver

Headroom is optional and runs separately. 9Router calls Headroom's local `/v1/compress` endpoint, then keeps normal routing, fallback, auth, and usage tracking:

```
Client → 9Router → Headroom /v1/compress → 9Router → provider
```

Local setup:

```bash
pip install "headroom-ai[proxy]"
headroom proxy --port 8787
```

Enable in Dashboard → Endpoint → Token Saver → Headroom. Default URL: `http://localhost:8787` (override with `HEADROOM_URL`).

**Optional extras** (install from the same Headroom card in the dashboard):

- **`code`** — tree-sitter AST-based code compression.
- **`ml`** — Kompress-v2 HuggingFace model compression.

The dashboard auto-detects installed extras via `pip list`, and offers one-click install/uninstall with a live log. Other extras (image, voice, otel, …) aren't tracked since they don't help token compression.

Docker examples:

```bash
# Headroom service in same Docker network
http://headroom:8787

# Headroom running on host machine
http://host.docker.internal:8787
```

If Headroom is down or returns an error, 9Router fails open and sends the original request.

### 🖼️ PXPipe Token Saver

PXPipe is a **multimodal** compressor: it re-renders dense Claude-format text context as compact images. Anthropic bills images by **pixels** (pixels/750) rather than encoded text length, so a long context can cost fewer tokens as an image than as text.

- **In-process** — runs as a library inside 9Router (no separate daemon/port). The npm package is installed on first enable.
- **Claude-only** — only transforms Claude-format requests above a size threshold (`pxpipeMinChars`, default 25000 chars).
- **Fail-open** — any error/timeout leaves the request untouched.
- **Default off** — enable in Dashboard → **Token Saver** (the `pxpipeEnabled` toggle). Stats and a health check live under Dashboard → **Pxpipe**.

Stacks with RTK (which runs first and strips agentic noise) and Headroom (external text compression).

### 🐴 Ponytail (Lazy Senior Dev)

Ponytail injects a _"lazy senior dev"_ system prompt into every request, biasing the LLM toward minimal, YAGNI-first code — deletion over addition, stdlib over new deps, one-liners over abstractions. Adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail).

- **Lite** — Build what's asked, name the lazier alternative.
- **Full** — YAGNI ladder enforced: stdlib → native → existing deps → one-liner → minimal code.
- **Ultra** — YAGNI extremist: deletion first, ship the one-liner, challenge the rest of the requirement in the same response.

```
Without Ponytail: verbose code, extra abstractions, "just in case" scaffolding
With Ponytail:    shortest working diff, no unrequested abstractions, fewer tokens
```

Never trades away: input validation, error handling that prevents data loss, security, accessibility, or anything explicitly requested. Enable in Dashboard → Endpoint → Ponytail. Stacks with Caveman (output terseness) and RTK (input compression).

### 🎯 Smart 3-Tier Fallback

Create combos with automatic fallback:

```
Combo: "my-coding-stack"
  1. cc/claude-opus-5          (your subscription)
  2. glm/glm-4.7               (cheap backup, $0.6/1M)
  3. kr/claude-sonnet-4.5      (free fallback)

→ Auto switches when quota runs out or errors occur
```

### 📊 Real-Time Quota Tracking

- Token consumption per provider
- Reset countdown (5-hour, daily, weekly)
- Cost estimation for paid tiers
- Monthly spending reports

### 🔄 Format Translation

Seamless translation between formats:

- **OpenAI** ↔ **Claude** ↔ **Gemini** ↔ **Cursor** ↔ **Kiro** ↔ **Vertex** ↔ **Antigravity** ↔ **Ollama** ↔ **OpenAI Responses**
- Your CLI tool sends OpenAI format → 9Router translates → Provider receives native format
- Works with any tool that supports custom OpenAI endpoints

### 👥 Multi-Account Support

- Add multiple accounts per provider
- Auto round-robin or priority-based routing
- Fallback to next account when one hits quota

### 🔄 Auto Token Refresh

- OAuth tokens automatically refresh before expiration
- No manual re-authentication needed
- Seamless experience across all providers

### 🎨 Custom Combos

- Create unlimited model combinations
- Mix subscription, cheap, and free tiers
- Name your combos for easy access
- Share combos across devices with Cloud Sync

### 📝 Request Logging

- Enable debug mode for full request/response logs
- Track API calls, headers, and payloads
- Troubleshoot integration issues
- Export logs for analysis

### 💾 Cloud Sync

- Sync providers, combos, and settings across devices
- Automatic background sync
- Secure encrypted storage
- Access your setup from anywhere

#### Cloud Runtime Notes

- Prefer server-side cloud variables in production:
  - `BASE_URL` (internal callback URL used by sync scheduler)
  - `CLOUD_URL` (cloud sync endpoint base)
- `NEXT_PUBLIC_BASE_URL` and `NEXT_PUBLIC_CLOUD_URL` are still supported for compatibility/UI, but server runtime now prioritizes `BASE_URL`/`CLOUD_URL`.
- Cloud sync requests now use timeout + fail-fast behavior to avoid UI hanging when cloud DNS/network is unavailable.

### 📊 Usage Analytics

- Track token usage per provider and model
- Cost estimation and spending trends
- Monthly reports and insights
- Optimize your AI spending

> **💡 IMPORTANT - Understanding Dashboard Costs:**
>
> The "cost" displayed in Usage Analytics is **for tracking and comparison purposes only**.
> 9Router itself **never charges** you anything. You only pay providers directly (if using paid services).
>
> **Example:** If your dashboard shows "$290 total cost" while using Kiro models, this represents
> what you would have paid using paid APIs directly. Your actual cost = **$0** (Kiro free tier: ~50 credits/mo).
>
> Think of it as a "savings tracker" showing how much you're saving by using free models or
> routing through 9Router!

### 🌐 Deploy Anywhere

- 💻 **Localhost** - Default, works offline
- ☁️ **VPS/Cloud** - Share across devices
- 🐳 **Docker** - One-command deployment
- 🚀 **Cloudflare Workers** - Global edge network

</details>

---

## 💰 Cost & Strategy

### Pricing at a glance

| Tier                | Provider              | Cost         | Quota Reset      | Best For                                |
| ------------------- | --------------------- | ------------ | ---------------- | --------------------------------------- |
| **🚀 TOKEN SAVER**  | **RTK (built-in)**    | **FREE**     | Always on        | **Save 20-40% tokens on EVERY request** |
| **💳 SUBSCRIPTION** | Claude Code (Pro/Max) | $20-200/mo   | 5h + weekly      | Already subscribed                      |
|                     | Codex (Plus/Pro)      | $20-200/mo   | 5h + weekly      | OpenAI users                            |
|                     | GitHub Copilot        | $10-19/mo    | Monthly          | GitHub users                            |
|                     | Cursor IDE            | $20/mo       | Monthly          | Cursor users                            |
| **💰 CHEAP**        | GLM-5.1 / GLM-4.7     | $0.6/1M      | Daily 10AM       | Budget backup                           |
|                     | MiniMax M2.7          | $0.2/1M      | 5-hour rolling   | Cheapest option                         |
|                     | Kimi K2.5             | $9/mo flat   | 10M tokens/mo    | Predictable cost                        |
| **🆓 FREE**         | Kiro AI               | $0           | 50 credits/mo    | Claude 4.5 + GLM-5 + MiniMax free (paid tiers above) |
|                     | OpenCode Free         | $0           | Varies*          | No auth, auto-fetch models (list changes over time) |
|                     | Vertex AI             | $300 credits | New GCP accounts | Gemini 3 Pro + DeepSeek + GLM-5 (use Vertex AI Studio endpoint for free credits) |

### Billing reality

- ✅ **9Router = FREE forever** (open source, never charges, no invoices, no credit card).
- ✅ **You pay providers directly** — subscriptions on their websites, or API fees. 9Router just routes.
- ✅ **Dashboard "cost" is a savings tracker, not a bill.** It shows what you *would have* paid using paid APIs — e.g. "$290 displayed" while using Kiro free tier means you **saved** $290, actual payment $0.
- ❌ **FREE providers have free-tier limits** (Kiro ~50 credits/mo, OpenCode/Vertex per their terms). iFlow/Qwen/Gemini CLI free tiers were discontinued in 2026.

### Example combos

| Combo | Layers (fallback top → bottom) | Monthly cost |
| --- | --- | --- |
| **free-forever** | `kr/claude-sonnet-4.5` → `kr/glm-5` → `oc/<auto>` (OpenCode Free) | **$0** |
| **maximize-claude** | `cc/claude-opus-5` (subscription) → `glm/glm-5.1` (cheap) → `kr/claude-sonnet-4.5` (free fallback) | ~$25 |
| **always-on** | `cc/claude-opus-5` → `cx/gpt-5.5` → `glm/glm-5.1` → `minimax/MiniMax-M2.7` → `kr/claude-sonnet-4.5` | $30-220 |
| **openclaw-free** | `kr/claude-sonnet-4.5` → `kr/glm-5` → `kr/MiniMax-M2.5` — free AI in WhatsApp/Telegram/Slack/Discord/iMessage/Signal | **$0** |

> 💡 **Pro Tip:** RTK + Kiro + OpenCode Free = **$0 cost + 20-40% token savings**.

---

## ❓ Frequently Asked Questions

<details>
<summary><b>📊 Why does my dashboard show high costs? Will I be charged?</b></summary>

The dashboard "cost" is a **savings tracker**, not a bill — it shows what you *would have* paid using paid APIs. **9Router never charges you** (open source, no invoices, no credit card). You only pay providers directly (subscriptions/API fees). Example: "$290 displayed" while using Kiro free tier = you **saved** $290, actual payment $0. See [💰 Cost & Strategy](#-cost--strategy) for full pricing, free-tier limits, and example combos.

</details>

<details>
<summary><b>🆓 Are FREE providers really free? Which ones still work?</b></summary>

**Yes, within free-tier limits** — Kiro AI (~50 credits/mo + 500 trial credits for new accounts in first 30 days), OpenCode Free (no-auth, model list fluctuates), Vertex AI ($300 credits for new GCP accounts — use the **Vertex AI Studio** endpoint since the Gemini API stopped consuming credits in Mar 2026). 9Router just routes; no catch, no future billing.

**Discontinued (don't use):** ❌ iFlow (paid since 2026) · ❌ Qwen Code (Alibaba discontinued free OAuth 2026-04-15) · ❌ Gemini CLI (Google shut down 2026-06-18, replaced by Antigravity CLI).

</details>

---

## 📖 Setup Guide

### 🔌 Connect a provider

All providers connect from **Dashboard → Providers**. Point your CLI tool at `http://localhost:20128/v1` (API key from the dashboard), then use the model prefix.

| Tier | Provider | How to connect | Model examples |
| --- | --- | --- | --- |
| 💳 **Subscription** | Claude Code | OAuth login → auto token refresh | `cc/claude-opus-5`, `cc/claude-sonnet-5` |
| 💳 | Codex | OAuth (port 1455) | `cx/gpt-5.6-sol`, `cx/gpt-5.5` |
| 💳 | GitHub Copilot | OAuth via GitHub (monthly reset) | `gh/gpt-5.4`, `gh/claude-opus-4.7`, `gh/gemini-3.1-pro-preview` |
| 💳 | Cursor IDE | OAuth login | `cu/claude-4.6-opus-max`, `cu/gpt-5.3-codex` |
| 💰 **Cheap** | GLM | API key from [Zhipu AI](https://open.bigmodel.cn/) — Coding Plan = 3× quota at 1/7 cost, resets daily 10 AM | `glm/glm-5.1`, `glm/glm-4.7` |
| 💰 | MiniMax | API key from [MiniMax](https://www.minimax.io/) — cheapest for long context | `minimax/MiniMax-M2.7` |
| 💰 | Kimi | API key from [Moonshot AI](https://platform.moonshot.ai/) — $9/mo flat for 10M tokens | `kimi/kimi-k2.5`, `kimi/kimi-k2.5-thinking` |

> **Pro Tip:** In any combo, order models Subscription → Cheap → Free so 9Router auto-falls through tiers when quota runs out. See [💰 Cost & Strategy](#-cost--strategy) for ready-made combos.

### 🆓 FREE providers (recommended)

<div align="center">
<table>
<tr>
<td width="33%" valign="top">

**Kiro AI** · `kr/`
~50 credits/mo free (500 trial for new accounts in first 30 days). Best free Claude.

```
Dashboard → Connect Kiro
→ AWS Builder ID / Google / GitHub

kr/claude-sonnet-4.5
kr/claude-haiku-4.5
kr/glm-5
kr/MiniMax-M2.5
kr/qwen3-coder-next
kr/deepseek-3.2
```

</td>
<td width="33%" valign="top">

**OpenCode Free** · `oc/`
No login — passthrough proxy. Fastest setup. Model list auto-fetched from `opencode.ai/zen/v1/models` (fluctuates over time).

```
Dashboard → Connect OpenCode Free
→ No login required
→ Use oc/<auto> in combos
```

</td>
<td width="33%" valign="top">

**Vertex AI** · `vertex/`
$300 free credits for new GCP accounts (90 days). **Use the Vertex AI Studio endpoint** — the Gemini API endpoint stopped consuming credits in Mar 2026.

```
Dashboard → Connect Vertex AI
→ Upload GCP Service Account JSON

vertex/gemini-3.1-pro-preview
vertex/gemini-3-flash-preview
vertex-partner/glm-5-maas
vertex-partner/deepseek-v3.2-maas
```

</td>
</tr>
</table>
</div>

<details>
<summary><b>🛰️ V2Ray Proxy (v2go)</b> · <i>fork</i></summary>

9Router manages a **local Xray-core client** that turns free V2Ray share links (VLESS/VMess/Trojan/Shadowsocks) into a SOCKS5/HTTP proxy 9Router can route any provider through. The config catalog is auto-synced from [v2go](https://github.com/Danialsamadi/v2go), which publishes ~1,000+ working servers via a GitHub Actions pipeline.

### Setup

```
Dashboard → V2Ray Proxy
  → Install Xray-core   (downloads the official binary, one-time, per OS/arch)
  → Sync configs        (pulls the v2go catalog — VLESS/VMess/Trojan/SS)
  → Pick a server       (filter by country / protocol; run a latency test)
  → Start               (launches the local SOCKS5 + HTTP proxy)
  → Assign the pool     (a managed Proxy Pool "V2Ray Proxy (v2go)" is created
                         automatically — bind it to any provider connection)
```

Once started, a managed Proxy Pool named **"V2Ray Proxy (v2go)"** appears in Dashboard → Proxy Pools. Assign it to any provider connection (or to a no-auth provider's **Proxy / Rotation** card) and that connection's traffic routes through the active SOCKS proxy.

### Features

- **Auto-sync** — refreshes the server catalog every 60 minutes (configurable) from v2go's `AllConfigsSub.txt`.
- **Server selection** — country and protocol filters, per-server latency testing.
- **Auto-rotation** *(optional)* — when the active server dies, 9Router promotes the next-best server automatically.
- **Health checks** — periodic liveness checks (default every 10 min).
- **Share-link parser** — a faithful JS port of v2go's `converter.go`: handles VLESS, VMess, Trojan, Shadowsocks, Hysteria2 with REALITY/TLS/WebSocket/gRPC/XHTTP transports, including the XHTTP host-safety guard that prevents Xray crashes.

### Engine / settings

The Xray-core binary is pinned to `v26.3.27` (MPL-2.0) and auto-downloaded on first use — override the tag with the `XRAY_VERSION` env var. The rest is configured from the dashboard (stored as settings, not env vars):

| Setting | Default | Purpose |
| --- | --- | --- |
| `xrayEnabled` | `false` | Master on/off for the V2Ray proxy |
| `xrayAutoStart` | `false` | Start the proxy when 9Router boots |
| `xrayAutoRotate` | `false` | Promote the next server when the active one dies |
| `xraySocksPort` | `10808` | Local SOCKS5 port |
| `xrayHttpPort` | `10809` | Local HTTP proxy port |
| `xraySubscriptionUrl` | v2go `AllConfigsSub.txt` | Config catalog source |
| `xraySyncIntervalMin` | `60` | Catalog refresh interval (minutes) |
| `xrayHealthCheckIntervalMin` | `10` | Liveness check interval (minutes) |

</details>

<details>
<summary><b>🔀 Proxy Pools & Rotating Groups</b> · <i>fork</i></summary>

A **proxy pool** is either a single proxy or a **rotating group** of many proxies (plus an optional "direct" server-IP slot). Bind it to any provider connection so that connection's outbound traffic goes through the pool.

### Create a pool

```
Dashboard → Proxy Pools → Create

  Type:
    • Single proxy  → one proxyUrl (http/https/socks5/socks5h/socks4/socks4a)
    • Rotating group → multiple entries + rotation mode

  Rotating group options:
    Rotation mode:
      • on-error  (default) — least-recently-used, skips the entry that just failed
      • round-robin — advance to the next entry every request
      • random    — uniform random per request
    Entries:   +proxy  (paste a proxy URL)
               +direct (server's own IP, no proxy)
    strictProxy: ☐  fail hard if the proxy errors (don't fall back to direct)
```

**Batch import:** paste a proxy list (`protocol://user:pass@host:port` or `host:port:user:pass`) to add many entries at once (deduped automatically).

### Bind to a connection

Open a provider connection → **Proxy** → select the pool. Free no-auth providers (OpenCode Free, mimo-free) instead show a **Proxy / Rotation** card on the provider page: set **Rotation Strategy** to round-robin or random (needs ≥2 active pools) to spread requests across IPs.

### How rotation behaves at runtime

- On a **rotatable error** (408/429/rate-limit/quota/capacity/overloaded/5xx), the current entry is cooled down (**60s** for rate-limits, **30s** for 5xx) and the next entry is tried **on the same account**.
- Only when the whole group is exhausted does 9Router fall back to the next account/combo tier.
- `strictProxy = on` disables that graceful fallback for the pool — a failing proxy fails the request instead of leaking your real IP.

</details>

<details>
<summary><b>🐬 DeepSeek Web (DS2API)</b> · <i>fork</i></summary>

9Router manages a **local Go sidecar** that turns your DeepSeek Web session into an OpenAI-compatible endpoint, so any CLI tool can use DeepSeek Web.

### Setup

```
Dashboard → DeepSeek Web
  → Install engine   (downloads vibecoder11200/ds2api v4.6.2-rotation, ~one-time)
  → Add account      (paste your DeepSeek Web credentials)
  → Start engine
  → Enable           (toggles the ds2api provider connection + auto-aliases models)
```

Models are auto-aliased with the `ds2api/` prefix on managed start (e.g. `ds2api/deepseek-chat`), so OpenAI clients work without the prefix too.

### Per-account proxies & rotating groups

The DS2API sidecar has its **own** proxy-group system (separate from 9Router's Proxy Pools):

```
Dashboard → DeepSeek Web → Proxy groups (rotating)
  Strategy: round-robin | random | failover
  Sticky:   N   (requests before rotating — round-robin only, 1–1000)

Each account row → proxy mode: direct | fixed | group
```

- `round-robin` — advance every N requests (sticky).
- `random` — uniform per request.
- `failover` — retry on the next proxy on transport error / 5xx / 408 / 429, replaying the request body.

### Engine / env

The engine is pulled from the [`vibecoder11200/ds2api`](https://github.com/vibecoder11200/ds2api) fork (release `v4.6.2-rotation`) which adds HTTP/HTTPS proxy support on top of upstream's socks5-only build. Override with:

| Env var | Purpose |
| --- | --- |
| `DS2API_VERSION` | Engine release tag (default `v4.6.2-rotation`) |
| `DS2API_URL` | Override the sidecar loopback URL |
| `DS2API_ADMIN_KEY` | Override the auto-generated admin secret |
| `DS2API_CONFIG_PATH` | Sidecar config file location (default `${DATA_DIR}/ds2api/config.json`) |

</details>

<details>
<summary><b>🔧 CLI Integration</b></summary>

### Cursor IDE

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from 9router dashboard]
  Model: cc/claude-opus-5
```

Or use combo: `premium-coding`

### Claude Code

Edit `~/.claude/config.json`:

```json
{
  "anthropic_api_base": "http://localhost:20128/v1",
  "anthropic_api_key": "your-9router-api-key"
}
```

### Codex CLI

```bash
export OPENAI_BASE_URL="http://localhost:20128"
export OPENAI_API_KEY="your-9router-api-key"

codex "your prompt"
```

### OpenClaw

**Option 1 — Dashboard (recommended):**

```
Dashboard → CLI Tools → OpenClaw → Select Model → Apply
```

**Option 2 — Manual:** Edit `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "9router/kr/claude-sonnet-4.5"
      }
    }
  },
  "models": {
    "providers": {
      "9router": {
        "baseUrl": "http://127.0.0.1:20128/v1",
        "apiKey": "sk_9router",
        "api": "openai-completions",
        "models": [
          {
            "id": "kr/claude-sonnet-4.5",
            "name": "Claude Sonnet 4.5 (Kiro Free)"
          }
        ]
      }
    }
  }
}
```

> **Note:** OpenClaw only works with local 9Router. Use `127.0.0.1` instead of `localhost` to avoid IPv6 resolution issues.

### Cline / Continue / RooCode

```
Provider: OpenAI Compatible
Base URL: http://localhost:20128/v1
API Key: [from dashboard]
Model: cc/claude-opus-5
```

</details>

<details>
<summary><b>🚀 Deployment</b></summary>

### VPS Deployment

```bash
# Clone and install
git clone https://github.com/vibecoder11200/9router.git
cd 9router
npm install
npm run build

# Configure
export JWT_SECRET="your-secure-secret-change-this"
export INITIAL_PASSWORD="your-password"
export DATA_DIR="/var/lib/9router"
export PORT="20128"
export HOSTNAME="0.0.0.0"
export NODE_ENV="production"
export NEXT_PUBLIC_BASE_URL="http://localhost:20128"
export NEXT_PUBLIC_CLOUD_URL="https://9router.com"
export API_KEY_SECRET="endpoint-proxy-api-key-secret"
export MACHINE_ID_SALT="endpoint-proxy-salt"

# Start
npm run start

# Or use PM2
npm install -g pm2
pm2 start npm --name 9router -- start
pm2 save
pm2 startup
```

### Docker

Published images (multi-platform `linux/amd64` + `linux/arm64`):

- Docker Hub: [`vibecoder11200/9router`](https://hub.docker.com/r/vibecoder11200/9router)
- GHCR: [`ghcr.io/vibecoder11200/9router`](https://github.com/vibecoder11200/9router/pkgs/container/9router)

**Quick start (use published image):**

```bash
docker run -d \
  --name 9router \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  vibecoder11200/9router:latest
```

→ Open http://localhost:20128

**Build from source (dev):**

```bash
git clone https://github.com/vibecoder11200/9router.git
cd 9router/app
docker build -t 9router .
docker run -d --name 9router -p 20128:20128 \
  -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data 9router
```

**Container defaults:**

- `PORT=20128`
- `HOSTNAME=0.0.0.0`

**Useful commands:**

```bash
docker logs -f 9router
docker restart 9router
docker stop 9router && docker rm 9router
docker pull vibecoder11200/9router:latest   # update to latest
```

**Data persistence:** `$HOME/.9router/db/data.sqlite` on host ↔ `/app/data/db/data.sqlite` in container.

### Environment Variables

| Variable                                             | Default                                  | Description                                                                         |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `JWT_SECRET`                                         | Auto-generated (`~/.9router/jwt-secret`) | JWT signing secret for dashboard auth cookie (override to share across instances)   |
| `INITIAL_PASSWORD`                                   | `123456`                                 | First login password when no saved hash exists                                      |
| `DATA_DIR`                                           | `~/.9router`                             | Main app data location (SQLite at `$DATA_DIR/db/data.sqlite`)                       |
| `PORT`                                               | framework default                        | Service port (`20128` in examples)                                                  |
| `HOSTNAME`                                           | framework default                        | Bind host (Docker defaults to `0.0.0.0`)                                            |
| `NODE_ENV`                                           | runtime default                          | Set `production` for deploy                                                         |
| `BASE_URL`                                           | `http://localhost:20128`                 | Server-side internal base URL used by cloud sync jobs                               |
| `CLOUD_URL`                                          | `https://9router.com`                    | Server-side cloud sync endpoint base URL                                            |
| `NEXT_PUBLIC_BASE_URL`                               | `http://localhost:3000`                  | Backward-compatible/public base URL (prefer `BASE_URL` for server runtime)          |
| `NEXT_PUBLIC_CLOUD_URL`                              | `https://9router.com`                    | Backward-compatible/public cloud URL (prefer `CLOUD_URL` for server runtime)        |
| `API_KEY_SECRET`                                     | `endpoint-proxy-api-key-secret`          | HMAC secret for generated API keys                                                  |
| `MACHINE_ID_SALT`                                    | `endpoint-proxy-salt`                    | Salt for stable machine ID hashing                                                  |
| `ENABLE_REQUEST_LOGS`                                | `false`                                  | Enables request/response logs under `logs/`                                         |
| `AUTH_COOKIE_SECURE`                                 | `false`                                  | Force `Secure` auth cookie (set `true` behind HTTPS reverse proxy)                  |
| `REQUIRE_API_KEY`                                    | `false`                                  | Enforce Bearer API key on `/v1/*` routes (recommended for internet-exposed deploys) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | empty                                    | Optional outbound proxy for upstream provider calls                                 |
| `SEARXNG_URL`                                        | `http://localhost:8888/search`           | Endpoint for the built-in unauthenticated SearXNG web-search provider               |
| `DS2API_URL` · *fork*                                | auto (loopback)                          | Override the DeepSeek Web sidecar URL                                                |
| `DS2API_VERSION` · *fork*                             | `v4.6.2-rotation`                        | DS2API engine release tag (pulled from `vibecoder11200/ds2api`)                     |
| `DS2API_ADMIN_KEY` · *fork*                           | auto-generated                           | Override the DS2API sidecar admin secret                                              |
| `XRAY_VERSION` · *fork*                               | `v26.3.27`                               | Xray-core binary release tag (auto-downloaded per OS/arch on first use)                |
| `HEADROOM_URL`                                       | `http://localhost:8787`                  | Headroom token-saver proxy endpoint                                                   |

Notes:

- Lowercase proxy variables are also supported: `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`.
- `.env` is not baked into Docker image (`.dockerignore`); inject runtime config with `--env-file` or `-e`.
- On Windows, `APPDATA` can be used for local storage path resolution.
- `INSTANCE_NAME` appears in older docs/env templates, but is currently not used at runtime.

### Runtime Files and Storage

- Main app state: `${DATA_DIR}/db/data.sqlite` (SQLite — providers, combos, aliases, keys, settings, usage history)
- Auto backups: `${DATA_DIR}/db/backups/`
- Optional request/translator logs: `<repo>/logs/...` when `ENABLE_REQUEST_LOGS=true`
- Both `${DATA_DIR}` and `~/.9router` resolve to the same location in a Docker container — the symlink `/root/.9router -> /app/data` is created at build time.

</details>

---

## 📊 Available Models

<details>
<summary><b>View all available models</b></summary>

**Claude Code (`cc/`)** - Pro/Max:

- `cc/claude-opus-5`
- `cc/claude-sonnet-5`
- `cc/claude-fable-5-1`
- `cc/claude-fable-5`
- `cc/claude-haiku-4-5-20251001`

**Codex (`cx/`)** - Plus/Pro:

- `cx/gpt-5.6-sol`
- `cx/gpt-5.5`
- `cx/gpt-5.4`
- `cx/gpt-5.4-mini`
- `cx/gpt-5.3-codex-spark`

**GitHub Copilot (`gh/`)**:

- `gh/gpt-5.4`
- `gh/claude-opus-4.7`
- `gh/claude-sonnet-4.6`
- `gh/gemini-3.1-pro-preview`
- `gh/grok-code-fast-1`

**Cursor (`cu/`)** - Subscription:

- `cu/claude-4.6-opus-max`
- `cu/claude-4.5-sonnet-thinking`
- `cu/gpt-5.3-codex`
- `cu/kimi-k2.5`

**GLM (`glm/`)** - $0.6/1M:

- `glm/glm-5.3`
- `glm/glm-5.1`
- `glm/glm-5`
- `glm/glm-4.7`

**MiniMax (`minimax/`)** - $0.2/1M:

- `minimax/MiniMax-M3`
- `minimax/MiniMax-M2.7`
- `minimax/MiniMax-M2.5`

**Kimi (`kimi/`)** - $9/mo flat:

- `kimi/kimi-k3`
- `kimi/kimi-k2.7-code`
- `kimi/kimi-k2.5`
- `kimi/kimi-k2.5-thinking`

**Kiro (`kr/`)** - Free (~50 credits/month, paid tiers above):

- `kr/claude-sonnet-4.5`
- `kr/claude-haiku-4.5`
- `kr/glm-5`
- `kr/MiniMax-M2.5`
- `kr/qwen3-coder-next`
- `kr/deepseek-3.2`

**OpenCode Free (`oc/`)** - FREE no-auth:

- Auto-fetched from `opencode.ai/zen/v1/models`

**Vertex AI (`vertex/`)** - $300 free credits:

- `vertex/gemini-3.1-pro-preview`
- `vertex/gemini-3-flash-preview`
- `vertex/gemini-2.5-flash`
- `vertex-partner/glm-5-maas`
- `vertex-partner/deepseek-v3.2-maas`

**Grok CLI (`gcli/`)** - OAuth (device-code):

- `gcli/grok-4.5`, `gcli/grok-4.5-high`, `gcli/grok-4.5-medium`, `gcli/grok-4.5-low`

**Perplexity Agent (`perplexity-agent/`)** - API key, Responses API:

- Cross-vendor routing: `perplexity-agent/openai/gpt-5.5`, `perplexity-agent/anthropic/claude-sonnet-4-6`, `perplexity-agent/google/gemini-3.1-pro-preview`, `perplexity-agent/xai/grok-4.20-reasoning`, plus Sonar. (Dynamic — fetched from `/v1/models`.)

**Featherless (`featherless/`)** - API key, OpenAI-compatible:

- `featherless/deepseek-v4-pro`, `featherless/glm-5.2`, `featherless/kimi-k2.7-code`, and more.

**Gemini Web (`gemini-web/`)** · *fork* - cookie auth:

- `gemini-web/gemini-3-pro`, `gemini-web/gemini-3-flash`, `gemini-web/gemini-3-flash-thinking`, `gemini-web/gemini-3-flash-image`, `gemini-web/gemini-3-veo-video`, `gemini-web/gemini-3-audio` (passthrough).

**Genspark Web (`genspark-web/`)** · *fork* - cookie auth:

- `genspark-web/gpt-5-pro`, `genspark-web/claude-sonnet-4-6`, `genspark-web/gemini-3-pro-preview`, `genspark-web/grok-4-0709` (append `-search` for web grounding), plus image models `genspark-web/nano-banana-pro`, `genspark-web/fal-ai/flux-2` (passthrough).

**DeepSeek Web (`ds2api/`)** · *fork* - managed sidecar:

- `ds2api/<deepseek-models>` — bare DeepSeek model names are auto-aliased on managed start.

</details>

---

## 🐛 Troubleshooting

**"Language model did not provide messages"**

- Provider quota exhausted → Check dashboard quota tracker
- Solution: Use combo fallback or switch to cheaper tier

**Rate limiting**

- Subscription quota out → Fallback to GLM/MiniMax
- Add combo: `cc/claude-opus-5 → glm/glm-5.1 → kr/claude-sonnet-4.5`

**OAuth token expired**

- Auto-refreshed by 9Router
- If issues persist: Dashboard → Provider → Reconnect

**High costs**

- Enable RTK in Dashboard → Endpoint settings (default ON, saves 20-40% tokens)
- Check usage stats in Dashboard
- Switch primary model to GLM/MiniMax
- Use free tier (Kiro, OpenCode Free, Vertex) for non-critical tasks

**Dashboard opens on wrong port**

- Set `PORT=20128` and `NEXT_PUBLIC_BASE_URL=http://localhost:20128`

**First login not working**

- Check `INITIAL_PASSWORD` in `.env`
- If unset, fallback password is `123456`

**No request logs under `logs/`**

- Set `ENABLE_REQUEST_LOGS=true`

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 20+
- **Framework**: Next.js 16
- **UI**: React 19 + Tailwind CSS 4
- **Database**: SQLite (better-sqlite3 / node:sqlite / sql.js fallback)
- **Streaming**: Server-Sent Events (SSE)
- **Auth**: OAuth 2.0 (PKCE) + JWT + API Keys

---

## 📝 API Reference

### Chat Completions

```bash
POST http://localhost:20128/v1/chat/completions
Authorization: Bearer your-api-key
Content-Type: application/json

{
  "model": "cc/claude-opus-5",
  "messages": [
    {"role": "user", "content": "Write a function to..."}
  ],
  "stream": true
}
```

### List Models

```bash
GET http://localhost:20128/v1/models
Authorization: Bearer your-api-key

→ Returns all models + combos in OpenAI format
```

## 📧 Support

- **Website**: [9router.com](https://9router.com)
- **GitHub**: [github.com/vibecoder11200/9router](https://github.com/vibecoder11200/9router)
- **Issues**: [github.com/vibecoder11200/9router/issues](https://github.com/vibecoder11200/9router/issues)

---

## 👥 Contributors

Thanks to all contributors who helped make 9Router better!

[![Contributors](https://contrib.rocks/image?repo=vibecoder11200/9router&max=150&columns=15&anon=1&v=20260309)](https://github.com/vibecoder11200/9router/graphs/contributors)

---

## 📊 Star Chart

[![Star Chart](https://starchart.cc/vibecoder11200/9router.svg?variant=adaptive)](https://starchart.cc/vibecoder11200/9router)

## 🔀 Forks

**This repository** — [`vibecoder11200/9router`](https://github.com/vibecoder11200/9router): a feature-enhanced fork of upstream [decolua/9router](https://github.com/decolua/9router). Adds a managed V2Ray/Xray proxy (v2go), DeepSeek Web (DS2API) sidecar, rotating proxy pools/groups, Genspark & Gemini web-cookie providers, external tunnel URL, and a GitHub Releases distribution model. Track changes in [`CHANGELOG.md`](./CHANGELOG.md).

**[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** — A full-featured TypeScript fork of 9Router. Adds 36+ providers, 4-tier auto-fallback, multi-modal APIs (images, embeddings, audio, TTS), circuit breaker, semantic cache, LLM evaluations, and a polished dashboard. 368+ unit tests. Available via npm and Docker.

---

## 🙏 Acknowledgments

Built on the shoulders of giants:

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — original Go implementation that inspired this JavaScript port.
- **[RTK](https://github.com/rtk-ai/rtk)** ![Stars](https://img.shields.io/github/stars/rtk-ai/rtk?style=flat&color=yellow) — Rust token-saver. 9Router ports its compression pipeline to JS → **−20-40% input tokens** on every request.
- **[Caveman](https://github.com/JuliusBrussee/caveman)** ![Stars](https://img.shields.io/github/stars/JuliusBrussee/caveman?style=flat&color=yellow) by **[@JuliusBrussee](https://github.com/JuliusBrussee)** — viral _"why use many token when few token do trick"_. 9Router adapts its prompt → **−65% output tokens**.
- **[Ponytail](https://github.com/DietrichGebert/ponytail)** ![Stars](https://img.shields.io/github/stars/DietrichGebert/ponytail?style=flat&color=yellow) by **[@DietrichGebert](https://github.com/DietrichGebert)** — _"lazy senior dev"_ skill. 9Router injects its YAGNI-first ladder → **fewer tokens, less code, shorter diffs**.

Huge thanks to these authors — without their work, 9Router's token-saving features wouldn't exist. ⭐ them on GitHub!

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with ❤️ for developers who code 24/7</sub>
</div>
