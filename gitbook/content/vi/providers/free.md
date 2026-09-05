# Free Providers - Fallback Chi phí 0

Backup khẩn cấp khi mọi thứ khác bị giới hạn quota. Code 24/7 với chi phí 0!

---

## Tổng quan

Provider free tier là **fallback** khi hết quota subscription và cheap:

- 🆓 **Kiro** - 6 model MIỄN PHÍ (~50 credits/tháng, bao gồm Claude Sonnet 4.5 & Haiku 4.5)
- 🆓 **OpenCode Free** - không cần đăng nhập, danh sách model tự động lấy, passthrough không giới hạn
- 🆓 **Vertex AI** - $300 credit GCP miễn phí (90 ngày, Gemini 3.1 Pro + model đối tác)

> ⚠️ **Free tier đã ngừng cung cấp:** iFlow chuyển sang trả phí từ 2026, OAuth miễn phí của Qwen Code kết thúc 2026-04-15, và Gemini CLI đã đóng cửa 2026-06-18 (hãy dùng **Antigravity** với tài khoản Google của bạn thay thế).

**Chiến lược:** Dùng làm backup khẩn cấp. Giữ tier trả phí làm chính, free tier làm lưới an toàn!

---

## Kiro (Claude MIỄN PHÍ)

### Pricing

| Plan | Chi phí Hàng tháng | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | 6 models | ~50 credits/tháng (500 credit dùng thử cho tài khoản mới, 30 ngày đầu) |

**Giá trị tốt nhất:** Claude MIỄN PHÍ! Cùng chất lượng với Claude Code trả phí.

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect Kiro
```

**Bước 2: AWS Builder ID hoặc OAuth**

- Click "Connect Kiro"
- Chọn phương thức đăng nhập:
  - AWS Builder ID (khuyên dùng)
  - Tài khoản Google
  - Tài khoản GitHub
- Cấp quyền
- Auto token refresh được bật

**Bước 3: Dùng trong CLI**

```
Model: kr/claude-sonnet-4.5
       kr/claude-haiku-4.5
       kr/glm-5
       kr/MiniMax-M2.5
       kr/qwen3-coder-next
       kr/deepseek-3.2
```

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `kr/claude-sonnet-4.5` | Claude Sonnet 4.5 | Cân bằng chất lượng/tốc độ |
| `kr/claude-haiku-4.5` | Claude Haiku 4.5 | Phản hồi nhanh |
| `kr/glm-5` | GLM 5 | Tiếng Trung + Anh |
| `kr/MiniMax-M2.5` | MiniMax M2.5 | Context dài |
| `kr/qwen3-coder-next` | Qwen3 Coder Next | Tạo code |
| `kr/deepseek-3.2` | DeepSeek 3.2 | Task reasoning |

### Mẹo Pro

- **Claude MIỄN PHÍ** - Cùng chất lượng tier trả phí
- **AWS Builder ID** - Setup dễ với tài khoản AWS
- **500 credit dùng thử** - Tài khoản mới nhận 500 credit trong 30 ngày đầu
- **Chất lượng tốt nhất** - Claude 4.5 miễn phí!

---

## OpenCode Free (Không cần đăng nhập)

### Pricing

| Plan | Chi phí Hàng tháng | Models | Quota |
|------|--------------|--------|-------|
| FREE | $0 | Tự động lấy | Không giới hạn (danh sách model thay đổi) |

**Giá trị tốt nhất:** Setup nhanh nhất — hoàn toàn không cần tài khoản.

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect OpenCode Free
```

**Bước 2: Không cần đăng nhập**

- Click "Connect OpenCode Free"
- Danh sách model tự động lấy từ `opencode.ai/zen/v1/models`
- Xong — không cần tài khoản, không cần OAuth

**Bước 3: Dùng trong CLI**

```
Model: oc/<auto>
```

### Mẹo Pro

- **Setup bằng 0** - Provider kết nối nhanh nhất
- **`oc/<auto>`** - Dùng placeholder này trong combos; 9Router tự chọn model khả dụng
- **Danh sách thay đổi** - Các model khả dụng thay đổi theo thời gian, combos xử lý mượt mà

---

## Vertex AI ($300 Credit Miễn phí)

### Pricing

| Plan | Chi phí Hàng tháng | Models | Quota |
|------|--------------|--------|-------|
| Dùng thử FREE | $0 | Gemini 3.1 Pro + model đối tác | $300 credit, 90 ngày |

