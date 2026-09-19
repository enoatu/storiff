const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildAuditRequest, buildAuditIssues, readAuditKey } = require("../storiff.js");

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeLine(kind, text, id) {
  return { kind, old: null, new: null, text, id };
}

// a.js に1と2、b.js に3と4を置く
function makeFiles() {
  return [
    { repo: ".", file: "a.js", status: "modified", lines: [makeLine("del", "old1", 1), makeLine("add", "new2", 2)] },
    { repo: ".", file: "b.js", status: "modified", lines: [makeLine("add", "new3", 3), makeLine("add", "new4", 4)] },
  ];
}

function makeStep(order, title, owns) {
  return { order, title, narration: "説明", owns, refs: [] };
}

test("問いはコマごとに3つ作られ、変更行はファイルごとにまとまる", () => {
  const request = buildAuditRequest([makeStep(1, "1つ目", [1, 2, 3])], makeFiles());
  assert.strictEqual(request.model, "typesafe/jev-1.13");
  assert.deepStrictEqual(Object.keys(request.questions), ["0_混ざり", "0_題", "0_脇"]);
  assert.strictEqual(request.questions["0_混ざり"].type, "score");
  assert.strictEqual(request.questions["0_題"].type, "noul");
  assert.strictEqual(request.state["コマ0"].題, "1つ目");
  assert.deepStrictEqual(request.state["コマ0"].変更行, {
    "a.js": ["- old1", "+ new2"],
    "b.js": ["+ new3"],
  });
});

test("リポジトリ名は同名ファイルを見分けるためだけに付く", () => {
  const files = [{ repo: "sub", file: "a.js", status: "modified", lines: [makeLine("add", "x", 1)] }];
  const request = buildAuditRequest([makeStep(1, "題", [1])], files);
  assert.deepStrictEqual(Object.keys(request.state["コマ0"].変更行), ["sub a.js"]);
});

test("目安を外れたコマだけ知らせる", () => {
  const steps = [
    makeStep(1, "混ざっている", [1, 2]),
    makeStep(2, "きれい", [3]),
    makeStep(3, "題が合わない", [4]),
  ];
  const answers = {
    "0_混ざり": { score: 2.1 }, "0_題": { noul: 0.9 }, "0_脇": { noul: 0.1 },
    "1_混ざり": { score: 0.2 }, "1_題": { noul: 0.9 }, "1_脇": { noul: 0.1 },
    "2_混ざり": { score: 0.3 }, "2_題": { noul: 0.2 }, "2_脇": { noul: 0.8 },
  };
  const issues = buildAuditIssues(steps, answers);
  assert.strictEqual(issues.mixedLines.length, 1);
  assert.ok(issues.mixedLines[0].startsWith("step1 混ざっている (2行) 混ざり 2.10"));
  assert.strictEqual(issues.titleLines.length, 1);
  assert.ok(issues.titleLines[0].startsWith("step3 題が合わない (1行) 題の当たり 0.20"));
  assert.strictEqual(issues.asideLines.length, 1);
  assert.ok(issues.asideLines[0].startsWith("step3 題が合わない (1行) 脇に置ける 0.80"));
});

test("目安のちょうど境目は知らせに入る", () => {
  const answers = {
    "0_混ざり": { score: 1.5 }, "0_題": { noul: 0.5 }, "0_脇": { noul: 0.6 },
  };
  const issues = buildAuditIssues([makeStep(1, "境目", [1])], answers);
  assert.strictEqual(issues.mixedLines.length, 1);
  assert.strictEqual(issues.titleLines.length, 0);
  assert.strictEqual(issues.asideLines.length, 1);
});

test("答えが欠けていても落ちない", () => {
  const issues = buildAuditIssues([makeStep(1, "題", [1])], {});
  assert.deepStrictEqual(issues, { mixedLines: [], titleLines: [], asideLines: [] });
});

test("鍵が無ければ何も返さない", () => {
  const homeDir = makeTempDir("storiff-audit-home-");
  const result = execFileSync(process.execPath, ["-e", `
    process.env.OPENROUTER_API_KEY = "";
    process.env.HOME = ${JSON.stringify(homeDir)};
    console.log(String(require(${JSON.stringify(path.join(__dirname, "..", "storiff.js"))}).readAuditKey()));
  `], { encoding: "utf8" });
  assert.strictEqual(result.trim(), "null");
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test("鍵が config.json にあれば読む", () => {
  const homeDir = makeTempDir("storiff-audit-home-");
  fs.mkdirSync(path.join(homeDir, ".storiff"));
  fs.writeFileSync(path.join(homeDir, ".storiff", "config.json"), JSON.stringify({ openrouter_key: "sk-test" }));
  const result = execFileSync(process.execPath, ["-e", `
    process.env.OPENROUTER_API_KEY = "";
    process.env.HOME = ${JSON.stringify(homeDir)};
    console.log(String(require(${JSON.stringify(path.join(__dirname, "..", "storiff.js"))}).readAuditKey()));
  `], { encoding: "utf8" });
  assert.strictEqual(result.trim(), "sk-test");
  fs.rmSync(homeDir, { recursive: true, force: true });
});
