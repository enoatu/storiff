const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildStory, buildValidation, buildSupportIssues, remapSupport } = require("../storiff.js");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeLine(text, id) {
  return { kind: "add", old: null, new: null, text, id };
}

// 変更IDを4件持つ差分を置く。1と2が a.js、3と4が gen.pb.go
function writeChanges(targetDir, excludedFiles) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [
      { repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] },
      { repo: ".", file: "gen.pb.go", status: "modified", lines: [makeLine("z", 3), makeLine("w", 4)] },
    ],
    change_ids: [1, 2, 3, 4],
    excluded_files: excludedFiles || [],
  }));
}

function writeSteps(targetDir, steps, support) {
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({ title: "題名", steps, support }));
}

function makeStep(order, title, owns) {
  return { order, title, narration: "説明", owns, refs: [] };
}

// check を叩く。戻り値は終了コードと出力
function runCheck(targetDir) {
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "check", targetDir], { encoding: "utf8" });
    return { exitCode: 0, output };
  } catch (error) {
    return { exitCode: error.status, output: error.stdout };
  }
}

test("support に置いた変更IDは未割り当てにならない", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2])], [{ owns: ["F2"], reason: "生成コード" }]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("ok: 全4件の変更IDがちょうど1回ずつ owns に入っています(うち補助 2件)"));
});

test("章と support が同じ変更IDを持つと重複で ng になる", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2, 3, 4])], [{ owns: [3, 4], reason: "生成コード" }]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.output.includes("重複した変更ID 2件: 3,4"));
});

test("support の reason が空だと参考として出る", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2])], [{ owns: ["F2"], reason: "" }]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("support1 reason が空です"));
});

test("support は最後のコマになり、理由が説明文に並ぶ", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2])], [{ owns: ["F2"], reason: "生成コード" }]);
  const story = buildStory(targetDir);
  assert.strictEqual(story.steps.length, 2);
  const supportStep = story.steps[1];
  assert.strictEqual(supportStep.title, "補助");
  assert.strictEqual(supportStep.is_support, true);
  assert.strictEqual(supportStep.order, 2);
  assert.deepStrictEqual(supportStep.owns, [3, 4]);
  assert.strictEqual(supportStep.narration, "- 生成コード");
});

test("行を持たない除外ファイルは、名前と行数だけ補助のコマに出る", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir, [{ repo: ".", file: "yarn.lock", status: "modified", changed_line_count: 3935, reason: "ノイズとして自動で脇に置いた" }]);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2, 3, 4])], []);
  const story = buildStory(targetDir);
  assert.strictEqual(story.steps.length, 2);
  assert.strictEqual(story.steps[1].narration, "- `yarn.lock` 3935行 ノイズとして自動で脇に置いた");
  assert.deepStrictEqual(story.steps[1].owns, []);
});

test("脇に置いた分も除外ファイルも無ければ補助のコマは出ない", (t) => {
  const targetDir = makeTempDir("storiff-support-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [makeStep(1, "1つ目", [1, 2, 3, 4])], []);
  const story = buildStory(targetDir);
  assert.strictEqual(story.steps.length, 1);
});

test("support の owns_files も所有済みとして数える", () => {
  const files = [
    { repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] },
    { repo: ".", file: "gen.pb.go", status: "modified", lines: [makeLine("z", 3)] },
  ];
  const validation = buildValidation([1, 2, 3], files, [makeStep(1, "1つ目", [1, 2])], [{ owns_files: ["gen.pb.go"], reason: "生成コード" }]);
  assert.strictEqual(validation.ok, true);
  assert.deepStrictEqual(validation.missing, []);
});

test("追従で変更IDが動いても support の受け持ちが付いてくる", () => {
  const previousFiles = [{ repo: ".", file: "gen.pb.go", status: "modified", lines: [makeLine("z", 3), makeLine("w", 4)] }];
  const idMap = new Map([[3, 10], [4, 11]]);
  const remapped = remapSupport(previousFiles, [{ owns: [3, 4], reason: "生成コード" }], idMap);
  assert.deepStrictEqual(remapped, [{ owns: ["10-11"], reason: "生成コード" }]);
});

test("追従で中身が丸ごと消えた support は理由ごと落ちる", () => {
  const previousFiles = [{ repo: ".", file: "gen.pb.go", status: "modified", lines: [makeLine("z", 3)] }];
  const remapped = remapSupport(previousFiles, [{ owns: [3], reason: "生成コード" }], new Map());
  assert.deepStrictEqual(remapped, []);
});

test("理由が埋まっている support は参考に出ない", () => {
  assert.deepStrictEqual(buildSupportIssues([{ owns: [1], reason: "生成コード" }]), []);
});
