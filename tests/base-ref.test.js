const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { resolveBaseRef } = require("../storiff.js");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(repoDir, ...args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

// コミットを2つ持つリポジトリを作る。2つ目のコミットの後に未コミットの変更も置く
function makeRepo() {
  const repoDir = makeTempDir("storiff-base-ref-");
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "test");
  fs.writeFileSync(path.join(repoDir, "app.js"), "const first = 1\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-qm", "first");
  fs.writeFileSync(path.join(repoDir, "app.js"), "const first = 1\nconst second = 2\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-qm", "second");
  fs.writeFileSync(path.join(repoDir, "app.js"), "const first = 1\nconst second = 2\nconst third = 3\n");
  return repoDir;
}

test("引数なしは HEAD を指す", () => {
  assert.strictEqual(resolveBaseRef([]), "HEAD");
});

test("名前を1つ書いたらそれがベース", () => {
  assert.strictEqual(resolveBaseRef(["origin/main"]), "origin/main");
});

test("2つ書いたら左がベース", () => {
  assert.strictEqual(resolveBaseRef(["HEAD^", "HEAD"]), "HEAD^");
});

test("2つの点は左がベース", () => {
  assert.strictEqual(resolveBaseRef(["HEAD~1..HEAD"]), "HEAD~1");
});

test("3つの点は分かれ道を探す", () => {
  assert.deepStrictEqual(resolveBaseRef(["origin/main...HEAD"]), { mergeBase: ["origin/main", "HEAD"] });
});

test("点の左右が空なら HEAD で埋める", () => {
  assert.deepStrictEqual(resolveBaseRef(["...HEAD"]), { mergeBase: ["HEAD", "HEAD"] });
  assert.deepStrictEqual(resolveBaseRef(["origin/main..."]), { mergeBase: ["origin/main", "HEAD"] });
  assert.strictEqual(resolveBaseRef(["..HEAD"]), "HEAD");
});

test("prep が動く名前を SHA に固定して覚える", () => {
  const repoDir = makeRepo();
  const targetDir = makeTempDir("storiff-base-sha-");
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "prep", targetDir], { cwd: repoDir, encoding: "utf8" });
  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(changes.base_sha["."], git(repoDir, "rev-parse", "HEAD"));
});

test("prep が範囲指定でも分かれ道の SHA を覚える", () => {
  const repoDir = makeRepo();
  const targetDir = makeTempDir("storiff-base-sha-range-");
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "prep", targetDir, "HEAD~1...HEAD"], { cwd: repoDir, encoding: "utf8" });
  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(changes.base_sha["."], git(repoDir, "merge-base", "HEAD~1", "HEAD"));
});

// 中身がまったく同じ改名は変更行が0件になり差分に出ないので、1行足してから改名する
test("改名したファイルの旧パスを覚える", () => {
  const repoDir = makeRepo();
  git(repoDir, "checkout", "-q", "--", "app.js");
  git(repoDir, "mv", "app.js", "renamed.js");
  fs.appendFileSync(path.join(repoDir, "renamed.js"), "const third = 3\n");
  const targetDir = makeTempDir("storiff-rename-");
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "prep", targetDir], { cwd: repoDir, encoding: "utf8" });
  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  const renamedFile = changes.files.find((file) => file.status === "renamed");
  assert.notStrictEqual(renamedFile, undefined);
  assert.strictEqual(renamedFile.file, "renamed.js");
  assert.strictEqual(renamedFile.old_file, "app.js");
});
