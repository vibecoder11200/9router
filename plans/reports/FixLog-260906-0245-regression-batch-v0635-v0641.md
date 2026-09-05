# Fix Log: Regression batch v0.6.35→v0.6.41 audit (2026-09-06)

Fix báo cáo `Research-260906-0130-regression-audit-v0.6.35-to-v0.6.41.md`, trừ ping.js (đã fix trong v0.6.42/43 của owner). 62 file thay đổi; hướng thiết kế tuân thủ triết lý v0.6.42: **không bao giờ phục hồi/gửi raw key từ server**.

## Đã sửa (theo nhóm)

**Nhóm 1 — S7 masked-key consumers**
- `exportDb` ReferenceError (hashApiKey chỉ re-export, không import) — export backup đã hỏng từ S7 với mọi DB có ≥1 key. Thêm import + `meta.installId` + export budget fields.
- `importDb`: drop marker `loginToken:"[REDACTED]"` (clone trước khi xoá), giữ budget columns, warning cross-install (keyHash gắn secret máy export) qua `restored.warnings` → route `/api/settings/database` → profile page (badge amber).
- `usageRepo`: `resolveApiKeyMeta` hash-join qua `getApiKeyHashNameMap()` mới (apiKeysRepo) — keyName trên usage dashboard hoạt động lại cho mọi trạng thái migration; fallback tail -6→-4 (vá leak).
- MITM: `initializeApp.autoStartMitm` bỏ masked key (skip + warn khi requireApiKey); route `antigravity-mitm` POST apiKey optional, chặn giá trị có `•`, 400 trung thực khi requireApiKey thiếu key; `manager.startServer` chỉ set `ROUTER_API_KEY` khi có key thật (3 nhánh spawn); UI `AntigravityToolCard`/`MitmServerCard` bỏ prefill/fallback masked, thay text-input "dán RAW key".
- Toàn bộ card cli-tools (13 file) + `ApiKeySelect`: loại masked key khỏi options/state/fallback; `sk_9router` giữ làm default local-mode.
- CLI `cliTools.getFirstApiKey` trả null khi masked + thông báo đúng; `apiKeys.js` bỏ double-mask.

**Nhóm 2 — C4 + stream**
- `errorConfig.ERROR_RULES`: +12 text-rule account-specific (cookie expired, auth failed, unauthorized, invalid api key, pat exchange failed, missing userid/accesstoken, cosy signing failed, spending-limit, insufficient credits, credit balance is too low, billing). **Cố ý bỏ "payment required"** — bare-402 pinned fail-fast bởi contract github-monthly-usage-lock (hạn chế đã ghi chú: commandcode billing-402 thuần text sẽ fail-fast đến khi có provider-scoped rules).
- `stream.js`: `data:[DONE]` không dấu cách được nhận diện (1 sentinel duy nhất, finalize đúng thời điểm) + trailing-buffer case.
- `commandcode.recordLine`: đếm byte UTF-8 thay vì char.
- `prefetch.js`: TTL cache 5 phút (≤100 mục, ≤2MB/mục, ≤32MB total) — hết re-download image mỗi fallback attempt.
- N7: success signal chuyển sang `onFirstChunk` (fire khi chunk đầu đọc được từ transform) — client-cancel sớm không còn mất lock-heal/breaker success.
- `.env.example`: tài liệu hoá 9R_CC_PEEK_LEGACY + NINEROUTER_CC_PEEK_MAX_BYTES.

**Nhóm 3 — Security S-cluster**
- S2: `fetchPublic(url, init, {maxRedirects=20, allowPrivate})` + strip authorization/cookie/x-api-key khi redirect đổi origin; `provider-nodes/validate` dùng `allowPrivate` chỉ khi `isLocalRequest && (hasTrustedPeerHeaders || dev)`.
- S6: migration one-time trong `runMigrationOnce` — install pre-v0.6.36 (MIN(apiKeys.createdAt) < 2026-09-05) thiếu key → persist `tunnelDashboardAccess: true`; bọc transaction, stamp flag sau khi mutate.
- S5: `loadEncryptedPassword` xoá blob không giải mã được + warn (MITM auto-start không còn tắt im lặng vĩnh viễn).

