const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { VIEWER_HTML, buildStory, readProgress, writeProgress, runPrep } = require("../storiff.js");

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

function writeMinimalStory(targetDir) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "1つ目", narration: "説明", owns: [1], refs: [] }],
  }));
}

test("読んだ位置を書くと progress.json に残り、読み直せる", (t) => {
  const targetDir = makeTempDir("storiff-progress-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeProgress(targetDir, { current_step_order: 3, read_step_orders: [1, 2, 3] });
  const progress = readProgress(targetDir);
  assert.strictEqual(progress.current_step_order, 3);
  assert.deepStrictEqual(progress.read_step_orders, [1, 2, 3]);
});

test("読んだ位置に数でない値や重複が混ざっても、整数の order だけが昇順で残る", (t) => {
  const targetDir = makeTempDir("storiff-progress-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeProgress(targetDir, { current_step_order: "3", read_step_orders: [3, "2", 1, 3, null] });
  const progress = readProgress(targetDir);
  assert.strictEqual(progress.current_step_order, null);
  assert.deepStrictEqual(progress.read_step_orders, [1, 3]);
});

test("記録が無いディレクトリでは、story.json の読んだ位置が空になる", (t) => {
  const targetDir = makeTempDir("storiff-progress-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  assert.strictEqual(buildStory(targetDir).progress, null);
});

test("記録があるディレクトリでは、story.json に読んだ位置が入る", (t) => {
  const targetDir = makeTempDir("storiff-progress-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  writeProgress(targetDir, { current_step_order: 1, read_step_orders: [1] });
  assert.strictEqual(buildStory(targetDir).progress.current_step_order, 1);
});

test("追従でステップが増えても、読んだ位置の order が指すステップは変わらない", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\nline2\nline3\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "1つ目", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));
  writeProgress(targetDir, { current_step_order: 1, read_step_orders: [1] });

  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\nnewLine\n");
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const story = buildStory(targetDir);
  assert.strictEqual(story.steps.length, 2);
  assert.strictEqual(story.progress.current_step_order, 1);
  assert.strictEqual(story.steps[0].order, 1);
  assert.strictEqual(story.steps[0].title, "1つ目");
  assert.strictEqual(story.steps[1].title, "修正1回目");
});

// ブラウザの代わりになる最小限の作りもの。読んだ位置の送信と、3秒ごとの取り直しを手で動かせるようにする
function readStepCount(viewerParts) {
  const readStepOrders = viewerParts.viewer.readStepOrdersNow();
  return Object.keys(readStepOrders).filter((stepOrder) => readStepOrders[stepOrder] === true).length;
}

function makeViewer(initialStory) {
  const createdElements = [];
  const elementsById = {};
  const makeElement = () => {
    let writtenText = "";
    const element = {
      className: "", innerHTML: "", disabled: false, dataset: {}, style: {}, onclick: null,
      appendChild() {}, insertBefore() {}, removeChild() {}, addEventListener() {},
      querySelector() { return null; },
      get textContent() { return writtenText; },
      set textContent(value) { writtenText = value == null ? "" : String(value); element.innerHTML = writtenText; },
    };
    createdElements.push(element);
    return element;
  };
  const documentStub = {
    createElement: makeElement,
    getElementById(id) {
      if (!elementsById[id]) elementsById[id] = makeElement();
      return elementsById[id];
    },
    querySelector(selector) { return selector === ".comment-form" ? null : makeElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const windowStub = { innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollTo() {}, addEventListener() {} };
  let servedStory = initialStory;
  const sentProgressList = [];
  const fetchStub = (requestUrl, options) => {
    if (requestUrl === "/progress") {
      sentProgressList.push(JSON.parse(options.body));
      return { catch() {} };
    }
    return {
      then(onResponse) {
        const parsedStory = onResponse({ json: () => JSON.parse(JSON.stringify(servedStory)) });
        return { then(onStory) { onStory(parsedStory); } };
      },
    };
  };
  const pollCallbacks = [];
  let waitingSave = null;
  const scriptText = VIEWER_HTML.slice(VIEWER_HTML.lastIndexOf("<script>") + "<script>".length, VIEWER_HTML.lastIndexOf("</script>"));
  const exposeCode = "\nreturn {goToStep:goToStep, readStepOrdersNow:function(){return readStepOrders;},"
    + " stepIndexNow:function(){return stepIndex;}, resumeStepOrderNow:function(){return resumeStepOrder;}};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(
    documentStub, windowStub, fetchStub,
    (callback) => pollCallbacks.push(callback),
    (callback) => { waitingSave = callback; return 1; },
    () => { waitingSave = null; },
    undefined,
  );
  return {
    viewer, createdElements, elementsById, sentProgressList,
    serveStory(story) { servedStory = story; },
    poll() { pollCallbacks.forEach((callback) => callback()); },
    runSave() {
      if (waitingSave == null) return;
      const callback = waitingSave;
      waitingSave = null;
      callback();
    },
  };
}

function makeStory(steps, progress) {
  return {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
    steps,
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
    progress: progress == null ? null : progress,
  };
}

function makeStep(order, title, narration) {
  return { order, title, narration, owns: [1], refs: [] };
}

function makeSteps(count) {
  const steps = [];
  for (let order = 1; order <= count; order++) steps.push(makeStep(order, order + "つ目", "説明"));
  return steps;
}

function findResumeButton(createdElements) {
  return createdElements.find((element) => element.id === "resumeBtn");
}

test("コマを移動すると、いまいるコマがサーバに送られる", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(3)));
  viewerParts.viewer.goToStep(2);
  viewerParts.runSave();
  const sentProgress = viewerParts.sentProgressList[viewerParts.sentProgressList.length - 1];
  assert.strictEqual(sentProgress.current_step_order, 3);
  assert.deepStrictEqual(sentProgress.read_step_orders.sort(), [1, 3]);
});

