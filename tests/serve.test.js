const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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

async function waitForServeGone(port, timeoutMsec) {
  const deadline = Date.now() + timeoutMsec;
  while (Date.now() < deadline) {
    try {
      await httpGet(port, "/health", 500);
    } catch (error) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// 死んだ pid を数字で決め打ちすると、たまたま動いている別のプロセスに当たる。終わらせた子プロセスの pid を使う
function makeFinishedPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("close", () => resolve(child.pid));
  });
}

test("E1 コメント準備中にsteps.jsonの読み込みが失敗しても、デーモンが生き続けhealthに応答し続ける", async (t) => {
  const targetDir = makeTempDir("storiff-serve-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "line1", id: 1 }] }],
    change_ids: [1],
    cwd: targetDir,
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [] }],
  }));

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "storiff.js"), "serve", targetDir, "--daemon", "--host", "127.0.0.1", "--port", "0", "--session-id", "dummy-session-for-test"],
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

  fs.writeFileSync(path.join(targetDir, "steps.json"), "{ 壊れたJSON");

  const commentResponse = await httpPostJson(serveInfo.port, "/comments", { change_id: 1, file: "a.js", repo: ".", line: 1, step_order: 1, body: "なぜこの行を足したのか" }, 2000);
  assert.strictEqual(commentResponse.statusCode, 200);

  await new Promise((resolve) => setTimeout(resolve, 500));

  const stillAlive = await waitForHealth(serveInfo.port, 2000);
  assert.strictEqual(stillAlive, true, "コメント処理後にデーモンが応答しなくなりました");
});

test("E2 /status が説明文の進みと、fill が動いているかどうかを返す", async (t) => {
  const targetDir = makeTempDir("storiff-status-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "line1", id: 1 }] }],
    change_ids: [1],
    cwd: targetDir,
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [
      { order: 1, title: "1コマ目", narration: "書けている説明", owns: [1], refs: [] },
      { order: 2, title: "2コマ目", narration: "", owns: [], refs: [] },
    ],
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

  const fillInfoPath = path.join(targetDir, "fill.json");
  const beforeFill = await httpGet(serveInfo.port, "/status", 2000);
  assert.strictEqual(beforeFill.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(beforeFill.body), { filling: false, replying: false, step_total: 2, step_filled: 1 });

  fs.writeFileSync(fillInfoPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  const whileFill = await httpGet(serveInfo.port, "/status", 2000);
  assert.strictEqual(JSON.parse(whileFill.body).filling, true, "生きている pid を置いても書いている最中になりませんでした");

  fs.writeFileSync(fillInfoPath, JSON.stringify({ pid: await makeFinishedPid(), started_at: new Date().toISOString() }));
  const afterFillDied = await httpGet(serveInfo.port, "/status", 2000);
  assert.strictEqual(JSON.parse(afterFillDied.body).filling, false, "死んだ pid が残っていると書いている最中に見えました");
});

test("E3 置き場ごと消されたら、作り直しと取り込みを断ってから自分で終わる", async (t) => {
  const targetDir = makeTempDir("storiff-gone-");

  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "line1", id: 1 }] }],
    change_ids: [1],
    cwd: targetDir,
  }));

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "..", "storiff.js"), "serve", targetDir, "--daemon", "--host", "127.0.0.1", "--port", "0", "--session-id", "dummy-session-for-test"],
    { stdio: "ignore" },
  );
  t.after(() => {
    try {
      child.kill();
    } catch (error) {
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  const serveInfo = await waitForServeInfo(targetDir, 5000);
  assert.ok(serveInfo, "serve.json が書き出されませんでした");
  const started = await waitForHealth(serveInfo.port, 5000);
  assert.strictEqual(started, true, "serve が起動しませんでした");

  fs.rmSync(targetDir, { recursive: true, force: true });

  const rebuildResponse = await httpPostJson(serveInfo.port, "/rebuild", {}, 2000);
  assert.strictEqual(rebuildResponse.statusCode, 410, "作り直しが断られませんでした");
  assert.match(rebuildResponse.body, /置き場が消えています/);

  const followResponse = await httpPostJson(serveInfo.port, "/follow", {}, 2000);
  assert.strictEqual(followResponse.statusCode, 410, "取り込みが断られませんでした");

  const gone = await waitForServeGone(serveInfo.port, 5000);
  assert.strictEqual(gone, true, "置き場が消えてもサーバが終わりませんでした");
});
