const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildIdMap, foldIdsToRanges, remapSteps, remapComments, runPrep } = require("../storiff.js");

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

function makeFile(repo, file, lines) {
  return { repo, file, status: "modified", lines };
}

function makeLine(kind, text, id) {
  return { kind, old: null, new: null, text, id };
}

function idsFromOwns(owns) {
  const ids = [];
  for (const item of owns) {
    const rangeMatch = String(item).match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      for (let id = parseInt(rangeMatch[1], 10); id <= parseInt(rangeMatch[2], 10); id++) ids.push(id);
    } else {
      ids.push(Number(item));
    }
  }
  return ids;
}

function textById(changes) {
  const map = new Map();
  for (const file of changes.files) {
    for (const line of file.lines) {
      if (line.id != null) map.set(line.id, line.text);
    }
  }
  return map;
}

test("行が動かないとき、旧IDと新IDが1対1で対応する", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2)])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2)])];
  const { idMap } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 1);
  assert.strictEqual(idMap.get(2), 2);
});

test("ファイルが1つ増えて全IDがずれたとき、旧IDが正しい新IDに対応する", () => {
  const previousFiles = [
    makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2)]),
    makeFile(".", "b.js", [makeLine("add", "z", 3), makeLine("add", "w", 4)]),
  ];
  const currentFiles = [
    makeFile(".", "new.js", [makeLine("add", "brand", 1), makeLine("add", "new", 2)]),
    makeFile(".", "a.js", [makeLine("add", "x", 3), makeLine("add", "y", 4)]),
    makeFile(".", "b.js", [makeLine("add", "z", 5), makeLine("add", "w", 6)]),
  ];
  const { idMap } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 3);
  assert.strictEqual(idMap.get(2), 4);
  assert.strictEqual(idMap.get(3), 5);
  assert.strictEqual(idMap.get(4), 6);
});

test("同じ中身の行が3つあるとき、出てきた順で対応する", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 10), makeLine("add", "foo", 11), makeLine("add", "foo", 12)])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 20), makeLine("add", "foo", 21), makeLine("add", "foo", 22)])];
  const { idMap } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(10), 20);
  assert.strictEqual(idMap.get(11), 21);
  assert.strictEqual(idMap.get(12), 22);
});

test("前回にあって今回に無い行が lostIds に入る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("del", "gone", 5)])];
  const currentFiles = [makeFile(".", "a.js", [])];
  const { lostIds } = buildIdMap(previousFiles, currentFiles);
  assert.deepStrictEqual(lostIds, [5]);
});

test("今回にあって前回に無い行が newIds に入る", () => {
  const previousFiles = [makeFile(".", "a.js", [])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("add", "brandNew", 9)])];
  const { newIds } = buildIdMap(previousFiles, currentFiles);
  assert.deepStrictEqual(newIds, [9]);
});

test("同じ中身の行が前回3つ今回2つのとき、余った旧IDが lostIds に入る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 1), makeLine("add", "foo", 2), makeLine("add", "foo", 3)])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 1), makeLine("add", "foo", 2)])];
  const { idMap, lostIds } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 1);
  assert.strictEqual(idMap.get(2), 2);
  assert.deepStrictEqual(lostIds, [3]);
});

test("同じ中身の行が前回2つ今回3つのとき、余った新IDが newIds に入る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 1), makeLine("add", "foo", 2)])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("add", "foo", 1), makeLine("add", "foo", 2), makeLine("add", "foo", 3)])];
  const { idMap, newIds } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 1);
  assert.strictEqual(idMap.get(2), 2);
  assert.deepStrictEqual(newIds, [3]);
});

test("id を持たない context 行が対応表に混ざらない", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("context", "same", null), makeLine("add", "x", 1)])];
  const currentFiles = [makeFile(".", "a.js", [makeLine("context", "same", null), makeLine("add", "x", 2)])];
  const { idMap, newIds, lostIds } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 2);
  assert.deepStrictEqual(newIds, []);
  assert.deepStrictEqual(lostIds, []);
});

test("別リポジトリの同名パスが混ざらない", () => {
  const previousFiles = [
    makeFile("repoA", "a.js", [makeLine("add", "same", 1)]),
    makeFile("repoB", "a.js", [makeLine("add", "same", 2)]),
  ];
  const currentFiles = [
    makeFile("repoA", "a.js", [makeLine("add", "same", 10)]),
    makeFile("repoB", "a.js", [makeLine("add", "same", 20)]),
  ];
  const { idMap } = buildIdMap(previousFiles, currentFiles);
  assert.strictEqual(idMap.get(1), 10);
  assert.strictEqual(idMap.get(2), 20);
});

test("連続するIDが範囲文字列に畳まれ、単独は整数のまま残る", () => {
  const folded = foldIdsToRanges([1, 2, 3, 5, 7, 8]);
  assert.deepStrictEqual(folded, ["1-3", 5, "7-8"]);
});

test("連続していないIDが範囲に畳まれず、整数のまま複数並ぶ", () => {
  const folded = foldIdsToRanges([1, 3, 5]);
  assert.deepStrictEqual(folded, [1, 3, 5]);
});

