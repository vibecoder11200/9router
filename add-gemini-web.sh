#!/bin/bash
set -e

# Read cookie file and extract relevant cookies
cd /home/luna/9router

# Login first
LOGIN_RESP=$(curl -sk -c /tmp/gw-cookies.txt https://localhost:9997/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"123456"}')
echo "Login: $LOGIN_RESP"

# Cookie data (from the file) - key cookies for Gemini Web
SAPISID="kNEOGLOXDvT2GGfV/AlXSAM0dmmi1uVscy"
SECURE_1PSID="g.a000-wjhGhFSZIbh0fSTtAzN3q-vcCN9hcYQdclFaLxvkUWH6bSQ4bMLtojJbG7p6JZQuti_7QACgYKAVMSARASFQHGX2MiONaxNcDhgkZAy8pHMTw46xoVAUF8yKoY4szfyyr30zR2nNZLaXPM0076"
SECURE_3PSID="g.a000-wjhGhFSZIbh0fSTtAzN3q-vcCN9hcYQdclFaLxvkUWH6bSQtbgj9rQ2XygisJ-sOS-ekwACgYKAYISARASFQHGX2Mi6C9eqbZXjqkGFd5xK-HqqhoVAUF8yKp9bNJ2VN_PRRPU7_7CQ-Pc0076"
SECURE_1PSIDTS="sidts-CjIByojQU5d5hBnR1gnSv6-9rXB1V7-8y_B3onx9XBiW0WQnBDar_NHs0jFoe231NMWXbRAA"
SECURE_3PSIDTS="sidts-CjIByojQU5d5hBnR1gnSv6-9rXB1V7-8y_B3onx9XBiW0WQnBDar_NHs0jFoe231NMWXbRAA"
SID="g.a000-wjhGhFSZIbh0fSTtAzN3q-vcCN9hcYQdclFaLxvkUWH6bSQE5TkSWqFOllYBJR5mDytuAACgYKAV4SARASFQHGX2Mi3ro9gORKTMSWRojT9wYuIBoVAUF8yKpHj72s7wU8gVJPk9XVe_F70076"
HSID="A2cTU0PGxKziXucCU"
SSID="ATm_IcKtSIDJO1Wxc"
APISID="QR1rM1qok7s6Olo6/AtoeglMMswNvK_EYw"
SECURE_1PAPISID="kNEOGLOXDvT2GGfV/AlXSAM0dmmi1uVscy"
SECURE_3PAPISID="kNEOGLOXDvT2GGfV/AlXSAM0dmmi1uVscy"
AEC="AaJma5vmFPlNi08SwfT-J-4_d95IFcXbP080BAaS2QzLoBoivccETxW_imk"
NID="532=ZCIJEuLEP9EK3P1BDr_8D2SH5-grk1HSEMjxyEKX-bApU_dCCH_PZpA1dvRJ_xeqkNLjhrAf1h-qFdVaYHjVO9c3xQ80pBS2NabuYN4hKIpGmiiCzlMyzd5QYF_OXjGjV56WFjze58WvWFnKyQueEHA_8dLoTg9rN46w5n8dbtfhcAVpnj47WLXRpzyrIN-mmZZvyj0nOFcRz48etGsPui9ABNqBju4-sGYZi5OTpP6N0Ts2T3Ibu1nOIBXImSVcR0ZC2pw3svNlYkSvp1SBUSeFVFd6rX1b4XCcNx_S3gSy3YgDzx6n7zX3SDT0SO4T2QNrkmSk3aRJLEVERcaM38UJGAqM1IWenJtyGXrid3LLLSmoMI1S0icXpqcmwzr6oMZzc2CW4GNIgaqjlxW1jwx81W88wm7oMl3p7PxoN7GhUy2cWMwe9WB5cpsTLwkoSaIzMVp3KbN4OE-Dq86g1SYIdJ6BWujlYsarp2WpYjzQfai0xve78QfWD6ced-WH_vOBi3pJzitYRBOtlMyhwhh0uWLCleMDjE1TBA-n072s3zXA6RBLEraekbp0oPLFBb8QSSIBWKBfeVW_6RMsSH6a_UBOprRHDflSPgWSqmUjy6Ba4Sb6p71djhtJyuR1qGaLfDp76Ned5Lt3JFgmCK-NH8pXZ5kjBY3dwfnML8dAM1CBsSZk7A1F1Wx1qKo0MvnyL93w8cNScRodxjA2QZk27B0vGeDDImUxHGbM8ezM3IkV0Yad4O7syjEzvtycyymamx_mg-_rvA6-oBTymzu-o65uGvxqpOEd1B59Te3JYq8nh7laQufJmkyIBmZXrcOaN6MIATorQ5IyZ6U-weBndTXUKYOK71Uv3exPoAxG46ZXpUBSPCly-uiAZfWvI0yY2ADsjC5Ds9vSKWG75SW0w8JQy_sujoZ8HFDExMt8HXufuoTvsdu6sM7X0mznF6MwFBoxjwP_xf750gR_K-Uc-Btn9TE4x0Dd9NMH-hP5HVKI_OM_5D9wLRyr9TFK7Md7sYR9fz2YXN01Eg9u0rNEXoQTdszWnuAxLnLwvaz5dwVBxDJ7LdNtKKTRGXN_w1mQ6lUowrcupGQMCTDvR80FuiJ3IzxsQBeZQ8l1GeFKDuzkiRWJbjPet8ylVmCvil5pH-hRZ8rTOcl7AWZ0b5XuvhaqYSCjP_zWFht_AlyNC2A-EAyt506CG29LfBAd9nEK6SL8yse0HBseFyeJx7NjvlNRGufSKC7Pwx61SNquR0kckCZcbcmmxmH_ZoI6xxCjXubklODwwtH8kkE0ZQM2hjynXWM5Q7zVBg5JIHBiQd8Z7YUe2pd0mzCEdvfQ5HeEdy3Mi8jHg7Tz9dXdynBY79jQbWW9_ZmCHneAs5WsPRHe5pEtS88PZmvDcFUv1f0YHe9FLtSbvHE1nu6MeVpf2QZYQHa-6G-TSEredkMfuvoM9_NeUUvLsvba5jaDlILdQ8IklNVXDECO-wbJf2AcdQ5NO3v2AnLyrduVg2tyZajVe1AXKFG3jofI9aCyaoXLlDIIE4iUn-K57D5MO3F-Kp4tQJp_Ez0-BGohNEiOzvsnOj6PwupKFlGZqX4ycZIlYVewK9SYYlBVj_oiFMnjdQZUnsY-40xqCTjn2afywta7LG-qPAu1ZDPVsK5lcymHWxOYP2TzbsbKaFvu4yp3CeyPb6yjEcjv_wH6ylp77gC2YZWYcKQSLUbMk-gcncsh9OpJKpa2_nRNEAKApFJVHeC2WPKnd-dRTJJ5E3gqPRaL34XXCtjlyCzdEj9w47v9rEHKg20fT_5phIiUOz73OLA7dkiDZTzWnXzruOyWETDyKPUrJrTmsTvXdNd0Nquu2DXeOaDD_VtcepX6amxMPAsKNOORX9_yWNIZ-rBtB9WROfBi4IQ6AujlbXTfIOPeBMHrGxjq2AjoZLgGCcR7HCjhvCVLEGAcECH9L45yWHtCQEl6Cey4XTdshzPidGbXB8S_mEjmoF0vXglv_V9t-XcFI1IWYzs0p75vc7ZSj1yG7_IZoLLoddhTx444bZtFJTIV6uxnu7cLXkAZZ-2954gsjgs7IL4w3HZ1nw-Ksj3G143bVeeZWS-b3U-INFnvfDsR-Fr7Nt6EKOrfp9GaC2kMWTyjgdVZ6CHjX_wGDM1tTreejGpcRJvvX7RW221yQkT64PBQw3HRtYCoHGfmh7JYgxDc5RyIyWv63yNIi7FNaExgMkiyr-uN5AnprmDX6_35wTLF55s8_Ej_gutJnzxpdQbtTDkhwYnHN0KvkgaD1pqMYRETY84owfB1R2zpf9aKKLkntisyoTYUFbLsiKWpKe3dOu2RuDUYdfo-DVrtgDJveLllrMyCQ2rI5xceTKtKujpseqiAr6mJlsMuhXM"
COMPASS="gemini-pd=CjwACWuJV93jFYb_b6k1ZbZc5AVi75OXfwVJx6huPFdJgLZgT-iphNSBtyIyTho-2Gurv4U86El7hPmdVFUQ0ciu0QYaZgAJa4lXZnO5V8_MqeRbxjfjkdia3tLnS6Mu7WXacLvQhP-cMy69cJIet3zocOsloYyGK6W6jJOV7ofXAxIuUikLQKf_yVJ_GcxnpDJ528pc91unejoNs0XBnVrhg6U6QFvmRUSKkSABKnAIARDeyK7RBhpmAAlriVchrRxjZo8Vm8rs3tpxgDjQVP4H4ZcuR1Vj_aTVV46ZeEK4yrCeRpiVMTkDyolxJpnB1fwSf5kMemeAs7GR5Xz-Lh7kIkjBZ9nCJHEfrpM4Va8vRJW5lmiPiWoHwdLp_RENKnAIAhDbyK7RBhpmAAlriVea-0D92NIIKjOjmSeEMFR8TMzgzF5f8XFG-uSm8mX0yvlCQBduKiC9rnKtQY1i7Fmw9ovBz5LajD_YhWZD9dixEY_0j7omhHiwZ-UFMpzpF_xu72ugmfAMWxuMReoDrQ0vMAE"

# Encode to JSON format that gemini-web expects
COOKIE_JSON=$(cat << ENDJSON
[
  {"domain":".google.com","name":"SAPISID","value":"$SAPISID","secure":true,"httpOnly":false},
  {"domain":".google.com","name":"__Secure-1PSID","value":"$SECURE_1PSID","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"__Secure-3PSID","value":"$SECURE_3PSID","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"__Secure-1PSIDTS","value":"$SECURE_1PSIDTS","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"__Secure-3PSIDTS","value":"$SECURE_3PSIDTS","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"SID","value":"$SID","secure":false,"httpOnly":false},
  {"domain":".google.com","name":"HSID","value":"$HSID","secure":false,"httpOnly":true},
  {"domain":".google.com","name":"SSID","value":"$SSID","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"APISID","value":"$APISID","secure":false,"httpOnly":false},
  {"domain":".google.com","name":"__Secure-1PAPISID","value":"$SECURE_1PAPISID","secure":true,"httpOnly":false},
  {"domain":".google.com","name":"__Secure-3PAPISID","value":"$SECURE_3PAPISID","secure":true,"httpOnly":false},
  {"domain":".google.com","name":"AEC","value":"$AEC","secure":true,"httpOnly":true},
  {"domain":".google.com","name":"NID","value":"$NID","secure":true,"httpOnly":true},
  {"domain":".gemini.google.com","name":"COMPASS","value":"$COMPASS","secure":true,"httpOnly":true}
]
ENDJSON
)

# Create provider connection with cookies
echo "=== Creating Gemini Web connection ==="
curl -sk -b /tmp/gw-cookies.txt https://localhost:9997/api/providers \
  -H 'Content-Type: application/json' \
  -d "$(cat << ENDPAYLOAD
{
  "provider": "gemini-web",
  "connectionName": "Gemini Web - khanhnq",
  "apiKey": "",
  "proxyConfig": { "connectionProxyEnabled": false },
  "proxyPoolId": null,
  "isWebCookieProvider": true,
  "providerSpecificData": {
    "cookies": $COOKIE_JSON
  }
}
ENDPAYLOAD
)"

echo ""
echo "=== Done ==="
