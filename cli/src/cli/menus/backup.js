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

// v0.6.46 Option F (F-on): the WHOLE archive is passphrase-sealed — honest
// counterpart to the .45 note above; replaces it on the encrypted path.
const ENCRYPTED_NOTE =
  "Everything in this file is encrypted with your passphrase; losing it " +
  "makes the backup unrecoverable.";

// RT46-A3-class hazard, caught client-side: http headers are latin1 on the
// wire — non-ASCII passphrases must be rejected before exportDatabase can
// throw ERR_INVALID_CHAR. The server-side 400 remains the authoritative gate.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function printWarnings(warnings) {
  (warnings || []).forEach((w) => {
    console.log(`${COLORS.yellow}⚠ ${w}${COLORS.reset}`);
  });
}

/**
 * Print the generated archive passphrase in a bordered show-once block.
 * Called exactly ONCE per generated passphrase — never reprinted (a retype
 * mismatch cancels the flow; regenerating means a NEW passphrase by design).
 * @param {string} passphrase - Grouped passphrase exactly as returned by the server
 */
function printShowOnceBlock(passphrase) {
  const width = Math.max(60, passphrase.length + 4);
  const line = "─".repeat(width);
  console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
  console.log(`${COLORS.cyan}│ 🔑 Archive passphrase (shown ONCE)${COLORS.reset}`);
  console.log(`${COLORS.cyan}│${COLORS.reset}`);
  console.log(`${COLORS.cyan}│  ${passphrase}${COLORS.reset}`);
  console.log(`${COLORS.cyan}│${COLORS.reset}`);
  console.log(
    `${COLORS.cyan}│  This cannot be shown again — write it down or copy it now.${COLORS.reset}`
  );
  console.log(`${COLORS.cyan}${line}${COLORS.reset}`);
}

/**
 * "Enter my own passphrase" sub-flow: double masked entry with local checks.
 * The server is the enforcer; these checks exist to fail fast with clear
 * messages (non-ASCII would kill the http header outright).
 * @returns {Promise<{passphrase: string|null, error: string|null}>}
 */
async function promptOwnPassphrase() {
  const first = await promptSecret(
    "Archive passphrase (min 10 chars, input hidden): "
  );
  if (first === null) return { passphrase: null, error: null }; // Ctrl+C → silent cancel
  const second = await promptSecret("Confirm passphrase (input hidden): ");
  if (second === null) return { passphrase: null, error: null };
  if (!first || !second) {
    return { passphrase: null, error: "Passphrase cannot be empty." };
  }
  if (!PRINTABLE_ASCII.test(first)) {
    return {
      passphrase: null,
      error:
        "Passphrase must contain only printable ASCII characters (letters, digits, punctuation) — " +
        "other characters cannot travel safely in an HTTP header. Please choose an ASCII passphrase.",
    };
  }
  if (first.replace(/[ -]/g, "").length < 10) {
    return {
      passphrase: null,
      error:
        "Passphrase too short (minimum 10 characters after removing spaces and hyphens).",
    };
  }
  if (first !== second) {
    return { passphrase: null, error: "Passphrases do not match." };
  }
  return { passphrase: first, error: null };
}

/**
 * Ask whether to encrypt the archive; when yes, run the own/generate
 * sub-choice (bounded 3 tries → cancel) and return the chosen passphrase
 * (null = plain export or cancelled).
 * @param {string} password - Dashboard password already collected (auth)
 * @returns {Promise<{cancelled: boolean, passphrase: string|null}>}
 */
