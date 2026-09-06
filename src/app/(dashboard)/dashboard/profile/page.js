"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Toggle, Input } from "@/shared/components";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import LanguageSwitcher from "@/shared/components/LanguageSwitcher";
import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG } from "@/shared/constants/config";
import { LOCALE_COOKIE, normalizeLocale } from "@/i18n/config";
import { LOCALE_FLAGS } from "@/shared/constants/locales";

// RT46-A3/O3: printable-ASCII-only passphrases on the dashboard surface.
// Browser fetch truncates header chars U+0100–U+01FF (`codepoint & 0xFF`) —
// without this client-side gate (enforced BEFORE any request fires), a
// passphrase with such a char gets sealed under a TRANSFORMED value and the
// archive becomes unopenable from every surface. The server 400 is the backstop.
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const PASSPHRASE_ASCII_HINT = "passphrase must be printable ASCII — spaces and hyphens are ignored";

function getLocaleFromCookie() {
  if (typeof document === "undefined") return "en";
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : "en";
  return normalizeLocale(value);
}

export default function ProfilePage() {
  const { theme, setTheme, isDark } = useTheme();
  const [locale, setLocale] = useState(() => getLocaleFromCookie());
  const [langOpen, setLangOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [settings, setSettings] = useState({ fallbackStrategy: "fill-first" });
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState({ type: "", message: "" });
  const [dbAuth, setDbAuth] = useState({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false });
  const pendingImportRef = useRef(null);
  // v0.6.46 Option F export state machine. Opened AFTER the dbAuth password
  // step (password collected FIRST in every path — auth → passphrase mental
  // model). step: "choose" | "own" | "panel"; choice: "no" | "own" | "generate".
  // The generated passphrase lives in this state ONLY: cleared on modal close
  // AND on unmount (show-once discipline), never localStorage/sessionStorage,
  // never console.log.
  const [exportEncrypt, setExportEncrypt] = useState(null);
  useEffect(() => () => setExportEncrypt(null), []);
  const [oidcForm, setOidcForm] = useState({
    authMode: "password",
    oidcIssuerUrl: "",
    oidcClientId: "",
    oidcScopes: "openid profile email",
    oidcLoginLabel: "Sign in with OIDC",
  });
  const [oidcClientSecret, setOidcClientSecret] = useState("");
  const [oidcStatus, setOidcStatus] = useState({ type: "", message: "" });
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcTestLoading, setOidcTestLoading] = useState(false);
  const [oidcTestStatus, setOidcTestStatus] = useState({ type: "", message: "" });
  const [oidcExpanded, setOidcExpanded] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const oidcRedirectUri = origin ? `${origin}/api/auth/oidc/callback` : "/api/auth/oidc/callback";
  const samlAcsUrl = origin ? `${origin}/api/auth/saml/acs` : "/api/auth/saml/acs";
  const samlMetadataUrl = origin ? `${origin}/api/auth/saml/metadata` : "/api/auth/saml/metadata";
  
  // SAML State
  const [ssoTypeTab, setSsoTypeTab] = useState("saml");
  const [samlForm, setSamlForm] = useState({
    samlEntryPoint: "",
    samlIssuer: "urn:9router:sp",
    samlCert: "",
    samlLoginLabel: "Sign in with SAML SSO",
    samlAttributeEmail: "email",
    samlAttributeName: "name",
  });
  const [samlStatus, setSamlStatus] = useState({ type: "", message: "" });
  const [samlLoading, setSamlLoading] = useState(false);
  const [samlTestLoading, setSamlTestLoading] = useState(false);
  const [samlTestStatus, setSamlTestStatus] = useState({ type: "", message: "" });
  const [showSamlGuide, setShowSamlGuide] = useState(false);
  const idpMetadataFileRef = useRef(null);
  const certFileRef = useRef(null);

  const importFileRef = useRef(null);
  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setOidcForm({
          authMode: data?.authMode || "password",
          oidcIssuerUrl: data?.oidcIssuerUrl || "",
          oidcClientId: data?.oidcClientId || "",
          oidcScopes: data?.oidcScopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setSsoTypeTab(data?.ssoType || "saml");
        setSamlForm({
          samlEntryPoint: data?.samlEntryPoint || "",
          samlIssuer: data?.samlIssuer || "urn:9router:sp",
          samlCert: data?.samlCert || "",
          samlLoginLabel: data?.samlLoginLabel || "Sign in with SAML SSO",
          samlAttributeEmail: data?.samlAttributeEmail || "email",
          samlAttributeName: data?.samlAttributeName || "name",
        });
        if (
          data?.authMode === "sso" ||
          data?.authMode === "saml" ||
          data?.authMode === "oidc" ||
          data?.authMode === "both"
        ) {
          setOidcExpanded(true);
        }
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
  }, []);

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: "Proxy settings applied" });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;

    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: "Please enter a Proxy URL to test" });
      return;
    }

    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });

      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: `Proxy test OK (${data.status}) in ${data.elapsedMs}ms`,
        });
      } else {
        setProxyStatus({
          type: "error",
          message: data?.error || "Proxy test failed",
        });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? "Proxy enabled" : "Proxy disabled",
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: "Passwords do not match" });
      return;
    }

    setPassLoading(true);
    setPassStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setPassStatus({ type: "success", message: "Password updated successfully" });
        setPasswords({ current: "", new: "", confirm: "" });
      } else {
        setPassStatus({ type: "error", message: data.error || "Failed to update password" });
      }
    } catch (err) {
      setPassStatus({ type: "error", message: "An error occurred" });
    } finally {
      setPassLoading(false);
    }
  };

  const updateFallbackStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fallbackStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, fallbackStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update settings:", err);
    }
  };

  const updateComboStrategy = async (strategy) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategy: strategy }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStrategy: strategy }));
      }
    } catch (err) {
      console.error("Failed to update combo strategy:", err);
    }
  };

  const updateStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, stickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update sticky limit:", err);
    }
  };

  const updateComboStickyLimit = async (limit) => {
    const numLimit = parseInt(limit);
    if (isNaN(numLimit) || numLimit < 1) return;

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStickyRoundRobinLimit: numLimit }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, comboStickyRoundRobinLimit: numLimit }));
      }
    } catch (err) {
      console.error("Failed to update combo sticky limit:", err);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const updateOidcForm = (field, value) => {
    setOidcForm((prev) => ({ ...prev, [field]: value }));
  };

  const saveOidcSettings = async (authMode = oidcForm.authMode || "password") => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const loginLabel = oidcForm.oidcLoginLabel.trim();
    const secret = oidcClientSecret.trim();

    if (authMode !== "password" && (!issuerUrl || !clientId || !secret) && !settings.oidcConfigured) {
      setOidcStatus({ type: "error", message: "Issuer URL, client ID, and client secret are required to enable OIDC." });
      return;
    }

    setOidcLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const payload = {
        authMode,
        ssoType: "oidc",
        oidcIssuerUrl: issuerUrl,
        oidcClientId: clientId,
        oidcScopes: scopes || "openid profile email",
        oidcLoginLabel: loginLabel || "Sign in with OIDC",
      };
      if (secret) {
        payload.oidcClientSecret = secret;
      }

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setOidcForm({
          authMode: data?.authMode || authMode,
          oidcIssuerUrl: data?.oidcIssuerUrl || issuerUrl,
          oidcClientId: data?.oidcClientId || clientId,
          oidcScopes: data?.oidcScopes || scopes || "openid profile email",
          oidcLoginLabel: data?.oidcLoginLabel || loginLabel || "Sign in with OIDC",
        });
        setOidcClientSecret("");
        setOidcStatus({
          type: "success",
          message:
            authMode === "oidc"
              ? "OIDC login enabled"
              : authMode === "both"
                ? "Password and OIDC login enabled"
                : "OIDC settings saved",
        });
      } else {
        setOidcStatus({ type: "error", message: data.error || "Failed to save OIDC settings" });
      }
    } catch (err) {
      setOidcStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcLoading(false);
    }
  };

  const testOidcConnection = async () => {
    const issuerUrl = oidcForm.oidcIssuerUrl.trim();
    const clientId = oidcForm.oidcClientId.trim();
    const scopes = oidcForm.oidcScopes.trim();
    const secret = oidcClientSecret.trim();

    if (!issuerUrl || !clientId) {
      setOidcTestStatus({ type: "error", message: "Issuer URL and client ID are required to test the connection." });
      return;
    }

    setOidcTestLoading(true);
    setOidcStatus({ type: "", message: "" });
    setOidcTestStatus({ type: "", message: "" });

    try {
      const saveRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authMode: oidcForm.authMode || settings.authMode || "password",
          oidcIssuerUrl: issuerUrl,
          oidcClientId: clientId,
          oidcScopes: scopes || "openid profile email",
          oidcLoginLabel: oidcForm.oidcLoginLabel.trim() || "Sign in with OIDC",
          ...(secret ? { oidcClientSecret: secret } : {}),
        }),
      });

      const saved = await saveRes.json().catch(() => ({}));
      if (!saveRes.ok) {
        setOidcTestStatus({
          type: "error",
          message: saved.error || "Failed to save OIDC settings before testing",
        });
        return;
      }

      const res = await fetch("/api/auth/oidc/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issuerUrl: saved.oidcIssuerUrl || issuerUrl,
          clientId: saved.oidcClientId || clientId,
          scopes: saved.oidcScopes || scopes || "openid profile email",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        const statusMessage = data.clientSecretTested
          ? data.clientSecretValid === true
            ? `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret validated too.`
            : `Connection OK. Discovery loaded from ${data.issuerUrl}. Client secret was not checked.`
          : `Connection OK. Discovery loaded from ${data.issuerUrl}.`;
        setOidcTestStatus({
          type: "success",
          message: statusMessage,
        });
      } else {
        setOidcTestStatus({ type: "error", message: data.error || "OIDC connection test failed" });
      }
    } catch (err) {
      setOidcTestStatus({ type: "error", message: "An error occurred" });
    } finally {
      setOidcTestLoading(false);
    }
  };

  const updateSamlForm = (field, value) => {
    setSamlForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleIdpMetadataUpload = (event) => {
    const file = event.target.files?.[0];
    if (idpMetadataFileRef.current) idpMetadataFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const xmlText = e.target?.result || "";
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, "text/xml");
        const parserError = doc.querySelector("parsererror");
        if (parserError) {
          setSamlStatus({ type: "error", message: "Unable to parse valid SAML IdP metadata from XML file" });
          return;
        }

        const entityID = doc.documentElement.getAttribute("entityID") || "";
        const ssoNodes = Array.from(doc.querySelectorAll("SingleSignOnService, *|SingleSignOnService"));
        let ssoUrl = "";
        for (const node of ssoNodes) {
          const binding = node.getAttribute("Binding") || "";
          const location = node.getAttribute("Location") || "";
          if (location) {
            ssoUrl = location;
            if (binding.includes("HTTP-Redirect")) break;
          }
        }

        const certNodes = Array.from(doc.querySelectorAll("X509Certificate, *|X509Certificate"));
        let certStr = "";
        if (certNodes.length > 0) {
          certStr = certNodes[0].textContent.trim();
        }

        setSamlForm((prev) => ({
          ...prev,
          samlEntryPoint: ssoUrl || prev.samlEntryPoint,
          samlIssuer: prev.samlIssuer || "urn:9router:sp",
          samlCert: certStr || prev.samlCert,
        }));

        setSamlStatus({
          type: "success",
          message: `IdP Metadata imported! (SSO URL: ${ssoUrl ? "found" : "not found"}, EntityID: ${entityID ? "found" : "not found"}, Cert: ${certStr ? "found" : "not found"})`,
        });
      } catch (err) {
        setSamlStatus({ type: "error", message: "Error reading IdP Metadata XML file" });
      }
    };
    reader.readAsText(file);
  };

  const handleCertFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (certFileRef.current) certFileRef.current.value = "";
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result || "";
      setSamlForm((prev) => ({ ...prev, samlCert: text.trim() }));
      setSamlStatus({ type: "success", message: "Certificate file loaded into configuration." });
    };
    reader.readAsText(file);
  };

  const saveSamlSettings = async (targetAuthMode = oidcForm.authMode || "password") => {
    setSamlLoading(true);
    setSamlStatus({ type: "", message: "" });
    setSamlTestStatus({ type: "", message: "" });

    try {
      const payload = {
        authMode: targetAuthMode,
        ssoType: "saml",
        samlEntryPoint: samlForm.samlEntryPoint.trim(),
        samlIssuer: samlForm.samlIssuer.trim() || "urn:9router:sp",
        samlCert: samlForm.samlCert.trim(),
        samlLoginLabel: samlForm.samlLoginLabel.trim() || "Sign in with SAML SSO",
        samlAttributeEmail: samlForm.samlAttributeEmail.trim() || "email",
        samlAttributeName: samlForm.samlAttributeName.trim() || "name",
      };

      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setSamlForm({
          samlEntryPoint: data?.samlEntryPoint || payload.samlEntryPoint,
          samlIssuer: data?.samlIssuer || payload.samlIssuer,
          samlCert: data?.samlCert || payload.samlCert,
          samlLoginLabel: data?.samlLoginLabel || payload.samlLoginLabel,
          samlAttributeEmail: data?.samlAttributeEmail || payload.samlAttributeEmail,
          samlAttributeName: data?.samlAttributeName || payload.samlAttributeName,
        });
        setSamlStatus({
          type: "success",
          message:
            targetAuthMode === "sso" || targetAuthMode === "saml"
              ? "SAML SSO login enabled"
              : targetAuthMode === "both"
                ? "Password and SAML SSO login enabled"
                : "SAML 2.0 settings saved",
        });
      } else {
        setSamlStatus({ type: "error", message: data.error || "Failed to save SAML settings" });
      }
    } catch {
      setSamlStatus({ type: "error", message: "An error occurred while saving SAML settings" });
    } finally {
      setSamlLoading(false);
    }
  };

  const testSamlConnection = async () => {
    setSamlTestLoading(true);
    setSamlStatus({ type: "", message: "" });
    setSamlTestStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/auth/saml/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samlEntryPoint: samlForm.samlEntryPoint.trim(),
          samlIssuer: samlForm.samlIssuer.trim(),
          samlCert: samlForm.samlCert.trim(),
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setSamlTestStatus({ type: "success", message: data.message || "SAML configuration verified!" });
      } else {
        setSamlTestStatus({ type: "error", message: data.error || "SAML configuration test failed" });
      }
    } catch {
      setSamlTestStatus({ type: "error", message: "An error occurred while testing SAML configuration" });
    } finally {
      setSamlTestLoading(false);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  const reloadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      console.error("Failed to reload settings:", err);
    }
  };

  const handleExportDatabase = async (password, archivePassphrase) => {
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    try {
      const headers = { "x-9r-password": password };
      // v0.6.46 Option F: passphrase-sealed export. No passphrase → no header
      // → the .45 request is byte-identical.
      if (archivePassphrase) headers["x-9r-archive-passphrase"] = archivePassphrase;
      const res = await fetch("/api/settings/database", { headers });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export database");
      }

      const payload = await res.json();
      const content = JSON.stringify(payload, null, 2);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = archivePassphrase
        ? `9router-backup-${stamp}-encrypted.json`
        : `9router-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setDbStatus({
        type: "success",
        message: archivePassphrase ? "Encrypted backup downloaded" : "Database backup downloaded",
      });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Failed to export database" });
    } finally {
      setDbLoading(false);
    }
  };

  // RT46-O7: parse the file at SELECTION time so encrypted-archive detection
  // happens BEFORE the dbAuth modal opens (the parsed result is cached and
  // reused at confirm — never reparsed).
  const handleImportDatabase = (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    setDbStatus({ type: "", message: "" });
    file
      .text()
      .then((raw) => {
        const parsed = JSON.parse(raw);
        const encrypted = parsed?.format === "9router-encrypted-archive";
        pendingImportRef.current = { parsed, encrypted };
        setDbAuth({ open: true, mode: "import", password: "", archivePassphrase: "", encrypted });
      })
      .catch((err) => {
        pendingImportRef.current = null;
        setDbStatus({ type: "error", message: err?.message || "Invalid backup file" });
      });
  };

  const runImportDatabase = async (password, archivePassphrase) => {
    const pending = pendingImportRef.current;
    if (!pending) return;
    setDbLoading(true);
    try {
      // Encrypted archives are posted as {archive, archivePassphrase, password};
      // legacy files keep the .45 {...payload, password} body unchanged.
      const body = pending.encrypted
        ? { archive: pending.parsed, archivePassphrase: archivePassphrase || "", password }
        : { ...pending.parsed, password };

      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to import database");
      }

      await reloadSettings();
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const needsRekeyCount = Number(data.needsRekeyCount) || 0;
      const rekeyNote = needsRekeyCount > 0
        ? `${needsRekeyCount} key(s) need re-keying — Endpoint page → API Keys → Re-key.`
        : "";
      setDbStatus({
        type: warnings.length || needsRekeyCount ? "warning" : "success",
        message: warnings.length || needsRekeyCount
          ? `Database imported with notices: ${[...warnings, rekeyNote].filter(Boolean).join(" ")}`
          : "Database imported successfully",
      });
      pendingImportRef.current = null;
      setDbAuth({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Invalid backup file" });
      if (pending.encrypted) {
        // The modal stayed open (encrypted imports never close it before the
        // POST): a 400 "Wrong archive passphrase or corrupted archive" is
        // surfaced verbatim in dbStatus while the modal remains available for
        // retry — the DB is untouched server-side on failure.
        setDbAuth((s) => ({ ...s, password, archivePassphrase: "" }));
      }
    } finally {
      if (!pending.encrypted) pendingImportRef.current = null;
      setDbLoading(false);
    }
  };

  // v0.6.46 Option F helpers — all passphrase material is state-only.
  const closeExportEncrypt = () => setExportEncrypt(null);

  const fetchGeneratedPassphrase = async (password) => {
    const res = await fetch("/api/settings/database/archive-passphrase", {
      headers: { "x-9r-password": password },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.passphrase !== "string" || !data.passphrase) {
      throw new Error(data.error || "Failed to generate passphrase");
    }
    return data.passphrase;
  };

  const continueEncryptChoice = async () => {
    const ee = exportEncrypt;
    if (!ee) return;
    if (ee.choice === "own") {
      setExportEncrypt({ ...ee, step: "own", error: "" });
      return;
    }
    if (ee.choice === "generate") {
      setExportEncrypt({ ...ee, loading: true, error: "", copyNote: "" });
      try {
        const generated = await fetchGeneratedPassphrase(ee.password);
        setExportEncrypt((s) => (s ? { ...s, loading: false, step: "panel", generated, retype: "" } : s));
      } catch (err) {
        setExportEncrypt((s) =>
          s ? { ...s, loading: false, error: err.message || "Failed to generate passphrase" } : s
        );
      }
      return;
    }
    // "no" — the .45 export exactly: no header, same copy and filename.
    closeExportEncrypt();
    await handleExportDatabase(ee.password);
  };

  const finalizeEncryptedExport = async (passphrase) => {
    const ee = exportEncrypt;
    if (!ee) return;
    // RT46-A3: the charset gate runs BEFORE any request fires (also enforced
    // by disabling the action button; this is the hard backstop).
    if (!PRINTABLE_ASCII.test(passphrase)) return;
    closeExportEncrypt();
    await handleExportDatabase(ee.password, passphrase);
  };

  const copyGeneratedPassphrase = async (text) => {
    let note = null;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        note = "Copied to clipboard";
      }
    } catch {
      note = null;
    }
    if (note === null) {
      // Fallback for non-secure origins (http LAN): legacy execCommand path.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) note = "Copied to clipboard";
      } catch {
        note = null;
      }
    }
    setExportEncrypt((s) => (s ? { ...s, copyNote: note || "Copy failed — select the passphrase text above and copy it manually, or use Download .txt" } : s));
  };

  const downloadPassphraseTxt = (passphrase) => {
    const content = `9router backup passphrase\n\n${passphrase}\n\nStore this passphrase securely — if it is lost, the encrypted backup cannot be recovered.\n`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "9router-backup-passphrase.txt";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  // Confirm password modal, then run export or import.
  const handleDbAuthConfirm = async () => {
    const { mode, password, archivePassphrase, encrypted } = dbAuth;
    if (mode === "export") {
      // Password collected FIRST; the encrypt-this-archive step comes after.
      setDbAuth({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false });
      setExportEncrypt({
        password,
        step: "choose",
        choice: "no",
        passphrase: "",
        confirm: "",
        generated: null,
        retype: "",
        error: "",
        copyNote: "",
        loading: false,
      });
    } else if (mode === "import") {
      if (encrypted) {
        // Stay open: a wrong passphrase surfaces the route's 400 while the
        // modal remains available for retry (runImportDatabase closes it on
        // success).
        await runImportDatabase(password, archivePassphrase);
      } else {
        setDbAuth({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false });
        await runImportDatabase(password);
      }
    }
  };

  const observabilityEnabled = settings.enableObservability === true;

  // RT46-A3/O3: the printable-ASCII gate is part of the ACTION gate — a
  // non-ASCII passphrase can never fire the request from this page.
  const dbAuthCanConfirm =
    !!dbAuth.password &&
    (!dbAuth.encrypted || (!!dbAuth.archivePassphrase && PRINTABLE_ASCII.test(dbAuth.archivePassphrase)));
  const ownEntryValid =
    exportEncrypt?.step === "own" &&
    exportEncrypt.passphrase.length > 0 &&
    exportEncrypt.passphrase === exportEncrypt.confirm &&
    PRINTABLE_ASCII.test(exportEncrypt.passphrase) &&
    PRINTABLE_ASCII.test(exportEncrypt.confirm);
  // Show-once retype: exact match against the fetched string — the browser
  // never normalizes (the server does, symmetrically, at seal/open).
  const retypeValid =
    exportEncrypt?.step === "panel" &&
    !!exportEncrypt.generated &&
    exportEncrypt.retype === exportEncrypt.generated &&
    PRINTABLE_ASCII.test(exportEncrypt.retype);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/version/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down; ignore error
    }
    setIsShuttingDown(false);
    setShutdownOpen(false);
  };

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.assign("/login");
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-0">
      <div className="flex flex-col gap-6">
        {/* Local Mode Info */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="size-10 sm:size-12 rounded-lg bg-green-500/10 text-green-500 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl sm:text-2xl">computer</span>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold">Local Mode</h2>
                <p className="text-sm text-text-muted">Running on your machine</p>
              </div>
            </div>
            <div className="inline-flex p-1 rounded-lg bg-black/5 dark:bg-white/5 w-full sm:w-auto">
              {["light", "dark", "system"].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setTheme(option)}
                  className={cn(
                    "flex items-center justify-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-md font-medium transition-all flex-1 sm:flex-initial",
                    theme === option
                      ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                      : "text-text-muted hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {option === "light" ? "light_mode" : option === "dark" ? "dark_mode" : "contrast"}
                  </span>
                  <span className="capitalize text-xs sm:text-sm">{option}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-3 pt-4 border-t border-border">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg bg-bg border border-border gap-2">
              <div>
                <p className="font-medium text-sm sm:text-base">Database Location</p>
                <p className="text-xs sm:text-sm text-text-muted font-mono break-all">~/.9router/db/data.sqlite</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => setDbAuth({ open: true, mode: "export", password: "" })}
                loading={dbLoading}
                className="w-full sm:w-auto"
              >
                Download Backup
              </Button>
              <Button
                variant="outline"
                icon="upload"
                onClick={() => importFileRef.current?.click()}
                disabled={dbLoading}
                className="w-full sm:w-auto"
              >
                Import Backup
              </Button>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportDatabase}
              />
            </div>
            {dbStatus.message && (
              <p className={`text-sm ${dbStatus.type === "error" ? "text-red-500" : dbStatus.type === "warning" ? "text-amber-600 dark:text-amber-400" : "text-green-600 dark:text-green-400"}`}>
                {dbStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Language */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">language</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Language</h3>
          </div>
          <button
            onClick={() => setLangOpen(true)}
            className="flex items-center justify-between w-full p-3 rounded-lg bg-bg border border-border hover:border-primary/50 transition-colors"
            data-i18n-skip="true"
          >
            <span className="text-sm text-text-muted">Display language</span>
            <span className="text-2xl">{LOCALE_FLAGS[locale] || "🌐"}</span>
          </button>
        </Card>

        {/* Security */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
              <span className="material-symbols-outlined text-[20px]">shield</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Security</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Require login</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  When ON, dashboard requires password. When OFF, access without login.
                </p>
              </div>
              <Toggle
                checked={settings.requireLogin === true}
                onChange={() => updateRequireLogin(!settings.requireLogin)}
                disabled={loading}
              />
            </div>
            {settings.requireLogin === true && (
              <form onSubmit={handlePasswordChange} className="flex flex-col gap-4 pt-4 border-t border-border/50">
                {settings.hasPassword && (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Current Password</label>
                    <Input
                      type="password"
                      placeholder="Enter current password"
                      value={passwords.current}
                      onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                      required
                    />
                  </div>
                )}
                {/* {!settings.hasPassword && (
                  <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <p className="text-sm text-blue-600 dark:text-blue-400">
                      Setting password for the first time. Leave current password empty or use default: <code className="bg-blue-500/20 px-1 rounded">123456</code>
                    </p>
                  </div>
                )} */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">New Password</label>
                    <Input
                      type="password"
                      placeholder="Enter new password"
                      value={passwords.new}
                      onChange={(e) => setPasswords({ ...passwords, new: e.target.value })}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label className="text-xs sm:text-sm font-medium">Confirm New Password</label>
                    <Input
                      type="password"
                      placeholder="Confirm new password"
                      value={passwords.confirm}
                      onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
                      required
                    />
                  </div>
                </div>

                {passStatus.message && (
                  <p className={`text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                    {passStatus.message}
                  </p>
                )}

                <div className="pt-2">
                  <Button type="submit" variant="primary" loading={passLoading} className="w-full sm:w-auto">
                    {settings.hasPassword ? "Update Password" : "Set Password"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        {/* Single Sign-On (SSO) */}
        <Card>
          <button
            type="button"
            onClick={() => setOidcExpanded((v) => !v)}
            className="w-full flex items-center gap-3 text-left"
          >
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">lock_open</span>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base sm:text-lg font-semibold">Single Sign-On (SSO)</h3>
              <p className="text-xs text-text-muted">
                {settings.authMode === "sso" || settings.authMode === "oidc" || settings.authMode === "saml"
                  ? `${settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"} SSO active`
                  : settings.authMode === "both"
                    ? `Password + ${settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"} active`
                    : "Optional SSO via Okta, Entra ID, Keycloak, or OIDC"}
              </p>
            </div>
            <span className="material-symbols-outlined text-text-muted shrink-0">
              {oidcExpanded ? "expand_less" : "expand_more"}
            </span>
          </button>
          {oidcExpanded && (
            <div className="flex flex-col gap-4 mt-4">
              <p className="text-xs sm:text-sm text-text-muted">
                Configure enterprise Single Sign-On (SSO) for dashboard access using SAML 2.0 or OIDC.
              </p>

              {/* SSO Protocol Switcher Tabs */}
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">SSO Protocol</label>
                <div className="flex p-1 rounded-lg bg-black/5 dark:bg-white/5 border border-border">
                  <button
                    type="button"
                    onClick={() => setSsoTypeTab("saml")}
                    className={cn(
                      "flex-1 py-1.5 px-3 rounded-md font-medium text-xs sm:text-sm transition-all text-center",
                      ssoTypeTab === "saml"
                        ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    SAML 2.0
                  </button>
                  <button
                    type="button"
                    onClick={() => setSsoTypeTab("oidc")}
                    className={cn(
                      "flex-1 py-1.5 px-3 rounded-md font-medium text-xs sm:text-sm transition-all text-center",
                      ssoTypeTab === "oidc"
                        ? "bg-white dark:bg-white/10 text-text-main shadow-sm"
                        : "text-text-muted hover:text-text-main"
                    )}
                  >
                    OIDC
                  </button>
                </div>
              </div>

              {/* Auth Mode selection */}
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">Auth Mode</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    {
                      value: "password",
                      title: "Password only",
                      desc: "Keep legacy password login.",
                    },
                    {
                      value: "sso",
                      title: `${ssoTypeTab === "saml" ? "SAML" : "OIDC"} only`,
                      desc: "Require SSO for dashboard access.",
                    },
                    {
                      value: "both",
                      title: "Both",
                      desc: "Allow password or SSO login.",
                    },
                  ].map((option) => {
                    const currentMode = oidcForm.authMode;
                    const active =
                      option.value === "password"
                        ? currentMode === "password"
                        : option.value === "sso"
                          ? currentMode === "sso" || currentMode === "saml" || currentMode === "oidc"
                          : currentMode === "both";
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => updateOidcForm("authMode", option.value)}
                        className={cn(
                          "text-left rounded-lg border p-3 transition-colors",
                          active
                            ? "border-primary bg-primary/5"
                            : "border-border bg-bg hover:bg-black/5 dark:hover:bg-white/5"
                        )}
                        disabled={loading || oidcLoading || samlLoading}
                      >
                        <p className="font-medium text-sm sm:text-base">{option.title}</p>
                        <p className="text-xs sm:text-sm text-text-muted mt-1">{option.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {ssoTypeTab === "saml" ? (
                /* SAML Configuration Panel */
                <div className="flex flex-col gap-4 pt-2 border-t border-border/50">
                  {/* IdP Setup Guidelines Banner & Collapsible Drawer */}
                  <div className="rounded-lg border border-border bg-bg/80 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setShowSamlGuide((prev) => !prev)}
                      className="w-full p-3 flex items-center justify-between gap-2 text-left hover:bg-surface/50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary text-lg">menu_book</span>
                        <div>
                          <p className="font-semibold text-xs sm:text-sm text-text-main">
                            IdP Setup Guidelines & Provider Configuration Instructions
                          </p>
                          <p className="text-[11px] text-text-muted">
                            Click to view setup steps for AWS IAM Identity Center, Okta, Entra ID, Keycloak, & Authentik
                          </p>
                        </div>
                      </div>
                      <span
                        className="material-symbols-outlined text-text-muted transition-transform text-lg"
                        style={{ transform: showSamlGuide ? "rotate(180deg)" : "none" }}
                      >
                        expand_more
                      </span>
                    </button>

                    {showSamlGuide && (
                      <div className="p-4 border-t border-border bg-surface/30 text-xs text-text-main flex flex-col gap-3">
                        <div className="p-2.5 rounded border border-primary/20 bg-primary/5 text-primary text-xs">
                          <p className="font-semibold mb-1">🔑 Required Service Provider (SP) Values for your IdP Setup:</p>
                          <ul className="list-disc pl-4 space-y-1 font-mono text-[11px]">
                            <li>
                              <b>Assertion Consumer Service (ACS) URL:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded break-all">{samlAcsUrl}</code>
                            </li>
                            <li>
                              <b>SP Entity ID / Audience URI:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded break-all">{samlForm.samlIssuer || "urn:9router:sp"}</code>
                            </li>
                            <li>
                              <b>NameID Format:</b>{" "}
                              <code className="bg-bg px-1 py-0.5 rounded">EmailAddress</code> or <code className="bg-bg px-1 py-0.5 rounded">Unspecified</code>
                            </li>
                          </ul>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>☁️</span> AWS IAM Identity Center
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Applications → <b>Add application</b> → Select <b>Add custom SAML 2.0 application</b>.</li>
                              <li>Set <b>Application ACS URL</b> to <code className="text-text-main font-mono">{samlAcsUrl}</code>.</li>
                              <li>Set <b>Application SAML audience</b> to <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code>.</li>
                              <li>Under <i>Attribute mappings</i>, map <code className="text-text-main font-mono">Subject</code> or <code className="text-text-main font-mono">email</code> to <code className="text-text-main font-mono">${`{user:email}`}</code>.</li>
                              <li>Download <b>IAM Identity Center SAML metadata XML</b> file and use 1-Click Import below!</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🔷</span> Microsoft Entra ID (Azure AD)
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Enterprise Applications → <b>New application</b> → <b>Create your own application</b>.</li>
                              <li>Select <b>Single sign-on</b> → <b>SAML</b>.</li>
                              <li><b>Identifier (Entity ID):</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li><b>Reply URL (ACS):</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li>Download <b>Federation Metadata XML</b> and import or copy X.509 Certificate.</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🟢</span> Okta / Auth0
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Applications → <b>Create App Integration</b> → Select <b>SAML 2.0</b>.</li>
                              <li><b>Single Sign-On URL:</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li><b>Audience URI (SP Entity ID):</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li>Name ID format: <i>EmailAddress</i>.</li>
                              <li>Download Identity Provider metadata XML or copy the X.509 cert.</li>
                            </ol>
                          </div>

                          <div className="p-3 rounded border border-border bg-bg/50 flex flex-col gap-1.5">
                            <p className="font-semibold text-text-main flex items-center gap-1.5">
                              <span>🛡️</span> Keycloak / Authentik
                            </p>
                            <ol className="list-decimal pl-4 text-text-muted space-y-1">
                              <li>Clients → <b>Create client</b> → Select <b>SAML</b>.</li>
                              <li><b>Client ID:</b> <code className="text-text-main font-mono">{samlForm.samlIssuer || "urn:9router:sp"}</code></li>
                              <li><b>Master SAML Processing URL:</b> <code className="text-text-main font-mono">{samlAcsUrl}</code></li>
                              <li>Export SAML Descriptor XML or copy IDP Certificate PEM.</li>
                            </ol>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Quick Import Card */}
                  <div className="p-3 rounded-lg border border-dashed border-primary/40 bg-primary/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-sm text-text-main">1-Click IdP Metadata XML Import</p>
                      <p className="text-xs text-text-muted">Auto-fill SSO URL, Issuer & Cert from XML metadata</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      icon="upload_file"
                      onClick={() => idpMetadataFileRef.current?.click()}
                    >
                      Upload Metadata XML
                    </Button>
                    <input
                      ref={idpMetadataFileRef}
                      type="file"
                      accept=".xml,application/xml,text/xml"
                      className="hidden"
                      onChange={handleIdpMetadataUpload}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Single Sign-On Service URL (samlEntryPoint)</label>
                      <Input
                        placeholder="https://idp.example.com/app/saml/sso/..."
                        value={samlForm.samlEntryPoint}
                        onChange={(e) => updateSamlForm("samlEntryPoint", e.target.value)}
                        disabled={loading || samlLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">SP Entity ID / Audience (samlIssuer)</label>
                      <Input
                        placeholder="urn:9router:sp"
                        value={samlForm.samlIssuer}
                        onChange={(e) => updateSamlForm("samlIssuer", e.target.value)}
                        disabled={loading || samlLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <label className="font-medium text-sm sm:text-base">IdP X.509 Certificate (samlCert)</label>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          icon="file_upload"
                          onClick={() => certFileRef.current?.click()}
                        >
                          Upload Certificate
                        </Button>
                        <input
                          ref={certFileRef}
                          type="file"
                          accept=".crt,.pem,.cer,text/plain"
                          className="hidden"
                          onChange={handleCertFileUpload}
                        />
                      </div>
                      <textarea
                        rows={4}
                        placeholder="-----BEGIN CERTIFICATE-----&#10;MIIC...&#10;-----END CERTIFICATE-----"
                        value={samlForm.samlCert}
                        onChange={(e) => updateSamlForm("samlCert", e.target.value)}
                        className="w-full p-2.5 rounded-lg border border-border bg-bg text-xs font-mono text-text-main focus:outline-none focus:border-primary"
                        disabled={loading || samlLoading}
                      />
                      <p className="text-xs text-text-muted">Paste raw Base64 certificate or PEM block.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Login Button Label</label>
                        <Input
                          placeholder="Sign in with SAML SSO"
                          value={samlForm.samlLoginLabel}
                          onChange={(e) => updateSamlForm("samlLoginLabel", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Email Claim Attribute</label>
                        <Input
                          placeholder="email"
                          value={samlForm.samlAttributeEmail}
                          onChange={(e) => updateSamlForm("samlAttributeEmail", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="font-medium text-sm sm:text-base">Display Name Claim</label>
                        <Input
                          placeholder="name"
                          value={samlForm.samlAttributeName}
                          onChange={(e) => updateSamlForm("samlAttributeName", e.target.value)}
                          disabled={loading || samlLoading}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 p-3 rounded-lg border border-border bg-bg text-xs sm:text-sm text-text-muted">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="font-medium text-text-main">ACS Callback URL</p>
                        <code className="block break-all font-mono text-xs">{samlAcsUrl}</code>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        icon="content_copy"
                        onClick={() => {
                          navigator.clipboard.writeText(samlAcsUrl);
                          setSamlStatus({ type: "success", message: "ACS URL copied to clipboard!" });
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
                      <div>
                        <p className="font-medium text-text-main">SP XML Metadata</p>
                        <code className="block break-all font-mono text-xs">{samlMetadataUrl}</code>
                      </div>
                      <a
                        href={samlMetadataUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        download="9router-sp-metadata.xml"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <span className="material-symbols-outlined text-[16px]">download</span>
                        Download XML
                      </a>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
                    <Button
                      type="button"
                      variant="primary"
                      loading={samlLoading}
                      onClick={() => saveSamlSettings(oidcForm.authMode)}
                      className="w-full sm:w-auto"
                    >
                      Save SAML settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      loading={samlTestLoading}
                      onClick={testSamlConnection}
                      className="w-full sm:w-auto"
                    >
                      Test SAML settings
                    </Button>
                  </div>

                  {samlTestStatus.message && (
                    <p className={`text-xs sm:text-sm ${samlTestStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {samlTestStatus.message}
                    </p>
                  )}

                  {samlStatus.message && (
                    <p className={`text-xs sm:text-sm ${samlStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {samlStatus.message}
                    </p>
                  )}
                </div>
              ) : (
                /* OIDC Panel */
                <div className="flex flex-col gap-4 pt-2 border-t border-border/50">
                  <div className="grid grid-cols-1 gap-4">
                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Issuer URL</label>
                      <Input
                        placeholder="https://auth.example.com/application/o/9router/"
                        value={oidcForm.oidcIssuerUrl}
                        onChange={(e) => updateOidcForm("oidcIssuerUrl", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Client ID</label>
                      <Input
                        placeholder="9router-dashboard"
                        value={oidcForm.oidcClientId}
                        onChange={(e) => updateOidcForm("oidcClientId", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Client Secret</label>
                      <Input
                        type="password"
                        placeholder="Leave blank to keep existing secret"
                        value={oidcClientSecret}
                        onChange={(e) => setOidcClientSecret(e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                      <p className="text-xs sm:text-sm text-text-muted">This value is write-only after saving.</p>
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Scopes</label>
                      <Input
                        placeholder="openid profile email"
                        value={oidcForm.oidcScopes}
                        onChange={(e) => updateOidcForm("oidcScopes", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>

                    <div className="flex flex-col gap-2">
                      <label className="font-medium text-sm sm:text-base">Login Button Label</label>
                      <Input
                        placeholder="Sign in with OIDC"
                        value={oidcForm.oidcLoginLabel}
                        onChange={(e) => updateOidcForm("oidcLoginLabel", e.target.value)}
                        disabled={loading || oidcLoading}
                      />
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-bg p-3 text-xs sm:text-sm text-text-muted">
                    <p className="font-medium text-text-main mb-1">Redirect URI</p>
                    <code className="block break-all font-mono">{oidcRedirectUri}</code>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
                    <Button type="button" variant="primary" loading={oidcLoading} onClick={() => saveOidcSettings()} className="w-full sm:w-auto">
                      Save OIDC settings
                    </Button>
                    <Button type="button" variant="outline" loading={oidcTestLoading} onClick={testOidcConnection} className="w-full sm:w-auto">
                      Test connection
                    </Button>
                  </div>

                  {oidcTestStatus.message && (
                    <p className={`text-xs sm:text-sm ${oidcTestStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {oidcTestStatus.message}
                    </p>
                  )}

                  {oidcStatus.message && (
                    <p className={`text-xs sm:text-sm ${oidcStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                      {oidcStatus.message}
                    </p>
                  )}
                </div>
              )}

              {settings.authMode === "oidc" || settings.authMode === "saml" || settings.authMode === "sso" ? (
                <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                  SSO login ({settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"}) is currently active. Password login is disabled until you switch back.
                </p>
              ) : null}

              {settings.authMode === "both" && (
                <p className="text-xs sm:text-sm text-amber-600 dark:text-amber-400">
                  Password and SSO login ({settings.ssoType === "saml" ? "SAML 2.0" : "OIDC"}) are both active.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* Routing Preferences */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">route</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Routing Strategy</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through accounts to distribute load
                </p>
              </div>
              <Toggle
                checked={settings.fallbackStrategy === "round-robin"}
                onChange={() => updateFallbackStrategy(settings.fallbackStrategy === "round-robin" ? "fill-first" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Sticky Round Robin Limit */}
            {settings.fallbackStrategy === "round-robin" && (
              <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm sm:text-base">Sticky Limit</p>
                  <p className="text-xs sm:text-sm text-text-muted">
                    Calls per account before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.stickyRoundRobinLimit || 3}
                  onChange={(e) => updateStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-16 sm:w-20 text-center shrink-0"
                />
              </div>
            )}

            {/* Combo Round Robin */}
            <div className="flex items-start sm:items-center justify-between gap-4 pt-4 border-t border-border/50">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Combo Round Robin</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  Cycle through providers in combos instead of always starting with first
                </p>
              </div>
              <Toggle
                checked={settings.comboStrategy === "round-robin"}
                onChange={() => updateComboStrategy(settings.comboStrategy === "round-robin" ? "fallback" : "round-robin")}
                disabled={loading}
              />
            </div>

            {/* Combo Sticky Round Robin Limit */}
            {settings.comboStrategy === "round-robin" && (
              <div className="flex items-center justify-between pt-2 border-t border-border/50">
                <div>
                  <p className="font-medium">Combo Sticky Limit</p>
                  <p className="text-sm text-text-muted">
                    Calls per combo model before switching
                  </p>
                </div>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.comboStickyRoundRobinLimit || 1}
                  onChange={(e) => updateComboStickyLimit(e.target.value)}
                  disabled={loading}
                  className="w-20 text-center"
                />
              </div>
            )}

            <p className="text-xs text-text-muted italic pt-2 border-t border-border/50">
              {settings.fallbackStrategy === "round-robin"
                ? `Currently distributing requests across all available accounts with ${settings.stickyRoundRobinLimit || 3} calls per account.`
                : "Currently using accounts in priority order (Fill First)."}
              {settings.comboStrategy === "round-robin"
                ? ` Combos rotate after ${settings.comboStickyRoundRobinLimit || 1} call${(settings.comboStickyRoundRobinLimit || 1) === 1 ? "" : "s"} per model.`
                : " Combos always start with their first model."}
            </p>
          </div>
        </Card>

        {/* Network */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">wifi</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Network</h3>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Outbound Proxy</p>
                <p className="text-xs sm:text-sm text-text-muted">Enable proxy for OAuth + provider outbound requests.</p>
              </div>
              <Toggle
                checked={settings.outboundProxyEnabled === true}
                onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
                disabled={loading || proxyLoading}
              />
            </div>

            {settings.outboundProxyEnabled === true && (
              <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 pt-2 border-t border-border/50">
                <div className="flex flex-col gap-2">
                  <label className="font-medium text-sm sm:text-base">Proxy URL</label>
                  <Input
                    placeholder="http://127.0.0.1:7897"
                    value={proxyForm.outboundProxyUrl}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Leave empty to inherit existing env proxy (if any).</p>
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                  <label className="font-medium text-sm sm:text-base">No Proxy</label>
                  <Input
                    placeholder="localhost,127.0.0.1"
                    value={proxyForm.outboundNoProxy}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Comma-separated hostnames/domains to bypass the proxy.</p>
                </div>

                <div className="pt-2 border-t border-border/50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={proxyTestLoading}
                    disabled={loading || proxyLoading}
                    onClick={testOutboundProxy}
                    className="w-full sm:w-auto"
                  >
                    Test proxy URL
                  </Button>
                  <Button type="submit" variant="primary" loading={proxyLoading} className="w-full sm:w-auto">
                    Apply
                  </Button>
                </div>
              </form>
            )}

            {proxyStatus.message && (
              <p className={`text-xs sm:text-sm ${proxyStatus.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {proxyStatus.message}
              </p>
            )}
          </div>
        </Card>

        {/* Observability Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">monitoring</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Observability</h3>
          </div>
          <div className="flex items-start sm:items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">Enable Observability</p>
              <p className="text-xs sm:text-sm text-text-muted">
                Record request details for inspection in the logs view
              </p>
            </div>
            <Toggle
              checked={observabilityEnabled}
              onChange={updateObservabilityEnabled}
              disabled={loading}
            />
          </div>
        </Card>

        {/* Account actions */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            fullWidth
            icon="power_settings_new"
            onClick={() => setShutdownOpen(true)}
            className="text-red-500 border-red-200 hover:bg-red-50 hover:border-red-300"
          >
            Shutdown
          </Button>
          <Button
            variant="outline"
            fullWidth
            icon="logout"
            onClick={handleLogout}
          >
            Logout
          </Button>
        </div>

        {/* App Info */}
        <div className="text-center text-xs sm:text-sm text-text-muted py-4">
          <p>{APP_CONFIG.name} v{APP_CONFIG.version}</p>
          <p className="mt-1">Local Mode - All data stored on your machine</p>
        </div>
      </div>

      <LanguageSwitcher
        hideTrigger
        isOpen={langOpen}
        onClose={(next) => {
          setLangOpen(false);
          setLocale(next);
        }}
      />
      <ConfirmModal
        isOpen={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title="Close Proxy"
        message="Are you sure you want to close the proxy server?"
        confirmText="Close"
        cancelText="Cancel"
        variant="danger"
        loading={isShuttingDown}
      />

      <Modal
        isOpen={dbAuth.open}
        onClose={() => setDbAuth({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false })}
        title="Confirm Password"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDbAuth({ open: false, mode: "", password: "", archivePassphrase: "", encrypted: false })} disabled={dbLoading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDbAuthConfirm} loading={dbLoading} disabled={!dbAuthCanConfirm}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-text-muted mb-3 text-sm">
          {dbAuth.mode === "export"
            ? "Enter your dashboard password. It encrypts your API-key secret inside the backup — but the rest of the backup, including provider access tokens, stays unencrypted; store the file securely."
            : "Enter your CURRENT dashboard password. If it differs from the password used when this backup was exported, the keys will need re-keying after import."}
        </p>
        <Input
          type="password"
          value={dbAuth.password}
          onChange={(e) => setDbAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter" && dbAuthCanConfirm) handleDbAuthConfirm(); }}
          placeholder="Current password"
          autoFocus
        />
        {dbAuth.mode === "import" && dbAuth.encrypted && (
          <>
            <p className="text-amber-600 dark:text-amber-400 my-3 text-sm">
              This backup is encrypted with a passphrase. If it is lost, the backup cannot be recovered.
            </p>
            <Input
              type="password"
              value={dbAuth.archivePassphrase}
              onChange={(e) => setDbAuth((s) => ({ ...s, archivePassphrase: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter" && dbAuthCanConfirm) handleDbAuthConfirm(); }}
              placeholder="Backup passphrase"
            />
            {dbAuth.archivePassphrase && !PRINTABLE_ASCII.test(dbAuth.archivePassphrase) && (
              <p className="text-red-500 text-xs mt-1">{PASSPHRASE_ASCII_HINT}</p>
            )}
          </>
        )}
      </Modal>

      <Modal
        isOpen={!!exportEncrypt}
        onClose={closeExportEncrypt}
        title="Encrypt this archive?"
        size="md"
        footer={
          exportEncrypt?.step === "choose" ? (
            <>
              <Button variant="ghost" onClick={closeExportEncrypt} disabled={exportEncrypt.loading || dbLoading}>
                Cancel
              </Button>
              <Button variant="primary" onClick={continueEncryptChoice} loading={exportEncrypt.loading}>
                Continue
              </Button>
            </>
          ) : exportEncrypt?.step === "own" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => setExportEncrypt({ ...exportEncrypt, step: "choose", error: "" })}
                disabled={dbLoading}
              >
                Back
              </Button>
              <Button
                variant="primary"
                onClick={() => finalizeEncryptedExport(exportEncrypt.passphrase)}
                loading={dbLoading}
                disabled={!ownEntryValid}
              >
                Download Encrypted Backup
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={closeExportEncrypt} disabled={dbLoading}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => finalizeEncryptedExport(exportEncrypt.generated)}
                loading={dbLoading}
                disabled={!retypeValid}
              >
                Download Encrypted Backup
              </Button>
            </>
          )
        }
      >
        {exportEncrypt?.step === "choose" && (
          <div className="flex flex-col gap-2">
            {[
              { key: "no", label: "No, keep it unencrypted", hint: "Provider access tokens stay unencrypted; store the file securely." },
              { key: "own", label: "Encrypt with my own passphrase", hint: "Choose a passphrase of 10+ characters." },
              { key: "generate", label: "Generate a passphrase for me", hint: "Shown once — save it when it appears." },
            ].map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setExportEncrypt((s) => (s ? { ...s, choice: option.key } : s))}
                className={cn(
                  "text-left p-3 rounded-lg border transition-colors",
                  exportEncrypt.choice === option.key
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                )}
              >
                <p className="text-sm font-medium">{option.label}</p>
                <p className="text-xs text-text-muted mt-0.5">{option.hint}</p>
              </button>
            ))}
            {exportEncrypt.error && <p className="text-red-500 text-sm mt-1">{exportEncrypt.error}</p>}
          </div>
        )}
        {exportEncrypt?.step === "own" && (
          <div className="flex flex-col">
            <Input
              type="password"
              value={exportEncrypt.passphrase}
              onChange={(e) => setExportEncrypt((s) => (s ? { ...s, passphrase: e.target.value } : s))}
              onKeyDown={(e) => { if (e.key === "Enter" && ownEntryValid) finalizeEncryptedExport(exportEncrypt.passphrase); }}
              placeholder="Passphrase"
              autoFocus
            />
            {exportEncrypt.passphrase && !PRINTABLE_ASCII.test(exportEncrypt.passphrase) && (
              <p className="text-red-500 text-xs mt-1">{PASSPHRASE_ASCII_HINT}</p>
            )}
            <p className="text-xs text-text-muted mt-1 mb-3">
              minimum 10 characters (I and L count as 1, O as 0; spaces and hyphens are ignored)
            </p>
            <Input
              type="password"
              value={exportEncrypt.confirm}
              onChange={(e) => setExportEncrypt((s) => (s ? { ...s, confirm: e.target.value } : s))}
              onKeyDown={(e) => { if (e.key === "Enter" && ownEntryValid) finalizeEncryptedExport(exportEncrypt.passphrase); }}
              placeholder="Confirm passphrase"
            />
            {exportEncrypt.confirm && !PRINTABLE_ASCII.test(exportEncrypt.confirm) && (
              <p className="text-red-500 text-xs mt-1">{PASSPHRASE_ASCII_HINT}</p>
            )}
            {exportEncrypt.passphrase && exportEncrypt.confirm && exportEncrypt.passphrase !== exportEncrypt.confirm && (
              <p className="text-red-500 text-xs mt-1">Passphrases do not match</p>
            )}
            <p className="text-amber-600 dark:text-amber-400 text-sm mt-4">
              Everything in this backup — provider tokens, API keys, settings — is encrypted with this passphrase. If you lose it, the backup cannot be recovered.
            </p>
          </div>
        )}
        {exportEncrypt?.step === "panel" && exportEncrypt.generated && (
          <div className="flex flex-col">
            <p className="text-text-muted text-sm mb-2">
              This passphrase cannot be shown again — save it now.
            </p>
            <pre className="p-3 rounded-lg bg-bg border border-border font-mono text-sm sm:text-base whitespace-pre-wrap break-all select-text">
              {exportEncrypt.generated}
            </pre>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" icon="content_copy" onClick={() => copyGeneratedPassphrase(exportEncrypt.generated)}>
                Copy
              </Button>
              <Button variant="outline" icon="download" onClick={() => downloadPassphraseTxt(exportEncrypt.generated)}>
                Download .txt
              </Button>
            </div>
            {exportEncrypt.copyNote && (
              <p className="text-xs text-text-muted mt-2">{exportEncrypt.copyNote}</p>
            )}
            <div className="mt-4">
              <Input
                type="password"
                value={exportEncrypt.retype}
                onChange={(e) => setExportEncrypt((s) => (s ? { ...s, retype: e.target.value } : s))}
                onKeyDown={(e) => { if (e.key === "Enter" && retypeValid) finalizeEncryptedExport(exportEncrypt.generated); }}
                placeholder="Re-type the passphrase to confirm"
              />
              {exportEncrypt.retype && !PRINTABLE_ASCII.test(exportEncrypt.retype) && (
                <p className="text-red-500 text-xs mt-1">{PASSPHRASE_ASCII_HINT}</p>
              )}
              {exportEncrypt.retype && PRINTABLE_ASCII.test(exportEncrypt.retype) && exportEncrypt.retype !== exportEncrypt.generated && (
                <p className="text-red-500 text-xs mt-1">Passphrase does not match — check it against the text above</p>
              )}
            </div>
            <p className="text-amber-600 dark:text-amber-400 text-sm mt-4">
              Everything in this backup — provider tokens, API keys, settings — is encrypted with this passphrase. If you lose it, the backup cannot be recovered.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
