// What counts as a secret, and how to keep one out of anything the collector writes.
// Node built-ins only: this folder is copied into projects with collect.mjs.

// The PEM marker sits outside `\b`, which would need a word character right before its dashes.
const PEM_MARKER_SOURCE = "-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----";
const PROVIDER_KEY_SOURCE = String.raw`\b(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{20,}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{22,}|sk-(?:proj|ant|svcacct)-[0-9A-Za-z_-]{20,}|xox[bap]-[0-9A-Za-z-]{20,}|AIza[0-9A-Za-z\-_]{35})|${PEM_MARKER_SOURCE}`;
// A whole name with a secret word anywhere in it: AWS_SECRET_ACCESS_KEY, secretKey, dbPassword.
// The match starts only where a name starts, and `(?=(?<name>…))\k<name>` takes the name atomically, so
// a long run of word characters (minified code, "token" × 20000) is read once instead of once per
// secret word in it, which was quadratic.
const wholeName = (chars, words, start) =>
  String.raw`${start}(?=${chars}*?(?:${words}))(?=(?<name>${chars}+))\k<name>`;
const SECRET_NAME_SOURCE = wholeName(String.raw`[\w-]`, String.raw`api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|signing[_-]?key|credentials?`, String.raw`(?<![\w-])`);
const QUOTE = "[\"'`]";

export const PROVIDER_KEY = new RegExp(PROVIDER_KEY_SOURCE);

