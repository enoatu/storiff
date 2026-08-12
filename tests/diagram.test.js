const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseDiagram, buildDiagramValidation, remapSteps, buildValidation, VIEWER_SCRIPT } = require("../storiff.js");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeFile(repo, file, lines) {
  return { repo, file, status: "modified", lines };
}

function makeLine(kind, text, id) {
  return { kind, old: null, new: null, text, id };
}

// ビューアに埋め込まれた図の描画部分だけを取り出して動かす
function loadViewerDiagram() {
  const start = VIEWER_SCRIPT.indexOf("var DIAGRAM_NODE_HEIGHT");
  const end = VIEWER_SCRIPT.indexOf("var minimapBuiltSignature");
  assert.ok(start !== -1 && end > start, "ビューアから図の描画部分を取り出せませんでした");
  const source = VIEWER_SCRIPT.slice(start, end) + "\nreturn {parseDiagram:parseDiagram, buildDiagramSvg:buildDiagramSvg, renderDiagram:renderDiagram};";
  return new Function("esc", source)((text) => String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;"));
}

// ビューアの描画先の代わり。style と innerHTML だけ持つ
function makeFakeContainer() {
  return { style: {}, innerHTML: "" };
}

function runCheck(targetDir) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "check", targetDir], { encoding: "utf8" });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status, stdout: error.stdout };
  }
}

function writeCheckTarget(targetDir, steps) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "line1", id: 1 }] }],
    change_ids: [1],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({ steps }));
}

test("flowchart のノードと矢印を読み取る", () => {
  const diagram = parseDiagram("flowchart LR\n  prep[差分を解析] --> skill(ストーリーにする)\n  skill --> serve{配信する}");
  assert.strictEqual(diagram.direction, "LR");
  assert.deepStrictEqual(diagram.nodes.map((node) => node.id), ["prep", "skill", "serve"]);
  assert.deepStrictEqual(diagram.nodes.map((node) => node.shape), ["box", "round", "diamond"]);
  assert.deepStrictEqual(diagram.edges, [
    { from: "prep", to: "skill", label: "" },
    { from: "skill", to: "serve", label: "" },
  ]);
});

test("矢印に付けたラベルを読み取る", () => {
  const diagram = parseDiagram("flowchart LR\n  prep --> |changes.json| skill");
  assert.deepStrictEqual(diagram.edges, [{ from: "prep", to: "skill", label: "changes.json" }]);
});

test("矢印をつなげて書いた1行から、矢印が2本できる", () => {
  const diagram = parseDiagram("flowchart TD\n  a --> b --> c");
  assert.deepStrictEqual(diagram.edges, [
    { from: "a", to: "b", label: "" },
    { from: "b", to: "c", label: "" },
  ]);
});

test("空行と %% のコメント行は読み飛ばされる", () => {
  const diagram = parseDiagram("flowchart TD\n\n%% ここは説明\n  a --> b\n");
  assert.strictEqual(diagram.nodes.length, 2);
  assert.deepStrictEqual(diagram.unreadableLines, []);
});

test("同じノードIDに違うラベルを付けると重複として拾う", () => {
  const diagram = parseDiagram("flowchart TD\n  api[サーバ]\n  api[通信] --> db[保存先]");
  assert.deepStrictEqual(diagram.duplicatedNodeIds, ["api"]);
});

test("同じノードIDに同じラベルを付け直しても重複にはならない", () => {
  const diagram = parseDiagram("flowchart TD\n  api[サーバ] --> db[保存先]\n  api[サーバ] --> cache[控え]");
  assert.deepStrictEqual(diagram.duplicatedNodeIds, []);
});

test("違うノードIDに同じラベルを付けると重複として拾う", () => {
  const diagram = parseDiagram("flowchart TD\n  first[保存する] --> second[保存する]");
  assert.deepStrictEqual(diagram.duplicatedNodeLabels, ["保存する"]);
});

test("graph の書き出しが古い書き方として拾われる", () => {
  const diagram = parseDiagram("graph TD\n  a --> b");
  assert.deepStrictEqual(diagram.oldSyntaxLines, ["graph TD"]);
  assert.strictEqual(diagram.nodes.length, 2);
});

test("矢印を -> や -->> と書くと古い書き方として拾われる", () => {
  assert.deepStrictEqual(parseDiagram("flowchart TD\n  a -> b").oldSyntaxLines, ["a -> b"]);
  assert.deepStrictEqual(parseDiagram("flowchart TD\n  a -->> b").oldSyntaxLines, ["a -->> b"]);
});

