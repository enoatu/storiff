#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const os = require("os");

// 1stepがおおよそ1時間の作業に収まる目安の変更行数。これを超えるstepは分割の候補
const CHANGED_LINES_PER_STEP_GUIDE = 80;

// 前回と今回のどちらかで同じ内容の行がこの本数を超えたら、単調増加列の候補から外し出現順に対応させる
const SAME_CONTENT_LINE_COUNT_MAX = 100;

// 単調増加列を計算する候補の総数がこれを超えたら、計算をやめて出現順に対応させる
const MONOTONIC_CANDIDATE_COUNT_MAX = 5000000;

// serve のデーモン起動を待つときのポーリング間隔と上限
const SERVE_POLL_INTERVAL_MSEC = 200;
const SERVE_START_TIMEOUT_MSEC = 10000;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeFileAtomic(filePath, content) {
  const tempPath = filePath + ".tmp" + process.pid + "-" + Date.now();
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// writeFileAtomic が強制終了で残した一時ファイルを消す
function cleanupStaleTempFiles(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  const tempFileNamePattern = /\.tmp\d+-\d+$/;
  for (const entry of fs.readdirSync(targetDir)) {
    if (tempFileNamePattern.test(entry)) fs.unlinkSync(path.join(targetDir, entry));
  }
}

// ~/.storiff/config.json の既定値。CLI引数の方が優先される
function loadConfig() {
  return readJson(path.join(os.homedir(), ".storiff", "config.json"), {});
}

// git diff の unified 出力をファイル単位に分解する
function parseDiff(diffText, repo, startId) {
  const files = [];
  const changeIds = [];
  let nextId = startId;
  let currentFile = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      let fallbackFile = null;
      const bIndex = rawLine.lastIndexOf(" b/");
      if (bIndex !== -1) {
        fallbackFile = rawLine.slice(bIndex + 3);
      }
      currentFile = { repo, file: fallbackFile, status: "modified", lines: [] };
      files.push(currentFile);
      continue;
    }
    if (!currentFile) continue;

    if (rawLine.startsWith("new file mode")) {
      currentFile.status = "added";
      continue;
    }
    if (rawLine.startsWith("deleted file mode")) {
      currentFile.status = "deleted";
      continue;
    }
    if (rawLine.startsWith("rename from ")) {
      currentFile.status = "renamed";
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.file = rawLine.slice("rename to ".length);
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      const oldPath = rawLine.slice(4);
      if (oldPath !== "/dev/null" && !currentFile.file) {
        currentFile.file = oldPath.replace(/^a\//, "");
      }
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const newPath = rawLine.slice(4);
      if (newPath !== "/dev/null") {
        currentFile.file = newPath.replace(/^b\//, "");
      }
      continue;
    }
    if (rawLine.startsWith("@@")) {
      const matched = rawLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (matched) {
        oldLine = parseInt(matched[1], 10);
        newLine = parseInt(matched[2], 10);
      }
      continue;
    }
    if (rawLine.startsWith("\\")) continue;

    const marker = rawLine[0];
    const text = rawLine.slice(1);
    if (marker === " ") {
      currentFile.lines.push({ kind: "context", old: oldLine, new: newLine, text });
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      const id = nextId++;
      currentFile.lines.push({ kind: "add", old: null, new: newLine, text, id });
      changeIds.push(id);
      newLine += 1;
    } else if (marker === "-") {
      const id = nextId++;
      currentFile.lines.push({ kind: "del", old: oldLine, new: null, text, id });
      changeIds.push(id);
      oldLine += 1;
    }
  }

  return { files, change_ids: changeIds, nextId };
}

// story作成時にClaudeが読むスリム版。コンテキスト行を落とし変更行だけにする
function buildChangesText(files) {
  const blocks = files.map((file) => {
    const repoTag = file.repo && file.repo !== "." ? file.repo + " " : "";
    const heading = "=== " + repoTag + file.file + " (" + file.status + ") ===";
    const changedLines = file.lines
      .filter((line) => line.kind !== "context")
      .map((line) => (line.kind === "add" ? "+" : "-") + "[" + line.id + "] " + line.text);
    return heading + "\n" + changedLines.join("\n");
  });
  return blocks.join("\n\n") + "\n";
}

// ファイルごとの1行地図。AIはまずこれを読み、F番号でstepに割り振る
function buildFilesMap(files) {
  const lines = files.map((file, index) => {
    const ids = file.lines.filter((line) => line.id != null).map((line) => line.id);
    const range = ids.length > 0 ? ids[0] + "-" + ids[ids.length - 1] : "-";
    const repoTag = file.repo && file.repo !== "." ? file.repo + " " : "";
    return "F" + (index + 1) + " [" + range + "] (" + ids.length + ") " + file.status + " " + repoTag + file.file;
  });
  return lines.join("\n") + "\n";
}

// リポジトリとファイルと行の種類と本文から、突き合わせ用のキーを組み立てる
function buildLineKey(file, line) {
  return [file.repo, file.file, line.kind, line.text].join("\0");
}

// 変更行のキーごとに変更IDの配列を返す。前回と今回の差分を突き合わせるための下準備
function buildLineKeyIndex(files) {
  const keyToIdsMap = new Map();
  for (const file of files) {
    for (const line of file.lines) {
      if (line.id == null) continue;
      const key = buildLineKey(file, line);
      if (!keyToIdsMap.has(key)) keyToIdsMap.set(key, []);
      keyToIdsMap.get(key).push(line.id);
    }
  }
  return keyToIdsMap;
}

// 値の列を先頭から見て、そこまでの狭義単調増加列の長さを1つずつ返す
function computeChainLengths(values) {
  const pileTops = [];
  const lengths = [];
  for (const value of values) {
    let low = 0;
    let high = pileTops.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (pileTops[mid] < value) low = mid + 1;
      else high = mid;
    }
    lengths.push(low + 1);
    if (low === pileTops.length) pileTops.push(value);
    else pileTops[low] = value;
  }
  return lengths;
}

// previousIdの昇順に並べたcurrentIdsのうち先頭からpreviousIdsと同じ数だけを出現順に対応させる
function assignByAppearanceOrder(idMap, previousIds, currentIds) {
  const sortedPreviousIds = [...previousIds].sort((left, right) => left - right);
  const pairCount = Math.min(sortedPreviousIds.length, currentIds.length);
  for (let index = 0; index < pairCount; index++) {
    idMap.set(sortedPreviousIds[index], currentIds[index]);
  }
}

// previousIdの昇順とcurrentIdの昇順が両方保たれる対応の中で、最も多く引き継げる組み合わせを選ぶ
// 各候補について前から見た単調増加列の長さと後ろから見た単調増加列の長さを求め、
// 両方を足した長さが全体の最大値と一致する候補だけを、previousId昇順・currentId昇順に選んでいく
// 同じキーの候補が複数あっても、選べるcurrentIdのうち最も早いものが優先されるので前後関係が入れ替わらない
// 同じ内容の行がSAME_CONTENT_LINE_COUNT_MAXを超えて並ぶキーは候補数が本数の掛け算で膨れ上がるため、
// そのキーだけこの計算から外し、前回と今回の出現順どうしをそのまま対応させる
// 候補の総数がMONOTONIC_CANDIDATE_COUNT_MAXを超えたときも、同じく出現順どうしの対応に落とす
function pickMonotonicIdMap(candidateGroups) {
  const previousIdsByCurrentIds = new Map();
  for (const group of candidateGroups) {
    if (!previousIdsByCurrentIds.has(group.currentIds)) previousIdsByCurrentIds.set(group.currentIds, []);
    previousIdsByCurrentIds.get(group.currentIds).push(group.previousId);
  }

  const idMap = new Map();
  const monotonicGroups = [];
  const resolvedCurrentIds = new Set();
  let monotonicCandidateCount = 0;
  for (const group of candidateGroups) {
    const previousIds = previousIdsByCurrentIds.get(group.currentIds);
    const isFrequentContent = previousIds.length > SAME_CONTENT_LINE_COUNT_MAX || group.currentIds.length > SAME_CONTENT_LINE_COUNT_MAX;
    if (!isFrequentContent) {
      monotonicGroups.push(group);
      monotonicCandidateCount += group.currentIds.length;
      continue;
    }
    if (resolvedCurrentIds.has(group.currentIds)) continue;
    resolvedCurrentIds.add(group.currentIds);
    assignByAppearanceOrder(idMap, previousIds, group.currentIds);
  }

  if (monotonicCandidateCount > MONOTONIC_CANDIDATE_COUNT_MAX) {
    const resolvedByAppearanceOrder = new Set();
    for (const group of monotonicGroups) {
      if (resolvedByAppearanceOrder.has(group.currentIds)) continue;
      resolvedByAppearanceOrder.add(group.currentIds);
      assignByAppearanceOrder(idMap, previousIdsByCurrentIds.get(group.currentIds), group.currentIds);
    }
    return idMap;
  }

  const candidates = [];
  const groupOffsets = [];
  for (const group of monotonicGroups) {
    groupOffsets.push(candidates.length);
    for (const currentId of [...group.currentIds].reverse()) {
      candidates.push({ previousId: group.previousId, currentId });
    }
  }
  const currentIdSequence = candidates.map((candidate) => candidate.currentId);
  const forwardLengths = computeChainLengths(currentIdSequence);

  const reversedNegatedSequence = [...currentIdSequence].reverse().map((currentId) => -currentId);
  const backwardLengthsReversed = computeChainLengths(reversedNegatedSequence);
  const candidateCount = candidates.length;
  const backwardLengths = new Array(candidateCount);
  for (let index = 0; index < candidateCount; index++) {
    backwardLengths[index] = backwardLengthsReversed[candidateCount - 1 - index];
  }

  const maxLength = forwardLengths.reduce((largest, length) => Math.max(largest, length), 0);
  let remaining = maxLength;
  let lastCurrentId = -Infinity;
  for (const [groupIndex, group] of monotonicGroups.entries()) {
    if (remaining === 0) break;
    const groupOffset = groupOffsets[groupIndex];
    const groupSize = group.currentIds.length;
    for (const [indexInGroup, currentId] of group.currentIds.entries()) {
      if (currentId <= lastCurrentId) continue;
      const candidateIndex = groupOffset + (groupSize - 1 - indexInGroup);
      if (forwardLengths[candidateIndex] + backwardLengths[candidateIndex] - 1 !== maxLength) continue;
      if (backwardLengths[candidateIndex] !== remaining) continue;
      idMap.set(group.previousId, currentId);
      lastCurrentId = currentId;
      remaining -= 1;
      break;
    }
  }
  return idMap;
}

