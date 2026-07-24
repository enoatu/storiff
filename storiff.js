#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// git diff の unified 出力をファイル単位に分解する
function parseDiff(diffText) {
  const files = [];
  const changeIds = [];
  let nextId = 1;
  let currentFile = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diffText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      currentFile = { file: null, status: "modified", lines: [] };
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

  return { diff_target: "working tree", files, change_ids: changeIds };
}

function runPrep(targetDir) {
  const diffText = execFileSync("git", ["diff"], { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (diffText.trim() === "") {
    console.log("変更なし: git diff が空のため changes.json は生成しません");
    return;
  }
  const changes = parseDiff(diffText);
  if (changes.change_ids.length === 0) {
    console.log("変更なし: 差分行が見つかりませんでした");
    return;
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, "changes.json");
  fs.writeFileSync(outputPath, JSON.stringify(changes, null, 2));
  console.log("生成: " + outputPath + " (変更ID " + changes.change_ids.length + "件, ファイル " + changes.files.length + "件)");
}

// owns の和集合が change_ids と一致するか検算する
function buildValidation(changeIds, steps) {
  const ownedCount = new Map();
  for (const step of steps) {
    for (const id of step.owns || []) {
      ownedCount.set(id, (ownedCount.get(id) || 0) + 1);
    }
  }
  const missing = changeIds.filter((id) => !ownedCount.has(id));
  const duplicated = [];
  for (const [id, count] of ownedCount) {
    if (count > 1) duplicated.push(id);
  }
  return { ok: missing.length === 0 && duplicated.length === 0, missing, duplicated };
}

function buildStory(targetDir) {
  const changes = readJson(path.join(targetDir, "changes.json"), null);
  if (!changes) throw new Error("changes.json がありません: 先に prep を実行してください");
  const steps = readJson(path.join(targetDir, "steps.json"), { title: "", steps: [] });
  const comments = readJson(path.join(targetDir, "comments.json"), []);
  return {
    title: steps.title || "",
    files: changes.files,
    change_ids: changes.change_ids,
    steps: steps.steps || [],
    validation: buildValidation(changes.change_ids, steps.steps || []),
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

function listenOnFreePort(server, startPort, onReady) {
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
    server.listen(port, "127.0.0.1", () => onReady(port));
  };
  tryListen();
}

function runServe(targetDir, requestedPort) {
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
  listenOnFreePort(server, startPort, (port) => {
    const url = "http://127.0.0.1:" + port + "/";
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
function esc(text){var div=document.createElement('div');div.textContent=text==null?'':String(text);return div.innerHTML;}
function commentKey(file, changeId){return file + '#' + changeId;}
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
    var chip=document.createElement('span');
    chip.className='chip'+(index===stepIndex?' active':'');
    chip.textContent=(index+1)+'. '+step.title;
    chip.onclick=function(){stepIndex=index;render();};
    list.appendChild(chip);
  });
}
function renderBanner(){
  var banner=document.getElementById('banner');
  var validation=story.validation||{ok:true};
  if(validation.ok){banner.innerHTML='';return;}
  var text='警告: ストーリーが全変更を過不足なく説明できていません';
  if(validation.missing&&validation.missing.length) text+=' / 説明もれの変更ID: '+validation.missing.join(', ');
  if(validation.duplicated&&validation.duplicated.length) text+=' / 重複所有の変更ID: '+validation.duplicated.join(', ');
  banner.innerHTML="<div class='banner'>"+esc(text)+"</div>";
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
  if(row.nextSibling&&row.nextSibling.className==='commentForm') return;
  var form=document.createElement('div');
  form.className='commentForm';
  var input=document.createElement('input');
  input.placeholder='この行へのコメントを書く';
  var sendBtn=document.createElement('button');
  sendBtn.textContent='送信';
  sendBtn.onclick=function(){
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
  form.appendChild(sendBtn);
  row.parentNode.insertBefore(form, row.nextSibling);
  input.focus();
}
function render(){
  var step=story.steps[stepIndex];
  document.getElementById('storyTitle').textContent=story.title||'';
  document.getElementById('stepTitle').textContent=step?('Step '+(step.order!=null?step.order:stepIndex+1)+': '+step.title):'ステップがありません';
  document.getElementById('narration').textContent=step?step.narration:'';
  document.getElementById('counter').textContent=(stepIndex+1)+' / '+story.steps.length;
  document.getElementById('prevBtn').disabled=stepIndex<=0;
  document.getElementById('nextBtn').disabled=stepIndex>=story.steps.length-1;
  renderStepList();
  renderBanner();
  var diff=document.getElementById('diff');
  diff.innerHTML='';
  if(!step) return;
  var ownsSet={}; (step.owns||[]).forEach(function(id){ownsSet[id]=true;});
  var refsSet={}; (step.refs||[]).forEach(function(id){refsSet[id]=true;});
  story.files.forEach(function(file){
    var hasOwned=file.lines.some(function(line){return line.id!=null&&ownsSet[line.id];});
    if(!hasOwned) return;
    var block=document.createElement('div');
    block.className='file';
    var heading=document.createElement('h3');
    heading.innerHTML=esc(file.file)+"<span class='status'>"+esc(file.status)+'</span>';
    block.appendChild(heading);
    file.lines.forEach(function(line){
      var row=document.createElement('div');
      row.className='line '+lineClass(line, ownsSet, refsSet);
      var num=(line.new==null?(line.old==null?'':line.old):line.new);
      var clickable=line.id!=null;
      if(clickable) row.className+=' clickable';
      row.innerHTML="<span class='num'>"+esc(num)+"</span><span class='txt'>"+esc(marker(line.kind)+line.text)+'</span>';
      if(clickable){row.onclick=function(){openForm(row, line, file.file, step.order!=null?step.order:stepIndex+1);};}
      block.appendChild(row);
      if(line.id!=null){
        var existing=commentsByKey[commentKey(file.file, line.id)]||[];
        existing.forEach(function(comment){block.appendChild(renderComment(comment));});
      }
    });
    diff.appendChild(block);
  });
}
document.getElementById('prevBtn').onclick=function(){if(stepIndex>0){stepIndex--;render();}};
document.getElementById('nextBtn').onclick=function(){if(stepIndex<story.steps.length-1){stepIndex++;render();}};
document.getElementById('doneBtn').onclick=function(){
  fetch('/done',{method:'POST'}).then(function(){document.getElementById('doneMsg').style.display='block';});
};
fetch('/story.json').then(function(res){return res.json();}).then(function(data){
  story=data; indexComments(); render();
});
`;

const VIEWER_HTML = `<!doctype html>
<html lang='ja'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>storiff</title>
<style>
body{font-family:-apple-system,'Segoe UI',sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:16px 24px;z-index:10}
#storyTitle{font-size:14px;color:#666;margin:0 0 4px}
#stepTitle{font-size:24px;font-weight:700;margin:0 0 8px}
#narration{font-size:16px;line-height:1.6;margin:0 0 12px;white-space:pre-wrap}
#nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
button{font-size:14px;padding:6px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
button:disabled{opacity:.4;cursor:default}
#stepList{display:flex;gap:6px;flex-wrap:wrap}
#stepList .chip{padding:4px 10px;border-radius:14px;border:1px solid #ccc;font-size:13px;cursor:pointer}
#stepList .chip.active{background:#0071e3;color:#fff;border-color:#0071e3}
#counter{font-weight:600}
#doneBtn{background:#0071e3;color:#fff;border-color:#0071e3}
main{padding:24px}
.banner{background:#fff3cd;border:1px solid #ffe08a;padding:12px 16px;border-radius:8px;margin-bottom:16px}
.file{background:#fff;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;overflow:hidden}
.file h3{margin:0;padding:10px 14px;background:#fafafa;border-bottom:1px solid #eee;font-size:14px;font-family:monospace}
.file h3 .status{margin-left:8px;color:#888;font-size:12px}
.line{display:flex;font-family:monospace;font-size:13px;line-height:1.5;white-space:pre-wrap}
.line .num{width:52px;text-align:right;padding-right:10px;color:#aaa;user-select:none;flex:none}
.line .txt{flex:1;padding-right:12px}
.line.clickable{cursor:pointer}
.line.clickable:hover{outline:1px solid #0071e3}
.add .txt{background:#e6ffed}
.del .txt{background:#ffeef0}
.own{font-weight:700}
.own .num{color:#0071e3}
.ref .txt{box-shadow:inset 3px 0 0 #b58900}
.other{opacity:.45}
.comment{background:#eef4ff;border-left:3px solid #0071e3;margin:2px 0 2px 52px;padding:6px 10px;font-family:sans-serif;font-size:13px}
.commentForm{margin:2px 0 6px 52px;display:flex;gap:8px}
.commentForm input{flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px}
#doneMsg{background:#d4edda;border:1px solid #a3d9a5;padding:12px 16px;border-radius:8px;margin-bottom:16px}
</style></head><body>
<header>
<p id='storyTitle'></p>
<h1 id='stepTitle'></h1>
<p id='narration'></p>
<div id='nav'>
<button id='prevBtn'>前へ</button>
<span id='counter'></span>
<button id='nextBtn'>次へ</button>
<div id='stepList'></div>
<button id='doneBtn'>レビュー完了</button>
</div></header>
<main>
<div id='doneMsg' style='display:none'>レビュー完了を送信しました。ご確認ありがとうございました</div>
<div id='banner'></div>
<div id='diff'></div>
</main>
<script>${VIEWER_SCRIPT}</script>
</body></html>`;

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const targetDir = args[1];
  if (!command || !targetDir) {
    console.log("使い方: node storiff.js prep <dir> | node storiff.js serve <dir> [--port N]");
    process.exit(1);
  }
  if (command === "prep") {
    runPrep(targetDir);
    return;
  }
  if (command === "serve") {
    let requestedPort = null;
    const portIndex = args.indexOf("--port");
    if (portIndex !== -1 && args[portIndex + 1]) {
      requestedPort = parseInt(args[portIndex + 1], 10);
    }
    runServe(targetDir, requestedPort);
    return;
  }
  console.log("不明なコマンド: " + command);
  process.exit(1);
}

main();
