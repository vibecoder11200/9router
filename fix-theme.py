#!/usr/bin/env python3
with open("src/app/globals.css", "r") as f:
    content = f.read()

# Replace @theme inline with @theme
content = content.replace("@theme inline {", "@theme {")

with open("src/app/globals.css", "w") as f:
    f.write(content)

print("OK - changed @theme inline to @theme")
