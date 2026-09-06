const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeLine(text, id) {
  return { kind: "add", old: null, new: null, text, id };
}

// 変更IDを4件持つ差分を置く。1と2が a.js、3と4が b.js
function writeChanges(targetDir) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] },
      { repo: ".", file: "b.js", status: "modified", lines: [makeLine("z", 3), makeLine("w", 4)] },
    ],
    change_ids: [1, 2, 3, 4],
  }));
}

// 変更IDを8件持つ差分を置く。1-5が a.js、6-8が b.js
function writeSpreadChanges(targetDir) {
  const makeLines = (startId, endId) => {
    const lines = [];
    for (let id = startId; id <= endId; id++) lines.push(makeLine("行" + id, id));
    return lines;
  };
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { repo: ".", file: "a.js", status: "modified", lines: makeLines(1, 5) },
      { repo: ".", file: "b.js", status: "modified", lines: makeLines(6, 8) },
    ],
    change_ids: [1, 2, 3, 4, 5, 6, 7, 8],
  }));
}

// 変更IDを500件持つ差分を置く。1-250が a.js、251-500が b.js
function writeLargeChanges(targetDir) {
  const makeLines = (startId, endId) => {
    const lines = [];
    for (let id = startId; id <= endId; id++) lines.push(makeLine("行" + id, id));
    return lines;
  };
  const changeIds = [];
  for (let id = 1; id <= 500; id++) changeIds.push(id);
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { repo: ".", file: "a.js", status: "modified", lines: makeLines(1, 250) },
      { repo: ".", file: "b.js", status: "modified", lines: makeLines(251, 500) },
    ],
    change_ids: changeIds,
  }));
}

function writeSteps(targetDir, steps) {
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({ title: "題名", steps }));
}

// check を叩く。戻り値は終了コードと出力
function runCheck(targetDir, options) {
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "check", targetDir, ...options], { encoding: "utf8" });
    return { exitCode: 0, output };
  } catch (error) {
    return { exitCode: error.status, output: error.stdout };
  }
}

function makeStep(order, title, owns) {
  return { order, title, narration: "説明", owns, refs: [] };
}

test("欠落した変更IDがあると ng になり、未割り当てのファイルが出る", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2, 3])]);
  const before = fs.readFileSync(path.join(targetDir, "steps.json"), "utf8");
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("未割り当てのファイル(どこかのstepに足すか、章に入れないなら理由を添えて support に置く):"));
  assert.ok(result.output.includes("F2 b.js (id 4)"));
  assert.strictEqual(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"), before);
});

test("欠落が飛び飛びのとき、未割り当てのIDは範囲ではなく飛び飛びのまま出る", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeSpreadChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 3, 4]), makeStep(2, "2つ目", [6, 7, 8])]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("F1 a.js (id 2,5)"), result.output);
});

test("続いた欠落は1つの範囲にまとまって出る", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeSpreadChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2, 3])]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("F1 a.js (id 4-5)"), result.output);
  assert.ok(result.output.includes("F2 b.js (id 6-8)"), result.output);
});

test("欠落が無ければ ok になり、steps.json は書き換わらない", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2]), makeStep(2, "2つ目", [3, 4])]);
  const before = fs.readFileSync(path.join(targetDir, "steps.json"), "utf8");
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output, "ok: 全4件の変更IDがちょうど1回ずつ owns に入っています\n");
  assert.strictEqual(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"), before);
});

test("重複した変更IDは ng になる", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2]), makeStep(2, "2つ目", [2, 3, 4])]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("重複した変更ID 1件: 2"));
});

test("不明なファイルは ng になる", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [{ order: 1, title: "1つ目", narration: "説明", owns: [1, 2, 3, 4], refs: [], owns_files: ["c.js"] }]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("不明なファイル: c.js"));
});

test("owns が文字列でも1文字ずつに分解されず、欠落として ng になる", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2]), { order: 2, title: "2つ目", narration: "説明", owns: "3-4", refs: [] }]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("F2 b.js (id 3-4)"), result.output);
});

test("大きく複数ファイルにまたがるstepは ng になる", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeLargeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "まとめて直した", ["1-250", "251-500"])]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("step1 まとめて直した (500行, 2ファイル)"));
});

test("1ファイルに収まっていても大きいstepは ng になる", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeLargeChanges(targetDir);
  writeSteps(targetDir, [
    makeStep(1, "a.js をまとめて直した", ["1-250"]),
    makeStep(2, "b.js の前半", ["251-400"]),
    makeStep(3, "b.js の後半", ["401-500"]),
  ]);
  const result = runCheck(targetDir, []);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("step1 a.js をまとめて直した (250行, 1ファイル)"));
});

test("無くなった --strict と --backfill を付けても既定のまま動く", (t) => {
  const targetDir = makeTempDir("storiff-check-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2]), makeStep(2, "2つ目", [3, 4])]);
  const result = runCheck(targetDir, ["--strict", "--backfill"]);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output, "ok: 全4件の変更IDがちょうど1回ずつ owns に入っています\n");
});
