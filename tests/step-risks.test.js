const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { VIEWER_HTML, buildStory, buildStepRisksIssues, buildFillPrompt, runPrep } = require("../storiff.js");

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

// ブラウザの代わりになる最小限の作りもの。要素は作った順に createdElements へ残す
// textContent は innerHTML に映す。簡易 markdown の描画が本物と同じ文字を通るようにするため
function makeViewer() {
  const createdElements = [];
  const elementsById = {};
  const makeElement = () => {
    const element = {
      className: "", innerHTML: "", disabled: false, dataset: {}, style: {}, onclick: null,
      appendChild() {}, insertBefore() {}, removeChild() {}, addEventListener() {},
      querySelector() { return null; },
    };
    Object.defineProperty(element, "textContent", {
      get() { return element.innerHTML; },
      set(value) { element.innerHTML = value == null ? "" : String(value); },
    });
    createdElements.push(element);
    return element;
  };
  const documentStub = {
    createElement: makeElement,
    getElementById(id) {
      if (!elementsById[id]) elementsById[id] = makeElement();
      return elementsById[id];
    },
    querySelector: makeElement,
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const windowStub = { innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollTo() {}, addEventListener() {} };
  const fetchStub = () => ({ then: () => ({ then: () => {} }) });
  const scriptText = VIEWER_HTML.slice(VIEWER_HTML.lastIndexOf("<script>") + "<script>".length, VIEWER_HTML.lastIndexOf("</script>"));
  const exposeCode = "\nreturn {setStory:function(data){story=data; stepIndex=0;}, render:render, goToStep:goToStep,"
    + " fingerprint:function(){return storyFingerprint(minimapFingerprint());}};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(documentStub, windowStub, fetchStub, () => {}, () => null, () => {}, undefined);
  return { viewer, createdElements, elementsById };
}

function makeStory(firstStepRisks) {
  const firstStep = { order: 1, title: "ステップ1", narration: "説明", owns: [1], refs: [] };
  if (firstStepRisks !== undefined) firstStep.risks = firstStepRisks;
  return {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
    steps: [firstStep, { order: 2, title: "ステップ2", narration: "説明", owns: [], refs: [] }],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
}

function findByClass(createdElements, className) {
  return createdElements.filter((element) => element.className === className);
}

function makeLine(text, id) {
  return { kind: "add", old: null, new: null, text, id };
}

function writeChanges(targetDir) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] }],
    change_ids: [1, 2],
  }));
}

function writeSteps(targetDir, risks) {
  const step = { order: 1, title: "1つ目", narration: "説明", owns: [1, 2], refs: [] };
  if (risks !== undefined) step.risks = risks;
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({ title: "題名", steps: [step] }));
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

test("気をつける点を持つステップを開くと、見出しと箇条書きが出る", () => {
  const { viewer, createdElements, elementsById } = makeViewer();
  viewer.setStory(makeStory(["`status` だけ見ていて参照中の注文を見ていない", "元に戻す手段が無い"]));
  viewer.render();
  assert.strictEqual(elementsById.stepRisks.style.display, "block");
  assert.strictEqual(findByClass(createdElements, "step-risks-head")[0].textContent, "このコマで気をつける点");
  const listHtml = findByClass(createdElements, "md-list").map((element) => element.innerHTML).join("");
  assert.ok(listHtml.includes("<li>元に戻す手段が無い</li>"));
});

test("気をつける点を持たないステップでは、枠ごと出ない", () => {
  const { viewer, createdElements, elementsById } = makeViewer();
  viewer.setStory(makeStory(undefined));
  viewer.render();
  assert.strictEqual(elementsById.stepRisks.style.display, "none");
  assert.strictEqual(findByClass(createdElements, "step-risks-head").length, 0);
  assert.strictEqual(elementsById.stepTitle.textContent, "ステップ1");
});

test("気をつける点が空だけなら、枠を出さない", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory([" ", ""]));
  viewer.render();
  assert.strictEqual(elementsById.stepRisks.style.display, "none");
});

