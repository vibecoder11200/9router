# Research Report: Regression audit v0.6.35 → v0.6.41 (9router)

- **Thời điểm nghiên cứu:** 2026-09-06
- **Phạm vi:** toàn bộ 42 commits từ tag `v0.6.35` đến `HEAD` (`b3266e0a`), trừ bug `ping.js:44` (đang được sửa riêng bởi owner).
- **Phương pháp:** diffstat + đọc diff từng cụm commit (v0.6.36 hardening A, v0.6.37 B, v0.6.38 C, v0.6.40/41 auth), sau đó rà ngược mọi consumer còn phụ thuộc hành vi cũ. 4 luồng audit song song (security S-cluster, core-path C-cluster, subsystems X-cluster, proxy-pools P-cluster × phases 05-08) + quét thủ công lớp lỗi S7 (masked key).

## Executive Summary

Bug `ping.js:44` **không phải cas duy nhất**. Cùng lớp lỗi "consumer đọc `.key` đã-mask như một credential" còn ít nhất **4 chỗ nữa**, trong đó 2 chỗ là CRITICAL (MITM start + CLI Quick Setup ghi key mask vào config Claude Code/Codex…). Ngoài ra, các cụm hardening khác để lại **~10 regression đã xác nhận** qua 4 nhóm: C4 vô hiệu hoá fallback trên 401/402 của cả họ provider web-account (gemini-web/grok/genspark/qoder/commandcode…), S2 vô hiệu hoá carve-out localhost của provider-nodes/validate, S6 khoá người dùng tunnel khi upgrade, breaker ăn cả lỗi hạ-cấu-trúc proxy, budget hard-block bị bypass trên 7 endpoint non-chat, và restore DB sang máy khác làm chết toàn bộ API key (S7 × install-secret).

Phân loại: **6 HIGH cần sửa trước khi release tiếp**, phần còn lại MEDIUM/LOW nên lên lịch. Chi tiết từng finding kèm `file:line` bên dưới.

---

## Nhóm 1 — Lớp lỗi S7 "masked key dùng làm credential" (cùng root cause với ping.js)

Từ `c93252f4` (S7), `getApiKeys()`/`rowToKey()` trả `key` = `sk-{keyId}-••••{last4}` cho mọi row đã hash (`src/lib/db/repos/apiKeysRepo.js:26-54`). Ký tự `•` (U+2022 > 255) làm mọi header `Authorization: Bearer …` chứa nó **ném TypeError (ByteString)** trong Node fetch, hoặc 401 nếu client khác.

| # | Mức | Vị trí | Hỏng gì |
|---|-----|--------|---------|
| 1 | (đang sửa) | `src/app/api/models/test/ping.js:44` | Test model/embedding/image/stt từ dashboard → fetch ném lỗi trước khi gửi |
| 2 | **CRITICAL** | `src/shared/services/initializeApp.js:211-215` | MITM **auto-start lúc boot** truyền `activeKey?.key` (masked) vào `startServer` → `ROUTER_API_KEY` của MITM child là key mask |
| 3 | **CRITICAL** | `src/app/(dashboard)/dashboard/cli-tools/components/AntigravityToolCard.js:115-121`, `MitmServerCard.js:~78` | MITM **start thủ công từ UI**: `apiKeys[0].key` (masked) làm key MITM. MITM child (`src/mitm/handlers/base.js:7,27`) gắn `Authorization: Bearer {ROUTER_API_KEY}` cho **mọi** request về /v1 → khi `requireApiKey=true`, mỗi request qua MITM crash (ByteString) hoặc 401 |
| 4 | **CRITICAL** | `cli/src/cli/menus/cliTools.js:29-33` + 7 call site (80, 112, 210, 294, 379, 455, 541) | CLI **Quick Setup** ghi `ANTHROPIC_AUTH_TOKEN: apiKey` (masked) vào env Claude Code/Codex/… → tool của user gửi key mask về /v1 → 401 hoặc crash từng request |
| 5 | HIGH | `src/lib/db/repos/usageRepo.js:404-424` (`getUsageStats` → `resolveApiKeyMeta:25-35`) | Join `apiKeyMap[mask]` vs usage rows (chứa **raw** key) **không bao giờ khớp** → cột "API Key Name" trên usage dashboard luôn rơi về pseudo-name; trả thêm lỗ hổng nhỏ: fallback lộ 6 ký tự cuối raw key (`usageRepo.js:31`) trong khi policy mask là 4 |
| 6 | HIGH | `src/lib/db/index.js:106-112` (exportDb) × `src/lib/auth/installSecret.js` | `exportDb` xuất `keyHash` (HMAC với secret **của máy này**) nhưng install secret là file ngoài DB, **không export**. Restore archive post-S7 sang máy khác → hash không bao giờ khớp, raw key không còn ở đâu → **toàn bộ key import chết âm thầm** (import vẫn báo thành công). Archive pre-S7 (raw key) thì restore đúng |
| 7 | LOW | `cli/src/cli/menus/apiKeys.js:32` (`maskKey(key.key)`) | CLI hiển thị key đã-mask rồi mask lần nữa — chỉ cosmetic |

