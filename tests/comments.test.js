const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { VIEWER_HTML, commentScope, appendComment, appendReply, setCommentResolved, remapComments, buildAskPrompt, buildStory } = require("../storiff.js");

function makeTempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "storiff-comments-")));
}

function readComments(targetDir) {
  return JSON.parse(fs.readFileSync(path.join(targetDir, "comments.json"), "utf8"));
}

function writeComments(targetDir, comments) {
  fs.writeFileSync(path.join(targetDir, "comments.json"), JSON.stringify(comments, null, 2));
}

function writeMinimalStory(targetDir) {
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify({
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [
      { kind: "add", old: null, new: 1, text: "1コマ目の行", id: 1 },
      { kind: "add", old: null, new: 2, text: "2コマ目の行", id: 2 },
    ] }],
    change_ids: [1, 2],
  }));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    title: "ストーリーの題",
    steps: [
      { order: 1, title: "1つ目", narration: "まず足す", owns: [1], refs: [] },
      { order: 2, title: "2つ目", narration: "次に足す", owns: [2], refs: [] },
    ],
  }));
}

// ブラウザの代わりになる最小限の作りもの。コメントの送信と解決の切り替えを手で動かせるようにする
function makeViewer(initialStory) {
  const createdElements = [];
  const elementsById = {};
  const makeElement = () => {
    let writtenText = "";
    const element = {
      className: "", innerHTML: "", disabled: false, dataset: {}, style: {}, onclick: null,
      appendChild() {}, insertBefore() {}, removeChild() {}, addEventListener() {}, focus() {}, scrollIntoView() {},
      querySelector() { return null; },
      get parentNode() { return element; },
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
  const sentRequests = [];
  const makeThenable = (value) => ({
    then(onValue) { const next = onValue(value); return { then(onNext) { onNext(next); } }; },
    catch() {},
  });
  const fetchStub = (requestUrl, options) => {
    if (requestUrl === "/story.json") return makeThenable({ json: () => JSON.parse(JSON.stringify(servedStory)) });
    const sentBody = options && options.body ? JSON.parse(options.body) : null;
    sentRequests.push({ url: requestUrl, body: sentBody });
    if (requestUrl !== "/comments") return makeThenable(null);
    return makeThenable({ json: () => Object.assign({ replies: [], at: "2026-08-20T00:00:00Z" }, sentBody) });
  };
  const pollCallbacks = [];
  const scriptText = VIEWER_HTML.slice(VIEWER_HTML.lastIndexOf("<script>") + "<script>".length, VIEWER_HTML.lastIndexOf("</script>"));
  const exposeCode = "\nreturn {setStory:function(data){story=data; stepIndex=0;}, render:render, goToStep:goToStep,"
    + " storyFingerprint:storyFingerprint, minimapFingerprint:minimapFingerprint};";
  const viewer = new Function("document", "window", "fetch", "setInterval", "setTimeout", "clearTimeout", "hljs", scriptText + exposeCode)(documentStub, windowStub, fetchStub, (callback) => pollCallbacks.push(callback), () => null, () => {}, undefined);
  return {
    viewer, createdElements, elementsById, sentRequests,
    serveStory(story) { servedStory = story; },
    poll() { pollCallbacks.forEach((callback) => callback()); },
  };
}

function makeStory(comments) {
  return {
    title: "題名",
    files: [{ repo: ".", file: "a.js", status: "modified", lines: [{ kind: "add", old: null, new: 1, text: "x", id: 1 }] }],
    change_ids: [1],
    steps: [{ order: 1, title: "1つ目", narration: "説明", owns: [1], refs: [] }],
    validation: { ok: true, missing: [], duplicated: [], unknown_files: [] },
    comments,
  };
}

function commentBodies(createdElements, fromIndex) {
  return createdElements.slice(fromIndex || 0).filter((element) => element.className === "comment-body").map((element) => element.textContent);
}

function countClassName(createdElements, className, fromIndex) {
  return createdElements.slice(fromIndex || 0).filter((element) => element.className === className).length;
}

function findResolveButtons(createdElements, fromIndex) {
  return createdElements.slice(fromIndex || 0).filter((element) => element.className === "comment-resolve");
}

function fingerprintOf(viewer, story) {
  viewer.setStory(story);
  return viewer.storyFingerprint(viewer.minimapFingerprint());
}

test("解決済みにすると comments.json に残り、未解決にも戻せる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [{ change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [] }]);
  setCommentResolved(targetDir, 1, true);
  assert.strictEqual(readComments(targetDir)[0].resolved, true);
  setCommentResolved(targetDir, 1, false);
  assert.strictEqual(readComments(targetDir)[0].resolved, false);
});

test("範囲の外のコメント番号を指すと解決の切り替えは断られる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [{ change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [] }]);
  assert.throws(() => setCommentResolved(targetDir, 2, true), /コメント番号が範囲外です/);
});