test("気をつける点を持たないステップへ進むと、前のコマの枠は消える", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory(["元に戻す手段が無い"]));
  viewer.render();
  assert.strictEqual(elementsById.stepRisks.style.display, "block");
  viewer.goToStep(1);
  assert.strictEqual(elementsById.stepRisks.style.display, "none");
  assert.strictEqual(elementsById.stepRisks.innerHTML, "");
});

test("気をつける点が配列でなくても、描画が止まらない", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory("箇条書きのつもりの文章"));
  viewer.render();
  assert.strictEqual(elementsById.stepRisks.style.display, "none");
  assert.strictEqual(elementsById.stepTitle.textContent, "ステップ1");
});

test("気をつける点は説明文と別の枠で、差分より前に置かれている", () => {
  assert.ok(VIEWER_HTML.indexOf("id='stepRisks'") < VIEWER_HTML.indexOf("id='diff'"));
  assert.ok(VIEWER_HTML.indexOf("id='narration'") < VIEWER_HTML.indexOf("id='stepRisks'"));
});

test("気をつける点が後から足されたら、定期取得の指紋が変わる", () => {
  const { viewer } = makeViewer();
  viewer.setStory(makeStory(undefined));
  const before = viewer.fingerprint();
  viewer.setStory(makeStory(["元に戻す手段が無い"]));
  assert.notStrictEqual(viewer.fingerprint(), before);
});

test("気をつける点は story.json にそのまま渡り、無ければ項目ごと無い", (t) => {
  const targetDir = makeTempDir("storiff-step-risks-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, undefined);
  assert.strictEqual("risks" in buildStory(targetDir).steps[0], false);

  writeSteps(targetDir, ["元に戻す手段が無い"]);
  assert.deepStrictEqual(buildStory(targetDir).steps[0].risks, ["元に戻す手段が無い"]);
});

test("気をつける点が無いときの check は、ok の文言だけを出し参考を足さない", (t) => {
  const targetDir = makeTempDir("storiff-step-risks-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, undefined);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output, "ok: 全2件の変更IDがちょうど1回ずつ owns に入っています\n");
});

test("気をつける点が埋まっていれば、check は参考を出さない", (t) => {
  const targetDir = makeTempDir("storiff-step-risks-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, ["元に戻す手段が無い"]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output.includes("参考 気をつける点の作り"), false);
});

test("気をつける点が配列でないとき、check は形が違うと参考に出すが ng にしない", (t) => {
  const targetDir = makeTempDir("storiff-step-risks-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, "箇条書きのつもりの文章");
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("step1 risks が配列になっていません"));
});

test("気をつける点が空だけのとき、check は消すよう参考に出す", (t) => {
  const targetDir = makeTempDir("storiff-step-risks-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, [" "]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("step1 risks が空だけです"));
});

test("buildStepRisksIssues は order が無いステップを上からの番号で指す", () => {
  const issues = buildStepRisksIssues([{ title: "1つ目" }, { title: "2つ目", risks: "文章" }]);
  assert.deepStrictEqual(issues, ["step2 risks が配列になっていません"]);
});

test("追従で steps.json を書き戻しても、気をつける点が消えない", (t) => {
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
    title: "題名",
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [], risks: ["元に戻す手段が無い"] }],
  }));

  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\nnewLine\n");
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const followedSteps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  assert.deepStrictEqual(followedSteps.steps[0].risks, ["元に戻す手段が無い"]);
  assert.ok(followedSteps.steps.some((step) => step.title === "修正1回目"));
  assert.strictEqual(followedSteps.steps.some((step) => step.title === "修正1回目" && step.risks != null), false);
});

test("fill のプロンプトは短く書くよう頼み、なぜを残す指示を落とさない", () => {
  const prompt = buildFillPrompt("/tmp/storiff-dir", { title: "題", owns: [1] }, 1, 3, "[1] +行");
  assert.ok(prompt.includes("150文字以内"));
  assert.strictEqual(prompt.includes("300文字"), false);
  assert.ok(prompt.includes("なぜそうしたか"));
  assert.ok(prompt.includes("材料から読み取れないことは書かない"));
});
