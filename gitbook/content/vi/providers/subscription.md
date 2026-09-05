# Subscription Providers - Tối đa hóa Giá trị

Tối đa hóa subscription AI hiện có với quota tracking thông minh và auto fallback. Dùng hết mọi quota subscription trước khi reset!

---

## Tổng quan

Provider tier subscription là lựa chọn **chính** - bạn đã trả tiền cho chúng, hãy lấy đầy đủ giá trị:

- ✅ **Claude Code** (Pro/Max) - Claude Opus 5 / Sonnet 5 / Haiku 4.5
- ✅ **OpenAI Codex** (Plus/Pro) - GPT 5.6 Sol, GPT 5.5
- ✅ **GitHub Copilot** - GPT-5.4, Claude Sonnet 4.6, Gemini 3.1
- ✅ **Antigravity** (Google) - Gemini 3.8 Flash, Claude Sonnet 4.6

> ⚠️ **Gemini CLI đã đóng cửa 2026-06-18.** Hãy dùng **Antigravity** với tài khoản Google của bạn để truy cập Gemini miễn phí thay thế.

**Chiến lược:** Dùng đầu tiên, theo dõi quota thời gian thực, fallback sang cheap/free khi hết.

---

## Claude Code (Pro/Max)

### Pricing

| Plan | Chi phí Hàng tháng | Quota Reset | Models |
|------|--------------|-------------|--------|
| Pro | $20 | 5 giờ + Hàng tuần | Opus, Sonnet, Haiku |
| Max | $100 | 5 giờ + Hàng tuần | Opus, Sonnet, Haiku |

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard opens → Providers → Connect Claude Code
```

**Bước 2: Đăng nhập OAuth**

- Click "Connect Claude Code"
- Browser mở → Đăng nhập Claude.ai
- Auto token refresh được bật
- Quota tracking bắt đầu

**Bước 3: Dùng trong CLI**

```
Model: cc/claude-opus-5
       cc/claude-sonnet-5
       cc/claude-haiku-4-5-20251001
```

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `cc/claude-opus-5` | Claude Opus 5 | Task phức tạp, kiến trúc |
| `cc/claude-sonnet-5` | Claude Sonnet 5 | Cân bằng tốc độ/chất lượng |
| `cc/claude-haiku-4-5-20251001` | Claude 4.5 Haiku | Phản hồi nhanh |

### Mẹo Pro

- **Dùng Opus cho task phức tạp** - Quyết định kiến trúc, refactoring
- **Dùng Sonnet cho tốc độ** - Edit nhanh, tạo code
- **Theo dõi quota mỗi model** - Dashboard hiển thị usage mỗi model
- **Reset 5 giờ** - Quota mới mỗi 5 giờ + reset hàng tuần

---

## OpenAI Codex (Plus/Pro)

### Pricing

| Plan | Chi phí Hàng tháng | Quota Reset | Models |
|------|--------------|-------------|--------|
| Plus | $20 | 5 giờ + Hàng tuần | GPT 5.5, GPT 5.4 |
| Pro | $200 | 5 giờ + Hàng tuần | GPT 5.6 Sol, GPT 5.5 |

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect Codex
```

**Bước 2: Đăng nhập OAuth**

- Click "Connect Codex"
- Browser mở đến `http://localhost:1455`
- Đăng nhập tài khoản OpenAI
- Auto token refresh được bật

**Bước 3: Dùng trong CLI**

```
Model: cx/gpt-5.6-sol
       cx/gpt-5.5
       cx/gpt-5.4
       cx/gpt-5.4-mini
```

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `cx/gpt-5.6-sol` | GPT 5.6 Sol | Model coding mới nhất |
| `cx/gpt-5.5` | GPT 5.5 | Context tối đa |
| `cx/gpt-5.4` | GPT 5.4 | Task chung |
| `cx/gpt-5.4-mini` | GPT 5.4 Mini | Coding nhanh, ổn định |

### Mẹo Pro

- **Quota rolling 5 giờ** - Quota mới mỗi 5 giờ
- **Reset hàng tuần** - Reset quota đầy đủ hàng tuần
- **Tier Pro** - Quota gấp 10× Plus

---

## GitHub Copilot

### Pricing

| Plan | Chi phí Hàng tháng | Quota Reset | Models |
|------|--------------|-------------|--------|
| Individual | $10 | Hàng tháng (ngày 1) | GPT-5.4, Claude Sonnet 4.6, Gemini 3.1 |
| Business | $19 | Hàng tháng (ngày 1) | GPT-5.4, Claude Sonnet 4.6, Gemini 3.1 |

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect GitHub
```

**Bước 2: OAuth qua GitHub**

- Click "Connect GitHub"
- Browser mở → Đăng nhập GitHub
- Authorize GitHub Copilot
- Auto token refresh được bật

**Bước 3: Dùng trong CLI**

```
Model: gh/gpt-5.4
       gh/gpt-5.3-codex
       gh/claude-sonnet-4.6
       gh/gemini-3.1-pro-preview
