// model.js のツリー操作。DOM を使わないので node だけで走る。
// 実行は tests/test_tag_composer.py 経由 (node があるときだけ走る)。

import assert from "node:assert/strict";
import * as model from "../web/js/model.js";
import { MAX_DEPTH } from "../web/js/render.js";

const failures = [];
function test(name, fn) {
    try {
        fn();
    } catch (error) {
        failures.push(`${name}\n  ${error.message}`);
    }
}

/** a/[b, c] と d を持つ適用エリアを作る。 */
function sample() {
    const tree = model.hydrate({
        active: [
            model.makeGroup("g", [model.makeTag("b"), model.makeTag("c")]),
            model.makeTag("d"),
        ],
        inactive: [],
    });
    return { tree, group: tree.active[0], d: tree.active[1] };
}

const tags = (nodes) => nodes.map((n) => n.tag ?? `[${n.name}]`);

test("hydrate fills in missing ids", () => {
    const tree = model.hydrate({ active: [{ kind: "tag", tag: "a" }], inactive: [] });
    assert.ok(tree.active[0].id, "id was not filled in");
});

test("find reports the containing area and index", () => {
    const { tree, group } = sample();
    const hit = model.find(tree, group.children[1].id);
    assert.equal(hit.area, "active");
    assert.equal(hit.parentId, group.id);
    assert.equal(hit.index, 1);
});

test("move into a group", () => {
    const { tree, group, d } = sample();
    assert.equal(model.move(tree, d.id, { area: "active", parentId: group.id, index: 0 }), true);
    assert.deepEqual(tags(group.children), ["d", "b", "c"]);
    assert.equal(tree.active.length, 1);
});

test("move across areas", () => {
    const { tree, d } = sample();
    assert.equal(model.move(tree, d.id, { area: "inactive", parentId: null, index: 0 }), true);
    assert.deepEqual(tags(tree.inactive), ["d"]);
    assert.deepEqual(tags(tree.active), ["[g]"]);
});

test("moving later within the same list lands where it was dropped", () => {
    // 先に取り除く分だけ挿入位置がずれる。補正を忘れると 1 つ手前に落ちる
    const { tree, group } = sample();
    const b = group.children[0];
    assert.equal(model.move(tree, b.id, { area: "active", parentId: group.id, index: 2 }), true);
    assert.deepEqual(tags(group.children), ["c", "b"]);
});

test("a group cannot be moved inside itself", () => {
    const { tree, group } = sample();
    assert.equal(model.move(tree, group.id, { area: "active", parentId: group.id, index: 0 }), false);
    assert.deepEqual(tags(tree.active), ["[g]", "d"]);
});

test("a group cannot be moved inside its own descendant", () => {
    const inner = model.makeGroup("inner", []);
    const outer = model.makeGroup("outer", [inner]);
    const tree = model.hydrate({ active: [outer], inactive: [] });
    const outerId = tree.active[0].id;
    const innerId = tree.active[0].children[0].id;
    assert.equal(model.move(tree, outerId, { area: "active", parentId: innerId, index: 0 }), false);
});

test("nesting is refused past the depth limit", () => {
    let node = model.makeTag("deep");
    for (let i = 0; i < MAX_DEPTH; i++) node = model.makeGroup(`g${i}`, [node]);
    const tree = model.hydrate({ active: [node, model.makeTag("x")], inactive: [] });

    let deepest = tree.active[0];
    while (deepest.kind === "group" && deepest.children[0]?.kind === "group") {
        deepest = deepest.children[0];
    }
    const x = tree.active[1];
    assert.equal(
        model.move(tree, x.id, { area: "active", parentId: deepest.id, index: 0 }),
        false,
        "expected the move to be refused",
    );
});

test("insert clamps an out-of-range index to the end", () => {
    const { tree } = sample();
    model.insert(tree, model.makeTag("z"), { area: "active", parentId: null, index: Infinity });
    assert.deepEqual(tags(tree.active), ["[g]", "d", "z"]);
});

test("clone gives every node a fresh id", () => {
    const { tree, group } = sample();
    const copy = model.clone(group);
    assert.notEqual(copy.id, group.id);
    assert.notEqual(copy.children[0].id, group.children[0].id);
    assert.deepEqual(tags(copy.children), tags(group.children));
    assert.equal(model.find(tree, copy.id), null, "the clone must not be in the tree yet");
});

test("wrapInGroup replaces the node in place", () => {
    const { tree, d } = sample();
    const wrapper = model.wrapInGroup(tree, d.id, "w");
    assert.deepEqual(tags(tree.active), ["[g]", "[w]"]);
    assert.deepEqual(tags(wrapper.children), ["d"]);
});

test("remove detaches the node", () => {
    const { tree, group } = sample();
    assert.equal(model.remove(tree, group.children[0].id), true);
    assert.deepEqual(tags(group.children), ["c"]);
    assert.equal(model.remove(tree, "nope"), false);
});

test("tagNamesIn walks nested groups", () => {
    const { tree } = sample();
    assert.deepEqual([...model.tagNamesIn(tree, "active")].sort(), ["b", "c", "d"]);
});

if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("model cases ok");