// 旧IDから新IDへの対応表を作る。前回だけにあったIDは lostIds、今回だけにあったIDは newIds に入る
function buildIdMap(previousFiles, currentFiles) {
  const currentKeyToIdsMap = buildLineKeyIndex(currentFiles);
  const candidateGroups = [];
  for (const file of previousFiles) {
    for (const line of file.lines) {
      if (line.id == null) continue;
      const currentIds = currentKeyToIdsMap.get(buildLineKey(file, line));
      if (currentIds) candidateGroups.push({ previousId: line.id, currentIds });
    }
  }
  const idMap = pickMonotonicIdMap(candidateGroups);
  const lostIds = [];
  for (const file of previousFiles) {
    for (const line of file.lines) {
      if (line.id != null && !idMap.has(line.id)) lostIds.push(line.id);
    }
  }
  const takenIds = new Set(idMap.values());
  const newIds = [];
  for (const file of currentFiles) {
    for (const line of file.lines) {
      if (line.id != null && !takenIds.has(line.id)) newIds.push(line.id);
    }
  }
  return { idMap, lostIds, newIds };
}

// 連続する整数IDを範囲文字列に畳む。単独のIDは整数のまま返す
function foldIdsToRanges(ids) {
  const sortedIds = [...ids].sort((left, right) => left - right);
  const folded = [];
  let start = null;
  let previous = null;
  const flushRange = () => {
    folded.push(start === previous ? start : start + "-" + previous);
  };
  for (const id of sortedIds) {
    if (start == null) {
      start = id;
      previous = id;
      continue;
    }
    if (id === previous + 1) {
      previous = id;
      continue;
    }
    flushRange();
    start = id;
    previous = id;
  }
  if (start != null) flushRange();
  return folded;
}

// 旧owns整数IDをidMapで新IDに写し、owns_filesを持たない新しいsteps配列を返す
function remapSteps(previousFiles, stepList, idMap) {
  const resolved = resolveSteps(previousFiles, stepList);
  return resolved.resolvedSteps.map((step) => {
    const previousOwns = step.owns;
    const previousRefs = step.refs;
    const owns = previousOwns.map((id) => idMap.get(id)).filter((id) => id != null);
    const refs = previousRefs.map((id) => idMap.get(id)).filter((id) => id != null);
    const remapped = Object.assign({}, step, { owns: foldIdsToRanges(owns), refs: foldIdsToRanges(refs) });
    delete remapped.owns_files;
    return remapped;
  });
}

// コメントのchange_idをidMapで新IDに写す。写せないものはnullにする
function remapComments(comments, idMap) {
  return comments.map((comment) => {
    const changeId = idMap.get(comment.change_id);
    return Object.assign({}, comment, { change_id: changeId == null ? null : changeId });
  });
}

// レビュー価値の低いノイズファイル。config.json の exclude で追加できる
const NOISE_PATTERNS = ["*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.min.js", "*.min.css", "*.map"];

// 自動生成ファイル。除外はせず末尾の場面に回す。config.json の generated で追加できる
const GENERATED_PATTERNS = ["*.generated.*", "*.gen.*", "*.pb.go"];

function matchesFilePattern(filePath, patterns) {
  if (!filePath) return false;
  const base = filePath.split("/").pop();
  return patterns.some((pattern) => {
    if (pattern.includes("*")) {
      const regexp = new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
      return regexp.test(base) || regexp.test(filePath);
    }
    return base === pattern || filePath === pattern;
  });
}

function runPrep(targetDir, repoList, hasExplicitArgs) {
  cleanupStaleTempFiles(targetDir);
  const changesPath = path.join(targetDir, "changes.json");
  let previousChanges = null;
  if (fs.existsSync(changesPath)) {
    try {
      previousChanges = JSON.parse(fs.readFileSync(changesPath, "utf8"));
    } catch (error) {
      console.log("追従しません: 前回の changes.json が壊れています(" + String(error.message).split("\n")[0].trim() + ")");
      return;
    }
    if (!Array.isArray(previousChanges.files) || previousChanges.files.some((file) => !Array.isArray(file.lines))) {
      console.log("追従しません: 前回の changes.json に files がありません");
      return;
    }
  }
  const previousSteps = readJson(path.join(targetDir, "steps.json"), null);
  const isFollow = previousChanges != null && previousSteps != null;
  const hasPreviousChanges = previousChanges != null;
  const usingRecordedRepoList = hasPreviousChanges && previousChanges.repo_args != null && !hasExplicitArgs;
  if (usingRecordedRepoList) console.log("記録済みの範囲を使います: " + previousChanges.diff_target);
  const effectiveRepoList = usingRecordedRepoList ? previousChanges.repo_args : repoList;
  const cwd = usingRecordedRepoList ? previousChanges.cwd || process.cwd() : process.cwd();
  const collectedFiles = [];
  const diffTargets = [];
  for (const repo of effectiveRepoList) {
    const repoPath = usingRecordedRepoList ? path.resolve(cwd, repo.path) : repo.path;
    const diffArgs = repo.diffArgs.length > 0 ? repo.diffArgs : ["HEAD"];
    let diffText;
    try {
      diffText = execFileSync("git", ["-C", repoPath, "diff", ...diffArgs], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
    } catch (error) {
      const gitMessage = (error.stderr ? error.stderr.toString() : String(error.message)).split("\n")[0].trim();
      console.log("git diff に失敗しました: " + gitMessage);
      return;
    }
    const range = diffArgs.join(" ");
    diffTargets.push(repo.path === "." ? range : repo.path + " " + range);
    if (diffText.trim() === "") continue;
    collectedFiles.push(...parseDiff(diffText, repo.path, 1).files);
  }
  const config = loadConfig();
  const excludePatterns = NOISE_PATTERNS.concat(config.exclude || []);
  const reviewableFiles = collectedFiles.filter((file) => !matchesFilePattern(file.file, excludePatterns));
  const excludedCount = collectedFiles.length - reviewableFiles.length;
  const generatedPatterns = GENERATED_PATTERNS.concat(config.generated || []);
  const normalFiles = reviewableFiles.filter((file) => !matchesFilePattern(file.file, generatedPatterns));
  const generatedFiles = reviewableFiles.filter((file) => matchesFilePattern(file.file, generatedPatterns));
  const files = normalFiles.concat(generatedFiles);
  const changeIds = [];
  let nextId = 1;
  for (const file of files) {
    for (const line of file.lines) {
      if (line.kind === "add" || line.kind === "del") {
        line.id = nextId;
        changeIds.push(nextId);
        nextId += 1;
      }
    }
  }
  if (changeIds.length === 0) {
    if (isFollow) {
      console.log("追従しません: 差分が0件になりました。全部コミット済みか範囲がずれています。既存のストーリーはそのまま残します");
      return;
    }
    console.log("変更なし: 差分行が見つかりませんでした");
    return;
  }
  const repos = effectiveRepoList.map((repo) => repo.path);
  const outputPath = path.join(targetDir, "changes.json");
  const changesJson = {
    diff_target: diffTargets.join(", "),
    repos,
    repo_args: effectiveRepoList,
    cwd,
    files,
    change_ids: changeIds,
  };
  const changesText = buildChangesText(files);
  const filesMapText = buildFilesMap(files);
  const textOutputPath = path.join(targetDir, "changes.txt");
  const filesMapPath = path.join(targetDir, "files.txt");
  const excludedNote = excludedCount > 0 ? ", ノイズ除外 " + excludedCount + "件" : "";

  let previousComments = null;
  let remappedSteps = null;
  let idMap = null;
  let lostIds = null;
  let newIds = null;
  let addedStepOrder = null;
  let isSameAsBefore = false;
  if (isFollow) {
    previousComments = readJson(path.join(targetDir, "comments.json"), []);
    const idMapResult = buildIdMap(previousChanges.files, files);
    idMap = idMapResult.idMap;
    lostIds = idMapResult.lostIds;
    newIds = idMapResult.newIds;
    remappedSteps = remapSteps(previousChanges.files, previousSteps.steps || [], idMap);
    const ownedIds = new Set();
    for (const step of resolveSteps(files, remappedSteps).resolvedSteps) {
      for (const id of step.owns) ownedIds.add(id);
    }
    const unownedIds = changeIds.filter((id) => !ownedIds.has(id));
    const fixStepCount = remappedSteps.filter((step) => /^修正\d+回目$/.test(step.title || "")).length;
    const maxOrder = remappedSteps.reduce((largest, step) => Math.max(largest, step.order || 0), 0);
    if (unownedIds.length > 0) {
      addedStepOrder = maxOrder + 1;
      remappedSteps.push({
        order: addedStepOrder,
        title: "修正" + (fixStepCount + 1) + "回目",
        narration: "",
        owns: foldIdsToRanges(unownedIds),
        refs: [],
      });
    }
    const isIdentityMap = [...idMap].every(([previousId, currentId]) => previousId === currentId);
    isSameAsBefore = lostIds.length === 0 && newIds.length === 0 && isIdentityMap;
  }

  fs.mkdirSync(targetDir, { recursive: true });
  if (isFollow && !isSameAsBefore) {
    writeFileAtomic(path.join(targetDir, "steps.prev.json"), JSON.stringify(previousSteps, null, 2));
    writeFileAtomic(path.join(targetDir, "comments.prev.json"), JSON.stringify(previousComments, null, 2));
  }
  writeFileAtomic(outputPath, JSON.stringify(changesJson, null, 2));
  writeFileAtomic(textOutputPath, changesText);
  writeFileAtomic(filesMapPath, filesMapText);
  console.log("生成: " + outputPath + " と " + textOutputPath + " と " + filesMapPath + " (変更ID " + changeIds.length + "件, ファイル " + files.length + "件, リポジトリ " + repos.length + "件" + excludedNote + ")");
  if (!isFollow) return;
  if (!isSameAsBefore) {
    writeFileAtomic(path.join(targetDir, "steps.json"), JSON.stringify(Object.assign({}, previousSteps, { steps: remappedSteps }), null, 2));
    writeFileAtomic(path.join(targetDir, "comments.json"), JSON.stringify(remapComments(previousComments, idMap), null, 2));
    writeFileAtomic(path.join(targetDir, "follow.json"), JSON.stringify({
      at: new Date().toISOString(),
      diff_target: changesJson.diff_target,
      id_map: Object.fromEntries(idMap),
      lost_ids: lostIds,
      new_ids: newIds,
      added_step_order: addedStepOrder,
    }, null, 2));
  }
  const hasRangeArgs = effectiveRepoList.some((repo) => repo.diffArgs.length > 0);
  const sameAsBeforeNote = isSameAsBefore ? "。前回と同じ差分です" + (hasRangeArgs ? "。範囲を指定しているときは修正をコミットしないと反映されません" : "") : "";
  console.log("追従: 引き継ぎ " + idMap.size + "件, 消えた行 " + lostIds.length + "件, 増えた行 " + newIds.length + "件" + sameAsBeforeNote);
}

// owns_files のパスを、そのファイルの全変更IDに展開する
function expandOwnsFiles(ownsFiles, files) {
  const ids = [];
  const unknownFiles = [];
  for (const name of ownsFiles) {
    const fileNumber = String(name).match(/^F(\d+)$/);
    if (fileNumber) {
      const target = files[parseInt(fileNumber[1], 10) - 1];
      if (!target) {
        unknownFiles.push(name);
        continue;
      }
      for (const line of target.lines) if (line.id != null) ids.push(line.id);
      continue;
    }
    const separator = name.indexOf("::");
    const wantRepo = separator === -1 ? null : name.slice(0, separator);
    const wantFile = separator === -1 ? name : name.slice(separator + 2);
    const matchedFiles = files.filter((file) => file.file === wantFile && (wantRepo == null || file.repo === wantRepo));
    if (matchedFiles.length === 0) {
      unknownFiles.push(name);
      continue;
    }
    for (const file of matchedFiles) {
      for (const line of file.lines) if (line.id != null) ids.push(line.id);
    }
  }
  return { ids, unknownFiles };
}

// owns の各要素を整数IDに展開する。整数、"整数"、"開始-終了" の範囲に対応
function expandOwns(owns) {
  const ids = [];
  for (const value of owns) {
    if (typeof value === "number") {
      ids.push(value);
      continue;
    }
    const text = String(value).trim();
    const range = text.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let id = start; id <= end; id++) ids.push(id);
      continue;
    }
    if (/^\d+$/.test(text)) ids.push(parseInt(text, 10));
  }
  return ids;
}