test("コマを続けて移動しても、送るのは最後の1回だけになる", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(4)));
  viewerParts.viewer.goToStep(1);
  viewerParts.viewer.goToStep(2);
  viewerParts.viewer.goToStep(3);
  assert.strictEqual(viewerParts.sentProgressList.length, 0);
  viewerParts.runSave();
  assert.strictEqual(viewerParts.sentProgressList.length, 1);
  assert.strictEqual(viewerParts.sentProgressList[0].current_step_order, 4);
});

test("記録が無いときは1コマ目から始まり、続きの案内も出ない", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(3)));
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 0);
  assert.strictEqual(viewerParts.viewer.resumeStepOrderNow(), null);
  assert.strictEqual(viewerParts.elementsById.resumeMsg.style.display, "none");
});

test("記録があっても1コマ目から始まり、続きの案内を押すとそのコマに移る", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(4), { current_step_order: 3, read_step_orders: [1, 2, 3] }));
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 0);
  assert.strictEqual(viewerParts.elementsById.resumeMsg.style.display, "flex");
  const resumeButton = findResumeButton(viewerParts.createdElements);
  assert.ok(resumeButton, "続きから読む案内が出ませんでした");
  resumeButton.onclick();
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 2);
  assert.strictEqual(viewerParts.elementsById.resumeMsg.style.display, "none");
});

test("記録した位置のコマが無くなっていたら、その手前で一番近いコマに移る", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(3), { current_step_order: 7, read_step_orders: [1, 2, 3] }));
  findResumeButton(viewerParts.createdElements).onclick();
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 2);
});

test("追従でコマが増えても、読んだ記録といまいるコマが保たれる", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(2)));
  viewerParts.viewer.goToStep(1);
  viewerParts.serveStory(makeStory(makeSteps(2).concat([makeStep(3, "修正1回目", "")])));
  viewerParts.poll();
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 1);
});

test("追従でコマが減っても、いまいるコマが残っているコマの中に収まる", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(4)));
  viewerParts.viewer.goToStep(3);
  viewerParts.serveStory(makeStory(makeSteps(2)));
  viewerParts.poll();
  assert.strictEqual(viewerParts.viewer.stepIndexNow(), 1);
});

test("説明文の取り直しで再描画されても、読んだ記録が消えない", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(3)));
  viewerParts.viewer.goToStep(1);
  assert.strictEqual(readStepCount(viewerParts), 2);
  viewerParts.serveStory(makeStory([makeStep(1, "書き換えた題", "説明"), makeStep(2, "2つ目", "説明"), makeStep(3, "3つ目", "説明")]));
  viewerParts.poll();
  assert.strictEqual(readStepCount(viewerParts), 2);
});

test("目次では読んだコマにだけ印がつく", () => {
  const viewerParts = makeViewer(makeStory(makeSteps(3)));
  const readItems = viewerParts.createdElements.filter((element) => element.className.indexOf("read") !== -1);
  assert.strictEqual(readItems.length, 1);
});

test("準備中のコマは読んだ記録に入らない", () => {
  const viewerParts = makeViewer(makeStory([makeStep(1, "1つ目", "説明"), makeStep(2, "仮の題", "")]));
  assert.strictEqual(readStepCount(viewerParts), 1);
});

test("全部のコマが準備中の間は、読んだ記録が空のままになる", () => {
  const viewerParts = makeViewer(makeStory([makeStep(1, "仮の題", ""), makeStep(2, "仮の題", "")]));
  assert.strictEqual(readStepCount(viewerParts), 0);
});
