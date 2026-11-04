// What counts as a secret, and how to keep one out of anything the collector writes.
// Node built-ins only: this folder is copied into projects with collect.mjs.

// The PEM marker sits outside `\b`, which would need a word character right before its dashes.
const PEM_MARKER_SOURCE = "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----";
const PROVIDER_KEY_SOURCE = String.raw`\b(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{20,}|ghp_[0-9A-Za-z]{30,}|xox[bap]-[0-9A-Za-z-]{20,}|AIza[0-9A-Za-z\-_]{35})|${PEM_MARKER_SOURCE}`;
const SECRET_NAME_SOURCE = String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)`;
const SECRET_VALUE_SOURCE = String.raw`[A-Za-z0-9_\-\/+=.]{16,}`;
const QUOTE = "[\"'`]";

export const PROVIDER_KEY = new RegExp(PROVIDER_KEY_SOURCE);
// The optional quote after the name is what makes this match JSON keys and object literals.
export const HARDCODED_SECRET = new RegExp(`${SECRET_NAME_SOURCE}["']?\\s*[:=]\\s*${QUOTE}${SECRET_VALUE_SOURCE}${QUOTE}`, "i");

// The marker, its base64 body (real or JSON-escaped newlines) and the end marker if there is one.
// Only those characters, so a marker with no end can't swallow the rest of a JSON document.
const PEM_BLOCK = new RegExp(String.raw`${PEM_MARKER_SOURCE}(?:\\[nr]|[\sA-Za-z0-9+/=])*(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?`, "g");
const PROVIDER_KEY_ALL = new RegExp(PROVIDER_KEY_SOURCE, "g");
// `\\?` because the same text can arrive JSON-escaped, for example inside a tool's JSON report.
const ASSIGNED_SECRET_ALL = new RegExp(`(${SECRET_NAME_SOURCE}\\\\?["']?\\s*[:=]\\s*\\\\?${QUOTE})${SECRET_VALUE_SOURCE}`, "gi");

export const redact = (text) => text
  .replace(PEM_BLOCK, "[redacted]")
  .replace(PROVIDER_KEY_ALL, "[redacted]")
  .replace(ASSIGNED_SECRET_ALL, "$1[redacted]");

// ---------- .env files ----------
export const isEnvTemplate = (path) => /\.(example|sample|template)$/.test(path);

// Frameworks expect `.env.development` and friends to be committed, so those only count when they
// hold a secret. `.env` and `*.local` are private by convention, whatever they hold today.
const PRIVATE_ENV_FILE = /(^|\/)\.env(\.local|\.[^/]+\.local)?$/;
const SECRET_KEY = /SECRET|PASSWORD|PASSWD|PWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_KEY|AUTH_KEY|SERVICE_ROLE/i;
const PUBLIC_KEY = /^(?:NEXT_PUBLIC|NUXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_/;
const CLIENT_EXPOSED_SECRET = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD/i; // the audit's client-exposed-secret rule
const PLACEHOLDER = /^(?:\$\{?\w+\}?|<.*>|changeme|change[-_]me|xxx+|your[-_].*|todo|none|null)$/i;
const URL_PASSWORD = /\/\/[^/\s:@]+:[^/\s@]+@/;

// Why a tracked env file counts as a leak, or null. Names variables only, never their values.
export function envFileLeak(path, text) {
  if (isEnvTemplate(path)) return null;
  if (PRIVATE_ENV_FILE.test(path)) return "private by convention";
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, raw] = m;
    const value = raw.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!value || PLACEHOLDER.test(value)) continue;
    const secretName = PUBLIC_KEY.test(name) ? CLIENT_EXPOSED_SECRET.test(name) : SECRET_KEY.test(name);
    if (secretName || URL_PASSWORD.test(value)) names.push(name);
  }
  return names.length ? `holds ${names.join(", ")}` : null;
}
