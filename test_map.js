import { convertSCToTC } from './utils/zh-map.js';

console.log("Testing Mapping Integrity...");

const pairs = [
    ['爱', '愛'],
    ['国', '國'],
    ['发', '發'],
    ['里', '裡'],
    ['面', '麵'],
    ['台', '臺']
];

let errors = 0;

pairs.forEach(([sc, tc]) => {
    const res = convertSCToTC(sc);
    if (res !== tc) {
        console.error(`[FAIL] ${sc} -> ${res} (Expected: ${tc})`);
        errors++;
    } else {
        console.log(`[OK] ${sc} -> ${tc}`);
    }
});

const sentence = "计算机科学的发展";
const expected = "計算機科學的發展"; // Note: '计算机' isn't in char map, but chars '计' '算' '机' should map.
// Wait, '计'->'計', '算'->'算', '机'->'機'.
const charMapped = "計算機科學的發展";

const resSentence = convertSCToTC(sentence);
console.log(`Sentence: ${sentence}`);
console.log(`Result:   ${resSentence}`);
console.log(`Expected: ${charMapped}`);

if (resSentence !== charMapped) {
    console.error("[FAIL] Sentence conversion mismatch.");
    errors++;
}

if (errors === 0) {
    console.log("SUCCESS: Map integrity verifies.");
} else {
    console.error(`FAILED: ${errors} errors found.`);
    process.exit(1);
}
