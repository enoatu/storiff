const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDiff, buildDraftSteps, DRAFT_STEP_COUNT_MIN, DRAFT_STEP_COUNT_MAX } = require("../storiff.js");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeGitRepo(repoDir) {
  execFileSync("git", ["init", "--quiet"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "storiff-test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "storiff-test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
}

function commitFile(repoDir, fileName, content, message) {
  fs.writeFileSync(path.join(repoDir, fileName), content);
  execFileSync("git", ["add", fileName], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", message], { cwd: repoDir });
}

// 追加行を addCount 行持つ、かたまり1つ分の unified 差分を作る
function makeHunkText(hunkIndex, addCount) {
  const startLine = hunkIndex * 100 + 1;
  const header = "@@ -" + startLine + ",1 +" + startLine + "," + (addCount + 1) + " @@ function build" + hunkIndex + "() {";
  const addedLines = [];
  for (let index = 0; index < addCount; index++) addedLines.push("+追加" + hunkIndex + "-" + index);
  return [header, " そのままの行", ...addedLines].join("\n");
}

function makeDiffText(fileName, hunkTexts, statusLine) {
  const head = ["diff --git a/" + fileName + " b/" + fileName];
  if (statusLine) head.push(statusLine);
  head.push("--- a/" + fileName, "+++ b/" + fileName);
  return head.concat(hunkTexts).join("\n") + "\n";
}

function buildStepsFromDiff(diffText) {
  return buildDraftSteps(parseDiff(diffText, ".", 1).files);
}

function runStoriff(commandArgs, cwd) {
  try {
    const output = execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), ...commandArgs], { encoding: "utf8", cwd });
    return { exitCode: 0, output };
  } catch (error) {
    return { exitCode: error.status, output: error.stdout };
  }
}

test("parseDiff はかたまりごとに変更IDをためる", () => {
  const diffText = makeDiffText("a.js", [makeHunkText(0, 2), makeHunkText(1, 1)]);
  const file = parseDiff(diffText, ".", 1).files[0];
  assert.deepStrictEqual(file.hunks, [{ ids: [1, 2] }, { ids: [3] }]);
});

test("parseDiff は行にかたまりの番号を残さない", () => {
  const file = parseDiff(makeDiffText("a.js", [makeHunkText(0, 1)]), ".", 1).files[0];
  assert.deepStrictEqual(Object.keys(file.lines[0]), ["kind", "old", "new", "text"]);
  assert.deepStrictEqual(Object.keys(file.hunks[0]), ["ids"]);
});

test("かたまりが1つだけの差分は1ステップになる", () => {
  const steps = buildStepsFromDiff(makeDiffText("a.js", [makeHunkText(0, 5)]));
  assert.strictEqual(steps.length, 1);
  assert.deepStrictEqual(steps[0], { order: 1, title: "a.js の1つ目の変更", narration: "", owns: ["1-5"], refs: [] });
});

test("かたまりが3個未満のときは、無理に3ステップへ割らずかたまりの数がそのままステップ数になる", () => {
  const diffText = makeDiffText("a.js", [makeHunkText(0, 5)]) + makeDiffText("b.js", [makeHunkText(0, 7)]);
  const steps = buildStepsFromDiff(diffText);
  assert.strictEqual(steps.length, 2);
  assert.deepStrictEqual(steps.map((step) => step.title), ["a.js の1つ目の変更", "b.js の1つ目の変更"]);
  assert.deepStrictEqual(steps.map((step) => step.owns), [["1-5"], ["6-12"]]);
});

test("連番はファイルごとに1から数え直す", () => {
  const hunkTexts = [];
  for (let index = 0; index < 4; index++) hunkTexts.push(makeHunkText(index, 30));
  const diffText = makeDiffText("a.js", hunkTexts) + makeDiffText("b.js", [makeHunkText(0, 30)]);
  const steps = buildStepsFromDiff(diffText);
  assert.deepStrictEqual(steps.map((step) => step.title),
    ["a.js の1つ目の変更", "a.js の2つ目の変更", "b.js の1つ目の変更"]);
});

test("小さいかたまりが続くと、ステップ数が目安(3〜10)に収まるようにまとまる", () => {
  const hunkTexts = [];
  for (let index = 0; index < 40; index++) hunkTexts.push(makeHunkText(index, 3));
  const steps = buildStepsFromDiff(makeDiffText("a.js", hunkTexts));
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps.map((step) => step.owns), [["1-42"], ["43-81"], ["82-120"]]);
});

test("大きすぎるかたまりは同じくらいの大きさに割られ、割った先も連番になる", () => {
  const steps = buildStepsFromDiff(makeDiffText("a.js", [makeHunkText(0, 5), makeHunkText(1, 5), makeHunkText(2, 300)]));
  assert.strictEqual(steps.length, 4);
  assert.deepStrictEqual(steps.map((step) => step.owns), [["1-85"], ["86-160"], ["161-235"], ["236-310"]]);
  assert.deepStrictEqual(steps.map((step) => step.title),
    ["a.js の1つ目の変更", "a.js の2つ目の変更", "a.js の3つ目の変更", "a.js の4つ目の変更"]);
  assert.deepStrictEqual(steps.map((step) => step.order), [1, 2, 3, 4]);
});

test("小さいかたまりはファイルをまたいでもまとまり、題は最初のファイル名とファイル数になる", () => {
  let diffText = "";
  for (let index = 0; index < 6; index++) diffText += makeDiffText("file" + index + ".js", [makeHunkText(index, 10)]);
  const steps = buildStepsFromDiff(diffText);
  assert.strictEqual(steps.length, 3);
  assert.deepStrictEqual(steps.map((step) => step.title),
    ["file0.js ほか1ファイルの変更", "file2.js ほか1ファイルの変更", "file4.js ほか1ファイルの変更"]);
  assert.deepStrictEqual(steps.map((step) => step.owns), [["1-20"], ["21-40"], ["41-60"]]);
});