**Giá trị tốt nhất:** Chất lượng Gemini đầy đủ trên hạ tầng của Google.

### Setup

**Bước 1: Kết nối qua Dashboard**

```bash
9router
# Dashboard → Providers → Connect Vertex AI
```

**Bước 2: Upload GCP Service Account JSON**

- Tạo tài khoản GCP (tài khoản mới nhận $300 credit, 90 ngày)
- Tạo service account và tải xuống JSON key
- Upload nó trong dashboard

**Bước 3: Dùng trong CLI**

```
Model: vertex/gemini-3.1-pro-preview
       vertex/gemini-3-flash-preview
       vertex-partner/glm-5-maas
       vertex-partner/deepseek-v3.2-maas
```

> **Lưu ý:** Dùng endpoint **Vertex AI Studio** — endpoint Gemini API đã ngừng tiêu free credit từ tháng 3/2026.

### Model có sẵn

| Model ID | Mô tả | Tốt nhất cho |
|----------|-------------|----------|
| `vertex/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | Task phức tạp |
| `vertex/gemini-3-flash-preview` | Gemini 3 Flash Preview | Phản hồi nhanh, vision |
| `vertex-partner/glm-5-maas` | GLM 5 (MaaS) | Tiếng Trung + Anh |
| `vertex-partner/deepseek-v3.2-maas` | DeepSeek V3.2 (MaaS) | Task reasoning |

---

## So sánh Tính năng

| Provider | Models | Model tốt nhất | Setup | Quota |
|----------|--------|------------|-------|-------|
| **Kiro** | 6 | Claude Sonnet 4.5 | AWS Builder ID | ~50 credits/tháng |
| **OpenCode Free** | auto | `oc/<auto>` | Không cần đăng nhập | Không giới hạn |
| **Vertex AI** | 4+ | Gemini 3.1 Pro Preview | GCP service account | $300 / 90 ngày |

**Thắng cuộc:** Kiro vì chất lượng, OpenCode Free vì setup bằng 0!

---

## Ví dụ Sử dụng

### Setup Cursor IDE

```
Settings → Models → Advanced:
  OpenAI API Base URL: http://localhost:20128/v1
  OpenAI API Key: [from 9router dashboard]
  Model: kr/claude-sonnet-4.5
```

### Tạo Combo (Khuyên dùng)

```
Dashboard → Combos → Create New

Name: free-combo
Models:
  1. kr/claude-sonnet-4.5 (Kiro quality)
  2. oc/<auto> (OpenCode Free backup)
  3. vertex/gemini-3.1-pro-preview (Vertex emergency)

Use in CLI: free-combo
```

**Kết quả:** Chi phí 0, uptime tối đa!

---

## Chiến lược Fallback Đầy đủ

### Combo 3 Tầng Hoàn chỉnh

```
Dashboard → Combos → Create New

Name: complete-fallback
Models:
  1. ag/gemini-3-flash (FREE, Google account)
  2. cc/claude-opus-5 (Paid subscription)
  3. glm/glm-4.7 (Cheap backup, $0.6/1M)
  4. minimax/MiniMax-M2.1 (Cheapest, $0.2/1M)
  5. kr/claude-sonnet-4.5 (FREE quality)
  6. oc/<auto> (FREE emergency)

Use in CLI: complete-fallback
```

**Kết quả:**
- Tier 1: MIỄN PHÍ (Antigravity, tài khoản Google)
- Tier 2: Subscription trả phí (Claude Code)
- Tier 3: Backup rẻ (GLM, MiniMax)
- Tier 4: Fallback MIỄN PHÍ (Kiro, OpenCode Free)

**Không bao giờ ngừng code!**

---

## Best Practices

### 1. Dùng làm Backup Khẩn cấp

```
Priority:
1. Subscription tier (maximize paid quota)
2. Cheap tier (pennies per 1M tokens)
3. FREE tier (backup, zero cost)

Only use free tier when:
- Subscription quota exhausted
- Budget limit reached
- Testing/non-critical tasks
```

### 2. Chọn Model phù hợp

```
Complex reasoning: kr/claude-sonnet-4.5
Fast coding: kr/qwen3-coder-next
Best quality: kr/claude-sonnet-4.5
Long context: kr/MiniMax-M2.5
Vision tasks: vertex/gemini-3-flash-preview
```

### 3. Tạo Combo Chỉ Free

```
For zero-cost coding:

