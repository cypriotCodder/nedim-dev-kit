// What counts as a secret, and how to keep one out of anything the collector writes.
// Node built-ins only: this folder is copied into projects with collect.mjs.

// The PEM marker sits outside `\b`, which would need a word character right before its dashes.
const PEM_MARKER_SOURCE = "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----";
const PROVIDER_KEY_SOURCE = String.raw`\b(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{20,}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{22,}|sk-(?:proj|ant|svcacct)-[0-9A-Za-z_-]{20,}|xox[bap]-[0-9A-Za-z-]{20,}|AIza[0-9A-Za-z\-_]{35})|${PEM_MARKER_SOURCE}`;
// The secret word can sit anywhere in the name: AWS_SECRET_ACCESS_KEY, secretKey, dbPassword. Nothing
// before it is needed, since the match can start at the word, and `[\w-]*` there would backtrack
// quadratically through a long run of word characters, as in minified code.
const SECRET_NAME_SOURCE = String.raw`(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)[\w-]*`;
const QUOTE = "[\"'`]";

export const PROVIDER_KEY = new RegExp(PROVIDER_KEY_SOURCE);

// ---------- Values that are named like secrets but aren't ----------
const PLACEHOLDER = /^(?:\$\{?\w+\}?|<.*>|changeme|change[-_]me|x{3,}|\*{3,}|your[-_].*|todo|none|null|undefined|true|false|redacted)$/i;
const ENV_REFERENCE = /process\.env|import\.meta\.env|\$\{|\{\{|%\(|^env\(|^ENV\[/;
const DOTTED_NAME = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)+$/; // errors.token_invalid, config.auth.secret
const WORDS = /^[a-z]+(?:[_-][a-z]+)+$|^[A-Z]+(?:_[A-Z]+)+$/; // refresh_token_cookie_name, MY_SECRET_NAME
const FILE_PATH = /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)|\/[\w.-]+\.[a-z]{2,4}$/; // ./certs/key.pem, /etc/x/key.pem
const SETTING = /^(?:\d+(?:\.\d+)?[smhdwy]?|\d+(?:ms|min|days?)|true|false|yes|no|on|off)$/i; // 15m, 8, 604800

// Whether a value assigned to a secret-looking name could be a credential.
export function looksLikeSecretValue(value) {
  const v = value.trim();
  if (!v || /\s/.test(v) || PLACEHOLDER.test(v) || ENV_REFERENCE.test(v) || SETTING.test(v)) return false;
  if (DOTTED_NAME.test(v) || WORDS.test(v) || FILE_PATH.test(v)) return false;
  return !/^(.)\1+$/.test(v); // aaaaaaaaaaaaaaaa
}

// Quoted, 16 or more characters with no space, and passing the value check.
const ASSIGNED = new RegExp(`${SECRET_NAME_SOURCE}["']?\\s*[:=]\\s*(${QUOTE})([^"'\`\\s]{16,})\\1`, "gi");
export const HARDCODED_SECRET = {
  test: (line) => [...line.matchAll(ASSIGNED)].some((m) => looksLikeSecretValue(m[2])),
};

// ---------- Redaction ----------
// Redaction errs the other way: removing a value that wasn't secret costs a little evidence.
// The marker, its base64 body (real or JSON-escaped newlines) and the end marker if there is one.
// Only those characters, so a marker with no end can't swallow the rest of a JSON document.
const PEM_BLOCK = new RegExp(String.raw`${PEM_MARKER_SOURCE}(?:\\[nr]|[\sA-Za-z0-9+/=])*(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)?`, "g");
const PROVIDER_KEY_ALL = new RegExp(PROVIDER_KEY_SOURCE, "g");
// `\\?` because the same text can arrive JSON-escaped, for example inside a tool's JSON report.
const ASSIGNED_SECRET_ALL = new RegExp(`(${SECRET_NAME_SOURCE}\\\\?["']?\\s*[:=]\\s*\\\\?${QUOTE})[^"'\`\\\\\\s]{8,}`, "gi");
// Unquoted, as in an env file or a shell line: DB_PASSWORD=hunter2.
const ENV_STYLE_ALL = /(\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?![\s"'`\\[])[^\s"'`\\]{4,}/g;
const URL_PASSWORD_ALL = /(\/\/[^/\s:@"'`]+:)[^/\s@"'`]+(@)/g;
const BEARER_ALL = /(\b(?:Bearer|Basic|token)\s+)[A-Za-z0-9\-._~+/]{16,}=*/g;

export const redact = (text) => text
  .replace(PEM_BLOCK, "[redacted]")
  .replace(PROVIDER_KEY_ALL, "[redacted]")
  .replace(ASSIGNED_SECRET_ALL, "$1[redacted]")
  .replace(ENV_STYLE_ALL, "$1[redacted]")
  .replace(URL_PASSWORD_ALL, "$1[redacted]$2")
  .replace(BEARER_ALL, "$1[redacted]");

// ---------- .env files ----------
export const isEnvTemplate = (path) => /\.(example|sample|template)$/.test(path);

// Frameworks expect `.env.development` and friends to be committed, so those only count when they
// hold a secret. `.env` and `*.local` are private by convention, whatever they hold today.
const PRIVATE_ENV_FILE = /(^|\/)\.env(\.local|\.[^/]+\.local)?$/;
const SECRET_KEY = /SECRET|PASSWORD|PASSWD|PWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_KEY|AUTH_KEY|SERVICE_ROLE/i;
// Settings about a secret rather than the secret: ACCESS_TOKEN_EXPIRES_IN, PASSWORD_MIN_LENGTH.
const ABOUT_A_SECRET = /_(?:EXPIRES?(?:_IN)?|EXPIRY|EXPIRATION|TTL|LIFETIME|MAX_AGE|LENGTH|MIN|MAX|MIN_LENGTH|MAX_LENGTH|ROUNDS|SALT_ROUNDS|COUNT|LIMIT|TIMEOUT|ENABLED|DISABLED|REQUIRED|HEADER|HEADER_NAME|COOKIE|COOKIE_NAME|NAME|ALGORITHM|ALG|ISSUER|AUDIENCE|URL_PATH|PATH|FILE|PREFIX)$/i;
const PUBLIC_KEY = /^(?:NEXT_PUBLIC|NUXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_/;
const CLIENT_EXPOSED_SECRET = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD/i; // the audit's client-exposed-secret rule
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
    if (URL_PASSWORD.test(value)) { names.push(name); continue; }
    const secretName = PUBLIC_KEY.test(name) ? CLIENT_EXPOSED_SECRET.test(name) : SECRET_KEY.test(name);
    if (secretName && !ABOUT_A_SECRET.test(name) && !SETTING.test(value)) names.push(name);
  }
  return names.length ? `holds ${names.join(", ")}` : null;
}