Ghi chú liên quan: v0.6.38 ship bug facade (`getApiKeyRow` không được re-export từ `src/lib/localDb.js`) → mọi chat request khi `requireApiKey=true` văng TypeError; đã sửa ở v0.6.39 (`a5f71a07`). Đây là lời cảnh báo cùng loại: **mỗi lần đổi shape của repo layer phải grep toàn bộ consumer**.

## Nhóm 2 — C4 `NO_FALLBACK_STATUSES` vô hiệu hoá fallback (commit `9279e803`, v0.6.36)

| # | Mức | Vị trí | Hỏng gì |
|---|-----|--------|---------|
| 8 | **HIGH** | `open-sse/services/accountFallback.js:54-56` vs các executor | Provider web-account multi-cookie tự "fabricate" 401/402 với text không khớp ERROR_RULES → **hết failover tài khoản**: `gemini-web.js:397-401`, `genspark-web.js:757-763`, `grok-web.js:310`, `perplexity-web.js:470`, `qoder.js:458-524`, `commandcode.js:94-121` (map "unauthorized"→401), `grok-cli.js:401-415` (402 spending-limit, comment cũ nói rõ "for fallback") |
| 9 | **HIGH** | `open-sse/executors/../videoGeneration.js:23-27,173-182` | xAI video-create: 401 không còn rotate account. Test `xai-video-handler.test.js:132-145` vẫn pass vì mock `checkFallbackError` vô điều kiện — **test lệch runtime** |
| 10 | **HIGH** | `open-sse/services/combo.js:335-341` | Failover giữa các member combo dừng ở bare 4xx (400/401/402/404/405/413/422) — trước đây default 30s transient fallback |
| 11 | MEDIUM | text matching | Anthropic "credit balance is too low" (400), OpenRouter "Insufficient credits" (402) không khớp text rule → fail fast thay vì fallback. Chỉ các chuỗi literal "quota exceeded"/"rate limit"… được cứu |
| 12 | MEDIUM | `open-sse/handlers/chatCore/streamingHandler.js:51-62,113-122` (N7) | Client cancel **trước byte đầu** → `onRequestSuccess` không fire → lock-heal (`chat.js:427-434`) và breaker `recordSuccess` bị mất dù upstream thành công |
| 13 | MEDIUM | `open-sse/handlers/chatCore.js:180` + `prefetch.js` (C2) | `structuredClone(body)` + re-download remote image **mỗi lần fallback attempt** (trước đây side-effect inline 1 lần dùng chung) → tốn băng thông/CPU với body lớn |
| 14 | MEDIUM | `open-sse/utils/stream.js:227-246,408-411` (C9) | Sentinel `data:[DONE]` (không dấu cách) không set `streamDoneSent` → client nhận **2 frame [DONE]** và usage finalize trễ; case này không được test nào phủ |
| 15 | LOW | `commandcode.js:148-155` (N9) | Whitelist header drop `x-ratelimit-*-tokens`, `openai-request-id`, `anthropic-ratelimit-*`… (chỉ ảnh hưởng executor commandcode); `9R_CC_PEEK_LEGACY` không có trong `.env.example`; peek cap đếm char không phải byte (`commandcode.js:187-190`); combo cycle legacy giờ 400 thay vì treo (`chat.js:208-219`) — cải thiện nhưng không có migration |

## Nhóm 3 — Security S-cluster (commit `0d35f1de`, v0.6.36)

