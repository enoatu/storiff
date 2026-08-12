const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { runPrep, buildCommitRange, collectIssueNumbers, collectDocPaths, buildContextText, fetchPullRequestOrNull } = require("../storiff.js");

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

// ~/.storiff/config.json を読ませないため、HOME を空のディレクトリに向ける
function useEmptyHome(t) {
  const originalHome = process.env.HOME;
  const homeDir = makeTempDir("storiff-home-");
  t.after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  process.env.HOME = homeDir;
}

// PATH の先頭に置く偽の gh。呼ばれたことを called.log に残し、PR の JSON を返す
function makeFakeGithubCommand(binDir) {
  const scriptPath = path.join(binDir, "gh");
  const script = [
    "#!/bin/sh",
    'echo "$@" >> "' + path.join(binDir, "called.log") + '"',
    'if [ "$1" = "pr" ]; then',
    "  cat <<'JSON'",
    '{"number":7,"title":"ログインを追加する","url":"https://example.com/pr/7","body":"社内からの要望で必要になった","comments":[{"author":{"login":"leader"},"body":"別の案は運用が重いので選ばなかった"}],"reviews":[]}',
    "JSON",
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n") + "\n";
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
}

// PATH の先頭に置く偽の gh。ログインしていない環境のように、理由を stderr に出して失敗する
function makeFailingGithubCommand(binDir) {
  const scriptPath = path.join(binDir, "gh");
  const script = ["#!/bin/sh", 'echo "gh にログインしていません" >&2', "exit 1"].join("\n") + "\n";
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
}

// PATH に git だけを置いたディレクトリを作り、gh が入っていない環境を再現する
function makeBinDirWithGitOnly(binDir) {
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.symlinkSync(gitPath, path.join(binDir, "git"));
}

test("git diff の範囲指定から git log の範囲を組み立てる", () => {
  assert.strictEqual(buildCommitRange([]), null);
  assert.strictEqual(buildCommitRange(["HEAD"]), null);
  assert.strictEqual(buildCommitRange(["HEAD~3"]), "HEAD~3..HEAD");
  assert.strictEqual(buildCommitRange(["origin/main...HEAD"]), "origin/main..HEAD");
  assert.strictEqual(buildCommitRange(["origin/main..HEAD"]), "origin/main..HEAD");
  assert.strictEqual(buildCommitRange(["main", "HEAD"]), "main..HEAD");
  assert.strictEqual(buildCommitRange(["--stat"]), null);
});

test("-- の後ろのファイル指定は範囲に混ぜない", () => {
  assert.strictEqual(buildCommitRange(["HEAD", "--", "src/"]), null);
  assert.strictEqual(buildCommitRange(["--", "src/"]), null);
  assert.strictEqual(buildCommitRange(["origin/main...HEAD", "--", "docs/"]), "origin/main..HEAD");
  assert.strictEqual(buildCommitRange(["HEAD~3", "--", "docs/", "src/"]), "HEAD~3..HEAD");
});

test("コミットのメッセージとブランチ名から課題番号を重複なく拾う", () => {
  const issueNumbers = collectIssueNumbers(["feature/ABC-123-login", "#12 を直す\nRefs #12, #34", "ABC-123 の続き"]);
  assert.deepStrictEqual(issueNumbers, ["ABC-123", "#12", "#34"]);
});

test("課題番号と同じ形の規格の名前は拾わない", () => {
  const issueNumbers = collectIssueNumbers(["UTF-8 で保存する", "SHA-256 と ISO-8601 と HTTP2-3 に合わせる", "ABC-123 も直す"]);
  assert.deepStrictEqual(issueNumbers, ["ABC-123"]);
});

test("材料が1つも取れなかったときの context.txt は空になる", () => {
  const emptyRepoContext = { repo: ".", branchName: "", commits: [], issueNumbers: [], pullRequest: null, issues: [] };
  assert.strictEqual(buildContextText([emptyRepoContext], []), "");
  assert.strictEqual(buildContextText([], []), "");
});

test("材料が上限を超えると途中で切られる", () => {
  const hugeCommit = { hash: "abc1234", date: "2026-08-01", author: "山田", subject: "件名", body: "x".repeat(200000) };
  const repoContext = { repo: ".", branchName: "main", commits: [hugeCommit], issueNumbers: [], pullRequest: null, issues: [] };
  const contextText = buildContextText([repoContext], []);
  assert.ok(contextText.length < 61000);
  assert.ok(contextText.includes("(長いのでここまで)"));
});

test("変更したファイルの上のディレクトリにある説明ファイルを集める", (t) => {
  const repoDir = makeTempDir("storiff-repo-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoDir, "src", "user"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "プロジェクトの決まり\n");
  fs.writeFileSync(path.join(repoDir, "src", "README.md"), "src の説明\n");

  const files = [{ repo: ".", file: "src/user/login.js", status: "modified", lines: [] }];
  const docPaths = collectDocPaths(files, new Map([[".", repoDir]]));
  assert.deepStrictEqual(docPaths, ["src/README.md", "CLAUDE.md"]);
});

test("ファイルのパスが根から始まっていても、たどるのが止まる", (t) => {
  const repoDir = makeTempDir("storiff-repo-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const files = [{ repo: ".", file: "/src/user/login.js", status: "modified", lines: [] }];
  assert.deepStrictEqual(collectDocPaths(files, new Map([[".", repoDir]])), []);
});

test("同じディレクトリのファイルが何件あっても、ディレクトリは1回だけ調べる", (t) => {
  const repoDir = makeTempDir("storiff-repo-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoDir, "src"));
  const files = [];
  for (let index = 1; index <= 50; index++) {
    files.push({ repo: ".", file: "src/file" + index + ".js", status: "modified", lines: [] });
  }

  const originalExistsSync = fs.existsSync;
  let existsSyncCount = 0;
  fs.existsSync = (checkedPath) => {
    existsSyncCount += 1;
    return originalExistsSync(checkedPath);
  };
  try {
    collectDocPaths(files, new Map([[".", repoDir]]));
  } finally {
    fs.existsSync = originalExistsSync;
  }
  assert.strictEqual(existsSyncCount, 6);
});

test("範囲を指定した prep が、その範囲のコミット本文とブランチ名と課題番号を context.txt に書く", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "このプロジェクトの決まり\n");
  commitFile(repoDir, "a.js", "line1\n", "first");
  execFileSync("git", ["checkout", "--quiet", "-b", "feature/ABC-123-login"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  execFileSync("git", ["add", "a.js"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "ログインを足す\n\n手で入れていた確認が漏れるので自動にした\nRefs #45"], { cwd: repoDir });

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: ["HEAD~1"] }], true);

  const contextText = fs.readFileSync(path.join(targetDir, "context.txt"), "utf8");
  assert.ok(contextText.includes("feature/ABC-123-login"));
  assert.ok(contextText.includes("ログインを足す"));
  assert.ok(contextText.includes("手で入れていた確認が漏れるので自動にした"));
  assert.ok(contextText.includes("Refs #45"));
  assert.ok(contextText.includes("ABC-123"));
  assert.ok(contextText.includes("#45"));
  assert.ok(contextText.includes("=== 関係しそうな説明ファイル ===\nCLAUDE.md"));
  assert.ok(!contextText.includes("=== PR ==="));

  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(changes.with_remote, false);
});

test("作業中の変更だけの prep では、コミットが無くても context.txt が書かれる", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");

  process.chdir(repoDir);
  assert.doesNotThrow(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }]));

  const contextText = fs.readFileSync(path.join(targetDir, "context.txt"), "utf8");
  assert.ok(!contextText.includes("=== コミット ==="));
  assert.ok(contextText.includes("=== ブランチ ==="));
});