test("返信が付くと解決済みのコメントは未解決に戻る", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [{ change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [], resolved: true }]);
  appendReply(targetDir, 1, "入口で弾くためです");
  const comment = readComments(targetDir)[0];
  assert.strictEqual(comment.resolved, false);
  assert.strictEqual(comment.replies.length, 1);
});

test("解決済みのまま一言残したいときは、返信しても未解決に戻らない", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [{ change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [], resolved: true }]);
  appendReply(targetDir, 1, "直しました", true);
  const comment = readComments(targetDir)[0];
  assert.strictEqual(comment.resolved, true);
  assert.strictEqual(comment.replies.length, 1);
});

test("reply の番号は範囲が混ざっても comments.json の並び順のまま", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [
    { scope: "story", body: "分け方が違う", replies: [] },
    { scope: "step", step_order: 2, body: "このコマの方針が違う", replies: [] },
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [] },
  ]);
  appendReply(targetDir, 3, "行への返事");
  const comments = readComments(targetDir);
  assert.strictEqual(comments[2].replies[0].body, "行への返事");
  assert.strictEqual(comments[0].replies.length, 0);
});

test("resolved も scope も持たない古いコメントは、未解決の行コメントとして扱われる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  writeComments(targetDir, [{ change_id: 1, file: "a.js", repo: ".", line: 1, step_order: 1, body: "ここなぜ?", replies: [], at: "2026-08-01T00:00:00Z" }]);
  const comment = buildStory(targetDir).comments[0];
  assert.strictEqual(comment.resolved, undefined);
  assert.strictEqual(commentScope(comment), "line");
});

test("知らない範囲の名前が入っていても行コメントとして扱われる", () => {
  assert.strictEqual(commentScope({ scope: "file", body: "x" }), "line");
  assert.strictEqual(commentScope({ scope: "step", body: "x" }), "step");
  assert.strictEqual(commentScope({ scope: "story", body: "x" }), "story");
});

test("追従で行コメントを写すとき、解決の状態と範囲も一緒に写る", () => {
  const idMap = new Map([[1, 5]]);
  const remapped = remapComments([
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "行への指摘", replies: [], resolved: true },
    { scope: "line", change_id: 9, file: "a.js", step_order: 1, body: "消えた行への指摘", replies: [], resolved: false },
  ], idMap);
  assert.strictEqual(remapped[0].change_id, 5);
  assert.strictEqual(remapped[0].resolved, true);
  assert.strictEqual(remapped[0].scope, "line");
  assert.strictEqual(remapped[1].change_id, null);
  assert.strictEqual(remapped[1].resolved, false);
});

test("追従でコマとストーリーへのコメントは change_id を触られない", () => {
  const idMap = new Map([[1, 5]]);
  const remapped = remapComments([
    { scope: "step", step_order: 1, body: "このコマの方針が違う", replies: [], resolved: true },
    { scope: "story", body: "そもそも分け方が違う", replies: [] },
  ], idMap);
  assert.strictEqual("change_id" in remapped[0], false);
  assert.strictEqual(remapped[0].resolved, true);
  assert.strictEqual(remapped[1].scope, "story");
});

test("コマ全体へのコメントには、そのコマの差分だけを渡す", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  const prompt = buildAskPrompt(targetDir, { scope: "step", step_order: 2, body: "このコマの方針が違う" });
  assert.match(prompt, /コマの題 2つ目/);
  assert.match(prompt, /次に足す/);
  assert.match(prompt, /2コマ目の行/);
  assert.doesNotMatch(prompt, /1コマ目の行/);
  assert.match(prompt, /このコマの方針が違う/);
});

test("ストーリー全体へのコメントには、コマの一覧を渡す", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  const prompt = buildAskPrompt(targetDir, { scope: "story", body: "そもそも分け方が違う" });
  assert.match(prompt, /ストーリーの題 ストーリーの題/);
  assert.match(prompt, /1 1つ目/);
  assert.match(prompt, /2 2つ目/);
  assert.doesNotMatch(prompt, /2コマ目の行/);
  assert.match(prompt, /そもそも分け方が違う/);
});

