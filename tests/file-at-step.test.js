const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(repoDir, ...args) {
  return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
}

// 末尾の改行まで含めて比べたいので、trim する git() とは別に用意する
function gitShow(repoDir, revisionPath) {
  return execFileSync("git", ["-C", repoDir, "show", revisionPath], { encoding: "utf8" });
}

function httpGet(port, urlPath, timeoutMsec) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: urlPath, timeout: timeoutMsec }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitForServeInfo(targetDir, timeoutMsec) {
  const serveInfoPath = path.join(targetDir, "serve.json");
  const deadline = Date.now() + timeoutMsec;
  while (Date.now() < deadline) {
    if (fs.existsSync(serveInfoPath)) {
      try {
        return JSON.parse(fs.readFileSync(serveInfoPath, "utf8"));
      } catch (error) {
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForHealth(port, timeoutMsec) {
  const deadline = Date.now() + timeoutMsec;
  while (Date.now() < deadline) {
    try {
      const result = await httpGet(port, "/health", 500);
      if (result.statusCode === 200) return true;
    } catch (error) {
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// 変更、新規、削除、改名を1回の差分にまとめて持たせる。改名は中身が同じだと差分に出ないので1行足す
function makeRepo() {
  const repoDir = makeTempDir("storiff-file-at-step-");
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "test@example.com");
  git(repoDir, "config", "user.name", "test");
  fs.writeFileSync(path.join(repoDir, "app.js"), "const first = 1\nconst second = 2\nconst third = 3\nconst fourth = 4\n");
  fs.writeFileSync(path.join(repoDir, "gone.js"), "const gone = 1\n");
  fs.writeFileSync(path.join(repoDir, "old.js"), "const kept = 1\nconst keptMore = 2\nconst keptEvenMore = 3\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-qm", "first");
  fs.writeFileSync(path.join(repoDir, "app.js"), "const first = 1\nconst secondChanged = 2\nconst third = 3\nconst fourth = 4\nconst fifth = 5\nconst sixth = 6\n");
  fs.writeFileSync(path.join(repoDir, "born.js"), "const born = 1\n");
  fs.unlinkSync(path.join(repoDir, "gone.js"));
  git(repoDir, "mv", "old.js", "renamed.js");
  fs.appendFileSync(path.join(repoDir, "renamed.js"), "const added = 4\n");
  git(repoDir, "add", "-A");
  return repoDir;
}

function findChangeId(changes, filePath, kind, text) {
  const file = changes.files.find((candidate) => candidate.file === filePath);
  const line = file.lines.find((candidate) => candidate.kind === kind && candidate.text === text);
  return line.id;
}

// app.js の変更を3コマに割り、残りのファイルの変更を4コマ目にまとめる
// 1コマ目と2コマ目を足すだけにして、コマを進めると行数が段階的に増えるようにしている
function writeSteps(targetDir, changes) {
  const addFifth = findChangeId(changes, "app.js", "add", "const fifth = 5");
  const addSixth = findChangeId(changes, "app.js", "add", "const sixth = 6");
  const delSecond = findChangeId(changes, "app.js", "del", "const second = 2");
  const addSecondChanged = findChangeId(changes, "app.js", "add", "const secondChanged = 2");
  const appIds = [addFifth, addSixth, delSecond, addSecondChanged];
  const restIds = changes.change_ids.filter((changeId) => !appIds.includes(changeId));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    title: "テスト",
    steps: [
      { order: 1, title: "行を足す", narration: "説明", owns: [addFifth], refs: [] },
      { order: 2, title: "もう1行足す", narration: "説明", owns: [addSixth], refs: [] },
      { order: 3, title: "名前を変える", narration: "説明", owns: [delSecond, addSecondChanged], refs: [] },
      { order: 4, title: "他のファイル", narration: "説明", owns: restIds, refs: [] },
    ],
  }, null, 2));
}

async function startServe(testContext, targetDir) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "storiff.js"), "serve", targetDir, "--daemon", "--host", "127.0.0.1", "--port", "0"],
    { stdio: "ignore" },
  );
  testContext.after(() => {
    try {
      child.kill();
    } catch (error) {
    }
  });
  const serveInfo = await waitForServeInfo(targetDir, 5000);
  assert.ok(serveInfo, "serve.json が書き出されませんでした");
  const started = await waitForHealth(serveInfo.port, 5000);
  assert.strictEqual(started, true, "serve が起動しませんでした");
  return serveInfo.port;
}

// prep まで済ませたリポジトリと配信中のポートをまとめて用意する
async function setUp(testContext) {
  const repoDir = makeRepo();
  const targetDir = makeTempDir("storiff-file-at-step-target-");
  testContext.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "prep", targetDir], { cwd: repoDir, encoding: "utf8" });
  const changes = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  writeSteps(targetDir, changes);
  const port = await startServe(testContext, targetDir);
  return { repoDir, targetDir, changes, port };
}

async function getFile(port, query) {
  const result = await httpGet(port, "/file?" + query, 5000);
  return { statusCode: result.statusCode, body: JSON.parse(result.body) };
}

test("F1 コマ0は変更前のコミットの中身そのもの", async (testContext) => {
  const { repoDir, changes, port } = await setUp(testContext);
  const result = await getFile(port, "step=0&path=app.js");
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.status, "modified");
  assert.strictEqual(result.body.content, gitShow(repoDir, changes.base_sha["."] + ":app.js"));
});

