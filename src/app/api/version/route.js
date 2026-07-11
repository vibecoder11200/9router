import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

// This fork is distributed via GitHub Releases (not npm), so the latest version
// is resolved from the GitHub Releases API, mirroring cli/cli.js checkForUpdate().
const GH_OWNER = "vibecoder11200";
const GH_REPO = "9router";
const RELEASES_LATEST_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
const VERSION_CACHE_TTL_MS = 3600000; // cache GitHub latest lookup for 1h

// Survive hot reload; one cache per process
const versionCache = (global.__ghVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch latest version tag from GitHub Releases (fork). Returns null on any
// failure so the dashboard gracefully shows "no update" instead of crashing.
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      RELEASES_LATEST_API,
      {
        timeout: 4000,
        headers: {
          "User-Agent": "9router-dashboard",
          "Accept": "application/vnd.github+json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const tag = String(JSON.parse(data).tag_name || "").replace(/^v/i, "").trim();
            resolve(tag || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = await getLatestVersionCached();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