// owns や refs の値を整数IDの配列に展開する。整数と範囲とF番号を混ぜてよい
function expandStepIds(rawValues, files) {
  const values = rawValues || [];
  const fileRefs = values.filter((value) => /^F\d+$/.test(String(value)));
  const idValues = values.filter((value) => !/^F\d+$/.test(String(value)));
  const fromFileRefs = expandOwnsFiles(fileRefs, files);
  return { ids: [...expandOwns(idValues), ...fromFileRefs.ids], unknownFiles: fromFileRefs.unknownFiles };
}

// 各stepの owns と owns_files と refs を整数IDの配列に展開する
function resolveSteps(files, steps) {
  const unknownFiles = [];
  const resolvedSteps = steps.map((step) => {
    const fromOwns = expandStepIds(step.owns, files);
    const fromOwnsFiles = expandOwnsFiles(step.owns_files || [], files);
    const fromRefs = expandStepIds(step.refs, files);
    unknownFiles.push(...fromOwns.unknownFiles, ...fromOwnsFiles.unknownFiles, ...fromRefs.unknownFiles);
    return Object.assign({}, step, { owns: [...fromOwns.ids, ...fromOwnsFiles.ids], refs: fromRefs.ids });
  });
  return { resolvedSteps, unknownFiles };
}

// owns の和集合が change_ids と一致するか検算する
function buildValidation(changeIds, files, steps) {
  const resolved = resolveSteps(files, steps);
  const ownedCount = new Map();
  for (const step of resolved.resolvedSteps) {
    for (const id of step.owns) {
      ownedCount.set(id, (ownedCount.get(id) || 0) + 1);
    }
  }
  const missing = changeIds.filter((id) => !ownedCount.has(id));
  const duplicated = [];
  for (const [id, count] of ownedCount) {
    if (count > 1) duplicated.push(id);
  }
  const ok = missing.length === 0 && duplicated.length === 0 && resolved.unknownFiles.length === 0;
  return { ok, missing, duplicated, unknown_files: resolved.unknownFiles, resolvedSteps: resolved.resolvedSteps };
}

function buildStory(targetDir) {
  const changes = readJson(path.join(targetDir, "changes.json"), null);
  if (!changes) throw new Error("changes.json がありません: 先に prep を実行してください");
  const steps = readJson(path.join(targetDir, "steps.json"), { title: "", steps: [] });
  const comments = readJson(path.join(targetDir, "comments.json"), []);
  const validation = buildValidation(changes.change_ids, changes.files, steps.steps || []);
  return {
    title: steps.title || "",
    files: changes.files,
    change_ids: changes.change_ids,
    steps: validation.resolvedSteps,
    validation: { ok: validation.ok, missing: validation.missing, duplicated: validation.duplicated, unknown_files: validation.unknown_files },
    comments,
  };
}

function appendComment(targetDir, body) {
  const commentsPath = path.join(targetDir, "comments.json");
  const comments = readJson(commentsPath, []);
  const newComment = Object.assign({}, body, { replies: [], at: new Date().toISOString() });
  comments.push(newComment);
  writeFileAtomic(commentsPath, JSON.stringify(comments, null, 2));
  return { comment: newComment, commentNumber: comments.length };
}
// コメント番号(1始まり)の replies に AI の返信を追記する
function appendReply(targetDir, commentNumber, body) {
  const commentsPath = path.join(targetDir, "comments.json");
  const comments = readJson(commentsPath, []);
  const target = comments[commentNumber - 1];
  if (!target) throw new Error("コメント番号が範囲外です: " + commentNumber);
  if (!Array.isArray(target.replies)) target.replies = [];
  target.replies.push({ author: "ai", body: body, at: new Date().toISOString() });
  writeFileAtomic(commentsPath, JSON.stringify(comments, null, 2));
  return target;
}

function buildFileDiffText(file, ownedIds) {
  const changedLines = file.lines.filter((line) => line.kind === "add" || line.kind === "del");
  const targetLines = ownedIds ? changedLines.filter((line) => ownedIds.has(line.id)) : changedLines;
  return targetLines.map((line) => (line.kind === "add" ? "+ " : "- ") + line.text).join("\n");
}

// change_idからコメント対象の行を全ファイル横断で探す。写せない古いコメントはファイルパスとrepoで代わりに絞り込む
function findCommentTarget(files, comment) {
  if (comment.change_id != null) {
    for (const file of files) {
      const line = file.lines.find((candidate) => candidate.id === comment.change_id);
      if (line) return { file, line };
    }
  }
  const matchedFiles = files.filter((file) => file.file === comment.file);
  const file = comment.repo != null
    ? matchedFiles.find((matchedFile) => matchedFile.repo === comment.repo) || null
    : matchedFiles[0] || null;
  return { file, line: null };
}

function buildAskPrompt(targetDir, comment, changes) {
  const resolvedChanges = changes || readJson(path.join(targetDir, "changes.json"), { files: [] });
  const steps = readJson(path.join(targetDir, "steps.json"), { steps: [] });
  const target = findCommentTarget(resolvedChanges.files, comment);
  const step = (steps.steps || []).find((candidate) => (candidate.order != null ? candidate.order : 0) === comment.step_order);
  const resolvedStep = step ? resolveSteps(resolvedChanges.files, [step]).resolvedSteps[0] : null;
  const ownedIds = resolvedStep ? new Set([...resolvedStep.owns, ...resolvedStep.refs]) : null;
  if (ownedIds && target.line) ownedIds.add(target.line.id);
  const diffText = target.file ? buildFileDiffText(target.file, ownedIds) : "";
  const narration = step ? step.narration : "";
  const repo = target.file ? target.file.repo : comment.repo;
  const repoTag = repo && repo !== "." ? repo + " " : "";
  const promptLines = [
    "以下のコード差分について、レビュアーからの質問に簡潔に答えてください",
    "",
    "ファイル " + repoTag + comment.file,
    "ストーリーの説明 " + narration,
  ];
  if (target.line) {
    promptLines.push("", "質問対象の行 " + (target.line.kind === "add" ? "+ " : "- ") + target.line.text);
  }
  promptLines.push("", "該当の差分", diffText, "", "質問 " + comment.body);
  return promptLines.join("\n");
}

function askHaiku(cwd, sessionId, prompt, onResult) {
  const claudeArgs = ["-p", "--resume", sessionId, "--model", "haiku", "--no-session-persistence", "--output-format", "json", prompt];
  const child = spawn("claude", claudeArgs, { cwd });
  const stdoutChunks = [];
  let isResultSent = false;
  const sendResultOnce = (result) => {
    if (isResultSent) return;
    isResultSent = true;
    onResult(result);
  };
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.resume();
  child.on("close", () => {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
    } catch (error) {
      sendResultOnce("");
      return;
    }
    sendResultOnce(parsed.result || "");
  });
  child.on("error", () => sendResultOnce(""));
}

// changes.json の cwd。無ければ現在の作業ディレクトリを使う
function resolveCwd(changes) {
  return (changes && changes.cwd) || process.cwd();
}

// haiku に渡す cwd とプロンプトを組み立てる。changes.json か steps.json が壊れていれば例外を投げる
function buildHaikuRequest(targetDir, comment) {
  const changes = readJson(path.join(targetDir, "changes.json"), { files: [] });
  return { cwd: resolveCwd(changes), prompt: buildAskPrompt(targetDir, comment, changes) };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function openBrowser(targetUrl) {
  const opener = fs.existsSync("/usr/bin/open") ? "/usr/bin/open" : "xdg-open";
  const child = spawn(opener, [targetUrl], { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.log("ブラウザを自動で開けませんでした: " + targetUrl);
  });
  child.unref();
}

function listenOnFreePort(server, startPort, bindHost, onResult) {
  let port = startPort;
  const tryListen = () => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        port += 1;
        tryListen();
      } else {
        throw error;
      }
    });
    server.listen(port, bindHost, () => onResult(port));
  };
  tryListen();
}

function readServeInfo(targetDir) {
  return readJson(path.join(targetDir, "serve.json"), null);
}

function writeServeInfo(targetDir, info) {
  writeFileAtomic(path.join(targetDir, "serve.json"), JSON.stringify(info, null, 2));
}

// リクエスト処理中のエラーをserve.logに追記する。応答は変えない
function appendServeLog(targetDir, message) {
  fs.appendFileSync(path.join(targetDir, "serve.log"), message + "\n");
}