**Nhóm 4 — Subsystems**
- X7: `probeProcess()` 3 trạng thái ours/gone/unknown (kill(0) phân biệt gone; empty-cmdline trên process sống = unknown); `getVerifiedManagedPid` (xray+ds2api) giữ PID file khi unknown — không còn orphan/double-spawn khi PowerShell-CIM lỗi.
- X12: import không persist "[REDACTED]" (newapi đã có sẵn thông báo no-token trung thực).
- `healthScheduler` warn khi clamp 1-4 → 5.

**Nhóm 5 — Proxy/budget/UI**
- `proxyFetch` 3 throw strict gắn `err.proxyInfra = true` → `chatCore` prop qua result → `chat.js` skip account KHÔNG lock/KHÔNG recordFailure (proxy-infra ≠ account); non-strict group exhausted cũng skip-without-lock; managed port-never-returned tương tự. Terminal 503-retry-after, message generic hoá.
- Budget: `auth.enforceKeyBudget` wired vào 7 endpoint (embeddings/fetch/stt/tts/image/search/video) — hết bypass hard-block.
- P3 UI: proxy-pools DELETE 409 hiện đúng `data.error`/`boundProviders`, confirm force-delete `{force:true}`; connection-bound hiện đúng count.
- Alerts: noauth strict-exhaustion không còn false `ALL_ACCOUNTS_LOCKED` (marker cấu trúc `strictPoolRefusal`, không dùng heuristic 503); strict group-exhausted emit `PROXY_POOL_EXHAUSTED` (TODO phase-05 cũ); dedup cho severity cao hơn xuyên qua window.
- `requestLocality.isLoopbackHostname`: nhận `::ffff:7f00:1` (hex IPv4-mapped).

## Tests
- Mới: `tests/unit/s7-followup-regressions.test.js` (10 case: exportDb ReferenceError regression, cross-install warning, REDACTED drop, budget round-trip, hash-map).
- Mở rộng: account-fallback (13 rule case + pin bare-402), ssrf-guard (5 case allowPrivate/credential-strip), stream-passthrough-done (3 case no-space DONE), process-guard (unknown-state), streaming-first-byte (mock đủ contract), xai-video (mock delegate REAL classifier).
- **Kết quả:** full suite 2672 pass / 110 fail — failing-set diff so với clean HEAD (worktree riêng): **0 failure mới**, 3 test `usage-by-api-key` fail-sẵn-từ-S7 giờ PASS. 110 fail còn lại là pre-existing (known-fails + flake Windows, đối chiếu bằng worktree + junction node_modules).
- `detect_changes` (GitNexus): 69 symbols/46 files — toàn bộ thuộc scope fix.

## Code review (agent)
Verdict đầu: REQUEST CHANGES (9 findings). Đã xử lý: #1 (ApiKeySelect + 13 card siblings + DefaultToolCard + MitmPageClient dead prop), #2 (empty-cmdline → unknown), #3 (byte ceiling cache), #4 (allowPrivate yêu cầu trusted-peer stamp ở production), #5 (strictPoolRefusal marker thay heuristic lastErrorCode 503), #6 (S6 migration transactional + flag order), #7 (clone trước delete). Không nhận: #8 (double-fetch 1 indexed SELECT — chấp nhận, KISS). Full suite chạy lại sau fix: không đổi (110/2672).

## Còn lại (không sửa, có chủ đích)
- Provider-scoped fallback rules (commandcode billing-402 thuần text) — cần mở rộng `checkFallbackError` signature, để làm riêng.
- importDb không khôi phục được key cross-install (thiết kế S7) — đã cảnh báo loudly; quyết định export-secret/re-key flow cần owner.
- C6 combo cycle legacy → 400 (cải thiện, tự sửa bằng cách edit combo); #24 silent clamp (đã thêm log).