test("空の配列を渡したとき空の配列が返る", () => {
  const folded = foldIdsToRanges([]);
  assert.deepStrictEqual(folded, []);
});

test("昇順でないIDを渡しても内部でソートされ、正しく畳まれる", () => {
  const folded = foldIdsToRanges([3, 1, 2]);
  assert.deepStrictEqual(folded, ["1-3"]);
});

test("F番号で持っていたステップが、書き換え後は範囲か整数になる", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2), makeLine("add", "z", 3)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: ["F1"], refs: [] }];
  const idMap = new Map([[1, 10], [2, 11], [3, 12]]);
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.deepStrictEqual(remapped[0].owns, ["10-12"]);
});

test("owns の一部が消えたとき、残りだけが新しい owns に入る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2), makeLine("add", "z", 3)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: [1, 2, 3], refs: [] }];
  const idMap = new Map([[1, 10], [3, 12]]);
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.deepStrictEqual(remapped[0].owns, [10, 12]);
});

test("owns が全部消えたステップは owns が空配列になり、ステップ自体は残る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 5)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: [5], refs: [] }];
  const idMap = new Map();
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.strictEqual(remapped.length, 1);
  assert.deepStrictEqual(remapped[0].owns, []);
  assert.strictEqual(remapped[0].order, 1);
  assert.strictEqual(remapped[0].title, "タイトル");
  assert.strictEqual(remapped[0].narration, "説明");
});

test("owns_files を持っていたステップは、書き換え後に owns_files を持たない", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 7)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: [], refs: [], owns_files: ["F1"] }];
  const idMap = new Map([[7, 70]]);
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.deepStrictEqual(remapped[0].owns, [70]);
  assert.strictEqual("owns_files" in remapped[0], false);
});

test("refs も新IDに写る", () => {
  const previousFiles = [makeFile(".", "a.js", [makeLine("add", "x", 1), makeLine("add", "y", 2)])];
  const steps = [{ order: 1, title: "タイトル", narration: "説明", owns: [], refs: ["1-2"] }];
  const idMap = new Map([[1, 10], [2, 11]]);
  const remapped = remapSteps(previousFiles, steps, idMap);
  assert.deepStrictEqual(remapped[0].refs, ["10-11"]);
});

test("コメントの change_id が写る。写せないコメントは change_id が null になり、body と replies が消えない", () => {
  const comments = [
    { change_id: 1, file: "a.js", line: 5, step_order: 1, body: "本文", replies: [], at: "2024-01-01T00:00:00.000Z" },
    { change_id: 99, file: "a.js", line: 9, step_order: 1, body: "本文2", replies: [{ author: "ai", body: "返信" }], at: "2024-01-01T00:00:00.000Z" },
  ];
  const idMap = new Map([[1, 10]]);
  const remapped = remapComments(comments, idMap);
  assert.strictEqual(remapped[0].change_id, 10);
  assert.strictEqual(remapped[1].change_id, null);
  assert.strictEqual(remapped[1].body, "本文2");
  assert.deepStrictEqual(remapped[1].replies, [{ author: "ai", body: "返信" }]);
});

test("別ディレクトリから追従しても cwd の目印が保たれ、以後どちらのディレクトリからでも追従できる", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  const otherDir = makeTempDir("storiff-other-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "content1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "content1\ncontent2\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(firstChanges.cwd, repoDir);

  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  process.chdir(otherDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const secondChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(secondChanges.cwd, repoDir);

  process.chdir(repoDir);
  assert.doesNotThrow(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }]));
  const thirdChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(thirdChanges.cwd, repoDir);

  process.chdir(otherDir);
  assert.doesNotThrow(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }]));
});

test("steps.json が無い間は2回prepしても追従に入らず、changes.json に repo_args と cwd だけが残る", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "content1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "content1\ncontent2\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.deepStrictEqual(firstChanges.repo_args, [{ path: ".", diffArgs: [] }]);
  assert.strictEqual(firstChanges.cwd, repoDir);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "steps.json")), false);

  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "steps.json")), false);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "follow.json")), false);
});

test("初回prepの後にコードを修正してprepを叩き直すと、追従後のownsが新しいchanges.jsonの正しい行を指す", (t) => {
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
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\nnewLine\n");
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  const secondChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  const secondSteps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  const lineTextById = textById(secondChanges);

  const firstStep = secondSteps.steps.find((step) => step.title === "タイトル");
  const firstStepTexts = idsFromOwns(firstStep.owns).map((id) => lineTextById.get(id)).sort();
  assert.deepStrictEqual(firstStepTexts, ["changedA", "line2"].sort());

  const fixStep = secondSteps.steps.find((step) => step.title === "修正1回目");
  const fixStepTexts = idsFromOwns(fixStep.owns).map((id) => lineTextById.get(id));
  assert.deepStrictEqual(fixStepTexts, ["newLine"]);
});

