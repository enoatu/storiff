const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { VIEWER_HTML, buildStory, runPrep } = require("../storiff.js");

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
  const exposeCode = "\nreturn {setStory:function(data){story=data; stepIndex=0;}, render:render, goToStep:goToStep};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(documentStub, windowStub, fetchStub, () => {}, () => null, () => {}, undefined);
  return { viewer, createdElements, elementsById };
}

function makeStory(overview) {
  const story = {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
    steps: [
      { order: 1, title: "ステップ1", narration: "説明", owns: [1], refs: [] },
      { order: 2, title: "ステップ2", narration: "説明", owns: [], refs: [] },
    ],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  if (overview) story.overview = overview;
  return story;
}

function makeOverview() {
  return {
    summary: "ユーザー取得の安全性を上げ、削除できるようにした",
    key_changes: ["null を弾く分岐を足した", "deleteUser を追加した"],
    risks: ["削除は元に戻せない"],
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

function writeSteps(targetDir, overview) {
  const steps = { title: "題名", steps: [{ order: 1, title: "1つ目", narration: "説明", owns: [1, 2], refs: [] }] };
  if (overview) steps.overview = overview;
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify(steps));
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

test("全体像を持たないストーリーは今まで通り描画でき、全体像の枠は出ない", () => {
  const { viewer, createdElements, elementsById } = makeViewer();
  viewer.setStory(makeStory(null));
  viewer.render();
  assert.strictEqual(elementsById.overview.style.display, "none");
  assert.strictEqual(findByClass(createdElements, "overview-head").length, 0);
  assert.strictEqual(elementsById.stepTitle.textContent, "ステップ1");
});

test("全体像があると、最初のステップで要約と主な変更と気をつける点が出る", () => {
  const { viewer, createdElements, elementsById } = makeViewer();
  viewer.setStory(makeStory(makeOverview()));
  viewer.render();
  assert.strictEqual(elementsById.overview.style.display, "block");
  assert.strictEqual(findByClass(createdElements, "overview-head")[0].textContent, "全体像");
  const labels = findByClass(createdElements, "overview-label").map((element) => element.textContent);
  assert.deepStrictEqual(labels, ["主な変更", "気をつける点"]);
  const bodyHtml = findByClass(createdElements, "md-line").map((element) => element.innerHTML).join("");
  assert.ok(bodyHtml.includes("ユーザー取得の安全性を上げ、削除できるようにした"));
  const listHtml = findByClass(createdElements, "md-list").map((element) => element.innerHTML).join("");
  assert.ok(listHtml.includes("<li>deleteUser を追加した</li>"));
  assert.ok(listHtml.includes("<li>削除は元に戻せない</li>"));
});

test("2つ目のステップへ進むと、全体像は出ない", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory(makeOverview()));
  viewer.render();
  viewer.goToStep(1);
  assert.strictEqual(elementsById.overview.style.display, "none");
});

test("全体像はあっても中身が空だけなら、枠を出さない", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory({ summary: "", key_changes: [" "], risks: [] }));
  viewer.render();
  assert.strictEqual(elementsById.overview.style.display, "none");
});

test("全体像は story.json に渡り、無ければ null になる", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, null);
  assert.strictEqual(buildStory(targetDir).overview, null);

  writeSteps(targetDir, makeOverview());
  assert.deepStrictEqual(buildStory(targetDir).overview, makeOverview());
});

test("全体像が無いときの check は、ok の文言だけを出し参考を足さない", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, null);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output, "ok: 全2件の変更IDがちょうど1回ずつ owns に入っています\n");
});

test("要約が空で箇条書きが0件のとき、check は参考に理由を並べるが ng にしない", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, { summary: "  ", key_changes: [], risks: ["削除は元に戻せない"] });
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("summary が空です"));
  assert.ok(result.output.includes("key_changes が0件です"));
  assert.strictEqual(result.output.includes("risks が0件です"), false);
});

test("全体像が埋まっていれば、check は参考を出さない", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, makeOverview());
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.output.includes("参考 全体像の作り"), false);
});

test("箇条書きが配列でないとき、check は形が違うと参考に出す", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, { summary: "要約", key_changes: "一覧のつもり", risks: ["削除は元に戻せない"] });
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("key_changes が配列になっていません"));
  assert.strictEqual(result.output.includes("key_changes が0件です"), false);
});

test("全体像が文字列で来たとき、check は形が違うと参考に出す", (t) => {
  const targetDir = makeTempDir("storiff-overview-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeChanges(targetDir);
  writeSteps(targetDir, "全体像のつもりの文章");
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.output.includes("overview が summary と key_changes と risks を持つ形になっていません"));
});

test("全体像の箇条書きが配列でなくても、描画が止まらない", () => {
  const { viewer, elementsById } = makeViewer();
  viewer.setStory(makeStory({ summary: "要約", key_changes: "一覧のつもり", risks: null }));
  viewer.render();
  assert.strictEqual(elementsById.overview.style.display, "block");
  assert.strictEqual(elementsById.stepTitle.textContent, "ステップ1");
});

test("追従で steps.json を書き戻しても、全体像が消えない", (t) => {
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
    overview: makeOverview(),
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\nnewLine\n");
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const followedSteps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  assert.deepStrictEqual(followedSteps.overview, makeOverview());
  assert.strictEqual(followedSteps.title, "題名");
  assert.ok(followedSteps.steps.some((step) => step.title === "修正1回目"));
});
