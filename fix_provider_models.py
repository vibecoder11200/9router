with open("open-sse/config/providerModels.js") as f:
    content = f.read()

# Find and fix the double "],"
# Look for "gemini-web" entry followed by "],  ],"
# The pattern is: 
#   ...  ],
#     ],   <-- extra! Remove this
#   };
old_extra = """  ],
  ],
};"""

new_fixed = """  ],
};"""

if old_extra in content:
    content = content.replace(old_extra, new_fixed)
    print("FIXED double closing bracket")
else:
    print("Pattern not found, checking...")
    # Show what's around the end
    lines = content.split('\n')
    for i, l in enumerate(lines[835:845], 836):
        print(f"{i}: {l}")

with open("open-sse/config/providerModels.js", "w") as f:
    f.write(content)

import subprocess
r = subprocess.run(["node", "--check", "open-sse/config/providerModels.js"], capture_output=True)
print(f"Syntax: {'OK' if r.returncode == 0 else r.stderr.decode()}")
