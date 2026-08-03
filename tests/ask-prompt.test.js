const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildAskPrompt, buildFileDiffText } = require("../storiff.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "storiff-test-"));
}

test("buildFileDiffText は変更行だけを +/- 付きで返す", () => {
  const file = {
    file: "app.js",
    lines: [
      { kind: "context", text: "const a = 1" },
      { kind: "add", text: "const b = 2", id: 1 },
      { kind: "del", text: "const c = 3", id: 2 },
    ],
  };
  const result = buildFileDiffText(file);
  assert.strictEqual(result, "+ const b = 2\n- const c = 3");
});

test("buildAskPrompt はファイル差分と説明と質問を含む", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ file: "app.js", lines: [{ kind: "add", text: "const b = 2", id: 1 }] }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "まず設定を足す" }],
  }));
  const comment = { change_id: 1, file: "app.js", line: 2, step_order: 1, body: "なぜここで足すのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /app\.js/);
  assert.match(prompt, /まず設定を足す/);
  assert.match(prompt, /\+ const b = 2/);
  assert.match(prompt, /なぜここで足すのか/);
});

test("buildAskPrompt は該当ファイルが無ければ差分が空になる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ file: "other.js", lines: [{ kind: "add", text: "const b = 2", id: 1 }] }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "まず設定を足す" }],
  }));
  const comment = { change_id: 1, file: "app.js", line: 2, step_order: 1, body: "なぜここで足すのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.doesNotMatch(prompt, /\+ const b = 2/);
  assert.match(prompt, /該当の差分\n\n/);
});

test("buildAskPrompt は該当 step が無ければ説明が空になる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ file: "app.js", lines: [{ kind: "add", text: "const b = 2", id: 1 }] }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 2, title: "別のステップ", narration: "まず設定を足す" }],
  }));
  const comment = { change_id: 1, file: "app.js", line: 2, step_order: 1, body: "なぜここで足すのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.doesNotMatch(prompt, /まず設定を足す/);
  assert.match(prompt, /ストーリーの説明 \n/);
});
