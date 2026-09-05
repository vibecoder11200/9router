# Circuit Breaker

Circuit breaker từng tài khoản ngăn 9Router dồn request vào một tài khoản đang rõ ràng là hỏng. Khi một tài khoản lỗi liên tục, breaker "mở" và bỏ qua nó trong thời gian cooldown — rồi thăm dò nhẹ nhàng trước khi tin lại.

Cơ chế nằm bên trong vòng fallback của chat, nên khi một tài khoản bị ngắt, request của bạn đơn giản rơi sang tài khoản khỏe tiếp theo. **Bạn không bao giờ thấy lỗi.**

---

## Cách hoạt động

```
Tài khoản lỗi 5 lần trong 60s
        ↓
🔴 Breaker MỞ — tài khoản bị bỏ qua 60s
        ↓ hết cooldown
🟡 Half-open — chính xác MỘT request thật được vào như probe thụ động
        ↓
✅ Thành công → breaker đóng, tài khoản trở lại hoàn toàn
❌ Thất bại → mở lại với cooldown ×2 (30s→60s→120s…, tối đa 10 phút)
```

- **Ngưỡng lỗi**: 5 lỗi cấp tài khoản trong cửa sổ 60 giây (mặc định).
- **Cooldown tăng dần**: mỗi lần mở lại nhân đôi cooldown, trần 10 phút.
- **Probe thụ động**: một request người dùng thật đóng vai trò probe — không có traffic tổng hợp, và người phía sau không bao giờ bị hy sinh: probe fail thì request rơi sang tài khoản tiếp theo.
- **Không đếm chồng**: quota-429 đã xử lý bởi strike-block của antigravity không bị tính là lỗi breaker.

Khi breaker mở hoặc phục hồi, cảnh báo `breaker-open` / `breaker-recovered` tương ứng bắn ra (xem [Cảnh báo](./alerts.md)).

---

## Panel trên Dashboard

```
Dashboard → Quota → panel Circuit Breaker

Tài khoản          Trạng thái  Lỗi     Cooldown
cc/claude-opus-5   🔴 open      7       thử lại sau 42s
cx/gpt-5.6-sol   🟡 half-open 1       đang probe…
glm/glm-4.7        🟢 closed    —       —
```

Panel hiển thị breaker đang mở/half-open, số lỗi gần đây, đếm ngược cooldown, strike-block của antigravity, và nút **reset thủ công** khi bạn đã sửa nguyên nhân gốc và không muốn chờ hết cooldown.

Reset thủ công qua API:

```bash
POST /api/providers/{providerId}/breaker
```

---

## Cấu hình

| Thiết lập | Mặc định | Ý nghĩa |
|---|---|---|
| `breakerEnabled` | `true` | Kill switch — `false` trả về đúng hành vi cũ không có breaker |
| `breakerFailureThreshold` | `5` | Số lỗi trong cửa sổ trước khi mở |
| `breakerWindowSec` | `60` | Cửa sổ đếm lỗi |
| `breakerBaseCooldownSec` | `60` | Cooldown đầu; nhân đôi mỗi lần mở lại |

Chỉnh qua Dashboard → Settings. Nếu nghi breaker hành xử sai, tắt `breakerEnabled` — hành vi y hệt vòng fallback cũ.

---

## Khi nào breaker ngắt

Các nguyên nhân đáng kiểm tra khi nhận cảnh báo `breaker-open`:

- Provider sập hoặc API suy giảm (phổ biến nhất)
- OAuth token của tài khoản đó hết hạn/bị thu hồi
- Proxy phía trước tài khoản chết (kiểm tra proxy pool)
- Strike quota của Antigravity (hiển thị trong panel, nhưng không đếm ở đây)

---

## Liên quan

- [Cảnh báo](./alerts.md) - sự kiện `breaker-open` / `breaker-recovered`
- [Smart Routing](./smart-routing.md) - vòng fallback chứa breaker