test("F2 最大コマまで当てると作業ツリーの中身と一致する", async (testContext) => {
  const { repoDir, port } = await setUp(testContext);
  const result = await getFile(port, "step=4&path=app.js");
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.content, fs.readFileSync(path.join(repoDir, "app.js"), "utf8"));
});

test("F3 コマを進めると行数が段階的に増える", async (testContext) => {
  const { port } = await setUp(testContext);
  const lineCounts = [];
  for (const stepOrder of [0, 1, 2]) {
    const result = await getFile(port, "step=" + stepOrder + "&path=app.js");
    lineCounts.push(result.body.content.replace(/\n$/, "").split("\n").length);
  }
  assert.deepStrictEqual(lineCounts, [4, 5, 6]);
});

test("F4 まだ当てていないコマの変更は入らない", async (testContext) => {
  const { port } = await setUp(testContext);
  const beforeRename = await getFile(port, "step=2&path=app.js");
  assert.strictEqual(beforeRename.body.content.includes("const second = 2"), true);
  assert.strictEqual(beforeRename.body.content.includes("const secondChanged = 2"), false);
  const afterRename = await getFile(port, "step=3&path=app.js");
  assert.strictEqual(afterRename.body.content.includes("const second = 2"), false);
  assert.strictEqual(afterRename.body.content.includes("const secondChanged = 2"), true);
});

test("F5 新規ファイルはコマ0で空、当て終わると作業ツリーと一致する", async (testContext) => {
  const { repoDir, port } = await setUp(testContext);
  const beforeAdd = await getFile(port, "step=0&path=born.js");
  assert.strictEqual(beforeAdd.statusCode, 200);
  assert.strictEqual(beforeAdd.body.status, "added");
  assert.strictEqual(beforeAdd.body.content, "");
  const afterAdd = await getFile(port, "step=4&path=born.js");
  assert.strictEqual(afterAdd.body.content, fs.readFileSync(path.join(repoDir, "born.js"), "utf8"));
});

test("F6 削除したファイルはコマ0で変更前の中身、当て終わると空になる", async (testContext) => {
  const { repoDir, changes, port } = await setUp(testContext);
  const beforeDelete = await getFile(port, "step=0&path=gone.js");
  assert.strictEqual(beforeDelete.statusCode, 200);
  assert.strictEqual(beforeDelete.body.status, "deleted");
  assert.strictEqual(beforeDelete.body.content, gitShow(repoDir, changes.base_sha["."] + ":gone.js"));
  const afterDelete = await getFile(port, "step=4&path=gone.js");
  assert.strictEqual(afterDelete.body.content, "");
});

test("F7 改名したファイルは新しいパスで引き、変更前は旧パスから読む", async (testContext) => {
  const { repoDir, changes, port } = await setUp(testContext);
  const beforeRename = await getFile(port, "step=0&path=renamed.js");
  assert.strictEqual(beforeRename.statusCode, 200);
  assert.strictEqual(beforeRename.body.status, "renamed");
  assert.strictEqual(beforeRename.body.content, gitShow(repoDir, changes.base_sha["."] + ":old.js"));
  const afterRename = await getFile(port, "step=4&path=renamed.js");
  assert.strictEqual(afterRename.body.content, fs.readFileSync(path.join(repoDir, "renamed.js"), "utf8"));
});

test("F8 repo を省くと . として扱う", async (testContext) => {
  const { port } = await setUp(testContext);
  const withoutRepo = await getFile(port, "step=1&path=app.js");
  const withRepo = await getFile(port, "step=1&path=app.js&repo=.");
  assert.deepStrictEqual(withoutRepo.body, withRepo.body);
});

test("F9 step が数字でない、無い、範囲外のときは400を返す", async (testContext) => {
  const { port } = await setUp(testContext);
  const notNumber = await getFile(port, "step=abc&path=app.js");
  assert.strictEqual(notNumber.statusCode, 400);
  assert.match(notNumber.body.error, /step は0以上の整数/);
  const missing = await getFile(port, "path=app.js");
  assert.strictEqual(missing.statusCode, 400);
  const tooLarge = await getFile(port, "step=99&path=app.js");
  assert.strictEqual(tooLarge.statusCode, 400);
  assert.match(tooLarge.body.error, /step が範囲外です/);
});

test("F10 path が無い、リポジトリの外を指す、差分に無いときは断る", async (testContext) => {
  const { port } = await setUp(testContext);
  const missing = await getFile(port, "step=1");
  assert.strictEqual(missing.statusCode, 400);
  assert.match(missing.body.error, /path を指定してください/);
  const outside = await getFile(port, "step=1&path=" + encodeURIComponent("../secret.js"));
  assert.strictEqual(outside.statusCode, 400);
  assert.match(outside.body.error, /リポジトリの外/);
  const unknown = await getFile(port, "step=1&path=nowhere.js");
  assert.strictEqual(unknown.statusCode, 404);
  assert.match(unknown.body.error, /差分にないファイルです/);
});

test("F11 base_sha を持たない古い changes.json では出せない", async (testContext) => {
  const targetDir = makeTempDir("storiff-file-at-step-old-");
  testContext.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", hunks: [{ ids: [1] }], lines: [{ kind: "add", old: null, new: 1, text: "line1", id: 1 }] }],
    change_ids: [1],
    cwd: targetDir,
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [] }],
  }));
  const port = await startServe(testContext, targetDir);
  const result = await getFile(port, "step=1&path=a.js");
  assert.strictEqual(result.statusCode, 409);
  assert.match(result.body.error, /変更前のコミットを覚えていない/);
});