```

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `gh/gpt-5.4` | GPT-5.4 | Model OpenAI mới nhất |
| `gh/gpt-5.3-codex` | GPT-5.3 Codex | Context tối đa |
| `gh/claude-sonnet-4.6` | Claude Sonnet 4.6 | Chất lượng Anthropic |
| `gh/gemini-3.1-pro-preview` | Gemini 3 Pro | Chất lượng Google |

### Mẹo Pro

- **Reset hàng tháng** - Reset quota đầy đủ vào ngày 1 hàng tháng
- **Nhiều model** - Truy cập GPT, Claude, Gemini trong một subscription
- **Tier Business** - Quota cao hơn cho team

---

## Antigravity (Tài khoản Google)

### Pricing

| Plan | Chi phí Hàng tháng | Quota | Models |
|------|--------------|-------|--------|
| FREE | $0 | Giới hạn Hàng ngày + Hàng tháng | Gemini 3.8 Flash, Claude Sonnet 4.6 |

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect Antigravity
```

**Bước 2: Google OAuth**

- Click "Connect Antigravity"
- Browser mở → Đăng nhập tài khoản Google
- Cấp quyền
- Auto token refresh được bật

**Bước 3: Dùng trong CLI**

```
Model: ag/gemini-3.8-flash-high
       ag/claude-sonnet-4-6
       ag/claude-opus-4-6-thinking
```

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `ag/gemini-3.8-flash-high` | Gemini 3.8 Flash (high) | Phản hồi chất lượng cao |
| `ag/claude-sonnet-4-6` | Claude Sonnet 4.6 | Chất lượng Anthropic |
| `ag/claude-opus-4-6-thinking` | Claude Opus 4.6 Thinking | Reasoning phức tạp |

### Mẹo Pro

- **Free tier** - Không phí với tài khoản Google
- **Truy cập Claude** - Claude Sonnet/Opus miễn phí
- **Giới hạn hàng ngày/tháng** - Free quota hào phóng, tự động reset

---

## So sánh Giá

| Provider | Chi phí Hàng tháng | Quota Reset | Giá trị |
|----------|--------------|-------------|-------|
| **Claude Code Pro** | $20 | 5 giờ + Hàng tuần | ⭐⭐⭐⭐⭐ Chất lượng tốt nhất |
| **Claude Code Max** | $100 | 5 giờ + Hàng tuần | ⭐⭐⭐⭐⭐ Quota cao nhất |
| **Codex Plus** | $20 | 5 giờ + Hàng tuần | ⭐⭐⭐⭐ Giá trị tốt |
| **Codex Pro** | $200 | 5 giờ + Hàng tuần | ⭐⭐⭐⭐⭐ Quota 10× |
| **Antigravity** | **$0** | Hàng ngày + Hàng tháng | ⭐⭐⭐⭐⭐ Gemini + Claude MIỄN PHÍ! |
| **GitHub Copilot** | $10-19 | Hàng tháng (ngày 1) | ⭐⭐⭐⭐ Đa model |

---

## Ví dụ Sử dụng

### Setup Cursor IDE

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from 9router dashboard]
  Model: cc/claude-opus-5
```

### Tạo Combo (Khuyên dùng)

```
Dashboard → Combos → Create New

Name: premium-coding
Models:
  1. ag/gemini-3-flash (FREE, use first)
  2. cc/claude-opus-5 (Subscription)
  3. cx/gpt-5.6-sol (Subscription backup)

Use in CLI: premium-coding
```

**Kết quả:** Tối đa free tier → Dùng subscription → Auto fallback

---

## Quota Tracking

9Router theo dõi quota thời gian thực:

- **Tiêu thụ token** - Tokens input/output mỗi request
- **Đếm ngược reset** - Thời gian đến lần reset tiếp theo
- **Phần trăm usage** - Đã dùng bao nhiêu quota
- **Auto fallback** - Chuyển sang tier sau khi hết

**Dashboard view:**

```
Claude Code Pro
├─ Quota: 75% used
├─ Reset: 2h 15m (5-hour)
├─ Weekly reset: 3 days
└─ Fallback: glm/glm-4.7 (cheap tier)
```

---

## Best Practices

### 1. Dùng Free Tier Trước

```
Priority:
1. Antigravity (FREE Gemini + Claude)
2. Claude Code/Codex (paid subscriptions)
3. Kiro/OpenCode Free (free fallback)
```

### 2. Theo dõi Quota Hàng ngày

- Kiểm tra dashboard mỗi sáng
- Lên kế hoạch task nặng quanh thời gian reset quota
- Dùng cheap/free tier cho task không quan trọng

### 3. Tạo Smart Combos

```
Example combo:
1. ag/gemini-3-flash (FREE primary)
2. cc/claude-opus-5 (Complex tasks)
3. glm/glm-4.7 (Cheap backup)
4. kr/claude-sonnet-4.5 (FREE fallback)
```

### 4. Tối ưu theo Thời gian

```
Morning: Fresh 5-hour quota (Claude/Codex)
Afternoon: Antigravity (free daily quota)
Evening: Subscription quota
Night: Cheap/free tier
```

---

## Troubleshooting

### "Quota exhausted"

**Giải pháp:**
- Kiểm tra quota tracker trong dashboard
- Đợi reset (5 giờ hoặc hàng ngày)
- Dùng combo fallback sang cheap/free tier

### "OAuth token expired"

**Giải pháp:**
- Auto-refresh bởi 9Router
- Nếu vẫn lỗi: Dashboard → Provider → Reconnect

### "Rate limiting"

**Giải pháp:**
- Hết quota subscription
- Thêm fallback: `cc/claude-opus-5 → glm/glm-4.7`
- Dùng free tier: `kr/claude-sonnet-4.5`

---

## Bước tiếp theo

- **Setup cheap backup:** [Cheap Providers](./cheap.md)
- **Thêm free fallback:** [Free Providers](./free.md)
- **Tạo combos:** Dashboard → Combos → Create New