test("ノードや矢印のラベルに入れた -> や => は古い書き方にしない", () => {
  const nodeLabelDiagram = parseDiagram("flowchart LR\n  a[x -> y] --> b");
  assert.deepStrictEqual(nodeLabelDiagram.oldSyntaxLines, []);
  assert.deepStrictEqual(nodeLabelDiagram.nodes.map((node) => node.label), ["x -> y", "b"]);

  const arrowLabelDiagram = parseDiagram("flowchart LR\n  a -->|map(x => y)| b");
  assert.deepStrictEqual(arrowLabelDiagram.oldSyntaxLines, []);
  assert.deepStrictEqual(arrowLabelDiagram.edges, [{ from: "a", to: "b", label: "map(x => y)" }]);
});

test("subgraph や style は読めない行になる", () => {
  const diagram = parseDiagram("flowchart TD\n  subgraph 内側\n  a[X]\n  end\n  style a fill:#fff");
  assert.deepStrictEqual(diagram.unreadableLines, ["subgraph 内側", "end", "style a fill:#fff"]);
  assert.deepStrictEqual(diagram.nodes.map((node) => node.id), ["a"]);
});

test("flowchart 以外の書き出しは読み取らず、ノードが空になる", () => {
  const diagram = parseDiagram("sequenceDiagram\n  A->>B: こんにちは");
  assert.deepStrictEqual(diagram.nodes, []);
  assert.deepStrictEqual(diagram.unreadableLines, ["sequenceDiagram"]);
});

test("diagram を持たないステップは検算の対象にならない", () => {
  const validation = buildDiagramValidation([
    { order: 1, title: "図なし", owns: [1] },
    { order: 2, title: "空文字", owns: [2], diagram: "  " },
  ]);
  assert.deepStrictEqual(validation.problems, []);
  assert.deepStrictEqual(validation.oversizedDiagramSteps, []);
});

test("読めない行と古い書き方と重複が、まとめて problems に入る", () => {
  const validation = buildDiagramValidation([
    { order: 3, title: "壊れた図", diagram: "graph TD\n  a[X]\n  a[Y]\n  b[Y]\n  subgraph 内側" },
  ]);
  assert.deepStrictEqual(validation.problems, [
    "step3 読めない行 「subgraph 内側」",
    "step3 古い書き方 「graph TD」",
    "step3 同じノードIDに違うラベルが付いている a",
    "step3 違うノードIDに同じラベルが付いている Y",
  ]);
});

test("書き出しの行しかない図は、ノードが1つも無いとして problems に入る", () => {
  const validation = buildDiagramValidation([{ order: 1, title: "中身なし", diagram: "flowchart TD" }]);
  assert.deepStrictEqual(validation.problems, ["step1 ノードが1つも無い。図を出さないなら diagram ごと消す"]);
});

test("読めない行のせいでノードが無い図は、読めない行だけを problems に入れる", () => {
  const validation = buildDiagramValidation([{ order: 2, title: "別の図", diagram: "sequenceDiagram\n  A->>B: こんにちは" }]);
  assert.deepStrictEqual(validation.problems, ["step2 読めない行 「sequenceDiagram」"]);
});

test("check は書き出しの行しかない図をngにする", (t) => {
  const targetDir = makeTempDir("storiff-diagram-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeCheckTarget(targetDir, [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [], diagram: "flowchart TD" }]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 1);
  assert.match(result.stdout, /step1 ノードが1つも無い/);
});

test("ノード数が目安を超える図は oversizedDiagramSteps に入り、problems には入らない", () => {
  const nodeLines = [];
  for (let number = 1; number <= 10; number++) nodeLines.push("  n" + number + "[処理" + number + "]");
  const validation = buildDiagramValidation([{ order: 1, title: "大きい図", diagram: "flowchart TD\n" + nodeLines.join("\n") }]);
  assert.deepStrictEqual(validation.problems, []);
  assert.deepStrictEqual(validation.oversizedDiagramSteps, ["step1 大きい図 (10ノード)"]);
});

test("check は図が壊れているとng、直すとokになる", (t) => {
  const targetDir = makeTempDir("storiff-diagram-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeCheckTarget(targetDir, [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [], diagram: "flowchart TD\n  a[X]\n  a[Y]" }]);
  const ngResult = runCheck(targetDir);
  assert.strictEqual(ngResult.exitCode, 1);
  assert.match(ngResult.stdout, /step1 同じノードIDに違うラベルが付いている a/);

  writeCheckTarget(targetDir, [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [], diagram: "flowchart TD\n  a[X] --> b[Y]" }]);
  const okResult = runCheck(targetDir);
  assert.strictEqual(okResult.exitCode, 0);
  assert.match(okResult.stdout, /^ok: /);
});

test("check は diagram が無くても今まで通りokになる", (t) => {
  const targetDir = makeTempDir("storiff-diagram-");
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeCheckTarget(targetDir, [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [] }]);
  const result = runCheck(targetDir);
  assert.strictEqual(result.exitCode, 0);
  assert.match(result.stdout, /^ok: /);
});

test("追従でステップを書き換えても diagram が残る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: ["F1"], refs: [], diagram: "flowchart LR\n  a --> b" }];
  const idMap = new Map([[1, 10], [2, 11]]);
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.deepStrictEqual(remapped[0].owns, ["10-11"]);
  assert.strictEqual(remapped[0].diagram, "flowchart LR\n  a --> b");
});

