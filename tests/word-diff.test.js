const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

function loadWordDiffModule() {
  const sourceText = fs.readFileSync(path.join(__dirname, "..", "storiff.js"), "utf8");
  const constantStart = sourceText.indexOf("var WORD_DIFF_SIMILARITY_MIN=");
  const constantEnd = sourceText.indexOf(";", constantStart) + 1;
  const constantBlock = sourceText.slice(constantStart, constantEnd);
  const functionStart = sourceText.indexOf("function tokenizeLine(");
  const functionEnd = sourceText.indexOf("// テキストノードを文字位置で辿り", functionStart);
  const functionBlock = sourceText.slice(functionStart, functionEnd);
  const moduleBody = constantBlock + "\n" + functionBlock
    + "\nreturn { tokenizeLine: tokenizeLine, computeChangedRanges: computeChangedRanges, computeWordDiffForPair: computeWordDiffForPair, WORD_DIFF_SIMILARITY_MIN: WORD_DIFF_SIMILARITY_MIN };";
  return new Function(moduleBody)();
}

const wordDiff = loadWordDiffModule();

test("行の一部だけ違う組を渡すと、変わった範囲だけが返る", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("let count = 10", "let count = 20");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, [[12, 14]]);
  assert.deepStrictEqual(wordDiffResult.rightRanges, [[12, 14]]);
});

test("記号をまたぐ変更でも、変わった単語の長さに応じて範囲の開始と終了がずれない", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("foo(x)", "foo(longvalue)");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, [[4, 5]]);
  assert.deepStrictEqual(wordDiffResult.rightRanges, [[4, 13]]);
});

test("まったく同じ行同士を渡すと、変わった範囲が空になる", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("const value = 1;", "const value = 1;");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, []);
  assert.deepStrictEqual(wordDiffResult.rightRanges, []);
});

test("まったく別の内容の行の組は、似ていないと判定され色分けの対象外になる", () => {
  const changedRanges = wordDiff.computeChangedRanges("apple banana cherry", "dog elephant fox");
  assert.ok(changedRanges.similarityRatio < wordDiff.WORD_DIFF_SIMILARITY_MIN);
  const wordDiffResult = wordDiff.computeWordDiffForPair("apple banana cherry", "dog elephant fox");
  assert.strictEqual(wordDiffResult, null);
});

test("片側がnullの組は色分けの対象外になる", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair(null, "brand new line");
  assert.strictEqual(wordDiffResult, null);
});

test("単語は英数字とアンダースコアの連続で1トークンになり、それ以外は1文字ずつのトークンになる", () => {
  const tokens = wordDiff.tokenizeLine("abc,def");
  assert.deepStrictEqual(tokens.map((token) => token.text), ["abc", ",", "def"]);
  assert.deepStrictEqual(tokens.map((token) => [token.start, token.end]), [[0, 3], [3, 4], [4, 7]]);
});

test("右側が長くなっても左側の単語がほぼそのまま含まれる組は色分けの対象になる", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("  return db.find(id)", "  return db.findOne(userId, { strict: true })");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, [[12, 16], [17, 19]]);
  assert.deepStrictEqual(wordDiffResult.rightRanges, [[12, 19], [20, 44]]);
});

test("左側の内容がそのまま右側に含まれる純粋な追記の組は色分けの対象になる", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("  const excludePatterns = NOISE_PATTERNS;", "  const excludePatterns = NOISE_PATTERNS.concat(config.exclude || []);");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, []);
  assert.deepStrictEqual(wordDiffResult.rightRanges, [[40, 69]]);
});

test("関数名が同じで引数名だけ変わった組は色分けの対象になる", () => {
  const wordDiffResult = wordDiff.computeWordDiffForPair("function getUser(id) {", "function getUser(userId) {");
  assert.ok(wordDiffResult);
  assert.deepStrictEqual(wordDiffResult.leftRanges, [[17, 19]]);
  assert.deepStrictEqual(wordDiffResult.rightRanges, [[17, 23]]);
});

test("変数名も処理内容も違う無関係な組は色分けの対象外になる", () => {
  const changedRanges = wordDiff.computeChangedRanges("const alpha = 1", "let beta = compute(x, y, z) + 99");
  assert.ok(changedRanges.similarityRatio < wordDiff.WORD_DIFF_SIMILARITY_MIN);
  const wordDiffResult = wordDiff.computeWordDiffForPair("const alpha = 1", "let beta = compute(x, y, z) + 99");
  assert.strictEqual(wordDiffResult, null);
});