test("解決済みのコメントは既定では出ず、件数がボタンに出る", () => {
  const { createdElements, elementsById } = makeViewer(makeStory([
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "まだ直っていない", replies: [] },
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "もう直した", replies: [], resolved: true },
  ]));
  const bodies = commentBodies(createdElements);
  assert.ok(bodies.includes("まだ直っていない"));
  assert.ok(!bodies.includes("もう直した"));
  assert.strictEqual(elementsById.resolvedBtn.textContent, "解決済み1件を出す");
});

test("解決済みが1件も無ければ、解決のフィルタは出ない", () => {
  const { elementsById } = makeViewer(makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "まだ直っていない", replies: [] }]));
  assert.strictEqual(elementsById.resolvedBtn.style.display, "none");
});

test("フィルタを切り替えると解決済みも出る", () => {
  const viewerParts = makeViewer(makeStory([
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "まだ直っていない", replies: [] },
    { scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "もう直した", replies: [], resolved: true },
  ]));
  const beforeIndex = viewerParts.createdElements.length;
  viewerParts.elementsById.resolvedBtn.onclick();
  const bodies = commentBodies(viewerParts.createdElements, beforeIndex);
  assert.ok(bodies.includes("もう直した"));
  assert.strictEqual(countClassName(viewerParts.createdElements, "comment resolved", beforeIndex), 1);
  assert.strictEqual(viewerParts.elementsById.resolvedBtn.textContent, "解決済みを隠す");
});

test("解決に切り替えると番号と状態が送られ、取り直しでも解決済みのまま隠れる", () => {
  const viewerParts = makeViewer(makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [] }]));
  const resolveButtons = findResolveButtons(viewerParts.createdElements);
  assert.strictEqual(resolveButtons.length, 1);
  assert.strictEqual(resolveButtons[0].textContent, "解決済みにする");

  const beforeIndex = viewerParts.createdElements.length;
  resolveButtons[0].onclick();
  assert.deepStrictEqual(viewerParts.sentRequests, [{ url: "/resolve", body: { comment_number: 1, resolved: true } }]);
  assert.ok(!commentBodies(viewerParts.createdElements, beforeIndex).includes("ここなぜ?"));

  const beforePollIndex = viewerParts.createdElements.length;
  viewerParts.serveStory(makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [], resolved: true }]));
  viewerParts.poll();
  assert.ok(!commentBodies(viewerParts.createdElements, beforePollIndex).includes("ここなぜ?"));
  assert.strictEqual(viewerParts.elementsById.resolvedBtn.textContent, "解決済み1件を出す");
});

test("コマ全体とストーリー全体のコメントは、差分の前の枠に出る", () => {
  const { createdElements } = makeViewer(makeStory([
    { scope: "story", body: "そもそも分け方が違う", replies: [] },
    { scope: "step", step_order: 1, body: "このコマの方針が違う", replies: [] },
  ]));
  assert.strictEqual(countClassName(createdElements, "file scope-comments"), 2);
  const bodies = commentBodies(createdElements);
  assert.deepStrictEqual(bodies, ["そもそも分け方が違う", "このコマの方針が違う"]);
});

test("別のコマへのコメントは、いま見ているコマの枠には出ない", () => {
  const story = makeStory([{ scope: "step", step_order: 1, body: "1コマ目への指摘", replies: [] }]);
  story.steps.push({ order: 2, title: "2つ目", narration: "説明", owns: [], refs: [] });
  const viewerParts = makeViewer(story);
  assert.ok(commentBodies(viewerParts.createdElements).includes("1コマ目への指摘"));
  const beforeIndex = viewerParts.createdElements.length;
  viewerParts.viewer.goToStep(1);
  assert.ok(!commentBodies(viewerParts.createdElements, beforeIndex).includes("1コマ目への指摘"));
});

test("scope を持たない古いコメントは、今までどおり行の下に出る", () => {
  const { createdElements } = makeViewer(makeStory([{ change_id: 1, file: "a.js", repo: ".", line: 1, step_order: 1, body: "古いコメント", replies: [] }]));
  assert.ok(commentBodies(createdElements).includes("古いコメント"));
  assert.strictEqual(countClassName(createdElements, "file-head lost-comments-heading"), 0);
});

test("写せなかった行コメントは、今までどおり無くなった行の枠に出る", () => {
  const { createdElements } = makeViewer(makeStory([{ scope: "line", change_id: null, file: "a.js", step_order: 1, body: "消えた行への指摘", replies: [] }]));
  assert.strictEqual(countClassName(createdElements, "file-head lost-comments-heading"), 1);
  assert.ok(commentBodies(createdElements).includes("消えた行への指摘"));
});

