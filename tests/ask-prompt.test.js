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
    steps: [{ order: 1, title: "導入", narration: "まず設定を足す", owns: [1] }],
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
    files: [{ file: "other.js", lines: [{ kind: "add", text: "const b = 2", id: 99 }] }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "まず設定を足す", owns: [99] }],
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
    steps: [{ order: 2, title: "別のステップ", narration: "まず設定を足す", owns: [1] }],
  }));
  const comment = { change_id: 1, file: "app.js", line: 2, step_order: 1, body: "なぜここで足すのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.doesNotMatch(prompt, /まず設定を足す/);
  assert.match(prompt, /ストーリーの説明 \n/);
});

test("C1 change_idからコメント対象行を特定し、そのステップの範囲だけを渡す", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{
      file: "big.js",
      repo: ".",
      lines: [
        { kind: "add", text: "one行目を追加", id: 1 },
        { kind: "add", text: "two行目を追加", id: 2 },
        { kind: "add", text: "three行目を追加", id: 3 },
      ],
    }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [
      { order: 1, title: "最初のステップ", narration: "まず1行目を足す", owns: [1] },
      { order: 2, title: "次のステップ", narration: "続けて2行目と3行目を足す", owns: [2, 3] },
    ],
  }));
  const comment = { change_id: 3, file: "big.js", repo: ".", line: 3, step_order: 2, body: "なぜここで足すのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /質問対象の行 \+ three行目を追加/);
  assert.match(prompt, /two行目を追加/);
  assert.match(prompt, /three行目を追加/);
  assert.doesNotMatch(prompt, /one行目を追加/);
});

test("C2 同名ファイルが複数リポジトリにあっても正しいリポジトリの差分になる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { file: "index.js", repo: "repoA", lines: [{ kind: "add", text: "repoAの行", id: 1 }] },
      { file: "index.js", repo: "repoB", lines: [{ kind: "add", text: "repoBの行", id: 2 }] },
    ],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "説明", owns: [1, 2] }],
  }));
  const comment = { file: "index.js", repo: "repoB", line: 1, step_order: 1, body: "これは何のためか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /repoBの行/);
  assert.doesNotMatch(prompt, /repoAの行/);
});

test("C2 repoの情報を持たない古いコメントでも落ちない", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { file: "index.js", repo: "repoA", lines: [{ kind: "add", text: "repoAの行", id: 1 }] },
      { file: "index.js", repo: "repoB", lines: [{ kind: "add", text: "repoBの行", id: 2 }] },
    ],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "説明", owns: [1, 2] }],
  }));
  const comment = { file: "index.js", line: 1, step_order: 1, body: "これは何のためか" };
  assert.doesNotThrow(() => buildAskPrompt(targetDir, comment));
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /index\.js/);
});

test("D1 refsの行と質問対象の行が絞り込みから落ちず該当の差分に残る", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{
      file: "app.js",
      repo: ".",
      lines: [
        { kind: "add", text: "ownsの行", id: 1 },
        { kind: "add", text: "refsの行", id: 2 },
        { kind: "add", text: "質問対象の行", id: 3 },
      ],
    }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "説明", owns: [1], refs: [2] }],
  }));
  const comment = { change_id: 3, file: "app.js", repo: ".", line: 3, step_order: 1, body: "なぜこの行があるのか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /ownsの行/);
  assert.match(prompt, /refsの行/);
  assert.match(prompt, /質問対象の行/);
});

test("D2 ファイル名にリポジトリが添えられる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ file: "index.js", repo: "repoB", lines: [{ kind: "add", text: "repoBの行", id: 1 }] }],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "導入", narration: "説明", owns: [1], refs: [] }],
  }));
  const comment = { change_id: 1, file: "index.js", repo: "repoB", line: 1, step_order: 1, body: "これは何のためか" };
  const prompt = buildAskPrompt(targetDir, comment);
  assert.match(prompt, /ファイル repoB index\.js/);
});
