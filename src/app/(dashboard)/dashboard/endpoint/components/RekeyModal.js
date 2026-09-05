"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

/**
 * Re-key an imported inert key (POST /api/keys/{id}/rekey — phase-03). The
 * user pastes the RAW key once; the pasted value is never displayed back or
 * stored — success shows only the masked display value.
 */
export default function RekeyModal({ isOpen, keyData, onClose, onSaved }) {
  const [rawKey, setRawKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedKey, setSavedKey] = useState(null);

  // Clear the pasted key and all feedback whenever the modal closes — the raw
  // key must not survive in component state (or the input) past dismissal.
  const handleClose = () => {
    setRawKey("");
    setError(null);
    setSavedKey(null);
    onClose();
  };

  const handleSubmit = async () => {
    if (!keyData || !rawKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/keys/${keyData.id}/rekey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawKey: rawKey.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setSavedKey(data.key?.key || null);
        setRawKey("");
        onSaved(keyData.id);
      } else if (res.status === 409) {
        setError("This key does not need re-keying");
      } else {
        setError(data.error || "Failed to re-key");
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!keyData) return null;

  return (
    <Modal
      isOpen={isOpen}
      title={`Re-key — ${keyData.name}`}
      onClose={() => { if (!saving) handleClose(); }}
    >
      <div className="flex flex-col gap-4">
        {savedKey ? (
          <>
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
              <p className="text-sm font-medium text-green-600 dark:text-green-400 mb-2">
                Re-keyed — key now validates on this install
              </p>
              <code className="text-xs text-text-main font-mono break-all">{savedKey}</code>
            </div>
            <Button onClick={handleClose} fullWidth>
              Done
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              Only needed for keys imported from another install. Paste the raw key once to
              make it authenticate on this machine.
            </p>
            <Input
              label="Raw key"
              type="password"
              value={rawKey}
              onChange={(e) => setRawKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
            {error && (
              <p className="text-xs text-red-500 break-words">{error}</p>
            )}
            <div className="flex gap-2">
              <Button onClick={handleSubmit} fullWidth disabled={saving || !rawKey.trim()}>
                {saving ? "Re-keying..." : "Re-key"}
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth disabled={saving}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

RekeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  keyData: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
  }),
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func.isRequired,
};