test("1件も無いときは、行に紐づかないコメントの枠を出さない", () => {
  const viewerParts = makeViewer(makeStory([]));
  const scopeAddButtons = viewerParts.createdElements.filter((element) => element.textContent === "コメントを書く");
  assert.strictEqual(scopeAddButtons.length, 0);
});

test("コマ全体のコメントには、範囲とコマの番号が入る", () => {
  const viewerParts = makeViewer(makeStory([]));
  const beforeIndex = viewerParts.createdElements.length;
  viewerParts.elementsById.stepCommentBtn.onclick();
  const openedElements = viewerParts.createdElements.slice(beforeIndex);
  const input = openedElements.find((element) => element.placeholder != null);
  const sendButton = openedElements.find((element) => element.textContent === "送信");
  input.value = "このコマの方針が違う";
  sendButton.onclick();
  assert.deepStrictEqual(viewerParts.sentRequests, [{ url: "/comments", body: { scope: "step", step_order: 1, body: "このコマの方針が違う" } }]);
});

test("指紋は解決の状態が変わったことを拾う", () => {
  const { viewer } = makeViewer(makeStory([]));
  const openFingerprint = fingerprintOf(viewer, makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [] }]));
  const resolvedFingerprint = fingerprintOf(viewer, makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", replies: [], resolved: true }]));
  assert.notStrictEqual(openFingerprint, resolvedFingerprint);
});

test("コメントを足すと comments.json に範囲がそのまま残る", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  appendComment(targetDir, { scope: "story", body: "そもそも分け方が違う" });
  const { commentNumber } = appendComment(targetDir, { scope: "step", step_order: 2, body: "このコマの方針が違う" });
  assert.strictEqual(commentNumber, 2);
  const comments = readComments(targetDir);
  assert.strictEqual(comments[0].scope, "story");
  assert.strictEqual(comments[1].step_order, 2);
  assert.deepStrictEqual(comments[1].replies, []);
});

test("行コメントを足すと、対象の行の本文も一緒に残る", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeMinimalStory(targetDir);
  appendComment(targetDir, { scope: "line", change_id: 2, file: "a.js", repo: ".", line: 2, step_order: 2, body: "ここなぜ?" });
  appendComment(targetDir, { scope: "step", step_order: 1, body: "このコマの方針が違う" });
  const comments = readComments(targetDir);
  assert.strictEqual(comments[0].line_text, "2コマ目の行");
  assert.strictEqual("line_text" in comments[1], false);
});

test("行を見失った印の付いたコメントは、無くなった行の枠で断り書きと一緒に出る", () => {
  const { createdElements } = makeViewer(makeStory([
    { scope: "line", change_id: null, file: "a.js", step_order: 1, body: "見失った行への指摘", line_text: "x", line_lost: true, replies: [] },
    { scope: "line", change_id: null, file: "a.js", step_order: 1, body: "印の無い古い指摘", replies: [] },
  ]));
  assert.strictEqual(countClassName(createdElements, "file-head lost-comments-heading"), 1);
  const lostLabels = createdElements.filter((element) => element.className === "comment-line-lost");
  assert.strictEqual(lostLabels.length, 1);
  assert.match(lostLabels[0].textContent, /別の場所を指しているかもしれません/);
});

test("指紋は行を見失った印が変わったことを拾う", () => {
  const { viewer } = makeViewer(makeStory([]));
  const foundFingerprint = fingerprintOf(viewer, makeStory([{ scope: "line", change_id: 1, file: "a.js", step_order: 1, body: "ここなぜ?", line_text: "x", replies: [] }]));
  const lostFingerprint = fingerprintOf(viewer, makeStory([{ scope: "line", change_id: null, file: "a.js", step_order: 1, body: "ここなぜ?", line_text: "x", line_lost: true, replies: [] }]));
  assert.notStrictEqual(foundFingerprint, lostFingerprint);
});

test("reply の --keep-resolved を CLI からも指定できる", (t) => {
  const targetDir = makeTempDir();
  t.after(() => fs.rmSync(targetDir, { recursive: true, force: true }));

  writeComments(targetDir, [{ scope: "step", step_order: 1, body: "このコマの方針が違う", replies: [], resolved: true }]);
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "reply", targetDir, "1", "直しました", "--keep-resolved"]);
  assert.strictEqual(readComments(targetDir)[0].resolved, true);
  execFileSync(process.execPath, [path.join(__dirname, "..", "storiff.js"), "reply", targetDir, "1", "もう一度直しました"]);
  const comment = readComments(targetDir)[0];
  assert.strictEqual(comment.resolved, false);
  assert.strictEqual(comment.replies.length, 2);
});
