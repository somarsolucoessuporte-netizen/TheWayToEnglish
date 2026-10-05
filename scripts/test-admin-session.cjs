const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// /admin session cookie (src/lib/admin/session.ts): only a token signed with
// the current ADMIN_PASSWORD and not yet expired opens the panel; with no
// password configured, nothing does.

function loadTs(filename) {
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', source)(require, module, module.exports);
  return module.exports;
}

const s = loadTs(path.resolve(__dirname, '../src/lib/admin/session.ts'));

delete process.env.ADMIN_PASSWORD;
assert.equal(s.checkPassword(''), false, 'no password configured: empty attempt is rejected');
assert.equal(s.checkPassword('anything'), false);
assert.throws(() => s.createSessionToken(), /ADMIN_PASSWORD/);
assert.equal(s.isValidSessionToken('9999999999999.x'), false);

process.env.ADMIN_PASSWORD = 'correct horse';
assert.equal(s.checkPassword('correct horse'), true);
assert.equal(s.checkPassword('correct hors'), false);
assert.equal(s.checkPassword(''), false);

const now = 1_800_000_000_000;
const token = s.createSessionToken(now);
assert.equal(s.isValidSessionToken(token, now + 1000), true, 'fresh token is valid');
assert.equal(s.isValidSessionToken(token, now + s.ADMIN_SESSION_SECONDS * 1000 + 1), false, 'expired token is rejected');
const [exp, sig] = token.split('.');
assert.equal(s.isValidSessionToken(`${Number(exp) + 999999}.${sig}`, now), false, 'extending the expiry breaks the signature');
assert.equal(s.isValidSessionToken(`${exp}.${sig.slice(0, -2)}xx`, now), false, 'tampered signature is rejected');
assert.equal(s.isValidSessionToken(undefined, now), false);
assert.equal(s.isValidSessionToken('garbage', now), false);

process.env.ADMIN_PASSWORD = 'new password';
assert.equal(s.isValidSessionToken(token, now + 1000), false, 'changing the password logs everyone out');

console.log('admin session: signed, expiring, password-bound cookie');