test("gh が入っていない環境で --with-remote を渡しても prep が止まらない", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeBinDirWithGitOnly(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir;
  assert.strictEqual(fetchPullRequestOrNull(repoDir), null);
  assert.doesNotThrow(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }], false, true));

  const contextText = fs.readFileSync(path.join(targetDir, "context.txt"), "utf8");
  assert.ok(!contextText.includes("=== PR ==="));
  assert.strictEqual(fs.existsSync(path.join(targetDir, "changes.json")), true);
});

test("gh が失敗したときは理由を1行だけ出し、prep は止まらない", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeFailingGithubCommand(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir + path.delimiter + originalPath;
  const originalConsoleLog = console.log;
  const shownLogs = [];
  console.log = (message) => shownLogs.push(String(message));
  try {
    runPrep(targetDir, [{ path: ".", diffArgs: [] }], false, true);
  } finally {
    console.log = originalConsoleLog;
  }

  const failureLogs = shownLogs.filter((line) => line.startsWith("材料を集められません: "));
  assert.deepStrictEqual(failureLogs, ["材料を集められません: gh pr (gh にログインしていません)"]);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "changes.json")), true);
});

test("gh が入っていないときは失敗を出さない", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeBinDirWithGitOnly(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir;
  const originalConsoleLog = console.log;
  const shownLogs = [];
  console.log = (message) => shownLogs.push(String(message));
  try {
    runPrep(targetDir, [{ path: ".", diffArgs: [] }], false, true);
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepStrictEqual(shownLogs.filter((line) => line.startsWith("材料を集められません: ")), []);
});

test("既定では gh を呼ばず、--with-remote を渡したときだけ PR の説明とコメントが入る", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const localTargetDir = makeTempDir("storiff-target-");
  const remoteTargetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(localTargetDir, { recursive: true, force: true });
    fs.rmSync(remoteTargetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeFakeGithubCommand(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir + path.delimiter + originalPath;
  runPrep(localTargetDir, [{ path: ".", diffArgs: [] }]);
  assert.strictEqual(fs.existsSync(path.join(binDir, "called.log")), false);
  assert.ok(!fs.readFileSync(path.join(localTargetDir, "context.txt"), "utf8").includes("=== PR ==="));

  runPrep(remoteTargetDir, [{ path: ".", diffArgs: [] }], false, true);
  assert.strictEqual(fs.existsSync(path.join(binDir, "called.log")), true);
  const contextText = fs.readFileSync(path.join(remoteTargetDir, "context.txt"), "utf8");
  assert.ok(contextText.includes("=== PR ===\n#7 ログインを追加する"));
  assert.ok(contextText.includes("社内からの要望で必要になった"));
  assert.ok(contextText.includes("--- leader ---\n別の案は運用が重いので選ばなかった"));

  const changes = JSON.parse(fs.readFileSync(path.join(remoteTargetDir, "changes.json"), "utf8"));
  assert.strictEqual(changes.with_remote, true);
});

test("追従の prep でも context.txt を集め直すが、--with-remote は引き継がない", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  execFileSync("git", ["checkout", "--quiet", "-b", "feature/first"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeFakeGithubCommand(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir + path.delimiter + originalPath;
  runPrep(targetDir, [{ path: ".", diffArgs: [] }], false, true);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  execFileSync("git", ["checkout", "--quiet", "-b", "feature/second"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\nline3\n");
  fs.rmSync(path.join(binDir, "called.log"));
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const contextText = fs.readFileSync(path.join(targetDir, "context.txt"), "utf8");
  assert.ok(contextText.includes("feature/second"));
  assert.ok(!contextText.includes("=== PR ==="));
  assert.strictEqual(fs.existsSync(path.join(binDir, "called.log")), false);

  const secondChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(secondChanges.with_remote, false);
});

test("記録済みの範囲を使う prep でも、--with-remote を渡し直せば PR を読む", (t) => {
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const binDir = makeTempDir("storiff-bin-");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  makeFakeGithubCommand(binDir);

  process.chdir(repoDir);
  process.env.PATH = binDir + path.delimiter + originalPath;
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\nline3\n");
  runPrep(targetDir, [{ path: ".", diffArgs: [] }], false, true);

  assert.ok(fs.readFileSync(path.join(targetDir, "context.txt"), "utf8").includes("=== PR ==="));
});

test("生成物は本人だけが読み書きできる権限で残る", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const parentDir = makeTempDir("storiff-target-");
  const targetDir = path.join(parentDir, "story");
  useEmptyHome(t);
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  assert.strictEqual(fs.statSync(targetDir).mode & 0o777, 0o700);
  for (const fileName of ["changes.json", "changes.txt", "files.txt", "hints.txt", "context.txt"]) {
    assert.strictEqual(fs.statSync(path.join(targetDir, fileName)).mode & 0o777, 0o600);
  }
});
