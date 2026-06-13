#!/usr/bin/env python3
import os
os.chdir("/home/luna/9router")
with open("src/app/(dashboard)/dashboard/providers/page.js", "r") as f:
    content = f.read()

# Uncomment the Web Cookie Providers section
# Fix 1: Remove opening comment markers
old1 = '{/* Web Cookie Providers — use browser subscription cookie instead of API key */}'
new1 = '/* Web Cookie Providers — use browser subscription cookie instead of API key */'

old2 = '{/* <div className="flex flex-col gap-4">'
new2 = '<div className="flex flex-col gap-4">'

# More targeted: just remove all JSX comment markers within this section
# Pattern: remove "{/* " and " */}" 

# Actually, simpler approach: find and replace the exact commented block
old_block = """      {/* Web Cookie Providers — use browser subscription cookie instead of API key */}
      {/* <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Web Cookie Providers{" "}
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Object.entries(WEB_COOKIE_PROVIDERS).map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
      </div> */}"""

new_block = """      {/* Web Cookie Providers — use browser subscription cookie instead of API key */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Web Cookie Providers{" "}
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Object.entries(WEB_COOKIE_PROVIDERS).map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
      </div>"""

assert old_block in content, "Could not find the commented block!"
content = content.replace(old_block, new_block)

with open("src/app/(dashboard)/dashboard/providers/page.js", "w") as f:
    f.write(content)

print("OK - uncommented Web Cookie Providers section!")
print("Block replaced successfully!")