async function collectArchivePassphrase(password) {
  const answer = await prompt(
    "Encrypt the whole archive with a passphrase? (y/N): "
  );
  if (answer.trim().toLowerCase() !== "y") {
    return { cancelled: false, passphrase: null }; // plain Enter = N → .45 flow
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const choice = await prompt(
      "1) Enter my own passphrase   2) Generate one for me\nSelect option (number): "
    );
    if (choice.trim() === "1") {
      const { passphrase, error } = await promptOwnPassphrase();
      if (passphrase !== null) return { cancelled: false, passphrase };
      if (error) {
        showStatus(error, "error");
        continue; // restart the sub-choice, bounded
      }
      return { cancelled: true, passphrase: null }; // Ctrl+C on a masked prompt
    }
    if (choice.trim() === "2") {
      let genRes;
      try {
        genRes = await api.getArchivePassphrase(password);
      } catch (err) {
        // Same no-crash rule as the export call below (a916ec20 pattern).
        showStatus(`Could not generate passphrase: ${err.message}`, "error");
        return { cancelled: true, passphrase: null };
      }
      if (!genRes.success || !genRes.data || !genRes.data.passphrase) {
        showStatus(
          `Could not generate passphrase: ${genRes.error || "empty response"}`,
          "error"
        );
        return { cancelled: true, passphrase: null };
      }
      const generated = genRes.data.passphrase;
      printShowOnceBlock(generated);
      for (let retype = 1; retype <= 3; retype++) {
        const entry = await promptSecret(
          "Retype the passphrase exactly to confirm (input hidden): "
        );
        if (entry === null) return { cancelled: true, passphrase: null };
        if (entry === generated) return { cancelled: false, passphrase: generated };
        // NEVER reprint the passphrase — offer remaining tries only.
        if (retype < 3) {
          showStatus(
            `Passphrase does not match (${3 - retype} attempt(s) left — it cannot be shown again)`,
            "error"
          );
        }
      }
      showStatus("Export cancelled (passphrase not confirmed)", "info");
      return { cancelled: true, passphrase: null };
    }
    showStatus("Invalid selection. Please enter 1 or 2.", "error");
  }
  showStatus("Export cancelled (too many invalid attempts)", "info");
  return { cancelled: true, passphrase: null };
}

/**
 * Export the full database backup to a JSON file in cwd (RT-15: guarded write)
 */
async function handleExport() {
  console.log("\n📤 Export Backup");
  console.log("─".repeat(30));

  // RT46-A5: the .45 CLI cancels on empty/null password — kept byte-identical.
  // There is no token-only export path from this menu (that exists only at
  // the HTTP contract level; the CLI always sends its token header anyway).
  const password = await promptSecret(
    "Dashboard password (wraps the key secret) (input hidden): "
  );
  if (password === null || password === "") {
    showStatus("Export cancelled", "info");
    await pause();
    return true;
  }

  // v0.6.46 Option F: opt-in whole-archive encryption (default N).
  const { cancelled, passphrase: archivePassphrase } =
    await collectArchivePassphrase(password);
  if (cancelled) {
    await pause();
    return true;
  }

  let res;
  try {
    res = await api.exportDatabase(
      password,
      archivePassphrase ? { archivePassphrase } : {}
    );
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
  const file = archivePassphrase
    ? `9router-backup-${stamp}-encrypted.json`
    : `9router-backup-${stamp}.json`;
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
  if (archivePassphrase) {
    console.log(ENCRYPTED_NOTE);
  } else {
    console.log(SECURITY_NOTE);
  }
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
  if (payload && payload.format === "9router-encrypted-archive") {
    // v0.6.46 Option F: passphrase-sealed wrapper — unwrap happens
    // server-side BEFORE importDb; a wrong passphrase hard-fails with the
    // DB untouched. Offer exactly ONE retry of the passphrase, then menu.
    let archivePassphrase = await promptSecret("Archive passphrase (input hidden): ");
    if (!archivePassphrase) {
      showStatus("Import cancelled", "info");
      await pause();
      return true;
    }
    try {
      res = await api.importDatabase(payload, password, { archivePassphrase });
    } catch (err) {
      showStatus(`Import failed: ${err.message}`, "error");
      await pause();
      return true;
    }
    if (
      !res.success &&
      typeof res.error === "string" &&
      /wrong archive passphrase/i.test(res.error)
    ) {
      showStatus(`Import failed: ${res.error}`, "error");
      archivePassphrase = await promptSecret(
        "Retry once — archive passphrase (input hidden): "
      );
      if (archivePassphrase) {
        try {
          res = await api.importDatabase(payload, password, { archivePassphrase });
        } catch (err) {
          showStatus(`Import failed: ${err.message}`, "error");
          await pause();
          return true;
        }
      }
    }
  } else {
    try {
      res = await api.importDatabase(payload, password);
    } catch (err) {
      showStatus(`Import failed: ${err.message}`, "error");
      await pause();
      return true;
    }
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
      "unencrypted). Wrong password on import = keys need re-keying.\n" +
      "Backups can optionally be encrypted with a passphrase (recommended for " +
      "off-device storage). Encrypted backups cannot be opened without the passphrase.",
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
