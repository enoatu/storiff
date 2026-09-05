const { test } = require("node:test");
const assert = require("node:assert");
const { VIEWER_HTML } = require("../storiff.js");

// ブラウザの代わりになる最小限の作りもの。story.json の取得と3秒ごとの取り直しを手で動かせるようにする
function makeViewer(initialStory) {
  const createdElements = [];
  const elementsById = {};
  const makeElement = () => {
    let writtenText = "";
    const element = {
      className: "", innerHTML: "", disabled: false, dataset: {}, style: {}, onclick: null,
      appendChild() {}, insertBefore() {}, removeChild() {}, addEventListener() {},
      querySelector() { return null; },
      // 本文のエスケープが textContent に入れて innerHTML で読み出す作りなので、そこだけ本物に寄せる
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
    // コメント記入中は再描画を止める作りなので、記入欄は無いものとして答える
    querySelector(selector) { return selector === ".comment-form" ? null : makeElement(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const windowStub = { innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollTo() {}, addEventListener() {} };
  let servedStory = initialStory;
  const fetchStub = () => ({
    then(onResponse) {
      const parsedStory = onResponse({ json: () => JSON.parse(JSON.stringify(servedStory)) });
      return { then(onStory) { onStory(parsedStory); } };
    },
  });
  const pollCallbacks = [];
  const scriptText = VIEWER_HTML.slice(VIEWER_HTML.lastIndexOf("<script>") + "<script>".length, VIEWER_HTML.lastIndexOf("</script>"));
  const exposeCode = "\nreturn {setStory:function(data){story=data; stepIndex=0;}, render:render,"
    + " storyFingerprint:storyFingerprint, minimapFingerprint:minimapFingerprint};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(documentStub, windowStub, fetchStub, (callback) => pollCallbacks.push(callback), () => null, () => {}, undefined);
  return {
    viewer, createdElements, elementsById,
    serveStory(story) { servedStory = story; },
    poll() { pollCallbacks.forEach((callback) => callback()); },
  };
}

function makeStory(steps) {
  return {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
    steps,
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments: [],
  };
}

function makeStep(order, title, narration) {
  return { order, title, narration, owns: [1], refs: [] };
}

function withOverview(story, overview) {
  story.overview = overview;
  return story;
}

// 簡易 markdown が書き出した本文の行を、書かれた順に取り出す
function narrationLines(createdElements, fromIndex) {
  return createdElements.slice(fromIndex || 0).filter((element) => element.className === "md-line").map((element) => element.innerHTML);
}

function fingerprintOf(viewer, story) {
  viewer.setStory(story);
  return viewer.storyFingerprint(viewer.minimapFingerprint());
}

test("説明文がまだ空のステップでは、書いている途中だと分かる文が出る", () => {
  const { createdElements, elementsById } = makeViewer(makeStory([makeStep(1, "仮の題", "")]));
  assert.strictEqual(elementsById.narration.className, "narration pending");
  assert.ok(narrationLines(createdElements).some((html) => html.includes("説明文をいま書いています")));
});

test("説明文が入っているステップでは、書いている途中だと分かる文は出ない", () => {
  const { createdElements, elementsById } = makeViewer(makeStory([makeStep(1, "仮の題", "入口で null を弾くようにした")]));
  assert.strictEqual(elementsById.narration.className, "narration");
  assert.ok(narrationLines(createdElements).some((html) => html.includes("入口で null を弾く")));
  assert.ok(!narrationLines(createdElements).some((html) => html.includes("説明文をいま書いています")));
});

test("左の一覧では、説明文が空のステップにだけ準備中と出る", () => {
  const { createdElements } = makeViewer(makeStory([makeStep(1, "書けた題", "書けた説明"), makeStep(2, "仮の題", "")]));
  const pendingLabels = createdElements.filter((element) => element.className === "step-pending");
  assert.strictEqual(pendingLabels.length, 1);
  assert.strictEqual(pendingLabels[0].textContent, "準備中");
});

test("説明文が埋まると、取り直しで準備中の表示が消える", () => {
  const viewerParts = makeViewer(makeStory([makeStep(1, "仮の題", "")]));
  assert.strictEqual(viewerParts.elementsById.narration.className, "narration pending");
  const beforePollIndex = viewerParts.createdElements.length;
  viewerParts.serveStory(makeStory([makeStep(1, "仮の題", "入口で null を弾くようにした")]));
  viewerParts.poll();
  assert.strictEqual(viewerParts.elementsById.narration.className, "narration");
  const linesAfterPoll = narrationLines(viewerParts.createdElements, beforePollIndex);
  assert.ok(linesAfterPoll.some((html) => html.includes("入口で null を弾く")));
  assert.ok(!linesAfterPoll.some((html) => html.includes("説明文をいま書いています")));
  assert.strictEqual(viewerParts.createdElements.slice(beforePollIndex).filter((element) => element.className === "step-pending").length, 0);
});

test("追従で増えたステップは、説明文が空でも準備中と出ない", () => {
  const { createdElements } = makeViewer(makeStory([
    makeStep(1, "修正1回目", ""),
    makeStep(2, "仮の題", ""),
  ]));
  const pendingLabels = createdElements.filter((element) => element.className === "step-pending");
  assert.strictEqual(pendingLabels.length, 1);
});

test("追従で増えたコマでは、説明文を書いている途中だとは出ない", () => {
  const { createdElements, elementsById } = makeViewer(makeStory([makeStep(1, "修正1回目", "")]));
  assert.strictEqual(elementsById.narration.className, "narration");
  assert.ok(!narrationLines(createdElements).some((html) => html.includes("説明文をいま書いています")));
});

test("全体像の箇条書きが配列でなくても、取り直しで画面が更新され続ける", () => {
  const brokenOverview = { summary: "要約", key_changes: "一覧のつもり", risks: "気をつける点のつもり" };
  const viewerParts = makeViewer(withOverview(makeStory([makeStep(1, "1つ目", "説明")]), brokenOverview));
  assert.strictEqual(viewerParts.elementsById.stepTitle.textContent, "1つ目");

  const beforePollIndex = viewerParts.createdElements.length;
  viewerParts.serveStory(withOverview(makeStory([makeStep(1, "書き換えた題", "書き換えた説明")]), brokenOverview));
  viewerParts.poll();
  assert.strictEqual(viewerParts.elementsById.stepTitle.textContent, "書き換えた題");
  assert.strictEqual(viewerParts.createdElements.slice(beforePollIndex).filter((element) => element.className === "file").length, 1);
});

test("指紋は説明文が埋まったことを拾う", () => {
  const { viewer } = makeViewer(makeStory([makeStep(1, "仮の題", "")]));
  const emptyFingerprint = fingerprintOf(viewer, makeStory([makeStep(1, "仮の題", "")]));
  const filledFingerprint = fingerprintOf(viewer, makeStory([makeStep(1, "仮の題", "入口で null を弾くようにした")]));
  assert.notStrictEqual(emptyFingerprint, filledFingerprint);
});

test("指紋は題が書き換わったことを拾う", () => {
  const { viewer } = makeViewer(makeStory([makeStep(1, "仮の題", "")]));
  const draftFingerprint = fingerprintOf(viewer, makeStory([makeStep(1, "仮の題", "説明")]));
  const rewrittenFingerprint = fingerprintOf(viewer, makeStory([makeStep(1, "入口で null を弾く", "説明")]));
  assert.notStrictEqual(draftFingerprint, rewrittenFingerprint);
});
