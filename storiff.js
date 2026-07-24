#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const os = require("os");

// 1stepがおおよそ1時間の作業に収まる目安の変更行数。これを超えるstepは分割の候補
const CHANGED_LINES_PER_STEP_GUIDE = 80;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
      currentFile = { repo, file: null, status: "modified", lines: [] };
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

// story作成時にClaudeが読む軽量なテキスト版。changes.jsonの整形JSONより行が短い
function buildChangesText(files) {
  const blocks = files.map((file) => {
    const repoTag = file.repo && file.repo !== "." ? file.repo + " " : "";
    const heading = "=== " + repoTag + file.file + " (" + file.status + ") ===";
    const lines = file.lines.map((line) => {
      if (line.kind === "context") return "  " + line.text;
      const marker = line.kind === "add" ? "+" : "-";
      return marker + "[" + line.id + "] " + line.text;
    });
    return heading + "\n" + lines.join("\n");
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

function runPrep(targetDir, repoList) {
  const files = [];
  const changeIds = [];
  const diffTargets = [];
  let nextId = 1;
  for (const repo of repoList) {
    const diffText = execFileSync("git", ["-C", repo.path, "diff", ...repo.diffArgs], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
    const range = repo.diffArgs.length > 0 ? repo.diffArgs.join(" ") : "working tree";
    diffTargets.push(repo.path === "." ? range : repo.path + " " + range);
    if (diffText.trim() === "") continue;
    const parsed = parseDiff(diffText, repo.path, nextId);
    files.push(...parsed.files);
    changeIds.push(...parsed.change_ids);
    nextId = parsed.nextId;
  }
  if (changeIds.length === 0) {
    console.log("変更なし: 差分行が見つかりませんでした");
    return;
  }
  const repos = repoList.map((repo) => repo.path);
  fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, "changes.json");
  fs.writeFileSync(outputPath, JSON.stringify({ diff_target: diffTargets.join(", "), repos, files, change_ids: changeIds }, null, 2));
  const textOutputPath = path.join(targetDir, "changes.txt");
  fs.writeFileSync(textOutputPath, buildChangesText(files));
  const filesMapPath = path.join(targetDir, "files.txt");
  fs.writeFileSync(filesMapPath, buildFilesMap(files));
  console.log("生成: " + outputPath + " と " + textOutputPath + " と " + filesMapPath + " (変更ID " + changeIds.length + "件, ファイル " + files.length + "件, リポジトリ " + repos.length + "件)");
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

// 各stepの owns と owns_files を整数IDの owns に展開する
function resolveSteps(files, steps) {
  const unknownFiles = [];
  const resolvedSteps = steps.map((step) => {
    const expanded = expandOwnsFiles(step.owns_files || [], files);
    unknownFiles.push(...expanded.unknownFiles);
    return Object.assign({}, step, { owns: [...expandOwns(step.owns || []), ...expanded.ids] });
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
  const newComment = Object.assign({}, body, { at: new Date().toISOString() });
  comments.push(newComment);
  fs.writeFileSync(commentsPath, JSON.stringify(comments, null, 2));
  return newComment;
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

function listenOnFreePort(server, startPort, bindHost, onReady) {
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
    server.listen(port, bindHost, () => onReady(port));
  };
  tryListen();
}

function runServe(targetDir, requestedPort, bindHost) {
  const server = http.createServer(async (request, response) => {
    try {
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
        sendJson(response, 200, appendComment(targetDir, body));
        return;
      }
      if (request.method === "POST" && request.url === "/done") {
        fs.writeFileSync(path.join(targetDir, "done.flag"), new Date().toISOString());
        sendJson(response, 200, { done: true });
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    } catch (error) {
      sendJson(response, 500, { error: String(error && error.message ? error.message : error) });
    }
  });

  const startPort = requestedPort || 4711;
  const displayHost = bindHost === "0.0.0.0" ? os.hostname() : bindHost;
  listenOnFreePort(server, startPort, bindHost, (port) => {
    const url = "http://" + displayHost + ":" + port + "/";
    console.log("storiff serve: " + url);
    console.log("done.flag ができるまで待機します: " + path.join(targetDir, "done.flag"));
    openBrowser(url);
  });

  const donePath = path.join(targetDir, "done.flag");
  const watcher = setInterval(() => {
    if (fs.existsSync(donePath)) {
      console.log("レビュー完了を検知しました。サーバを終了します");
      clearInterval(watcher);
      server.close(() => process.exit(0));
    }
  }, 1000);
}

const VIEWER_SCRIPT = `
var story=null, stepIndex=0, commentsByKey={};
// 表示の種類 unified か split。既定は左右並列。stepを移動しても保つ
var viewMode='split';
// 変更行の周囲に残す無変更行の数
var CONTEXT_LINES=3;

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
  (story.comments||[]).forEach(function(comment){
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
  if(validation.missing&&validation.missing.length) parts.push('説明もれの変更ID '+validation.missing.join(', '));
  if(validation.duplicated&&validation.duplicated.length) parts.push('重複所有の変更ID '+validation.duplicated.join(', '));
  if(validation.unknown_files&&validation.unknown_files.length) parts.push('不明なファイル '+validation.unknown_files.join(', '));
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
  box.textContent=comment.body;
  return box;
}
function openForm(row, line, file, stepOrder){
  if(row.nextSibling&&row.nextSibling.className==='comment-form') return;
  var form=document.createElement('div');
  form.className='comment-form';
  var input=document.createElement('input');
  input.placeholder='この行へのコメントを書く';
  var sendButton=document.createElement('button');
  sendButton.textContent='送信';
  sendButton.onclick=function(){
    var body=input.value.trim();
    if(!body) return;
    var payload={change_id:line.id, file:file, line:(line.new==null?line.old:line.new), step_order:stepOrder, body:body};
    fetch('/comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(function(res){return res.json();})
      .then(function(saved){
        var key=commentKey(file, line.id);
        if(!commentsByKey[key]) commentsByKey[key]=[];
        commentsByKey[key].push(saved);
        form.parentNode.insertBefore(renderComment(saved), form);
        input.value='';
      });
  };
  form.appendChild(input);
  form.appendChild(sendButton);
  row.parentNode.insertBefore(form, row.nextSibling);
  input.focus();
}
// 差分1行のマス目を作る。lineがnullなら片側だけの空マス
function buildCell(line, ownsSet, refsSet){
  var cell=document.createElement('div');
  if(!line){cell.className='line empty'; return cell;}
  cell.className='line '+lineClass(line, ownsSet, refsSet);
  var lineNumber=(line.new==null?(line.old==null?'':line.old):line.new);
  var numberLabel=document.createElement('span');
  numberLabel.className='num';
  numberLabel.textContent=lineNumber;
  var markerLabel=document.createElement('span');
  markerLabel.className='mark';
  markerLabel.textContent=marker(line.kind);
  var textLabel=document.createElement('span');
  textLabel.className='txt';
  textLabel.textContent=line.text;
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
  var row=buildCell(line, ownsSet, refsSet);
  if(line.id!=null){
    row.className+=' clickable';
    row.onclick=function(){openForm(row, line, file.file, stepOrder);};
  }
  parent.appendChild(row);
  appendExistingComments(parent, line, file);
}
// 左右並列の1行を追加する。左は変更前、右は変更後
function appendSplitRow(parent, splitLine, file, stepOrder, ownsSet, refsSet){
  var rowElement=document.createElement('div');
  rowElement.className='split-row';
  [splitLine.left, splitLine.right].forEach(function(line){
    var cell=buildCell(line, ownsSet, refsSet);
    if(line&&line.id!=null){
      cell.className+=' clickable';
      cell.onclick=function(){openForm(rowElement, line, file.file, stepOrder);};
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
}
document.getElementById('prevBtn').onclick=function(){if(stepIndex>0){stepIndex--;render();window.scrollTo(0,0);}};
document.getElementById('nextBtn').onclick=function(){if(stepIndex<story.steps.length-1){stepIndex++;render();window.scrollTo(0,0);}};
document.getElementById('doneBtn').onclick=function(){
  fetch('/done',{method:'POST'}).then(function(){document.getElementById('doneMsg').style.display='block';});
};
function setViewMode(mode){
  viewMode=mode;
  document.getElementById('unifiedBtn').className='view-toggle-btn'+(mode==='unified'?' active':'');
  document.getElementById('splitBtn').className='view-toggle-btn'+(mode==='split'?' active':'');
  render();
}
document.getElementById('unifiedBtn').onclick=function(){setViewMode('unified');};
document.getElementById('splitBtn').onclick=function(){setViewMode('split');};
document.addEventListener('keydown', function(event){
  var tag=event.target&&event.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA') return;
  if(event.key==='ArrowLeft'&&stepIndex>0){stepIndex--;render();window.scrollTo(0,0);}
  if(event.key==='ArrowRight'&&stepIndex<story.steps.length-1){stepIndex++;render();window.scrollTo(0,0);}
});
fetch('/story.json').then(function(res){return res.json();}).then(function(data){
  story=data; indexComments(); render();
});
`;

const VIEWER_HTML = `<!doctype html>
<html lang='ja'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>storiff</title>
<style>
:root{
  --sidebar-width:280px;
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
.main{margin-left:var(--sidebar-width)}
.top-header{
  position:sticky;top:0;z-index:10;background:var(--surface);
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
.file-head{display:flex;align-items:center;gap:8px;padding:11px 16px;background:var(--surface-soft);border-bottom:1px solid var(--border-soft)}
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
.split-row>.line{flex:1 1 0;min-width:0;overflow-x:auto;border-right:1px solid var(--border-soft)}
.split-row>.line:last-child{border-right:none}
.comment{background:var(--accent-soft);border-left:3px solid var(--accent);margin:4px 12px 4px 46px;padding:7px 12px;border-radius:0 6px 6px 0;font-family:inherit;font-size:13px;white-space:pre-wrap}
.comment-form{margin:4px 12px 8px 46px;display:flex;gap:8px}
.comment-form input{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px}
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
<button id='doneBtn' class='done-btn'>レビュー完了</button>
</div>
<h2 id='stepTitle' class='step-heading'></h2>
<p id='narration' class='narration'></p>
</div></header>
<div class='content'>
<div id='doneMsg' class='done-msg' style='display:none'>レビュー完了を送信しました。ご確認ありがとうございました</div>
<div id='banner'></div>
<div id='diff'></div>
</div>
</div>
<script>${VIEWER_SCRIPT}</script>
</body></html>`;

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const targetDir = args[1];
  if (!command || !targetDir) {
    console.log("使い方: node storiff.js prep <dir> [--repo P [範囲]]... | node storiff.js check <dir> | node storiff.js merge <dir> | node storiff.js serve <dir> [--port N] [--host H]");
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
      if (validation.missing.length > 0) console.log("  未割り当ての変更ID " + validation.missing.length + "件: " + validation.missing.slice(0, 50).join(","));
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
  if (command === "merge") {
    const stepsPath = path.join(targetDir, "steps.json");
    const doc = readJson(stepsPath, null);
    if (!doc || !Array.isArray(doc.steps)) {
      console.log("steps.json がありません: 先に骨組みを書いてください");
      process.exit(1);
    }
    const notesByOrder = new Map();
    for (const name of fs.readdirSync(targetDir)) {
      if (!/^notes-.*\.json$/.test(name)) continue;
      let note = null;
      try {
        note = JSON.parse(fs.readFileSync(path.join(targetDir, name), "utf8"));
      } catch (error) {
        console.log("警告 " + name + " は壊れているので飛ばす");
        continue;
      }
      if (note && note.order != null) notesByOrder.set(note.order, note);
    }
    let filled = 0;
    doc.steps = doc.steps.map((step) => {
      const note = notesByOrder.get(step.order);
      if (!note) return step;
      filled++;
      return Object.assign({}, step, {
        narration: note.narration != null ? note.narration : step.narration,
        file_notes: note.file_notes != null ? note.file_notes : step.file_notes,
      });
    });
    fs.writeFileSync(stepsPath, JSON.stringify(doc, null, 2));
    console.log("merge: " + filled + " / " + doc.steps.length + " step に narration を反映(owns は不変)");
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
    if (repoList.length === 0) {
      repoList.push({ path: ".", diffArgs: globalDiffArgs });
    } else {
      for (const repo of repoList) {
        if (repo.diffArgs.length === 0) repo.diffArgs = globalDiffArgs;
      }
    }
    runPrep(targetDir, repoList);
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
    runServe(targetDir, requestedPort, bindHost);
    return;
  }
  console.log("不明なコマンド: " + command);
  process.exit(1);
}

main();
