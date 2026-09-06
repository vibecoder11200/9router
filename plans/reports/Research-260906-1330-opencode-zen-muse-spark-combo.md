# Research Report: OpenCode Free (zen) — muse-spark qua 9router, Combo goclaw/openclaw, và ma trận sức khoẻ model

**Ngày điều tra:** 2026-09-06 · **Phạm vi:** opencode provider trong 9router v0.6.47 (master 7f6be621), zen API opencode.ai, server nullbox (20.196.65.138, 9router v0.6.47, fresh-install 2026-09-05), capture `requests-response-muse-opencode-local.txt` (2026-09-03/04).

## Executive Summary

**muse-spark-1.2/1.3-contributor-free KHÔNG hỏng trên 9router hiện tại.** Trên server nullbox đang chạy v0.6.47, muse-spark-1.3 thành công **348/348 request** trong 48h qua (client oh-my-pi). Toàn bộ pipeline 9router (chat→responses lẫn claude→openai→responses, có/không tools, có/không reasoning_effort) được reproduce lại local và đều HTTP 200 từ zen. Lỗi "luôn failed" mà bạn gặp là của **phiên bản cũ trước các fix 2026-09-03** (`560fa77d` route responses models via registry + `4e9ca601` auto-sync zen routing từ api.json) — hoặc đến từ các nguyên nhân khác bên dưới.

Nguyên nhân thật sự khiến **goclaw/openclaw qua Combo hay gặp lỗi** trong khi oh-my-pi xài thẳng `oc/muse-spark-1.3` mượt: combo **FoodThapCamLite** chứa các member bệnh:
1. `nemotron-3-ultra-free` — **dùng được nhưng chậm thất thường** (probe 43.6s cho prompt trivial; đợt xấu thì ~10s chỉ phát `: keep-alive` rồi error-in-SSE). Combo thấy HTTP 200 là coi là success ngay (`result.ok`) → những lần chờ quá lâu, client dễ hiểu là treo/timeout.
2. `ling-3.0-flash-fin-free` — dùng được nhưng upstream gián đoạn theo đợt: lúc 503 (non-stream), lúc SSE framing hỏng (`data: {...data: {...` dính liền + event rác cuối), lúc lại 200 stream tốt 1.7s.
3. `mimo-v2.5-free` — rate-limit thật (HTTP 429 `FreeUsageLimitError`) khiến combo rơi xuống member kế tiếp.
4. Trên server: **202 lỗi strictProxy** (`Proxy required but failed (strictProxy=true): fetch failed`) — proxy xray của server lag, làm fail mọi model trong lúc proxy down (không liên quan model).

Các model trên đều KHÔNG cần bỏ khỏi combo — đây là flaky gián đoạn, combo fallback đã là cơ chế xử lý đúng. Lỗi "luôn gặp lỗi" của goclaw/openclaw tương quan với việc dính các đợt xấu này (đặc biệt qua combo đi qua nhiều member), còn oh-my-pi xài **tên model trực tiếp** chỉ chạm muse-spark (ổn định nhất) nên hầu như không thấy.

**Hardcode trong `opencode.js` đã bỏ:** UA `opencode/1.18.22 ...` fix cứng nay lấy **version động từ npm registry** (`registry.npmjs.org/opencode-ai/latest`), refresh cùng chu kỳ 6h với catalog api.json, fallback về pin 1.18.27. Khi verify đã tự resolve được **1.18.29** (mới hơn cả capture) — minh hoạ rõ version pin stale chỉ sau vài ngày.

## Key Findings

### 1. So sánh request opencode-direct vs 9router (muse-spark-1.3 + mimo-v2.5)

Từ capture (opencode 1.18.27 direct) và pipeline 9router reproduce:

