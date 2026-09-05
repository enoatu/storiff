const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const { appendComment, runPrep, runRebuild } = require("../storiff.js");

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

function readComments(targetDir) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "comments.json"), "utf8"));
}

function readSteps(targetDir) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
}

function textById(changes) {
  const textByIdMap = new Map();
  for (const file of changes.files) {
    for (const line of file.lines) {
      if (line.id != null) textByIdMap.set(line.id, line.text);
    }
  }
  return textByIdMap;
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

function httpPostJson(port, urlPath, value, timeoutMsec) {
  return new Promise((resolve, reject) => {
    const bodyText = JSON.stringify(value);
    const request = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", timeout: timeoutMsec, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyText) } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("timeout"));
    });
    request.end(bodyText);
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

test("runRebuild で steps.json が作り直され、機械的な区切りに置き換わる", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "base\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "base\nkeepA\nkeepB\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));
  const stepsBefore = fs.readFileSync(path.join(targetDir, "steps.json"), "utf8");

  runRebuild(targetDir);

  const stepsAfter = readSteps(targetDir);
  assert.notStrictEqual(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"), stepsBefore);
  assert.strictEqual(stepsAfter.title, "");
  assert.strictEqual(stepsAfter.steps.some((step) => step.title === "タイトル"), false);
  assert.strictEqual(stepsAfter.steps.every((step) => step.narration === ""), true);
});

test("runRebuild で既存コメントが残り、change_id が新しい区切りのIDに付け替わる", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "base\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "base\nkeepA\nkeepB\nkeepC\ntargetLine\nkeepD\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));
  const targetLine = firstChanges.files[0].lines.find((line) => line.text === "targetLine");
  appendComment(targetDir, { scope: "line", change_id: targetLine.id, file: "a.js", repo: ".", line: targetLine.new, step_order: 1, body: "ここなぜ?" });
  const commentBefore = readComments(targetDir)[0];
  assert.strictEqual(commentBefore.change_id, targetLine.id);

  fs.writeFileSync(path.join(repoDir, "a.js"), "base\nnewInserted\nkeepA\nkeepB\nkeepC\ntargetLine\nkeepD\n");
  runRebuild(targetDir);

  const commentsAfter = readComments(targetDir);
  assert.strictEqual(commentsAfter.length, 1);
  assert.strictEqual(commentsAfter[0].body, "ここなぜ?");
  assert.notStrictEqual(commentsAfter[0].change_id, targetLine.id);
  assert.strictEqual("line_lost" in commentsAfter[0], false);

  const currentChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(textById(currentChanges).get(commentsAfter[0].change_id), "targetLine");
});

test("実行中に2回目の /rebuild を投げると409になる", async (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "base\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "base\nkeepA\nkeepB\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "storiff.js"), "serve", targetDir, "--daemon", "--host", "127.0.0.1", "--port", "0"],
    { stdio: "ignore" },
  );
  t.after(() => {
    try {
      child.kill();
    } catch (error) {
    }
  });

  const serveInfo = await waitForServeInfo(targetDir, 5000);
  assert.ok(serveInfo, "serve.json が書き出されませんでした");
  const started = await waitForHealth(serveInfo.port, 5000);
  assert.strictEqual(started, true, "serve が起動しませんでした");

  const [first, second] = await Promise.all([
    httpPostJson(serveInfo.port, "/rebuild", {}, 5000),
    httpPostJson(serveInfo.port, "/rebuild", {}, 5000),
  ]);
  const statusCodes = [first.statusCode, second.statusCode].sort();
  assert.deepStrictEqual(statusCodes, [200, 409]);
});
