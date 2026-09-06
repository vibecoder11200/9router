const fs = require("fs");
const path = require("path");
const api = require("../api/client");
const { prompt, promptSecret, pause, COLORS } = require("../utils/input");
const { showStatus } = require("../utils/display");
const { showMenuWithBack } = require("../utils/menuHelper");

// RT-16: every mention of the wrapped secret must stay honest — the key
// secret is encrypted, the REST of the backup (incl. provider tokens) is not.
const SECURITY_NOTE =
  "It contains an encrypted copy of your API-key secret — but provider access " +
  "tokens inside are NOT encrypted; store the file securely.";

function printWarnings(warnings) {
  (warnings || []).forEach((w) => {
    console.log(`${COLORS.yellow}⚠ ${w}${COLORS.reset}`);
  });
}

/**
 * Export the full database backup to a JSON file in cwd (RT-15: guarded write)
 */
async function handleExport() {
  console.log("\n📤 Export Backup");
  console.log("─".repeat(30));

  const password = await promptSecret(
    "Dashboard password (wraps the key secret) (input hidden): "
  );
  if (password === null || password === "") {
    showStatus("Export cancelled", "info");
    await pause();
    return true;
  }

  let res;
  try {
    res = await api.exportDatabase(password);
  } catch (err) {
    // The API call itself can throw (non-latin1 password makes http.request
    // reject with ERR_INVALID_CHAR; connection refused) — same no-crash rule
    // as the guarded write below: menuHelper runs actions without try/catch.
    showStatus(`Export failed: ${err.message}`, "error");
    await pause();
    return true;
  }
  if (!res.success) {
    showStatus(`Export failed: ${res.error}`, "error");
    await pause();
    return true;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = `9router-backup-${stamp}.json`;
  try {
    fs.writeFileSync(file, JSON.stringify(res.data, null, 2), { mode: 0o600 });
  } catch (err) {
    // RT-15: EBUSY/EPERM (file open in an editor, OneDrive cwd) must not
    // crash the TUI — menuHelper runs actions without try/catch.
    showStatus(
      `Could not write backup file: ${err.message} (target: ${path.resolve(file)})`,
      "error"
    );
    await pause();
    return true;
  }

  console.log(`\n✅ Backup written: ${path.resolve(file)}`);
  console.log(SECURITY_NOTE);
  // RT-17: envelope-less export (e.g. fresh install without a stored
  // password) carries a portable-backup warning — print it verbatim.
  printWarnings(res.data && res.data.warnings);
  await pause();
  return true;
}

/**
 * Import a database backup from a JSON file
 */
async function handleImport() {
  console.log("\n📥 Import Backup");
  console.log("─".repeat(30));

  const filePath = await prompt("Path to backup .json: ");
  if (!filePath) {
    showStatus("Import cancelled", "info");
    await pause();
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath.trim(), "utf8"));
  } catch (err) {
    showStatus(`Could not read backup file: ${err.message}`, "error");
    await pause();
    return true;
  }

  const password = await promptSecret(
    "Password used when this backup was exported (input hidden): "
  );
  if (password === null) {
    showStatus("Import cancelled", "info");
    await pause();
    return true;
  }

  let res;
  try {
    res = await api.importDatabase(payload, password);
  } catch (err) {
    showStatus(`Import failed: ${err.message}`, "error");
    await pause();
    return true;
  }
  if (!res.success) {
    showStatus(`Import failed: ${res.error}`, "error");
    await pause();
    return true;
  }

  console.log("\n✅ Import complete.");
  printWarnings(res.data && res.data.warnings);
  const needsRekeyCount = res.data && res.data.needsRekeyCount;
  if (needsRekeyCount > 0) {
    console.log(
      `${COLORS.yellow}→ ${needsRekeyCount} key(s) need re-keying: API Keys → select the key → Re-key (paste raw key)${COLORS.reset}`
    );
  }
  await pause();
  return true;
}

/**
 * Backup & Restore menu
 * @param {number} port - Server port number
 * @param {Array<string>} breadcrumb - Breadcrumb path
 */
async function showBackupMenu(port, breadcrumb = []) {
  await showMenuWithBack({
    title: "💾 Backup & Restore",
    breadcrumb,
    headerContent:
      "Export embeds your API-key secret encrypted with the dashboard password " +
      "(the rest of the backup — including provider access tokens — stays " +
      "unencrypted). Wrong password on import = keys need re-keying.",
    items: [
      {
        label: "Export Backup",
        action: async () => {
          await handleExport();
          return true;
        }
      },
      {
        label: "Import Backup",
        action: async () => {
          await handleImport();
          return true;
        }
      }
    ]
  });
}

module.exports = {
  showBackupMenu
};