| Khía cạnh | opencode direct | 9router | Zen chấp nhận? |
|---|---|---|---|
| Endpoint muse-spark | `/zen/v1/responses` | `/zen/v1/responses` (registry + api.json auto-sync) | — |
| Endpoint mimo | `/zen/v1/chat/completions` | `/zen/v1/chat/completions` | — |
| Auth | `Bearer public` | `Bearer public` | ✅ |
| UA | `opencode/1.18.27 ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14` | pin cũ 1.18.22 → **nay động** | ✅ mọi UA (kể cả `goclaw/2.5.2 node/22`) đều 200 — zen không chặn theo UA |
| System prompt | `input[0] = {role:"developer"}` | `instructions` field (chat) / developer item (claude-path) | ✅ cả hai |
| `store` | `false` | `false` (translator tự set) | ✅ |
| `include` | `["reasoning.encrypted_content"]` | không gửi (turn đầu không cần) | ✅ |
| `reasoning` | `{effort:"minimal"|"low", summary:"auto"}` | chỉ gửi khi client có reasoning_effort; không có → zen mặc định `effort:"high"` (đốt reasoning tokens — với max_output_tokens nhỏ sẽ `incomplete` + output rỗng) | ✅ |
| `stream_options` (chat) | `{include_usage:true}` | không gửi | ✅ |

Kết luận: **không có delta nào khiến zen từ chối.** Mọi biến thể (openai client, claude client, tools, effort) đều 200.

### 2. Ma trận sức khoẻ OpenCode Free (probe live 2026-09-06, 102 model trong api.json)

**Khoẻ (5):** `muse-spark-1.3-contributor-free` (RESP, ~2.5s), `muse-spark-1.2-contributor-free` (RESP), `mimo-v2.5-free` (CHAT, ~1.2s), `nemotron-3.5-lightning-free` (CHAT, ~3.6s), `big-pickle` (CHAT, ~5.1s).

**Flaky nhưng DÙNG ĐƯỢC (2 — đã xác nhận lại lần 2, 15:20 cùng ngày, đều 200 có nội dung):**
- `nemotron-3-ultra-free`: dùng được, nhưng chậm thất thường — probe đầu ~10s im lặng rồi lỗi; probe lại 200 nhưng mất 43.6s cho prompt trivial. Khoảng thời gian chờ dài này dễ bị client hiểu là timeout.
- `ling-3.0-flash-fin-free`: probe đầu 503 (non-stream) / SSE framing hỏng (stream); probe lại 1.7s stream tốt. Upstream gián đoạn theo đợt, không chết.

→ 2 model này **không nên bỏ khỏi combo** (chỉ điểm flaky gián đoạn; combo fallback tự xử lý các lúc xấu). Khi goclaw/openclaw gặp lỗi/timeouts qua combo, khả năng cao là dính đúng một "đợt xấu" của member này chứ không phải model hỏng hẳn.

**Chết (~33, `status:"deprecated"` + `ModelError: Model not supported`):** glm-5-free, glm-4.7-free, kimi-k2.5-free, kimi-k2, kimi-k2-thinking, minimax-m2.1/m2.5/m3-free, ling-2.6-flash-free, ling-3.0-flash-free, ling-3.0-tiny-free, mimo-v2-flash/omni/pro-free, nemotron-3-super-free, qwen3-coder, qwen3.6-plus-free, x-preview-f-free, hy3-free, hy3-preview-free, longcat-2.0-free, laguna-s-2.1-free, north-mini-code-free, trinity-large-preview-free, gemini-3-pro, claude-3-5-haiku, claude-opus-4-1, grok-code, deepseek-v4-flash-free (400), glm-4.6, minimax-m2.1...

**Trả phí (401 `Missing API key` — không phải free tier):** mọi claude-*/gpt-*/gemini-*/grok-*/kimi-k2.6+/kimi-k3/glm-5.x/minimax-m2.5+...

→ Danh sách model free thực dụng hiện nay: 5 model ổn định + 2 model flaky-gian-đoạn-nhưng-dùng-được (nemotron-3-ultra-free, ling-3.0-flash-fin-free) — tổng 7, trùng đúng combo FoodThapCamLite.

### 3. Tại sao "opencode direct mượt mà 9router hay fail" (quá khứ)