test("かたまりが十分に多い差分でも、ステップ数は目安の上限(10)からあふれない", () => {
  let diffText = "";
  for (let index = 0; index < 199; index++) diffText += makeDiffText("f" + index + ".js", [makeHunkText(index, 20)]);
  const files = parseDiff(diffText, ".", 1).files;
  const steps = buildDraftSteps(files);
  assert.ok(steps.length <= DRAFT_STEP_COUNT_MAX, "steps=" + steps.length);
  assert.ok(steps.length >= DRAFT_STEP_COUNT_MIN, "steps=" + steps.length);
  const ownedIds = steps.flatMap((step) => step.owns).flatMap((range) => {
    const [start, end] = String(range).split("-").map(Number);
    const ids = [];
    for (let id = start; id <= (end || start); id++) ids.push(id);
    return ids;
  });
  assert.deepStrictEqual(ownedIds.sort((a, b) => a - b), files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.ids)).sort((a, b) => a - b));
});

test("新規ファイルの追加も1ステップになる", () => {
  const diffText = ["diff --git a/new.js b/new.js", "new file mode 100644", "--- /dev/null", "+++ b/new.js",
    "@@ -0,0 +1,3 @@", "+1行目", "+2行目", "+3行目", ""].join("\n");
  const files = parseDiff(diffText, ".", 1).files;
  assert.strictEqual(files[0].status, "added");
  const steps = buildDraftSteps(files);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].title, "new.js の1つ目の変更");
  assert.deepStrictEqual(steps[0].owns, ["1-3"]);
});

test("削除ファイルも1ステップになる", () => {
  const diffText = ["diff --git a/old.js b/old.js", "deleted file mode 100644", "--- a/old.js", "+++ /dev/null",
    "@@ -1,3 +0,0 @@", "-1行目", "-2行目", "-3行目", ""].join("\n");
  const files = parseDiff(diffText, ".", 1).files;
  assert.strictEqual(files[0].status, "deleted");
  const steps = buildDraftSteps(files);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].title, "old.js の1つ目の変更");
  assert.deepStrictEqual(steps[0].owns, ["1-3"]);
});

test("--with-draft で書いた下書きが check を通る", (t) => {
  const repoDir = makeTempDir("storiff-draft-repo-");
  const targetDir = makeTempDir("storiff-draft-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  makeGitRepo(repoDir);
  const baseLines = [];
  for (let index = 0; index < 300; index++) baseLines.push("行" + index);
  commitFile(repoDir, "a.js", baseLines.join("\n") + "\n", "最初");
  const changedLines = baseLines.slice();
  for (const position of [10, 120, 250]) {
    for (let offset = 0; offset < 20; offset++) changedLines[position + offset] = "書き換えた行" + (position + offset);
  }
  fs.writeFileSync(path.join(repoDir, "a.js"), changedLines.join("\n") + "\n");
  fs.writeFileSync(path.join(repoDir, "b.js"), "増やしたファイル\n");
  execFileSync("git", ["add", "b.js"], { cwd: repoDir });

  const prepResult = runStoriff(["prep", targetDir, "--with-draft"], repoDir);
  assert.strictEqual(prepResult.exitCode, 0, prepResult.output);
  assert.ok(prepResult.output.includes("区切りの下書き:"), prepResult.output);

  const steps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  assert.strictEqual(steps.title, "");
  assert.strictEqual(steps.steps.length, 3);
  assert.ok(steps.steps.every((step) => step.narration === ""));
  assert.deepStrictEqual(steps.steps.map((step) => step.title),
    ["a.js の1つ目の変更", "a.js の2つ目の変更", "b.js の1つ目の変更"]);

  const checkResult = runStoriff(["check", targetDir], repoDir);
  assert.strictEqual(checkResult.exitCode, 0, checkResult.output);
  assert.ok(checkResult.output.startsWith("ok: 全121件の変更IDがちょうど1回ずつ owns に入っています"), checkResult.output);
});

test("--with-draft を付けなければ steps.json は作らない", (t) => {
  const repoDir = makeTempDir("storiff-draft-repo-");
  const targetDir = makeTempDir("storiff-draft-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "1行目\n", "最初");
  fs.writeFileSync(path.join(repoDir, "a.js"), "書き換えた1行目\n");

  const prepResult = runStoriff(["prep", targetDir], repoDir);
  assert.strictEqual(prepResult.exitCode, 0, prepResult.output);
  assert.strictEqual(prepResult.output.includes("区切りの下書き:"), false);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "steps.json")), false);
});

test("すでに steps.json があれば --with-draft でも上書きしない", (t) => {
  const repoDir = makeTempDir("storiff-draft-repo-");
  const targetDir = makeTempDir("storiff-draft-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "1行目\n", "最初");
  fs.writeFileSync(path.join(repoDir, "a.js"), "書き換えた1行目\n");
  runStoriff(["prep", targetDir, "--with-draft"], repoDir);

  const written = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  written.title = "手で書いた題";
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify(written, null, 2));

  const prepResult = runStoriff(["prep", targetDir, "--with-draft"], repoDir);
  assert.strictEqual(prepResult.exitCode, 0, prepResult.output);
  assert.strictEqual(prepResult.output.includes("区切りの下書き:"), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8")).title, "手で書いた題");
});