// ---------- Values that are named like secrets but aren't ----------
const PLACEHOLDER = /^(?:\$\{?\w+\}?|<.*>|changeme|change[-_]me|x{3,}|\*{3,}|your[-_].*|todo|none|null|undefined|true|false|redacted)$/i;
const ENV_REFERENCE = /process\.env|import\.meta\.env|\$\{|\{\{|%\(|^env\(|^ENV\[/;
const DOTTED_NAME = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)+$/; // errors.token_invalid, config.auth.secret
// Digit segments are short and never mixed with letters, so a key like key-3ax6xnjp29jd6fds4g still counts.
const WORDS = /^[a-z]+(?:[_-](?:[a-z]+|\d{1,4}))+$|^[A-Z]+(?:_[A-Z]+)+$/; // refresh_token_cookie_name, color-neutral-600
// Design-token references: --color-neutral-600, var(--space-4), $brand-primary, {color.neutral.600}.
// Lowercase only, and an alias needs a dot, so a random key behind a prefix still counts.
// SDK class names: ClientSecretCredential, AWSCredentialsProviderChain. Letters only, every capital
// run followed by lowercase, so a random key (which has digits or lone lowercase letters) still counts.
const CLASS_NAME = /^(?:[A-Z]{1,4}[a-z]{2,}){2,}$/;
// Cloud resource names: projects/acme/locations/global/keyRings/main. Collections are camelCase words,
// so a base64 secret with slashes in it still counts.
const RESOURCE_NAME = /^[a-z]+(?:[A-Z][a-z]+)*\/[\w.-]+(?:\/[a-z]+(?:[A-Z][a-z]+)*\/[\w.-]+)*$/;
const DESIGN_TOKEN = /^(?:--|\$)[a-z][a-z0-9-]*$|^var\(--[a-z][a-z0-9-]*\)$|^\{[\w-]+(?:\.[\w-]+)+\}$/;
const FILE_PATH = /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)|\/[\w.-]+\.[a-z]{2,4}$/; // ./certs/key.pem, /etc/x/key.pem
// Thirteen digits covers a millisecond timestamp. A longer run of digits can be a key.
const SETTING = /^(?:\d{1,13}(?:\.\d{1,6})?[smhdwy]?|\d{1,13}(?:ms|min|days?)|true|false|yes|no|on|off)$/i; // 15m, 8, 604800

// Whether a value assigned to a secret-looking name could be a credential.
export function looksLikeSecretValue(value) {
  const v = value.trim();
  if (!v || /\s/.test(v) || PLACEHOLDER.test(v) || ENV_REFERENCE.test(v) || SETTING.test(v)) return false;
  if (DOTTED_NAME.test(v) || WORDS.test(v) || FILE_PATH.test(v) || DESIGN_TOKEN.test(v)) return false;
  if (CLASS_NAME.test(v) || RESOURCE_NAME.test(v)) return false;
  return !/^(.)\1+$/.test(v); // aaaaaaaaaaaaaaaa
}

// Quoted, 16 or more characters with no space, and passing the value check.
const ASSIGNED = new RegExp(`${SECRET_NAME_SOURCE}["']?\\s*[:=]\\s*(?<quote>${QUOTE})(?<value>[^"'\`\\s]{16,})\\k<quote>`, "gi");
export const HARDCODED_SECRET = {
  test: (line) => [...line.matchAll(ASSIGNED)].some((m) => looksLikeSecretValue(m.groups.value)),
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
const ENV_STYLE_ALL = new RegExp(String.raw`(${wholeName("[A-Z0-9_]", "SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|SIGNING_?KEY|CREDENTIALS?", String.raw`\b`)}\s*=\s*)(?![\s"'${"`"}\\[])[^\s"'${"`"}\\]{4,}`, "g");
// The same in any case (db_password=hunter2, authToken=abc), but only written tight with no call in
// the value, so code such as `const password = req.body.password` keeps the evidence an auditor needs.
// The value is taken whole, and the "no call" rule is applied in redactTight(), not in the pattern:
// a lookahead for "(" rescanned the value once per name in it, which was quadratic in minified code.
const TIGHT_ASSIGNMENT = new RegExp(String.raw`(${wholeName(String.raw`\w`, "secret|password|passwd|token|api_?key|private_?key|access_?key|signing_?key|credentials?", String.raw`\b`)}=)(?![\s"'${"`"}\\[=])(?=(?<value>[^\s"'${"`"}\\]*))\k<value>`, "gi");
function redactTight(text) {
  const re = new RegExp(TIGHT_ASSIGNMENT);
  let out = "", kept = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const { value } = m.groups, valueAt = m.index + m[1].length, call = value.lastIndexOf("(");
    if (call < 0 && value.length >= 4) {
      out += text.slice(kept, valueAt) + "[redacted]";
      kept = re.lastIndex;
    } else {
      // Not redacted here. A name further on can still be, but only one after the value's last "(".
      re.lastIndex = valueAt + call + 1;
    }
  }
  return out + text.slice(kept);
}
const URL_PASSWORD_ALL = /(\/\/[^/\s:@"'`]+:)[^/\s@"'`]+(@)/g;
const BEARER_ALL = /(\b(?:Bearer|Basic|token)\s+)[A-Za-z0-9\-._~+/]{16,}=*/g;

export const redact = (text) => redactTight(text
  .replace(PEM_BLOCK, "[redacted]")
  .replace(PROVIDER_KEY_ALL, "[redacted]")
  .replace(ASSIGNED_SECRET_ALL, "$1[redacted]")
  .replace(ENV_STYLE_ALL, "$1[redacted]"))
  .replace(URL_PASSWORD_ALL, "$1[redacted]$2")
  .replace(BEARER_ALL, "$1[redacted]");

// ---------- .env files ----------
export const isEnvTemplate = (path) => /\.(example|sample|template)$/.test(path);

// Frameworks expect `.env.development` and friends to be committed, so those only count when they
// hold a secret. `.env` and `*.local` are private by convention, whatever they hold today.
const PRIVATE_ENV_FILE = /(^|\/)\.env(\.local|\.[^/]+\.local)?$/;
const SECRET_KEY = /SECRET|PASSWORD|PASSWD|PWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_KEY|AUTH_KEY|SIGNING_?KEY|SERVICE_ROLE/i;
// Settings about a secret rather than the secret: ACCESS_TOKEN_EXPIRES_IN, PASSWORD_MIN_LENGTH.
const ABOUT_A_SECRET = /_(?:EXPIRES?(?:_IN)?|EXPIRY|EXPIRATION|TTL|LIFETIME|MAX_AGE|LENGTH|MIN|MAX|MIN_LENGTH|MAX_LENGTH|ROUNDS|SALT_ROUNDS|COUNT|LIMIT|TIMEOUT|ENABLED|DISABLED|REQUIRED|HEADER|HEADER_NAME|COOKIE|COOKIE_NAME|NAME|ALGORITHM|ALG|ISSUER|AUDIENCE|URL_PATH|PATH|FILE|PREFIX|VERSION|SIZE|BYTES|SIZE_BYTES|AT|AT_MS|AT_NS)$/i;
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