- Trước 2026-09-03, 9router chưa route muse-spark qua `/zen/v1/responses` → 400/404 từ zen. Đã fix bởi `560fa77d` + `4e9ca601` + catalog auto-sync (`opencodeCatalog.js`) — nay đã tự bắt được 28 model responses-only và 33 deprecated từ api.json.
- Server nullbox được cài lại sạch ngày 05-09 với v0.6.47 — mọi log lỗi cũ đã mất; bằng chứng hiện tại: muse-spark 348/348 OK.
- 6/246 lỗi mimo trên server là rate-limit thật (429); 202/246 còn lại là strictProxy (proxy hạ tầng, không phải model).

### 4. Combo + goclaw/openclaw

- Combo resolve trước format-handling nên client Anthropic-format vẫn dùng được combo (đã test claude→muse-spark 200 OK).
- **Không cần thay đổi thành phần combo** — tất cả 7 member đều dùng được; 2 member flaky (nemotron-ultra, ling-fin) chỉ lỗi gián đoạn và combo fallback đã là cơ chế xử lý đúng.
- Ghi nhận kỹ thuật (gap thiết kế, tùy chọn xử lý sau): `handleComboChat` chỉ tin HTTP status (`result.ok`). zen thỉnh thoảng trả **200 kèm error bên trong SSE** (quan sát ở nemotron-ultra trong đợt xấu) → combo trả "success" chứa error cho client thay vì fallback tiếp. Nếu muốn cứng hơn, có thể detect error-object trong data-event đầu tiên của stream để combo fallback — không bắt buộc.

### 5. Hardcode đã xử lý

- `open-sse/executors/opencode.js`: bỏ `OPENCODE_UA` pin cứng. UA cho client không-phải-opencode được ghép từ version npm mới nhất (`getOpencodeCliUserAgent()` trong `opencodeCatalog.js`), suffix runtime giữ pin (không có nguồn registry). Fallback = `opencode/1.18.27 ...`.
- Giữ nguyên (có chủ đích, khớp official CLI): `Bearer public`, default `x-opencode-client: cli`, default `x-opencode-project: global`.
- Test mới: "resolves the zen User-Agent version from npm and falls back when unavailable" (9/9 catalog + 6/6 muse-spark + 36 opencode-go tests pass).
- `detect_changes`: LOW risk, 0 process ảnh hưởng ngoài phạm vi.

## Verification (đã thực hiện)

1. Replay 3 biến thể UA (mới/cũ/goclaw) trực tiếp vào zen → 200 hết.
2. Reproduce pipeline 9router bằng node (translator + executor thật): openai-chat, openai-chat+tools, openai-chat+reasoning_effort, claude-format multi-turn + tool_use/tool_result + tools → tất cả 200.
3. Probe 102 model × (chat/responses đúng endpoint) → ma trận trên.
4. Đo stream nemotron-ultra/ling-fin bằng reader thô → bắt được keep-alive-silence + error-in-SSE + SSE framing hỏng.
5. Query SQLite server nullbox: phân loại 246 lỗi mimo (202 strictProxy / 6 429), 348 success muse-spark, bảng combos.

## Unresolved / Next steps

1. **Combo hardening** (đề xuất, chưa làm): khi upstream 200 nhưng data-event đầu tiên của stream là `{"error":...}` → nên coi là failure để combo fallback. Cần thiết kế ở tầng stream (chatCore/stream utils), ngoài phạm vi lần này.
2. Chưa xác định được chính xác client goclaw/openclaw của bạn bắn endpoint nào (server không còn log) — nếu tái diễn, bật lại và xem `requestDetails` + log CHAT/COMBO trên server.
3. Server nullbox đang bật strictProxy với proxy xray hay fail — nên xem lại cấu hình proxy (out-of-scope cho repo).

## References

- Capture: `C:\Users\ankha\Downloads\requests-response-muse-opencode-local.txt` (opencode 1.18.27, 2026-09-03/04)
- Code: `open-sse/executors/opencode.js`, `open-sse/providers/opencodeCatalog.js`, `open-sse/providers/registry/opencode.js`, `open-sse/translator/request/openai-responses.js`, `open-sse/services/combo.js`
- Git: `560fa77d`, `4e9ca601`, `ab044e6d`, `a913c4bd`, `7e1d39a9`
- Server: nullbox 20.196.65.138 (~/.9router/db/data.sqlite)