| # | Mức | Vị trí | Hỏng gì |
|---|-----|--------|---------|
| 16 | **HIGH** | `src/app/api/provider-nodes/validate/route.js:14` × `src/shared/utils/ssrfGuard.js:172-193` | S2 đổi sang `fetchPublic` **vô hiệu hoá carve-out localhost** ngay trong cùng route (`route.js:71-79` giữ `assertPublicUrl` chỉ cho remote) → **không validate được node self-hosted** (ollama `localhost:11434`, LAN 192.168.x) — đúng dạng "consumer bị bỏ sót" như ping.js. Tương tự `/v1/fetch` direct-url với URL local. Error trả về còn sai (`"Network connection failed"`) |
| 17 | **HIGH** | `src/lib/db/repos/settingsRepo.js:35,163-166` × `src/dashboardGuard.js:266-276`, `login/route.js:38-40` (S6) | Upgrade từ bản cũ mà **chưa từng lưu** `tunnelDashboardAccess` → mặc định mới `false` → user tunnel/cloudflared/tailscale bị khoá toàn bộ dashboard (redirect + 403 login). Headless tunnel-only: chicken-and-egg, phải vào local 1 lần |
| 18 | MEDIUM | `src/mitm/manager.js:175-201` (S5) | `mitmSudoEncrypted` cũ mã hoá bằng key công thức cũ → decrypt trả null âm thầm → **MITM auto-start im lặng tắt hẳn trên macOS/Linux** sau upgrade; blob cũ không bao giờ được clear; DNS restore/tailscale fail êm |
| 19 | MEDIUM | `src/lib/db/index.js:126-160` (S1) | `importDb` giữ nguyên password hiện tại → mất đường recovery "import backup cũ để lấy lại password"; path còn lại (`/api/auth/reset-password`) STRICT_LOCAL_ONLY |
| 20 | LOW | `src/shared/utils/ssrfGuard.js:202-219` (S2) | Redirect cap 20→5; và `Authorization`/body giờ được **re-play sang redirect target** (undici auto-follow trước đây strip auth cross-origin) — capability leak mới, bounded |
| 21 | LOW | `requestLocality.js:47-59`, `:12-24` | Docker: peer = bridge gateway → luôn "remote" (setup-code flow v0.6.40/41 đã phủ first-run; còn edge re-auth nhạy cảm); IPv4-mapped IPv6 dạng hex không nhận loopback. S9 CRC không được enforce ở đâu trong server auth → không có sóng 401 sau upgrade (clean) |

## Nhóm 4 — X-cluster + phase 07 (commits `e360522a`, `c18d20d9`, v0.6.38)

| # | Mức | Vị trí | Hỏng gì |
|---|-----|--------|---------|
| 22 | MEDIUM | `src/lib/processGuard.js:30-58` × `src/lib/xray/process.js:102-110` (X7) | Windows: PowerShell-CIM probe fail-closed (AppLocker/WMI off/cold-start >5s) → **live managed xray bị coi là chết** → PID file bị xoá, start lần 2 không bind được 10808 → orphan giữ port, UI báo stopped, tới khi kill tay. Như vậy với ds2api |
| 23 | MEDIUM | `src/lib/db/index.js:103-107,167-175` × `open-sse/services/usage/newapi.js:57-62` (X12) | Export redact `loginToken` → import persist literal `"[REDACTED]"` → balance/usage TOTU (và tokenrouter) 401 với **thông báo sai** ("token expired — re-add via auto-fetch"); không có cảnh báo lúc import |
| 24 | LOW | `settingsRepo.js:87,119` × `totuAutoFetch/index.js:237-239`, `healthScheduler.js:77` | Hành vi im lặng sau upgrade: TOTU interval=0 giờ **thực sự tắt** (trước đây `\|\|60` ép 60 dù UI nói "Never"); xray health 1-4 bị clamp 5; scheduler health 10 phút **mặc định bật cho mọi install** (trước đây key là no-op) — auto-rotate lần đầu chạy mà không ai biết |

## Nhóm 5 — P-cluster × phases 05-08 (commits `932e6ff7`, `e6d14114`, `8a340ea6`, `b0c73e84`)