Name: zero-cost
Models:
  1. kr/claude-sonnet-4.5 (Best quality)
  2. kr/qwen3-coder-next (Fast coding)
  3. oc/<auto> (Emergency backup)

Cost: $0 forever!
```

### 4. Test Trước Production

```
Use free tier to:
- Test prompts
- Prototype features
- Learn new frameworks
- Non-critical tasks

Save paid quota for:
- Production code
- Complex refactoring
- Critical features
```

---

## Ví dụ Thực tế

### Ví dụ 1: Sinh viên/Người học (Ngân sách 0)

```
Setup:
1. kr/claude-sonnet-4.5 (Best quality)
2. kr/qwen3-coder-next (Fast coding)
3. oc/<auto> (Emergency backup)

Monthly cost: $0
Usage: Free tier quotas

Perfect for:
- Learning to code
- Personal projects
- Homework/assignments
```

### Ví dụ 2: Freelancer (Tiết kiệm Ngân sách)

```
Setup:
1. ag/gemini-3-flash (FREE, Google account)
2. glm/glm-4.7 (Cheap backup, $0.6/1M)
3. kr/claude-sonnet-4.5 (FREE fallback)

Monthly cost: $5-10
Usage: 100M+ tokens

Perfect for:
- Client projects (paid tier)
- Testing (free tier)
- Emergency backup
```

### Ví dụ 3: Heavy User (Tối đa hết tất cả)

```
Setup:
1. ag/gemini-3-flash (FREE, Google account)
2. cc/claude-opus-5 (Subscription $20-100)
3. cx/gpt-5.6-sol (Subscription $20-200)
4. glm/glm-4.7 (Cheap $0.6/1M)
5. minimax/MiniMax-M2.1 (Cheapest $0.2/1M)
6. kr/claude-sonnet-4.5 (FREE quality)
7. oc/<auto> (FREE unlimited)

Monthly cost: $40-320 (subscriptions) + $10-20 (cheap tier)
Usage: 500M+ tokens

Perfect for:
- Professional development
- Team projects
- 24/7 coding
```

---

## So sánh Chi phí

### Kịch bản: 100M tokens/tháng

**Phương án 1: Chỉ ChatGPT API**
```
100M × $20/1M = $2,000/month
```

**Phương án 2: Chỉ 9Router Free Tier**
```
100M via free tier = $0/month
Savings: $2,000/month (100%)
```

**Phương án 3: Chiến lược Hoàn chỉnh 9Router**
```
60M via Antigravity (FREE): $0
30M via Claude Code (subscription): $0 extra
8M via GLM (cheap): $4.80
2M via Kiro (FREE): $0
Total: $4.80/month + subscriptions you already have
Savings: $1,995/month (99.76%)
```

---

## Troubleshooting

### "OAuth failed"

**Giải pháp:**
- Kiểm tra kết nối internet
- Thử browser khác
- Xóa cache browser
- Kết nối lại trong dashboard

### "Model not available"

**Giải pháp:**
- Kiểm tra provider đã kết nối trong dashboard
- Xác minh OAuth token hợp lệ
- Kết nối lại provider nếu cần

### "Slow responses"

**Giải pháp:**
- Free tier có thể có ưu tiên thấp hơn
- Dùng trong giờ thấp điểm
- Chuyển sang free provider khác
- Nâng cấp lên cheap tier để tăng tốc

---

## Giới hạn

### Cân nhắc Free Tier

- **Tốc độ** - Có thể chậm hơn tier trả phí
- **Ưu tiên** - Ưu tiên thấp hơn trong giờ cao điểm
- **Rate limit** - Free quota có giới hạn (Kiro ~50 credits/tháng)
- **Tính khả dụng** - Có thể có downtime thỉnh thoảng

**Giải pháp:** Dùng chiến lược fallback 3 tầng để đáng tin cậy!

---

## Bước tiếp theo

- **Setup subscriptions:** [Subscription Providers](./subscription.md)
- **Thêm cheap backup:** [Cheap Providers](./cheap.md)
- **Tạo combos:** Dashboard → Combos → Create New
- **Bắt đầu code:** Dùng combo `complete-fallback` để có độ tin cậy tối đa