test("配信するステップに diagram がそのまま残る", () => {
  const files = [makeFile(".", "a.js", [makeLine("add", "x", 1)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: [1], refs: [], diagram: "flowchart LR\n  a --> b" }];
  const validation = buildValidation([1], files, steps);
  assert.strictEqual(validation.ok, true);
  assert.strictEqual(validation.resolvedSteps[0].diagram, "flowchart LR\n  a --> b");
});

test("ビューアには storiff.js と同じ parseDiagram がそのまま埋め込まれている", () => {
  assert.ok(VIEWER_SCRIPT.includes("function parseDiagram(source)"), "ビューアに parseDiagram が埋め込まれていません");
  assert.ok(VIEWER_SCRIPT.includes(parseDiagram.toString()), "ビューアの parseDiagram が storiff.js の実装と違います");
});

test("ビューアのスクリプト全体が構文として読める", () => {
  assert.doesNotThrow(() => new Function(VIEWER_SCRIPT));
});

test("ビューアが図をSVGに描き、ラベルをエスケープする", () => {
  const viewer = loadViewerDiagram();
  const svg = viewer.buildDiagramSvg(viewer.parseDiagram("flowchart LR\n  a[<script>] -->|渡す| b[受け取る]"));
  assert.match(svg, /^<svg class="dg-svg" width="\d/);
  assert.ok(svg.includes("&lt;script&gt;") === false && svg.includes("&lt;script>"), "ラベルがエスケープされていません");
  assert.ok(svg.includes("渡す"), "矢印のラベルが描かれていません");
  assert.strictEqual((svg.match(/class="dg-node"/g) || []).length, 2);
  assert.strictEqual((svg.match(/class="dg-edge"/g) || []).length, 1);
});

test("ビューアは図の向きで座標の伸びる向きを変える", () => {
  const viewer = loadViewerDiagram();
  const horizontal = viewer.parseDiagram("flowchart LR\n  a --> b");
  viewer.buildDiagramSvg(horizontal);
  assert.ok(horizontal.nodes[1].x > horizontal.nodes[0].x, "横向きなのに右に伸びていません");
  assert.strictEqual(horizontal.nodes[0].y, horizontal.nodes[1].y);

  const vertical = viewer.parseDiagram("flowchart TD\n  a --> b");
  viewer.buildDiagramSvg(vertical);
  assert.ok(vertical.nodes[1].y > vertical.nodes[0].y, "縦向きなのに下に伸びていません");
  assert.strictEqual(vertical.nodes[0].x, vertical.nodes[1].x);
});

test("ビューアは矢印がぐるっと回っていても描き終わる", () => {
  const viewer = loadViewerDiagram();
  const svg = viewer.buildDiagramSvg(viewer.parseDiagram("flowchart LR\n  a --> b --> c --> a"));
  assert.strictEqual((svg.match(/class="dg-node"/g) || []).length, 3);
  assert.strictEqual((svg.match(/class="dg-edge"/g) || []).length, 3);
});

test("ビューアは読めない図でも例外を投げず、図の枠を出さない", () => {
  const viewer = loadViewerDiagram();
  const container = makeFakeContainer();
  viewer.renderDiagram(container, "sequenceDiagram\n  A->>B: こんにちは");
  assert.strictEqual(container.style.display, "none");
  assert.strictEqual(container.innerHTML, "");
});

test("ビューアは diagram が無いステップで図の枠を出さない", () => {
  const viewer = loadViewerDiagram();
  const container = makeFakeContainer();
  viewer.renderDiagram(container, null);
  assert.strictEqual(container.style.display, "none");
  assert.strictEqual(container.innerHTML, "");
});

test("ビューアは図の描画で例外が出たらブラウザのコンソールに残す", () => {
  const viewer = loadViewerDiagram();
  let assignCount = 0;
  const container = {
    style: {},
    set innerHTML(value) {
      assignCount += 1;
      if (assignCount === 2) throw new Error("描画に失敗しました");
    },
    get innerHTML() {
      return "";
    },
  };
  const originalConsoleError = console.error;
  const shownErrors = [];
  console.error = (error) => shownErrors.push(error);
  try {
    viewer.renderDiagram(container, "flowchart LR\n  a[X] --> b[Y]");
  } finally {
    console.error = originalConsoleError;
  }
  assert.strictEqual(shownErrors.length, 1);
  assert.match(String(shownErrors[0].message), /描画に失敗しました/);
});

test("ビューアは読める図で図の枠を出す", () => {
  const viewer = loadViewerDiagram();
  const container = makeFakeContainer();
  viewer.renderDiagram(container, "flowchart LR\n  a[X] --> b[Y]");
  assert.strictEqual(container.style.display, "block");
  assert.match(container.innerHTML, /^<svg /);
});