function runServeDaemon(targetDir, requestedPort, bindHost, sessionId) {
  let isFollowRunning = false;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { pid: process.pid });
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(VIEWER_HTML);
        return;
      }
      if (request.method === "GET" && request.url === "/story.json") {
        sendJson(response, 200, buildStory(targetDir));
        return;
      }
      if (request.method === "POST" && request.url === "/comments") {
        const body = await readBody(request);
        const { comment, commentNumber } = appendComment(targetDir, body);
        const info = readServeInfo(targetDir);
        let haikuRequest = null;
        if (info != null && info.session_id != null) {
          try {
            haikuRequest = buildHaikuRequest(targetDir, comment);
          } catch (error) {
            appendServeLog(targetDir, "haiku返信の準備に失敗しました: " + String(error && error.message ? error.message : error));
          }
        }
        sendJson(response, 200, comment);
        if (haikuRequest != null) {
          askHaiku(haikuRequest.cwd, info.session_id, haikuRequest.prompt, (answer) => {
            if (answer === "") return;
            appendReply(targetDir, commentNumber, answer);
          });
        }
        return;
      }
      if (request.method === "POST" && request.url === "/done") {
        fs.writeFileSync(path.join(targetDir, "done.flag"), new Date().toISOString());
        sendJson(response, 200, { done: true });
        return;
      }
      if (request.method === "POST" && request.url === "/close") {
        fs.writeFileSync(path.join(targetDir, "close.flag"), new Date().toISOString());
        sendJson(response, 200, { closed: true });
        return;
      }
      if (request.method === "POST" && request.url === "/follow") {
        if (isFollowRunning) {
          sendJson(response, 409, { started: false, error: "差分の取り込みが実行中です" });
          return;
        }
        let logFd;
        try {
          logFd = fs.openSync(path.join(targetDir, "serve.log"), "a");
        } catch (error) {
          sendJson(response, 500, { error: String(error && error.message ? error.message : error) });
          return;
        }
        let cwd;
        try {
          cwd = resolveCwd(readJson(path.join(targetDir, "changes.json"), {}));
        } catch (error) {
          fs.closeSync(logFd);
          sendJson(response, 500, { error: String(error && error.message ? error.message : error) });
          return;
        }
        const child = spawn(process.execPath, [__filename, "prep", path.resolve(targetDir)], { cwd, stdio: ["ignore", logFd, logFd], detached: true });
        isFollowRunning = true;
        let stopped = false;
        const stopFollowing = () => {
          if (stopped) return;
          stopped = true;
          isFollowRunning = false;
          fs.closeSync(logFd);
        };
        child.on("error", (error) => {
          fs.writeSync(logFd, "prep起動失敗: " + String(error && error.message ? error.message : error) + "\n");
          stopFollowing();
        });
        child.on("exit", (exitCode, signal) => {
          if (signal != null) fs.writeSync(logFd, "prep異常終了: シグナル" + signal + "\n");
          else if (exitCode !== 0) fs.writeSync(logFd, "prep異常終了: 終了コード" + exitCode + "\n");
          stopFollowing();
        });
        child.unref();
        sendJson(response, 200, { started: true });
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (response.headersSent) {
        appendServeLog(targetDir, "応答済みのリクエストでエラーが発生しました: " + message);
        return;
      }
      sendJson(response, 500, { error: message });
    }
  });

  const startPort = requestedPort || 4711;
  const displayHost = bindHost === "0.0.0.0" ? os.hostname() : bindHost;
  listenOnFreePort(server, startPort, bindHost, (port) => {
    const url = "http://" + displayHost + ":" + port + "/";
    writeServeInfo(targetDir, { pid: process.pid, port, host: bindHost, url, session_id: sessionId, started_at: new Date().toISOString() });
    console.log("storiff serve: " + url);
    console.log("レビュー完了(done.flag)を待ちます。終了(close.flag)でサーバを閉じます");
  });

  const closePath = path.join(targetDir, "close.flag");
  const watcher = setInterval(() => {
    if (fs.existsSync(closePath)) {
      console.log("終了の合図を検知しました。サーバを終了します");
      clearInterval(watcher);
      server.close(() => {
        try {
          fs.unlinkSync(path.join(targetDir, "serve.json"));
        } catch (error) {
        }
        process.exit(0);
      });
    }
  }, 1000);
}

function isServeAlive(info, onResult) {
  if (info == null || info.pid == null || info.port == null) {
    onResult(false);
    return;
  }
  try {
    process.kill(info.pid, 0);
  } catch (error) {
    onResult(false);
    return;
  }
  let isResultSent = false;
  const sendResultOnce = (isAlive) => {
    if (isResultSent) return;
    isResultSent = true;
    onResult(isAlive);
  };
  const requestHost = info.host === "0.0.0.0" ? "127.0.0.1" : info.host;
  const request = http.get({ host: requestHost, port: info.port, path: "/health", timeout: 1000 }, (response) => {
    sendResultOnce(response.statusCode === 200);
    response.resume();
  });
  request.on("error", () => sendResultOnce(false));
  request.on("timeout", () => {
    request.destroy();
    sendResultOnce(false);
  });
}

function startServeDaemon(targetDir, requestedPort, bindHost, sessionId) {
  const daemonArgs = ["serve", targetDir, "--daemon", "--host", bindHost];
  if (requestedPort != null) {
    daemonArgs.push("--port", String(requestedPort));
  }
  if (sessionId != null) {
    daemonArgs.push("--session-id", sessionId);
  }
  const logFd = fs.openSync(path.join(targetDir, "serve.log"), "a");
  const child = spawn(process.execPath, [__filename, ...daemonArgs], { stdio: ["ignore", logFd, logFd], detached: true });
  child.on("error", () => {
    console.log("ビューアを起動できませんでした");
  });
  child.unref();
  const waitStartedAt = Date.now();
  const waiter = setInterval(() => {
    const info = readServeInfo(targetDir);
    if (info != null && info.pid === child.pid) {
      clearInterval(waiter);
      console.log("storiff serve: " + info.url);
      openBrowser(info.url);
      process.exit(0);
    }
    if (Date.now() - waitStartedAt > SERVE_START_TIMEOUT_MSEC) {
      clearInterval(waiter);
      console.log("ビューアの起動に失敗しました");
      process.exit(1);
    }
  }, SERVE_POLL_INTERVAL_MSEC);
}

