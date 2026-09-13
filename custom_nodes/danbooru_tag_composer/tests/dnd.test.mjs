// dnd.js のドラッグの取り決め。DOM は最小限の張りぼてで足りるので node だけで走る。
// 実行は tests/test_tag_composer.py 経由 (node があるときだけ走る)。

import assert from "node:assert/strict";
import { beginDrag, endDrag, installDropZone } from "../web/js/dnd.js";

const failures = [];
function test(name, fn) {
    try {
        fn();
        endDrag();
    } catch (error) {
        failures.push(`${name}\n  ${error.message}`);
    }
}

function fakeTransfer() {
    return {
        data: {},
        effectAllowed: "uninitialized",
        dropEffect: "none",
        setData(type, value) {
            this.data[type] = value;
        },
    };
}

/** 空の適用エリア 1 つぶんの張りぼて。落とし先は「一番外のリストの末尾」になる。 */
function fakeRoot() {
    const list = {
        dataset: { area: "active", parent: "" },
        classList: { add() {}, remove() {} },
        querySelectorAll: () => [],
    };
    const handlers = {};
    return {
        addEventListener: (type, fn) => (handlers[type] = fn),
        querySelector: (selector) => (selector === ".dtc-list" ? list : null),
        contains: () => false,
        fire(type, event) {
            handlers[type]({ preventDefault() {}, target: {}, clientY: 0, ...event });
        },
    };
}

/** dropEffect が effectAllowed の許す範囲に入っているか。 */
function permitted(effectAllowed, dropEffect) {
    if (effectAllowed === "all" || effectAllowed === "uninitialized") return true;
    return effectAllowed.toLowerCase().includes(dropEffect);
}

// 食い違うとブラウザは drop イベントを飛ばさない。候補チップを move で始めて copy で
// 受けようとしていたために、候補からのドラッグだけエリアへ落とせなかった
for (const payload of [
    { kind: "move", id: "t1", text: "1girl" },
    { kind: "new", node: { id: "t2", kind: "tag", tag: "1girl" }, text: "1girl" },
]) {
    test(`${payload.kind}: dropEffect が effectAllowed と噛み合う`, () => {
        const transfer = fakeTransfer();
        beginDrag({ dataTransfer: transfer }, payload);

        const root = fakeRoot();
        installDropZone(root, () => {});
        root.fire("dragover", { dataTransfer: transfer });

        assert.ok(
            permitted(transfer.effectAllowed, transfer.dropEffect),
            `effectAllowed=${transfer.effectAllowed} では dropEffect=${transfer.dropEffect} は通らない`,
        );
    });
}

test("候補チップを落とすと適用エリアの末尾が落とし先になる", () => {
    const node = { id: "t3", kind: "tag", tag: "smile" };
    beginDrag({ dataTransfer: fakeTransfer() }, { kind: "new", node, text: "smile" });

    const root = fakeRoot();
    const drops = [];
    installDropZone(root, (data, target) => drops.push({ data, target }));
    root.fire("drop", {});

    assert.equal(drops.length, 1, "drop が届いていない");
    assert.equal(drops[0].data.node, node);
    assert.deepEqual(drops[0].target, { area: "active", parentId: null, index: 0 });
});

test("ドラッグ中のテキストは表示用の文字列", () => {
    const transfer = fakeTransfer();
    beginDrag({ dataTransfer: transfer }, { kind: "new", node: {}, text: "1girl" });
    assert.equal(transfer.data["text/plain"], "1girl");
});

if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("dnd cases ok");
