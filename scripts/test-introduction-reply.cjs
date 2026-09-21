const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
  '../src/core/conversation/introductionReply.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleExports = {};
new Function('exports', output)(moduleExports);
const reply = (text, code = '1A', prior = "Hello, my name's Debbie. What's your name?") =>
  moduleExports.introductionReply(code, [
    { role: 'assistant', content: prior }, { role: 'user', content: text },
  ]);
for (const text of ['My name is Francisco.', 'My name\u2019s Francisco.',
  'Hello, my name is Francisco.', "I'm Francisco."]) {
  const result = reply(text);
  assert.ok(result, text);
  assert.equal(result.praise, true);
  assert.equal(result.correction, undefined);
  assert.match(result.speech.english, /Now reply: Nice to meet you too/);
  assert.equal(result.completedGoals, undefined, 'The dialogue is not complete after just the name');
}
for (const text of ['My name are Francisco.', 'My name is Francisco. What is your name?', 'Listening']) {
  assert.equal(reply(text), undefined);
}
assert.equal(reply('My name is Francisco.', 'A'), undefined);
assert.equal(reply('My name is Francisco.', '1A', 'Where are you from?'), undefined);
console.log('PASS: introductions advance within the dialogue without prematurely completing the task');
