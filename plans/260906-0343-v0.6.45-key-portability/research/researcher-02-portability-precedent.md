# Researcher-02: Credential portability precedent in comparable self-hosted gateways

Date: 2026-09-06. NOTE: web search quota exhausted mid-task; findings rely on attempted fetches + maintainer docs knowledge; URLs marked (unfetched) could not be re-verified live today.

## Product-by-product

### 1. LiteLLM proxy (BerriAI/litellm)
- Virtual keys optionally stored **hashed** in DB via `LITTELLM_SALT_KEY` (env) + `LITTELLM_STORE_VIRTUAL_KEYS_IN_DB_HASHED=true`. Master key stays in config/env, not DB.
- Docs explicitly state: if `LITTELLM_SALT_KEY` is lost/changed, hashed keys **cannot be recovered/validated**; keep the same salt across environments. Docs treat salt as a **deployment secret that must be backed up alongside the DB** (i.e., "ship the pepper with your own infra backup"), but they do NOT package the salt inside a portable, encrypted backup blob.
- So LiteLLM's implicit answer: backup = DB + env secrets together; no encrypted-in-backup export, no re-key flow.
- Sources: https://docs.litellm.ai/docs/proxy/virtual_keys (unfetched), https://docs.litellm.ai/docs/hashing_keys (404 — moved; salt-key behavior per docs history), GitHub issues BerriAI/litellm searching "salt key" (unfetched).

### 2. one-api (songquanpeng) / new-api (Calcium-Ion)
- Tokens (`tokens.key`) and upstream channel keys (`channels.key`) stored **plaintext** in DB (default SQLite `one-api.db`). Backup/restore = copy DB file; everything just works because nothing is hashed.
- Verdict: they dodge the problem entirely by not hashing — security trade-off, not a portability pattern to copy.
- Sources: https://github.com/songquanpeng/one-api (code: model/token.go stores plaintext key; unfetched today).

### 3. Portkey / Higress / uni-api / Kong
- These keep credentials in **config files / env** (Portkey gateway config.yaml, uni-api YAML, Kong declarative DB-less config), not hashed in a DB. Portability = copy the config file; secrets travel with it. No pepper, no re-key.
- Kong: `kong config db_import`/declarative config carries key-auth credentials (plaintext or hashed via keyring encryption, where the keyring key must itself be restored with the same node — same pepper-portability caveat as LiteLLM).
- Sources: https://docs.konghq.com/gateway/entities/keyring/ (unfetched), https://github.com/Portkey-AI/gateway (config-based, unfetched).

### 4. "Show-once" hashed-token products
- **Gitea**: tokens stored SHA-256 hashed; `gitea dump` **includes `app.ini` (SECRET_KEY, INTERNAL_TOKEN, CREDENTIAL_STORE_SECRET) together with the DB** — i.e., Gitea DOES ship the pepper inside its official backup artifact (unencrypted zip, protected by operator file perms). Restore without app.ini breaks token validation. This is the strongest precedent FOR option A's mechanics, though the backup itself is not passphrase-encrypted.
  - Sources: https://docs.gitea.com/administration/backup-and-restore/ (linked from upgrade page, fetched indirectly), https://docs.gitea.com/installation/upgrade-from-gitea (fetched: config is a required backup component).
- **Grafana**: API keys/service-account tokens hashed (SHA-256 of base64) in DB, no pepper — restore a Grafana DB anywhere and token hashes still validate; losing the raw token is unrecoverable (re-issue required). No pepper export exists.
  - Source: https://grafana.com/docs/grafana/latest/administration/api-keys/ (unfetched).
- **MinIO**: credentials are not show-once-hashed; access keys stored reversibly in IAM — not applicable precedent.

## Verdict table (one line each)

| Product | Pepper in backup? | Pattern |
|---|---|---|
| LiteLLM | Pepper in *infra* backup (env), not in a portable encrypted artifact | "back up salt with DB" |
| one-api / new-api | N/A — plaintext keys in DB | avoid hashing |
| Kong (keyring) | Keyring key must be restored with node | same as LiteLLM |
| Portkey / Higress / uni-api | N/A — plaintext in config file | config-as-backup |
| Gitea | **YES — app.ini (pepper/secrets) inside `gitea dump`** | pepper ships in backup |
| Grafana | No pepper at all (unpeppered SHA-256) | hashes portable, raw keys unrecoverable |

## Conclusion for 9router
- **Precedent for A (ship pepper in backup): exists — Gitea `dump` is the canonical example**, and LiteLLM requires equivalent practice at the infra level. No surveyed product *encrypts* the pepper with a dashboard password inside the backup, so 9router's option A is a modest novelty on top of a proven pattern (Gitea ships it unencrypted).
- **Precedent for B (re-key after restore): Grafana-style** — no product ships an explicit "re-paste each key" import flow; Grafana's equivalent is just "create new tokens" (manual, per-token, same UX as B).
- **Industry norm**: "backup must include the secrets required to validate credentials" (Gitea, LiteLLM, Kong keyring all converge here). B is a fallback, not the norm.
- Recommendation: **A is defensible and precedented** (Gitea dump); hardening A toward F — encrypt the whole backup (or at least the secret blob) with a passphrase — closes the gap where 9router would otherwise be shipping an unencrypted pepper like Gitea does. B remains a good degraded-mode/fallback path.

## Unresolved questions
- LiteLLM docs URL for hashing moved; exact doc wording on salt-loss behavior not re-verified live (search quota exhausted). Verify at https://docs.litellm.ai/docs/proxy/virtual_keys.
- Whether any product passphrase-encrypts the pepper inside the backup: none found — suspected confirmed, but only 3 verified live sources today.
- new-api may have added encrypted-token storage in recent versions; unverified.
