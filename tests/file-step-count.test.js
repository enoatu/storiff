const { test } = require("node:test");
const assert = require("node:assert");
const { VIEWER_HTML } = require("../storiff.js");

// ブラウザの代わりになる最小限の作りもの。要素は作った順に createdElements へ残す
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
    + " fileStepCountLabel:fileStepCountLabel};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(documentStub, windowStub, fetchStub, () => {}, () => null, () => {}, undefined);
  return { viewer, createdElements, elementsById };
}

function makeLine(text, id) {
  return { kind: "add", old: null, new: null, text, id };
}

function findByClass(createdElements, className) {
  return createdElements.filter((element) => element.className === className);
}

test("2コマにまたがるファイルには、見出しに何コマ目かが出る", () => {
  const { viewer, createdElements } = makeViewer();
  const story = {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] }],
    change_ids: [1, 2],
    steps: [
      { order: 1, title: "1つ目", narration: "説明", owns: [1], refs: [] },
      { order: 2, title: "2つ目", narration: "説明", owns: [2], refs: [] },
    ],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  viewer.setStory(story);
  viewer.render();
  assert.deepStrictEqual(findByClass(createdElements, "file-count").map((element) => element.textContent), ["1/2"]);

  const beforeNextIndex = createdElements.length;
  viewer.goToStep(1);
  assert.deepStrictEqual(findByClass(createdElements.slice(beforeNextIndex), "file-count").map((element) => element.textContent), ["2/2"]);
});

test("1コマにしか出ないファイルには、何コマ目かを出さない", () => {
  const { viewer, createdElements } = makeViewer();
  const story = {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1)] }],
    change_ids: [1],
    steps: [{ order: 1, title: "1つ目", narration: "説明", owns: [1], refs: [] }],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  viewer.setStory(story);
  viewer.render();
  assert.strictEqual(findByClass(createdElements, "file-count").length, 0);
});

test("refs にしか入っていないコマは、出現回数に数えない", () => {
  const { viewer } = makeViewer();
  const story = {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] }],
    change_ids: [1, 2],
    steps: [
      { order: 1, title: "1つ目", narration: "説明", owns: [1], refs: [] },
      { order: 2, title: "2つ目", narration: "説明", owns: [], refs: [1] },
    ],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  viewer.setStory(story);
  assert.strictEqual(viewer.fileStepCountLabel(story.files[0], 1), null);
});

test("並び順は order の昇順で数え、steps配列の並びには従わない", () => {
  const { viewer } = makeViewer();
  const story = {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2), makeLine("z", 3)] }],
    change_ids: [1, 2, 3],
    steps: [
      { order: 3, title: "3番目", narration: "説明", owns: [3], refs: [] },
      { order: 1, title: "1番目", narration: "説明", owns: [1], refs: [] },
      { order: 2, title: "2番目", narration: "説明", owns: [2], refs: [] },
    ],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  viewer.setStory(story);
  assert.strictEqual(viewer.fileStepCountLabel(story.files[0], 1), "1/3");
  assert.strictEqual(viewer.fileStepCountLabel(story.files[0], 2), "2/3");
  assert.strictEqual(viewer.fileStepCountLabel(story.files[0], 3), "3/3");
});

test("同じパスでも repo が違えば別ファイルとして数える", () => {
  const { viewer } = makeViewer();
  const story = {
    title: "題名",
    files: [
      { repo: "repoA", file: "a.js", status: "modified", lines: [makeLine("x", 1), makeLine("y", 2)] },
      { repo: "repoB", file: "a.js", status: "modified", lines: [makeLine("x", 3)] },
    ],
    change_ids: [1, 2, 3],
    steps: [
      { order: 1, title: "1つ目", narration: "説明", owns: [1, 3], refs: [] },
      { order: 2, title: "2つ目", narration: "説明", owns: [2], refs: [] },
    ],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
  viewer.setStory(story);
  assert.strictEqual(viewer.fileStepCountLabel(story.files[0], 1), "1/2");
  assert.strictEqual(viewer.fileStepCountLabel(story.files[1], 1), null);
});