| # | Mức | Vị trí | Hỏng gì |
|---|-----|--------|---------|
| 25 | **HIGH** | `src/sse/handlers/chat.js:592-632` | Lỗi **hạ-cấu-trúc proxy** (strict single-URL pool fetch fail ~502, non-strict group exhausted, managed pool infra fail) vẫn rơi vào `markAccountUnavailable` + breaker `recordFailure` → pool chết mở breaker **tất cả account** gắn vào nó; pool hồi phục thì traffic vẫn tối tới khi từng breaker probe lại (backoff 60s→10m). Mâu thuẫn với claim "strict pool outage → 503-retry-after, không lock account" |
| 26 | **HIGH** | `src/sse/handlers/chat.js:94-110` là điểm enforce duy nhất | **Budget hard-block bị bypass** trên 7 endpoint non-chat vẫn validate key nhưng không gọi `checkKeyBudget`: embeddings (`embeddings.js:56-66`), fetch, stt, tts, imageGeneration, search, videoGeneration — key over-limit vẫn tiêu free, chi phí cộng dồn chờ chat request sau mới chặn |
| 27 | MEDIUM | `proxy-pools/page.js:239-240` × `proxy-pools/[id]/route.js:292-301` (P3) | DELETE 409 do providerStrategies bind → UI hiện **"Cannot delete: 0 connection(s)…"** (đọc nhầm field `boundConnectionCount` không tồn tại), không hiện `boundProviders`/hint `{force:true}`, không có nút force-delete |
| 28 | MEDIUM-LOW | `chat.js:312-318` × `auth.js:65-76` | Noauth + strict pool exhausted → alert sai sự thật `ALL_ACCOUNTS_LOCKED` (không account nào locked) song song với alert đúng; path group-exhausted terminal (`chat.js:591` TODO) không emit `proxy-pool-exhausted` trực tiếp |
| 29 | LOW | `alerts/index.js:155-162` | Dedup không phân biệt severity → WARN "exhausted" che CRITICAL "errored" cùng pool trong window |

## Trọng số ưu tiên sửa (đề xuất)

1. **Lớp S7 ( findings 2-6)** — cùng root cause với bản sửa ping.js của bạn; sửa tập trung tại nguồn: thêm hàm "raw key cho internal use" (ví dụ `getActiveRawKeys()` dùng keyHash lookup ngược hoặc giữ raw trong memory chỉ cho consumer nội bộ) thay vì vá từng chỗ. Đặc biệt #4 (CLI quick setup) và #6 (export/import) cần quyết định thiết kế: internal callers nên gọi thẳng repo, còn cross-machine migration cần export secret (có password) hoặc cơ chế re-key.
2. **C4 (8-10)** — ít nhất: thêm text-rules cho các message 401/402 của executor fabricate, hoặc cho executor đánh dấu `accountSpecific: true` để bypass NO_FALLBACK; sửa 3 test đang mock lệch runtime.
3. **S6 (17) + S2 (16)** — S6: migration một-lần set `tunnelDashboardAccess=true` cho install cũ có tunnel URL cấu hình; S2: fetchPublic cần chế độ "allow-local cho local caller" thay vì block hop-0.
4. **Breaker/pool (25) + budget bypass (26)** — phân loại lỗi infra-proxy khỏi account-failure trước khi feeding breaker; gọi `checkKeyBudget` ở chung một wrapper auth cho 7 endpoint.
5. Còn lại theo bảng.

## Unresolved questions

- Với finding 6 (export/import keyHash): chủ đích thiết kế là "backup chỉ restore cùng máy" hay cần hỗ trợ migrate machine-to-machine? Quyết định này đổi hướng fix (export secret mã hoá bằng password vs re-key flow).
- Finding 25: cần confirm `chat.js:566-601` nhánh group-rotation đã phân biệt đúng `usedEntryId` — audit chỉ đọc tĩnh, chưa có repro runtime.
- Số liệu user ảnh hưởng thực tế của finding 17/24 (bao nhiêu install dùng tunnel / đã set interval) chưa có — cần telemetry hoặc hỏi trực tiếp user.

## Đầu mối đã kiểm và SẠCH (không cần lo)

- S1 CLI token: CLI và server derive cùng công thức, mọi caller đều gửi đúng token (`dashboardGuard.js:12-15` vs `cli/api/client.js:60-66,97`).
- S8 `require-login`: không còn UI consumer nào đọc field bị drop.
- S9: không có consumer ngoài server cần install secret; key cũ vẫn hoạt động (CRC không enforce).
- P12 `cooldownUntil`: không còn writer nào ghi sai format.
- C1 peek replay: không có double-delivery; C10 body-timeout 504 đúng; X2 sync fail-closed đúng; X6/X9/X10 clean.
- Cache analytics (phase 09) và alerts module: additive, backward-compatible.
