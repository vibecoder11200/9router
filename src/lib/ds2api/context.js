// Shared resolution of the DS2API sidecar runtime context for server routes.
import { getSettings } from "@/lib/localDb";
import { DEFAULT_DS2API_URL } from "./detect.js";
import { getCredentials, getManagedPid } from "./process.js";

export async function resolveDs2api() {
  const settings = await getSettings();
  const base = String(settings.ds2apiUrl || DEFAULT_DS2API_URL).replace(/\/$/, "");
  const creds = getCredentials();
  return {
    base,
    adminKey: creds?.adminKey || null,
    apiKey: creds?.apiKey || null,
    managedPid: getManagedPid(),
  };
}
