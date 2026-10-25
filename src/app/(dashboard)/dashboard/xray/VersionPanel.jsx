"use client";

// Binary-update panel (Phase 4): version dropdown (stable latest default,
// labeled prereleases) + always-visible Update/Install button + Check.
// Extracted from page.js when it outgrew ~1500 lines.

import { Button } from "@/shared/components";

export default function VersionPanel({
  status,
  versionInfo,
  releases,
  installVersion,
  onInstallVersionChange,
  busy,
  onInstall,
  onCheck,
  onDropdownOpen,
  onRollback,
}) {
  return (
    <>
      <select
        className="text-sm border border-border rounded px-2 py-2 bg-transparent max-w-45"
        value={installVersion}
        onFocus={onDropdownOpen}
        onClick={onDropdownOpen}
        onChange={(e) => onInstallVersionChange(e.target.value)}
        title={installVersion === "latest" ? "Latest stable" : installVersion}
      >
        <option value="latest">Latest (stable){versionInfo?.latest ? ` — ${versionInfo.latest}` : ""}</option>
        {releases.map((r) => (
          <option key={r.version} value={r.version}>
            {r.version}{r.prerelease ? " (pre-release)" : ""}
          </option>
        ))}
      </select>
      <Button onClick={onInstall} disabled={busy}>
        {status.binaryInstalled ? "Update / Reinstall" : "Install Xray Binary"}
      </Button>
      <Button variant="ghost" onClick={onCheck} disabled={busy}>Check</Button>
      {/* .prev (RT-5) holds the exact pre-update binary — always available
          even when the wanted version has fallen off the 30-release list. */}
      {status.rollbackVersion && (
        <Button
          variant="ghost"
          onClick={onRollback}
          disabled={busy}
          title={`Restore the binary retained from before the last update (${status.rollbackVersion})`}
        >
          Rollback to {status.rollbackVersion}
        </Button>
      )}
    </>
  );
}
