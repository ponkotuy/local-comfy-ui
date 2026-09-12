// render.js を tests/fixtures/render_cases.json に照らす。
// tagtree.py も同じファイルでテストされており、両者が食い違うとここで落ちる。
// 実行は tests/test_tag_composer.py 経由 (node があるときだけ走る)。

import { readFileSync } from "node:fs";
import { render, DEFAULT_SEPARATOR } from "../web/js/render.js";

const fixture = process.argv[2];
const { cases } = JSON.parse(readFileSync(fixture, "utf-8"));

const failures = [];
for (const testCase of cases) {
    const options = testCase.options || {};
    const got = render(testCase.tree, {
        separator: options.separator ?? DEFAULT_SEPARATOR,
        underscoreToSpace: options.underscore_to_space ?? false,
    });
    if (got !== testCase.expected) {
        failures.push(
            `${testCase.name}\n  expected: ${JSON.stringify(testCase.expected)}` +
                `\n  got:      ${JSON.stringify(got)}`,
        );
    }
}

if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log(`${cases.length} render cases ok`);