const VIEWER_SCRIPT = `
var story=null, stepIndex=0, commentsByKey={}, lostCommentsByStep={};
// 表示の種類 unified か split。既定は左右並列。stepを移動しても保つ
var viewMode='split';
// 変更行の周囲に残す無変更行の数
var CONTEXT_LINES=3;
// 差分を取り込むボタンを再度押せるようにするまでの待ち時間
var FOLLOW_COOLDOWN_MSEC=5000;

function esc(text){var div=document.createElement('div');div.textContent=text==null?'':String(text);return div.innerHTML;}
// 先にHTMLエスケープしてから \`code\` と **強調** を効かせる
function formatInline(rawText){
  var html=esc(rawText);
  html=html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  html=html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  return html;
}
// 簡易 markdown を要素に描画する。改行と行頭 - の箇条書きに対応
function renderMarkdown(container, text){
  container.innerHTML='';
  var lines=String(text==null?'':text).split('\\n');
  var bulletItems=null;
  function flushBullets(){
    if(!bulletItems) return;
    var listElement=document.createElement('ul');
    listElement.className='md-list';
    listElement.innerHTML=bulletItems.join('');
    container.appendChild(listElement);
    bulletItems=null;
  }
  lines.forEach(function(line){
    var bulletMatch=line.match(/^\\s*-\\s+(.*)$/);
    if(bulletMatch){
      if(!bulletItems) bulletItems=[];
      bulletItems.push('<li>'+formatInline(bulletMatch[1])+'</li>');
      return;
    }
    flushBullets();
    var paragraph=document.createElement('div');
    paragraph.className='md-line';
    paragraph.innerHTML=line.trim()===''?'&nbsp;':formatInline(line);
    container.appendChild(paragraph);
  });
  flushBullets();
}
function commentKey(file, changeId){return file + '#' + changeId;}
function stepNumber(step, index){return step.order!=null?step.order:index+1;}
function indexComments(){
  commentsByKey={};
  lostCommentsByStep={};
  var stepOrders=(story.steps||[]).map(function(step, index){return stepNumber(step, index);});
  var lastStepOrder=stepOrders.length>0?stepOrders[stepOrders.length-1]:null;
  (story.comments||[]).forEach(function(comment){
    if(comment.change_id==null){
      var stepOrder=comment.step_order;
      if(lastStepOrder!=null&&stepOrders.indexOf(stepOrder)===-1) stepOrder=lastStepOrder;
      if(!lostCommentsByStep[stepOrder]) lostCommentsByStep[stepOrder]=[];
      lostCommentsByStep[stepOrder].push(comment);
      return;
    }
    var key=commentKey(comment.file, comment.change_id);
    if(!commentsByKey[key]) commentsByKey[key]=[];
    commentsByKey[key].push(comment);
  });
}
function renderStepList(){
  var list=document.getElementById('stepList');
  list.innerHTML='';
  story.steps.forEach(function(step, index){
    var item=document.createElement('button');
    item.className='step-item'+(index===stepIndex?' active':'');
    var numberLabel=document.createElement('span');
    numberLabel.className='step-num';
    numberLabel.textContent=index+1;
    var titleLabel=document.createElement('span');
    titleLabel.className='step-item-title';
    titleLabel.textContent=step.title;
    item.appendChild(numberLabel);
    item.appendChild(titleLabel);
    item.onclick=function(){stepIndex=index;render();window.scrollTo(0,0);};
    list.appendChild(item);
  });
}
function renderBanner(){
  var banner=document.getElementById('banner');
  banner.innerHTML='';
  var validation=story.validation||{ok:true};
  if(validation.ok) return;
  var parts=['ストーリーが全変更を過不足なく説明できていません'];
  if(validation.missing&&validation.missing.length>0) parts.push('説明もれの変更ID '+validation.missing.join(', '));
  if(validation.duplicated&&validation.duplicated.length>0) parts.push('重複所有の変更ID '+validation.duplicated.join(', '));
  if(validation.unknown_files&&validation.unknown_files.length>0) parts.push('不明なファイル '+validation.unknown_files.join(', '));
  var box=document.createElement('div');
  box.className='banner';
  box.textContent=parts.join(' / ');
  banner.appendChild(box);
}
function lineClass(line, ownsSet, refsSet){
  var kindClass=line.kind==='add'?'add':(line.kind==='del'?'del':'context');
  if(line.id!=null&&ownsSet[line.id]) return kindClass+' own';
  if(line.id!=null&&refsSet[line.id]) return kindClass+' ref';
  if(line.kind!=='context') return kindClass+' other';
  return kindClass;
}
function marker(kind){return kind==='add'?'+':(kind==='del'?'-':' ');}
function renderComment(comment){
  var box=document.createElement('div');
  box.className='comment';
  var bodyLine=document.createElement('div');
  bodyLine.className='comment-body';
  bodyLine.textContent=comment.body;
  box.appendChild(bodyLine);
  (comment.replies||[]).forEach(function(reply){
    var replyBox=document.createElement('div');
    replyBox.className='reply';
    var author=document.createElement('span');
    author.className='reply-author';
    author.textContent=reply.author==='ai'?'AI':(reply.author||'');
    var replyBody=document.createElement('div');
    replyBody.className='reply-body';
    renderMarkdown(replyBody, reply.body);
    replyBox.appendChild(author);
    replyBox.appendChild(replyBody);
    box.appendChild(replyBox);
  });
  return box;
}
function openForm(row, line, file, stepOrder, repo){
  if(row.nextSibling&&row.nextSibling.className==='comment-form') return;
  var openedMinimapSignature=minimapSignature;
  var form=document.createElement('div');
  form.className='comment-form';
  var input=document.createElement('input');
  input.placeholder='この行へのコメントを書く';
  var sendButton=document.createElement('button');
  sendButton.textContent='送信';
  sendButton.onclick=function(){
    var body=input.value.trim();
    if(!body) return;
    if(minimapSignature!==openedMinimapSignature){
      form.parentNode.removeChild(form);
      var msg=document.getElementById('doneMsg');
      msg.textContent='差分が更新されたためコメント欄を閉じました。もう一度開いて書いてください';
      msg.style.display='block';
      return;
    }
    var payload={change_id:line.id, file:file, repo:repo, line:(line.new==null?line.old:line.new), step_order:stepOrder, body:body};
    fetch('/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(res){return res.json();})
      .then(function(saved){
        var key=commentKey(file, line.id);
        if(!commentsByKey[key]) commentsByKey[key]=[];
        commentsByKey[key].push(saved);
        form.parentNode.insertBefore(renderComment(saved), form);
        form.parentNode.removeChild(form);
      });
  };
  form.appendChild(input);
  form.appendChild(sendButton);
  row.parentNode.insertBefore(form, row.nextSibling);
  input.focus();
}
// 拡張子から highlight.js の言語名を得る
var LANGUAGE_BY_EXT={js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',rb:'ruby',go:'go',rs:'rust',java:'java',c:'c',h:'c',cpp:'cpp',hpp:'cpp',cs:'csharp',php:'php',pl:'perl',pm:'perl',sh:'bash',bash:'bash',zsh:'bash',json:'json',yml:'yaml',yaml:'yaml',html:'xml',xml:'xml',vue:'xml',css:'css',scss:'scss',sql:'sql',md:'markdown'};
function languageOf(filePath){
  var ext=String(filePath).split('.').pop().toLowerCase();
  return LANGUAGE_BY_EXT[ext]||null;
}
// 対応言語なら色付けし、未対応やライブラリ未読込ならエスケープだけする
function highlightText(text, language){
  if(!language||typeof hljs==='undefined') return esc(text);
  try{return hljs.highlight(String(text==null?'':text), {language:language, ignoreIllegal:true}).value;}
  catch(error){return esc(text);}
}
// 差分1行のマス目を作る。lineがnullなら片側だけの空マス
function buildCell(line, ownsSet, refsSet, file){
  var cell=document.createElement('div');
  if(!line){cell.className='line empty'; return cell;}
  cell.className='line '+lineClass(line, ownsSet, refsSet);
  if(line.id!=null) cell.dataset.id=line.id;
  var lineNumber=(line.new==null?(line.old==null?'':line.old):line.new);
  var numberLabel=document.createElement('span');
  numberLabel.className='num';
  numberLabel.textContent=lineNumber;
  var markerLabel=document.createElement('span');
  markerLabel.className='mark';
  markerLabel.textContent=marker(line.kind);
  var textLabel=document.createElement('span');
  textLabel.className='txt';
  textLabel.innerHTML=highlightText(line.text, languageOf(file.file));
  cell.appendChild(numberLabel);
  cell.appendChild(markerLabel);
  cell.appendChild(textLabel);
  return cell;
}
// その行に付いた既存コメントを親要素に追加する
function appendExistingComments(parent, line, file){
  if(!line||line.id==null) return;
  var existing=commentsByKey[commentKey(file.file, line.id)]||[];
  existing.forEach(function(comment){parent.appendChild(renderComment(comment));});
}
// 統合表示の1行を追加する。クリックでコメント欄を開く
function appendLine(parent, line, file, stepOrder, ownsSet, refsSet){
  var row=buildCell(line, ownsSet, refsSet, file);
  if(line.id!=null){
    row.className+=' clickable';
    row.onclick=function(){openForm(row, line, file.file, stepOrder, file.repo);};
  }
  parent.appendChild(row);
  appendExistingComments(parent, line, file);
}
// 左右並列の1行を追加する。左は変更前、右は変更後
function appendSplitRow(parent, splitLine, file, stepOrder, ownsSet, refsSet){
  var rowElement=document.createElement('div');
  rowElement.className='split-row';
  [splitLine.left, splitLine.right].forEach(function(line){
    var cell=buildCell(line, ownsSet, refsSet, file);
    if(line&&line.id!=null){
      cell.className+=' clickable';
      cell.onclick=function(){openForm(rowElement, line, file.file, stepOrder, file.repo);};
    }
    rowElement.appendChild(cell);
  });
  parent.appendChild(rowElement);
  appendExistingComments(parent, splitLine.left, file);
  appendExistingComments(parent, splitLine.right, file);
}
// 連続した無変更行を1行に畳む。クリックで中身を開く
function appendFold(parent, hiddenCount, appendHidden){
  var foldRow=document.createElement('div');
  foldRow.className='fold';
  foldRow.textContent='⋯ '+hiddenCount+' 行を表示 ⋯';
  foldRow.onclick=function(){
    var fragment=document.createDocumentFragment();
    appendHidden(fragment);
    parent.insertBefore(fragment, foldRow);
    parent.removeChild(foldRow);
  };
  parent.appendChild(foldRow);
}
// del行とadd行を突き合わせ、左右並列の行の並びを作る
function buildSplitLines(lines, visible){
  var splitLines=[];
  var delLines=[];
  var addLines=[];
  function flush(){
    var pairCount=Math.max(delLines.length, addLines.length);
    for(var pairIndex=0; pairIndex<pairCount; pairIndex++){
      var leftItem=delLines[pairIndex]||null;
      var rightItem=addLines[pairIndex]||null;
      var shown=(leftItem&&leftItem.visible)||(rightItem&&rightItem.visible);
      splitLines.push({left:leftItem?leftItem.line:null, right:rightItem?rightItem.line:null, visible:!!shown});
    }
    delLines=[];
    addLines=[];
  }
  for(var index=0; index<lines.length; index++){
    var line=lines[index];
    if(line.kind==='del'){delLines.push({line:line, visible:visible[index]}); continue;}
    if(line.kind==='add'){addLines.push({line:line, visible:visible[index]}); continue;}
    flush();
    splitLines.push({left:line, right:line, visible:!!visible[index]});
  }
  flush();
  return splitLines;
}
// owns行とrefs行の周囲だけを表示対象にする
function computeVisible(lines, ownsSet, refsSet){
  var visible=new Array(lines.length);
  for(var index=0; index<lines.length; index++){
    var line=lines[index];
    if(line.id!=null&&(ownsSet[line.id]||refsSet[line.id])){
      var from=Math.max(0, index-CONTEXT_LINES);
      var to=Math.min(lines.length-1, index+CONTEXT_LINES);
      for(var mark=from; mark<=to; mark++) visible[mark]=true;
    }
  }
  return visible;
}
// owns_files の1項目がこのファイルを指すか。repo::path 形式にも対応
function matchesOwnsEntry(file, entry){
  var separator=entry.indexOf('::');
  var wantRepo=separator===-1?null:entry.slice(0, separator);
  var wantFile=separator===-1?entry:entry.slice(separator+2);
  return file.file===wantFile&&(wantRepo==null||file.repo===wantRepo);
}
// ファイル内で最初に登場する owns の変更ID。無ければ末尾に回す
function firstOwnedId(file, ownsSet){
  for(var index=0; index<file.lines.length; index++){
    var line=file.lines[index];
    if(line.id!=null&&ownsSet[line.id]) return line.id;
  }
  return Infinity;
}
// 表示するファイルを owns_files の並び順にし、残りは最初の変更ID順で後ろに続ける
function orderedFiles(shownFiles, step, ownsSet){
  var orderedByOwnsFiles=[];
  (step.owns_files||[]).forEach(function(entry){
    shownFiles.forEach(function(file){
      if(orderedByOwnsFiles.indexOf(file)===-1&&matchesOwnsEntry(file, entry)) orderedByOwnsFiles.push(file);
    });
  });
  var restFiles=shownFiles.filter(function(file){return orderedByOwnsFiles.indexOf(file)===-1;});
  restFiles.sort(function(fileA, fileB){return firstOwnedId(fileA, ownsSet)-firstOwnedId(fileB, ownsSet);});
  return orderedByOwnsFiles.concat(restFiles);
}
// そのファイルへの file_notes の説明文。repo::path を優先し path でも引く
function fileNote(step, file){
  var notes=step.file_notes||{};
  var repoKey=file.repo+'::'+file.file;
  if(notes[repoKey]!=null) return notes[repoKey];
  if(notes[file.file]!=null) return notes[file.file];
  return null;
}
function renderFile(file, step, ownsSet, refsSet){
  var card=document.createElement('div');
  card.className='file';
  var heading=document.createElement('div');
  heading.className='file-head';
  if(file.repo&&file.repo!=='.'){
    var repoTag=document.createElement('span');
    repoTag.className='repo';
    repoTag.textContent=file.repo;
    heading.appendChild(repoTag);
  }
  var pathLabel=document.createElement('span');
  pathLabel.className='path';
  pathLabel.textContent=file.file;
  var statusLabel=document.createElement('span');
  statusLabel.className='status status-'+file.status;
  statusLabel.textContent=file.status;
  heading.appendChild(pathLabel);
  heading.appendChild(statusLabel);
  card.appendChild(heading);
  var note=fileNote(step, file);
  if(note!=null){
    var noteBox=document.createElement('div');
    noteBox.className='file-note';
    renderMarkdown(noteBox, note);
    card.appendChild(noteBox);
  }
  var code=document.createElement('div');
  code.className=viewMode==='split'?'code split':'code';
  var stepOrder=stepNumber(step, stepIndex);
  var visible=computeVisible(file.lines, ownsSet, refsSet);
  if(viewMode==='split') renderSplitCode(code, file, stepOrder, ownsSet, refsSet, visible);
  else renderUnifiedCode(code, file, stepOrder, ownsSet, refsSet, visible);
  card.appendChild(code);
  return card;
}
function renderUnifiedCode(code, file, stepOrder, ownsSet, refsSet, visible){
  var index=0;
  while(index<file.lines.length){
    if(!visible[index]){
      var start=index;
      while(index<file.lines.length&&!visible[index]) index++;
      (function(fromIndex, toIndex){
        appendFold(code, toIndex-fromIndex+1, function(fragment){
          for(var hidden=fromIndex; hidden<=toIndex; hidden++){
            appendLine(fragment, file.lines[hidden], file, stepOrder, ownsSet, refsSet);
          }
        });
      })(start, index-1);
    }else{
      appendLine(code, file.lines[index], file, stepOrder, ownsSet, refsSet);
      index++;
    }
  }
}
function renderSplitCode(code, file, stepOrder, ownsSet, refsSet, visible){
  var splitLines=buildSplitLines(file.lines, visible);
  var index=0;
  while(index<splitLines.length){
    if(!splitLines[index].visible){
      var start=index;
      while(index<splitLines.length&&!splitLines[index].visible) index++;
      (function(fromIndex, toIndex){
        appendFold(code, toIndex-fromIndex+1, function(fragment){
          for(var hidden=fromIndex; hidden<=toIndex; hidden++){
            appendSplitRow(fragment, splitLines[hidden], file, stepOrder, ownsSet, refsSet);
          }
        });
      })(start, index-1);
    }else{
      appendSplitRow(code, splitLines[index], file, stepOrder, ownsSet, refsSet);
      index++;
    }
  }
}
var minimapBuiltSignature=null, mmStepById={};
const MM_SCALE = 0.15;

function buildMinimap(){
  var inner=document.getElementById('minimapInner');
  if(minimapBuiltSignature===minimapSignature) return;
  inner.innerHTML='';

  mmStepById={};
  (story.steps||[]).forEach(function(step, stepPosition){
    (step.owns||[]).forEach(function(id){ mmStepById[id]=stepPosition; });
  });

  var mapContainer = document.createElement('div');
  mapContainer.className = 'mm-full-diff';

  var html = '';
  (story.files||[]).forEach(function(file){
    html += '<div class="mm-file" data-filename="'+esc(file.file)+'"><div class="mm-file-code">';
    file.lines.forEach(function(line){
      var cls = line.kind === 'add' ? 'mm-add' : (line.kind === 'del' ? 'mm-del' : 'mm-ctx');
      html += '<div class="mm-line ' + cls + '" ' + (line.id != null ? 'data-id="'+line.id+'"' : '') + '>' + esc(line.text||' ') + '</div>';
    });
    html += '</div></div>';
  });

  mapContainer.innerHTML = html;

  var wrap = document.createElement('div');
  wrap.id = 'mmWrap';
  wrap.style.width = (100 / MM_SCALE) + '%';
  wrap.style.transformOrigin = 'top left';
  wrap.style.transform = 'scale(' + MM_SCALE + ')';
  wrap.appendChild(mapContainer);

  inner.appendChild(wrap);

  var band = document.createElement('div');
  band.id = 'mmViewport';
  band.className = 'mm-viewport';
  band.style.display = 'none';
  inner.appendChild(band);
  minimapBuiltSignature=minimapSignature;
}

function updateMinimapViewport(){
  if(!minimapBuiltSignature) return;
  var cells = document.querySelectorAll('#diff .line[data-id]');
  var windowHeight = window.innerHeight;
  var topId = null, bottomId = null;
  var minTop = Infinity, maxBottom = -Infinity;

  cells.forEach(function(cell) {
    var rect = cell.getBoundingClientRect();
    if(rect.bottom > 0 && rect.top < windowHeight) {
      if(rect.top < minTop) { minTop = rect.top; topId = cell.dataset.id; }
      if(rect.bottom > maxBottom) { maxBottom = rect.bottom; bottomId = cell.dataset.id; }
    }
  });

  var band = document.getElementById('mmViewport');
  if(!topId) { band.style.display = 'none'; return; }

  var topEl = document.querySelector('.mm-full-diff .mm-line[data-id="'+topId+'"]');
  var bottomEl = bottomId ? document.querySelector('.mm-full-diff .mm-line[data-id="'+bottomId+'"]') : topEl;

  if(topEl && bottomEl) {
    var top = topEl.offsetTop * MM_SCALE;
    var bottom = (bottomEl.offsetTop + bottomEl.offsetHeight) * MM_SCALE;

    band.style.display = 'block';
    band.style.top = top + 'px';
    band.style.height = Math.max(10, bottom - top) + 'px';

    var inner = document.getElementById('minimapInner');
    var targetScroll = top - (inner.clientHeight / 2);
    inner.scrollTop = targetScroll;
  }
}

function minimapJump(clientY){
  if(!minimapBuiltSignature) return;
  var inner = document.getElementById('minimapInner');
  var rect = inner.getBoundingClientRect();
  var clickY = clientY - rect.top + inner.scrollTop;
  var targetY = clickY / MM_SCALE;

  var lines = document.querySelectorAll('.mm-full-diff .mm-line[data-id]');
  var closestId = null;
  var minDist = Infinity;
  lines.forEach(function(line) {
    var dist = Math.abs(line.offsetTop - targetY);
    if(dist < minDist) { minDist = dist; closestId = line.dataset.id; }
  });

  if(closestId) {
    var targetStep = mmStepById[closestId];
    if(targetStep != null && targetStep !== stepIndex) {
      stepIndex = targetStep;
      render();
    }
    setTimeout(function(){
      var element = document.querySelector('#diff .line[data-id="'+closestId+'"]');
      if(element) element.scrollIntoView({block:'center'});
    }, 50);
  }
}

function render(){
  var step=story.steps[stepIndex];
  document.getElementById('storyTitle').textContent=story.title||'storiff';
  document.getElementById('stepTitle').textContent=step?step.title:'ステップがありません';
  renderMarkdown(document.getElementById('narration'), step?step.narration:'');
  document.getElementById('counter').textContent='Step '+(step?stepNumber(step, stepIndex):0)+' / '+story.steps.length;
  document.getElementById('prevBtn').disabled=stepIndex<=0;
  document.getElementById('nextBtn').disabled=stepIndex>=story.steps.length-1;
  renderStepList();
  renderBanner();
  var diff=document.getElementById('diff');
  diff.innerHTML='';
  if(!step) return;
  var ownsSet={}; (step.owns||[]).forEach(function(id){ownsSet[id]=true;});
  var refsSet={}; (step.refs||[]).forEach(function(id){refsSet[id]=true;});
  var shownFiles=story.files.filter(function(file){
    return file.lines.some(function(line){return line.id!=null&&(ownsSet[line.id]||refsSet[line.id]);});
  });
  orderedFiles(shownFiles, step, ownsSet).forEach(function(file){
    diff.appendChild(renderFile(file, step, ownsSet, refsSet));
  });
  var lostComments=lostCommentsByStep[stepNumber(step, stepIndex)]||[];
  if(lostComments.length>0){
    var lostBox=document.createElement('div');
    lostBox.className='file';
    var lostHeading=document.createElement('div');
    lostHeading.className='file-head lost-comments-heading';
    lostHeading.textContent='修正で無くなった行へのコメント';
    lostBox.appendChild(lostHeading);
    lostComments.forEach(function(comment){lostBox.appendChild(renderComment(comment));});
    diff.appendChild(lostBox);
  }
  buildMinimap();
  updateMinimapViewport();
}
document.getElementById('prevBtn').onclick=function(){if(stepIndex>0){stepIndex--;render();window.scrollTo(0,0);}};
document.getElementById('nextBtn').onclick=function(){if(stepIndex<story.steps.length-1){stepIndex++;render();window.scrollTo(0,0);}};
document.getElementById('followBtn').onclick=function(){
  var followBtn=document.getElementById('followBtn');
  var msg=document.getElementById('doneMsg');
  followBtn.disabled=true;
  msg.textContent='差分を取り込んでいます';
  msg.style.display='block';
  fetch('/follow',{method:'POST'}).then(function(response){
    return response.json().then(function(body){
      if(!response.ok) throw new Error(body.error||'差分の取り込みに失敗しました');
      msg.textContent='差分の取り込みを始めました。まもなく反映されます';
      setTimeout(function(){followBtn.disabled=false;}, FOLLOW_COOLDOWN_MSEC);
    });
  }).catch(function(error){
    msg.textContent=error instanceof TypeError?'差分の取り込みに失敗しました。サーバが起動しているか確認してください':error.message;
    msg.style.display='block';
    followBtn.disabled=false;
  });
};
document.getElementById('doneBtn').onclick=function(){
  fetch('/done',{method:'POST'}).then(function(){
    var msg=document.getElementById('doneMsg');
    msg.textContent='コメントを送信しました。AIの返信がまもなく各コメントの下に表示されます';
    msg.style.display='block';
  });
};
document.getElementById('closeBtn').onclick=function(){
  fetch('/close',{method:'POST'}).then(function(){
    var msg=document.getElementById('doneMsg');
    msg.textContent='レビューを終了しました。このタブは閉じてかまいません';
    msg.style.display='block';
  });
};
function setViewMode(mode){
  viewMode=mode;
  document.getElementById('unifiedBtn').className='view-toggle-btn'+(mode==='unified'?' active':'');
  document.getElementById('splitBtn').className='view-toggle-btn'+(mode==='split'?' active':'');
  render();
}
document.getElementById('unifiedBtn').onclick=function(){setViewMode('unified');};
document.getElementById('splitBtn').onclick=function(){setViewMode('split');};
document.querySelector('.minimap').onclick=function(event){minimapJump(event.clientY);};
document.querySelector('.minimap').addEventListener('mousemove', function(event){
  if(!minimapBuiltSignature) return;
  var inner = document.getElementById('minimapInner');
  var rect = inner.getBoundingClientRect();
  var clickY = event.clientY - rect.top + inner.scrollTop;
  var targetY = clickY / MM_SCALE;

  var lines = document.querySelectorAll('.mm-full-diff .mm-line[data-id]');
  var closestId = null;
  var minDist = Infinity;
  lines.forEach(function(line) {
    var dist = Math.abs(line.offsetTop - targetY);
    if(dist < minDist && dist < 150) { minDist = dist; closestId = line.dataset.id; }
  });

  if(closestId) {
    var stepPos = mmStepById[closestId];
    var stepObj = story.steps[stepPos];
    var fileName = 'Unknown';
    for(var index=0;index<story.files.length;index++){
      if(story.files[index].lines.some(function(line){return line.id==closestId;})){fileName=story.files[index].file;break;}
    }
    var popup=document.getElementById('mmPopup');
    popup.innerHTML='<div style="font-weight:700;margin-bottom:4px">'+esc(fileName)+'</div>'+(stepObj?'<div style="color:var(--text-soft)">Step '+(stepPos+1)+': '+esc(stepObj.title)+'</div>':'');
    popup.style.display='block';
    popup.style.top=(event.clientY+15)+'px';
    popup.style.right=(window.innerWidth-event.clientX+15)+'px';
  } else {
    document.getElementById('mmPopup').style.display='none';
  }
});
document.querySelector('.minimap').addEventListener('mouseleave', function(){
  document.getElementById('mmPopup').style.display='none';
});
window.addEventListener('scroll', updateMinimapViewport);
window.addEventListener('resize', updateMinimapViewport);
document.addEventListener('keydown', function(event){
  var tag=event.target&&event.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;
  if(event.key==='ArrowLeft'&&stepIndex>0){stepIndex--;render();window.scrollTo(0,0);}
  if(event.key==='ArrowRight'&&stepIndex<story.steps.length-1){stepIndex++;render();window.scrollTo(0,0);}
});
// ステップの番号とownsの中身、変更IDの件数を並べた文字列。ミニマップの中身はこれだけで決まる
function minimapFingerprint(){
  var stepPart=(story.steps||[]).map(function(step){return step.order+':'+(step.owns||[]).join(',');}).join('|');
  var changePart=(story.change_ids||[]).length;
  return stepPart+'@'+changePart;
}
// ミニマップ用の指紋に題名・タイトル・説明文・refsの件数・コメントと返信の件数を加えた文字列。差分や追従、説明文の書き換えによる変化の検知に使う
function storyFingerprint(minimapPart){
  var stepPart=(story.steps||[]).map(function(step){return step.order+':'+step.title+':'+step.narration+':'+(step.refs||[]).length;}).join('|');
  var comments=story.comments||[];
  var commentPart=comments.length+'#'+comments.map(function(comment){return (comment.replies||[]).length;}).join(',');
  return minimapPart+'@'+story.title+'@'+stepPart+'@'+commentPart;
}
var storySignature='';
var minimapSignature='';
fetch('/story.json').then(function(res){return res.json();}).then(function(data){
  story=data; indexComments();
  minimapSignature=minimapFingerprint();
  storySignature=storyFingerprint(minimapSignature);
  render();
});
// AI の返信や追従による差分・ステップの変化を拾うため story.json を定期取得し、変化があれば再描画する
setInterval(function(){
  fetch('/story.json').then(function(res){return res.json();}).then(function(data){
    story=data; indexComments();
    if((story.steps||[]).length>0){
      if(stepIndex>=story.steps.length) stepIndex=story.steps.length-1;
      if(stepIndex<0) stepIndex=0;
    }
    var latestMinimap=minimapFingerprint();
    minimapSignature=latestMinimap;
    var latest=storyFingerprint(latestMinimap);
    if(latest===storySignature) return;
    if(document.querySelector('.comment-form')) return;
    storySignature=latest;
    var scrollY=window.scrollY;
    render();
    window.scrollTo(0, scrollY);
  });
}, 3000);
`;