test("追従で差分が0件になったとき、steps.jsonとcomments.jsonが書き換わらない", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));
  fs.writeFileSync(path.join(targetDir, "comments.json"), JSON.stringify([
    { change_id: firstChanges.change_ids[0], file: "a.js", line: 2, step_order: 1, body: "本文", replies: [], at: "2024-01-01T00:00:00.000Z" },
  ]));
  const stepsBefore = fs.readFileSync(path.join(targetDir, "steps.json"), "utf8");
  const commentsBefore = fs.readFileSync(path.join(targetDir, "comments.json"), "utf8");

  execFileSync("git", ["add", "a.js"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "second"], { cwd: repoDir });
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);

  assert.strictEqual(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"), stepsBefore);
  assert.strictEqual(fs.readFileSync(path.join(targetDir, "comments.json"), "utf8"), commentsBefore);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "steps.prev.json")), false);
});

test("複数リポジトリを相対パスで指定し、初回とは別のディレクトリから追従しても対応表が正しい", (t) => {
  const originalCwd = process.cwd();
  const baseDir = makeTempDir("storiff-base-");
  const repoADir = path.join(baseDir, "repoA");
  const repoBDir = path.join(baseDir, "repoB");
  const otherDir = makeTempDir("storiff-other-");
  const targetDir = makeTempDir("storiff-target-");
  fs.mkdirSync(repoADir);
  fs.mkdirSync(repoBDir);
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoADir);
  commitFile(repoADir, "a.js", "content1\n", "first");
  fs.writeFileSync(path.join(repoADir, "a.js"), "content1\ncontent2\n");
  makeGitRepo(repoBDir);
  commitFile(repoBDir, "b.js", "content1\n", "first");
  fs.writeFileSync(path.join(repoBDir, "b.js"), "content1\ncontent2\n");

  const repoList = [{ path: "repoA", diffArgs: [] }, { path: "repoB", diffArgs: [] }];
  process.chdir(baseDir);
  runPrep(targetDir, repoList);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  assert.strictEqual(firstChanges.cwd, baseDir);
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  fs.writeFileSync(path.join(repoADir, "a.js"), "content1\ncontent2\nnewLineInRepoA\n");

  process.chdir(otherDir);
  assert.doesNotThrow(() => runPrep(targetDir, repoList));
  const secondChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  const secondSteps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  assert.strictEqual(secondChanges.cwd, baseDir);

  const lineTextById = textById(secondChanges);
  const firstStep = secondSteps.steps.find((step) => step.title === "タイトル");
  const firstStepTexts = idsFromOwns(firstStep.owns).map((id) => lineTextById.get(id)).sort();
  assert.deepStrictEqual(firstStepTexts, ["content2", "content2"].sort());

  const fixStep = secondSteps.steps.find((step) => step.title === "修正1回目");
  const fixStepTexts = idsFromOwns(fixStep.owns).map((id) => lineTextById.get(id));
  assert.deepStrictEqual(fixStepTexts, ["newLineInRepoA"]);
});

test("comments.jsonが壊れているとき追従が失敗しても、changes.jsonとsteps.jsonが書き換わらず控えファイルも作られない", (t) => {
  const originalCwd = process.cwd();
  const repoDir = makeTempDir("storiff-repo-");
  const targetDir = makeTempDir("storiff-target-");
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  makeGitRepo(repoDir);
  commitFile(repoDir, "a.js", "line1\n", "first");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");

  process.chdir(repoDir);
  runPrep(targetDir, [{ path: ".", diffArgs: [] }]);
  const firstChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  fs.writeFileSync(path.join(targetDir, "steps.json"), JSON.stringify({
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));
  fs.writeFileSync(path.join(targetDir, "comments.json"), "{ 壊れたJSON");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\nline3\n");

  const changesBefore = fs.readFileSync(path.join(targetDir, "changes.json"), "utf8");
  const stepsBefore = fs.readFileSync(path.join(targetDir, "steps.json"), "utf8");

  assert.throws(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }]));

  assert.strictEqual(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"), changesBefore);
  assert.strictEqual(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"), stepsBefore);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "steps.prev.json")), false);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "comments.prev.json")), false);
  assert.strictEqual(fs.existsSync(path.join(targetDir, "follow.json")), false);
});

test("cwdを持たない古いchanges.jsonでも追従がクラッシュせず、cwdが入り直る", (t) => {
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
    steps: [{ order: 1, title: "タイトル", narration: "説明", owns: firstChanges.change_ids, refs: [] }],
  }));

  delete firstChanges.cwd;
  fs.writeFileSync(path.join(targetDir, "changes.json"), JSON.stringify(firstChanges));

  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nchangedA\nline3\nnewLine\n");

  assert.doesNotThrow(() => runPrep(targetDir, [{ path: ".", diffArgs: [] }]));

  const secondChanges = JSON.parse(fs.readFileSync(path.join(targetDir, "changes.json"), "utf8"));
  const secondSteps = JSON.parse(fs.readFileSync(path.join(targetDir, "steps.json"), "utf8"));
  assert.strictEqual(secondChanges.cwd, repoDir);
  assert.strictEqual(secondSteps.steps.some((step) => step.title === "修正1回目"), true);
});
