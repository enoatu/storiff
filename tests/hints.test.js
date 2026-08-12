const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { findDefinitionRegexps, buildHintsText, buildHintsTextOrNote, runPrep } = require("../storiff.js");

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

function makeFile(repo, file, lines) {
  return { repo, file, status: "modified", lines };
}

function makeLine(kind, text, id) {
  return { kind, old: null, new: null, text, id };
}

test("別ファイルで定義した関数を使っている行が手がかりに出る", () => {
  const files = [
    makeFile(".", "src/api.js", [makeLine("add", "function fetchUser(id) {", 12)]),
    makeFile(".", "src/page.js", [makeLine("add", "const shown = fetchUser(1)", 45), makeLine("add", "log(fetchUser)", 46)]),
  ];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /src\/api\.js の fetchUser を 変更ID 12 で定義し、変更ID 45, 46 が使っています/);
});

test("対応していない言語のファイルは定義を拾わない", () => {
  const files = [
    makeFile(".", "lib/report.rb", [makeLine("add", "def build_report(rows)", 1)]),
    makeFile(".", "lib/main.rb", [makeLine("add", "build_report(rows)", 2)]),
  ];
  const hintsText = buildHintsText(files);
  assert.doesNotMatch(hintsText, /build_report/);
  assert.match(hintsText, /手がかりは見つかりませんでした/);
});

test("ディレクトリ名に点があっても拡張子を取り違えない", () => {
  assert.notStrictEqual(findDefinitionRegexps("src/login.js"), null);
  assert.strictEqual(findDefinitionRegexps("dir.old/Makefile"), null);
  assert.strictEqual(findDefinitionRegexps("scripts/.js"), null);
});

test("拡張子が無いファイルでも落ちない", () => {
  const files = [makeFile(".", "Makefile", [makeLine("add", "build:", 1)]), makeFile(".", null, [makeLine("add", "なにか", 2)])];
  assert.doesNotThrow(() => buildHintsText(files));
});

test("使われていない名前は手がかりに出ない", () => {
  const files = [makeFile(".", "src/api.js", [makeLine("add", "function fetchUser(id) {", 1)])];
  const hintsText = buildHintsText(files);
  assert.doesNotMatch(hintsText, /fetchUser/);
});

test("定義した行自体は使っている行に数えない", () => {
  const files = [makeFile(".", "src/api.js", [makeLine("add", "const fetchUser = () => fetchUser", 1)])];
  const hintsText = buildHintsText(files);
  assert.doesNotMatch(hintsText, /fetchUser/);
});

test("関数の中で作った変数は手がかりに出ないが、関数そのものは深さに関わらず出る", () => {
  const files = [
    makeFile(".", "src/api.js", [makeLine("add", "  const workingList = []", 1), makeLine("add", "  function fetchUser(id) {", 2)]),
    makeFile(".", "src/page.js", [makeLine("add", "show(workingList, fetchUser)", 3)]),
  ];
  const hintsText = buildHintsText(files);
  assert.doesNotMatch(hintsText, /workingList/);
  assert.match(hintsText, /fetchUser を 変更ID 2 で定義し、変更ID 3 が使っています/);
});

test("行頭の export 付きの定数も手がかりに出る", () => {
  const files = [
    makeFile(".", "src/config.ts", [makeLine("add", "export const RETRY_COUNT_MAX = 3", 1)]),
    makeFile(".", "src/page.ts", [makeLine("add", "retry(RETRY_COUNT_MAX)", 2)]),
  ];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /RETRY_COUNT_MAX を 変更ID 1 で定義し、変更ID 2 が使っています/);
});

test("短すぎる名前は当たりが多いので手がかりに出ない", () => {
  const files = [
    makeFile(".", "src/api.js", [makeLine("add", "const id = 1", 1)]),
    makeFile(".", "src/page.js", [makeLine("add", "show(id)", 2)]),
  ];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /手がかりは見つかりませんでした/);
});