const VIEWER_HTML = `<!doctype html>
<html lang='ja'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>storiff</title>
<link rel='stylesheet' href='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css' media='(prefers-color-scheme: light)'>
<link rel='stylesheet' href='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css' media='(prefers-color-scheme: dark)'>
<script src='https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js'></script>
<style>
:root{
  --sidebar-width:280px;
  --minimap-width:140px;
  --text-main:#1f2328;
  --text-soft:#59636e;
  --border:#d1d9e0;
  --border-soft:#e6eaef;
  --surface:#ffffff;
  --surface-soft:#f6f8fa;
  --accent:#3d5afe;
  --accent-soft:#eef1ff;
  --code-font:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{max-width:100%}
body{
  font-family:-apple-system,'Segoe UI','Hiragino Kaku Gothic ProN',Meiryo,sans-serif;
  margin:0;background:var(--surface-soft);color:var(--text-main);
  font-size:14px;line-height:1.6;overflow-x:hidden;
}
.sidebar{
  position:fixed;top:0;left:0;width:var(--sidebar-width);height:100vh;
  background:var(--surface);border-right:1px solid var(--border);
  overflow-y:auto;padding:20px 16px;
}
.sidebar-title{font-size:15px;font-weight:700;line-height:1.4;margin:0 4px 16px;word-break:break-word}
.step-list{display:flex;flex-direction:column;gap:4px}
.step-item{
  display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;
  padding:9px 10px;border:1px solid transparent;border-radius:8px;
  background:transparent;font-size:13px;line-height:1.4;color:var(--text-main);cursor:pointer;
}
.step-item:hover{background:var(--surface-soft)}
.step-item.active{background:var(--accent-soft);border-color:var(--accent);font-weight:600}
.step-num{
  flex:none;width:22px;height:22px;border-radius:50%;background:var(--surface-soft);
  color:var(--text-soft);font-size:12px;display:flex;align-items:center;justify-content:center;
}
.step-item.active .step-num{background:var(--accent);color:#fff}
.step-item-title{flex:1;padding-top:1px;word-break:break-word}
.main{margin-left:var(--sidebar-width);margin-right:var(--minimap-width)}
.minimap{position:fixed;top:0;right:0;width:var(--minimap-width);height:100vh;background:var(--surface);border-left:1px solid var(--border);overflow:hidden;z-index:25;cursor:pointer}
.minimap-inner{position:relative;height:100%;width:100%}
.mm-label{position:absolute;left:32px;font-size:10px;line-height:1.2;color:var(--text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:95px;pointer-events:none}
.mm-sep{position:absolute;left:0;right:0;border-top:1px solid var(--border-soft)}
.mm-mark{position:absolute;left:8px;width:14px;height:2px;background:#c8d1da}
.mm-mark.own{background:var(--accent);width:20px}
.mm-mark.ref{background:#d4a72c;width:18px}
.mm-viewport{position:absolute;left:0;right:0;background:var(--accent-soft);border-top:1px solid var(--accent);border-bottom:1px solid var(--accent);opacity:.55;pointer-events:none}
.mm-label.active{color:var(--accent);font-weight:700;background:var(--surface);padding:2px 4px;border-radius:4px;z-index:6;max-width:none;border:1px solid var(--border-soft)}
.mm-popup{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:12px;color:var(--text-main);box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none;white-space:pre-wrap;z-index:20}
.top-header{
  position:sticky;top:0;z-index:30;background:var(--surface);
  border-bottom:1px solid var(--border);padding:16px 32px;
}
.header-inner{width:100%}
.nav-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.counter{font-weight:700;font-size:13px;color:var(--text-soft);margin-right:4px}
.spacer{flex:1}
button{
  font-family:inherit;font-size:13px;padding:7px 14px;border:1px solid var(--border);
  border-radius:8px;background:var(--surface);color:var(--text-main);cursor:pointer;
}
button:hover:not(:disabled){background:var(--surface-soft)}
button:disabled{opacity:.4;cursor:default}
.done-btn{background:var(--accent);color:#fff;border-color:var(--accent)}
.done-btn:hover:not(:disabled){background:#2f49d6}
.view-toggle{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.view-toggle-btn{border:none;border-radius:0;padding:7px 12px;background:var(--surface)}
.view-toggle-btn.active{background:var(--accent);color:#fff}
.step-heading{font-size:20px;font-weight:700;margin:6px 0 8px;line-height:1.4;max-width:820px}
.narration{font-size:14px;line-height:1.7;margin:0;color:var(--text-main);max-width:820px}
.narration .md-line+.md-line{margin-top:2px}
.md-list{margin:4px 0;padding-left:22px}
.md-list li{margin:2px 0}
code{font-family:var(--code-font);font-size:.92em;background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:5px;padding:1px 5px}
.content{padding:24px 32px 80px}
.banner-box{background:#fff8e6;border:1px solid #f0d68a;color:#7a5b00;padding:12px 16px;border-radius:10px;margin-bottom:16px}
.done-msg{background:#e6f6ec;border:1px solid #a3d9b1;color:#1a7f37;padding:12px 16px;border-radius:10px;margin-bottom:16px}
.file{background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:20px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.file-head{display:flex;align-items:center;gap:8px;padding:11px 16px;background:var(--surface-soft);border-bottom:1px solid var(--border-soft);position:sticky;top:0;z-index:10}
.file-head .path{font-family:var(--code-font);font-size:13px;font-weight:600;word-break:break-all}
.file-head .repo{font-family:var(--code-font);font-size:11px;padding:2px 7px;background:var(--accent-soft);color:var(--accent);border-radius:6px}
.file-head .status{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:20px;background:#eaeef2;color:var(--text-soft)}
.file-note{padding:10px 16px;font-size:13px;line-height:1.6;color:var(--text-soft);border-bottom:1px solid var(--border-soft);background:#fbfcfe}
.status-added{background:#e6f6ec;color:#1a7f37}
.status-deleted{background:#ffebe9;color:#cf222e}
.status-renamed{background:#fff3d6;color:#9a6700}
.code{font-family:var(--code-font);font-size:12.5px;line-height:1.55;overflow-x:auto}
.line{display:flex;min-width:max-content;white-space:pre}
.line .num{flex:none;width:46px;text-align:right;padding:0 10px 0 8px;color:#a0a8b0;user-select:none}
.line .mark{flex:none;width:16px;text-align:center;color:#a0a8b0;user-select:none}
.line .txt{flex:1;padding-right:16px}
.line.empty{background:var(--surface-soft)}
.line.clickable{cursor:pointer}
.line.clickable:hover{background:var(--accent-soft)}
.add{background:#e6ffec}
.add .mark{color:#1a7f37}
.del{background:#ffebe9}
.del .mark{color:#cf222e}
.own{background:inherit}
.add.own{background:#acf2bd}
.del.own{background:#ffc9c2}
.own .num{color:var(--accent);font-weight:700}
.ref{box-shadow:inset 3px 0 0 #d4a72c}
.other{opacity:.4}
.fold{
  padding:5px 16px;color:var(--accent);background:var(--surface-soft);
  border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);
  cursor:pointer;font-family:inherit;font-size:12px;
}
.fold:hover{background:var(--accent-soft)}
.split-row{display:flex}
.split-row>.line{flex:1 1 0;min-width:0;white-space:pre-wrap;word-break:break-all;border-right:1px solid var(--border-soft)}
.split-row>.line:last-child{border-right:none}
.comment{background:var(--accent-soft);border-left:3px solid var(--accent);margin:4px 12px 4px 46px;padding:7px 12px;border-radius:0 6px 6px 0;font-family:inherit;font-size:13px}
.comment-body{white-space:pre-wrap}
.reply{margin-top:8px;padding-top:8px;border-top:1px solid var(--border-soft)}
.reply-author{display:inline-block;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px}
.reply-body{white-space:normal;line-height:1.6}
.comment-form{margin:4px 12px 8px 46px;display:flex;gap:8px}
.comment-form input{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px}
.lost-comments-heading{font-size:13px;font-weight:600;color:var(--text-soft)}
@media (prefers-color-scheme: dark){
  :root{
    --text-main:#e6edf3;
    --text-soft:#9198a1;
    --border:#3d444d;
    --border-soft:#2a2f38;
    --surface:#161b22;
    --surface-soft:#0d1117;
    --accent:#6c8cff;
    --accent-soft:#1b2440;
  }
  .done-btn:hover:not(:disabled){background:#5577ff}
  .banner-box{background:#2b2410;border-color:#5a4a1a;color:#e3c56b}
  .done-msg{background:#132a1a;border-color:#2f6b42;color:#5cc47f}
  .file-head .status{background:#2a2f38}
  .file-note{background:#0f141b}
  .add{background:#12261a}
  .add .mark{color:#3fb950}
  .del{background:#291416}
  .del .mark{color:#f85149}
  .add.own{background:#1c3b28}
  .del.own{background:#3d1d1f}
  .mm-mark{background:#39424d}
}

.mm-full-diff { width: 100%; background: var(--surface); padding-bottom: 200px; }
.mm-file { margin-bottom: 300px; border-bottom: 40px solid var(--border-soft); position: relative; padding-top: 150px; }
.mm-file-code { font-family: var(--code-font); font-size: 16px; white-space: pre; line-height: 1.5; }
.mm-line { padding: 0 20px; color: var(--text-soft); border-left: 20px solid transparent; }
.mm-ctx { opacity: 0.25; }
.mm-add { background: #e6ffec; color: #1a7f37; }
.mm-del { background: #ffebe9; color: #cf222e; }
.mm-viewport { position: absolute; left: 0; right: 0; background: rgba(61, 90, 254, 0.12); border-top: 3px solid rgba(61, 90, 254, 0.6); border-bottom: 3px solid rgba(61, 90, 254, 0.6); z-index: 10; pointer-events: none; transition: top 0.1s, height 0.1s; }
.minimap-inner { position: relative; height: 100%; width: 100%; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; cursor: pointer; }
.minimap-inner::-webkit-scrollbar { display: none; }

@media (prefers-color-scheme: dark) {
  .mm-add { background: #12261a; color: #3fb950; }
  .mm-del { background: #291416; color: #f85149; }
}
</style></head><body>
<div class='sidebar'>
<h1 id='storyTitle' class='sidebar-title'></h1>
<div id='stepList' class='step-list'></div>
</div>
<div class='main'>
<header class='top-header'><div class='header-inner'>
<div class='nav-row'>
<span id='counter' class='counter'></span>
<button id='prevBtn'>前へ</button>
<button id='nextBtn'>次へ</button>
<div class='view-toggle'>
<button id='unifiedBtn' class='view-toggle-btn'>統合</button>
<button id='splitBtn' class='view-toggle-btn active'>左右並列</button>
</div>
<span class='spacer'></span>
<button id='followBtn'>差分を取り込む</button>
<button id='doneBtn' class='done-btn'>レビュー完了</button>
<button id='closeBtn'>終了</button>
</div>
<h2 id='stepTitle' class='step-heading'></h2>
<p id='narration' class='narration'></p>
</div></header>
<div class='content'>
<div id='doneMsg' class='done-msg' style='display:none'>コメントを送信しました。AIの返信がまもなく各コメントの下に表示されます</div>
<div id='banner'></div>
<div id='diff'></div>
</div>
</div>
<div class='minimap'><div id='minimapInner' class='minimap-inner'></div></div>
<div id='mmPopup' class='mm-popup' style='display:none;position:fixed'></div>
<script>${VIEWER_SCRIPT}</script>
</body></html>`;

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const targetDir = args[1];
  if (!command || !targetDir) {
    console.log("使い方: node storiff.js prep <dir> [--repo P [範囲]]... | node storiff.js check <dir> | node storiff.js reply <dir> <コメント番号> <本文> | node storiff.js serve <dir> [--port N] [--host H]");
    process.exit(1);
  }
  if (command === "check") {
    const changes = readJson(path.join(targetDir, "changes.json"), null);
    if (!changes) {
      console.log("changes.json がありません: 先に prep を実行してください");
      process.exit(1);
    }
    const steps = readJson(path.join(targetDir, "steps.json"), { steps: [] });
    const validation = buildValidation(changes.change_ids, changes.files, steps.steps || []);
    if (!validation.ok) {
      console.log("ng:");
      if (validation.missing.length > 0) {
        const missingSet = new Set(validation.missing);
        const unassignedFiles = [];
        changes.files.forEach((file, index) => {
          const ids = file.lines.filter((line) => line.id != null && missingSet.has(line.id)).map((line) => line.id);
          if (ids.length > 0) unassignedFiles.push("F" + (index + 1) + " " + file.file + " (id " + ids[0] + "-" + ids[ids.length - 1] + ")");
        });
        console.log("  未割り当てのファイル(どこかのstepに足す):");
        for (const line of unassignedFiles) console.log("    " + line);
      }
      if (validation.duplicated.length > 0) console.log("  重複した変更ID " + validation.duplicated.length + "件: " + validation.duplicated.slice(0, 50).join(","));
      if (validation.unknown_files.length > 0) console.log("  不明なファイル: " + validation.unknown_files.join(", "));
      process.exit(1);
    }
    const idToFileKey = new Map();
    for (const file of changes.files) {
      for (const line of file.lines) if (line.id != null) idToFileKey.set(line.id, file.repo + " " + file.file);
    }
    const oversizedSteps = validation.resolvedSteps
      .map((step, index) => {
        const fileKeys = new Set();
        for (const id of step.owns) if (idToFileKey.has(id)) fileKeys.add(idToFileKey.get(id));
        return { order: step.order != null ? step.order : index + 1, title: step.title || "", lineCount: step.owns.length, fileCount: fileKeys.size };
      })
      .filter((step) => step.lineCount > CHANGED_LINES_PER_STEP_GUIDE);
    const mustSplit = oversizedSteps.filter((step) => step.lineCount > CHANGED_LINES_PER_STEP_GUIDE * 2 && step.fileCount > 1);
    const advisory = oversizedSteps.filter((step) => !mustSplit.includes(step));
    if (mustSplit.length > 0) {
      console.log("ng: 明らかに大きく複数ファイルにまたがるstepは分割する。サブ対象ごとに分け、同じ対象の追加と削除は対のまま入れる。追加と削除など作業種類では割らない");
      for (const step of mustSplit) {
        console.log("  step" + step.order + " " + step.title + " (" + step.lineCount + "行, " + step.fileCount + "ファイル)");
      }
      process.exit(1);
    }
    console.log("ok: 全 " + changes.change_ids.length + " 件の変更IDがちょうど1回ずつ owns に入っています");
    if (advisory.length > 0) {
      console.log("参考 目安 " + CHANGED_LINES_PER_STEP_GUIDE + "行を超えるstep(浅く広い機械的変更や自動生成物ならこのままでよい。密な実装なら分割を検討):");
      for (const step of advisory) {
        console.log("  step" + step.order + " " + step.title + " (" + step.lineCount + "行, " + step.fileCount + "ファイル)");
      }
    }
    return;
  }
  if (command === "reply") {
    const commentNumber = parseInt(args[2], 10);
    const body = args.slice(3).join(" ");
    if (!commentNumber || !body) {
      console.log("使い方: node storiff.js reply <dir> <コメント番号> <本文>");
      process.exit(1);
    }
    try {
      appendReply(targetDir, commentNumber, body);
    } catch (error) {
      console.log(error.message);
      process.exit(1);
    }
    console.log("reply: コメント" + commentNumber + " に返信を追記しました");
    return;
  }
  if (command === "prep") {
    const globalDiffArgs = [];
    const repoList = [];
    let currentRepo = null;
    const rest = args.slice(2);
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === "--repo" && rest[index + 1]) {
        currentRepo = { path: rest[index + 1], diffArgs: [] };
        repoList.push(currentRepo);
        index++;
      } else if (currentRepo) {
        currentRepo.diffArgs.push(rest[index]);
      } else {
        globalDiffArgs.push(rest[index]);
      }
    }
    const hasExplicitArgs = rest.length > 0;
    if (repoList.length === 0) {
      repoList.push({ path: ".", diffArgs: globalDiffArgs });
    } else {
      for (const repo of repoList) {
        if (repo.diffArgs.length === 0) repo.diffArgs = globalDiffArgs;
      }
    }
    try {
      runPrep(targetDir, repoList, hasExplicitArgs);
    } catch (error) {
      console.log("追従しません: steps.json か comments.json が壊れています(" + String(error.message).split("\n")[0].trim() + ")");
      process.exit(1);
    }
    return;
  }
  if (command === "serve") {
    let requestedPort = null;
    const portIndex = args.indexOf("--port");
    if (portIndex !== -1 && args[portIndex + 1]) {
      requestedPort = parseInt(args[portIndex + 1], 10);
    }
    const config = loadConfig();
    let bindHost = config.host || "127.0.0.1";
    const hostIndex = args.indexOf("--host");
    if (hostIndex !== -1 && args[hostIndex + 1]) {
      bindHost = args[hostIndex + 1];
    }
    let sessionId = null;
    const sessionIndex = args.indexOf("--session-id");
    if (sessionIndex !== -1 && args[sessionIndex + 1]) {
      sessionId = args[sessionIndex + 1];
    }
    if (args.includes("--daemon")) {
      runServeDaemon(targetDir, requestedPort, bindHost, sessionId);
      return;
    }
    const existing = readServeInfo(targetDir);
    isServeAlive(existing, (alive) => {
      if (alive) {
        if (sessionId != null && sessionId !== existing.session_id) {
          writeServeInfo(targetDir, Object.assign({}, existing, { session_id: sessionId }));
          console.log("session-id を更新しました: " + sessionId);
        }
        console.log("storiff serve: " + existing.url);
        console.log("すでに起動しているビューアに接続しました");
        openBrowser(existing.url);
        return;
      }
      startServeDaemon(targetDir, requestedPort, bindHost, sessionId);
    });
    return;
  }
  console.log("不明なコマンド: " + command);
  process.exit(1);
}

if (require.main === module) main();

module.exports.buildFileDiffText = buildFileDiffText;
module.exports.buildAskPrompt = buildAskPrompt;
module.exports.askHaiku = askHaiku;
module.exports.buildLineKeyIndex = buildLineKeyIndex;
module.exports.buildIdMap = buildIdMap;
module.exports.foldIdsToRanges = foldIdsToRanges;
module.exports.remapSteps = remapSteps;
module.exports.remapComments = remapComments;
module.exports.runPrep = runPrep;
module.exports.resolveSteps = resolveSteps;
module.exports.buildValidation = buildValidation;