test("同じ名前が何度も定義されていたらありふれた名前として捨てる", () => {
  const definitionLines = [];
  for (let index = 1; index <= 6; index++) definitionLines.push(makeLine("add", "const result = calc()", index));
  const files = [makeFile(".", "src/api.js", definitionLines), makeFile(".", "src/page.js", [makeLine("add", "show(result)", 7)])];
  const hintsText = buildHintsText(files);
  assert.doesNotMatch(hintsText, /result/);
});

test("使っている行が多いときは上限まで並べて残りを件数で示す", () => {
  const useLines = [];
  for (let index = 2; index <= 40; index++) useLines.push(makeLine("add", "fetchUser(" + index + ")", index));
  const files = [makeFile(".", "src/api.js", [makeLine("add", "function fetchUser(id) {", 1)]), makeFile(".", "src/page.js", useLines)];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /が使っています\(ほか 19 件\)/);
});

test("Python の関数と定数の手がかりが出る", () => {
  const files = [
    makeFile(".", "app.py", [makeLine("add", "def make_report(rows):", 1), makeLine("add", "ROW_COUNT_MAX = 10", 2)]),
    makeFile(".", "main.py", [makeLine("add", "print(make_report(ROW_COUNT_MAX))", 3)]),
  ];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /app\.py の make_report を 変更ID 1 で定義し、変更ID 3 が使っています/);
  assert.match(hintsText, /app\.py の ROW_COUNT_MAX を 変更ID 2 で定義し、変更ID 3 が使っています/);
});

test("Go の関数と型の手がかりが出る", () => {
  const files = [
    makeFile(".", "user.go", [makeLine("add", "func FetchUser(id int) *User {", 1), makeLine("add", "type UserList []User", 2)]),
    makeFile(".", "main.go", [makeLine("add", "var list UserList = FetchUser(1)", 3)]),
  ];
  const hintsText = buildHintsText(files);
  assert.match(hintsText, /user\.go の FetchUser を 変更ID 1 で定義し、変更ID 3 が使っています/);
  assert.match(hintsText, /user\.go の UserList を 変更ID 2 で定義し、変更ID 3 が使っています/);
});

test("変更行が多すぎるときは解析を省く", () => {
  const manyLines = [];
  for (let index = 1; index <= 100001; index++) manyLines.push(makeLine("add", "const nameOfValue = 1", index));
  const hintsText = buildHintsText([makeFile(".", "src/api.js", manyLines)]);
  assert.match(hintsText, /変更行が多すぎるので解析を省きました/);
});

test("解析に失敗したら hints.txt と prep の出力の両方に理由を残す", () => {
  const brokenFiles = [{ repo: ".", file: "src/api.js", status: "modified", lines: [{ kind: "add", id: 1 }] }];
  assert.throws(() => buildHintsText(brokenFiles));

  const originalConsoleLog = console.log;
  const shownLogs = [];
  console.log = (message, error) => shownLogs.push({ message, error });
  let hintsText;
  try {
    hintsText = buildHintsTextOrNote(brokenFiles);
  } finally {
    console.log = originalConsoleLog;
  }
  assert.match(hintsText, /^# 変更どうしのつながり\(参考\)/);
  assert.match(hintsText, /解析に失敗しました\(/);
  assert.strictEqual(shownLogs.length, 1);
  assert.match(shownLogs[0].message, /手がかりの解析に失敗しました/);
  assert.ok(shownLogs[0].error instanceof Error);
});

test("prep が hints.txt を書き出す", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "api.js", "const version = 1\n", "first");
  fs.writeFileSync(path.join(repoDir, "api.js"), "const version = 1\nfunction fetchUser(id) {}\nfetchUser(2)\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const hintsText = fs.readFileSync(path.join(targetDir, "hints.txt"), "utf8");
  assert.match(hintsText, /api\.js の fetchUser を 変更ID 1 で定義し、変更ID 2 が使っています/);
});

test("対応していない言語だけの差分でも prep は今まで通り動く", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "note.md", "はじめ\n", "first");
  fs.writeFileSync(path.join(repoDir, "note.md"), "はじめ\nつづき\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.deepStrictEqual(changes.change_ids, [1]);
  const hintsText = fs.readFileSync(path.join(targetDir, "hints.txt"), "utf8");
  assert.match(hintsText, /手がかりは見つかりませんでした/);
});
