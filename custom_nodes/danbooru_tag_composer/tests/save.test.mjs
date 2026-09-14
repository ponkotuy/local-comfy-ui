// save.js のセーブ形式。DOM を使わないので node だけで走る。
// 実行は tests/test_tag_composer.py 経由 (node があるときだけ走る)。

import assert from "node:assert/strict";
import * as save from "../web/js/save.js";
import * as model from "../web/js/model.js";

const failures = [];
function test(name, fn) {
    try {
        fn();
    } catch (error) {
        failures.push(`${name}\n  ${error.message}`);
    }
}

/** 復元できていないと困るものを一通り入れたツリー。 */
function sample() {
    return model.hydrate({
        active: [
            model.makeTag("1girl", { w: 1.3, ja: "女の子" }),
            model.makeGroup("髪", [model.makeTag("long_hair"), model.makeTag("blonde_hair")]),
            // 古いツリーには行ごとの on: false が残っていることがある
            model.makeTag("smile", { on: false }),
        ],
        // 折りたたんだままのグループも、開閉の状態ごと戻る
        inactive: [{ ...model.makeGroup("控え", [model.makeTag("nsfw")]), open: false }],
    });
}

test("pack then unpack restores both areas exactly", () => {
    const tree = sample();
    const restored = save.unpack(save.pack(tree)).tree;
    assert.deepEqual(restored, tree);
});

test("the file survives a trip through JSON", () => {
    const tree = sample();
    const text = JSON.stringify(save.pack(tree, { name: "夜景" }), null, 2);
    const loaded = save.unpack(text);
    assert.equal(loaded.name, "夜景");
    assert.deepEqual(loaded.tree, tree);
});

test("the envelope carries the format marker and a timestamp", () => {
    const packed = save.pack(model.emptyTree(), {
        name: " 名前 ",
        savedAt: new Date(Date.UTC(2026, 8, 14, 5, 12, 33)),
    });
    assert.equal(packed.format, save.FORMAT);
    assert.equal(packed.version, save.FORMAT_VERSION);
    // 名前は前後の空白だけ落とす
    assert.equal(packed.name, "名前");
    assert.equal(packed.saved_at, "2026-09-14T05:12:33.000Z");
});

test("options are written with the widget's own names", () => {
    const packed = save.pack(model.emptyTree(), {
        options: { separator: " | ", underscoreToSpace: true },
    });
    assert.deepEqual(packed.options, { separator: " | ", underscore_to_space: true });
    assert.deepEqual(save.unpack(packed).options, {
        separator: " | ",
        underscoreToSpace: true,
    });
});

test("a save without options leaves the node's settings alone", () => {
    // options が無ければ null。panel.js はこれを見てノードの設定に触らない
    for (const raw of [undefined, null, "ぬるぽ", {}, []]) {
        const loaded = save.unpack({ format: save.FORMAT, options: raw, tree: model.emptyTree() });
        assert.equal(loaded.options, null, `options: ${JSON.stringify(raw)}`);
    }
});

test("only the options that are present are restored", () => {
    const loaded = save.unpack({
        format: save.FORMAT,
        options: { underscore_to_space: true },
        tree: model.emptyTree(),
    });
    assert.deepEqual(loaded.options, { underscoreToSpace: true });
    assert.equal("separator" in loaded.options, false, "separator must stay untouched");
});

test("a bare tree is accepted as a save", () => {
    // ノードの tags ウィジェットの値をそのまま貼ってきた場合
    const loaded = save.unpack({ version: 1, active: [{ kind: "tag", tag: "1girl" }] });
    assert.equal(loaded.tree.active[0].tag, "1girl");
    assert.deepEqual(loaded.tree.inactive, []);
    assert.equal(loaded.options, null);
});

test("an envelope without the marker is accepted when it holds a tree", () => {
    const loaded = save.unpack({ name: "x", tree: { active: [{ tag: "1girl" }], inactive: [] } });
    assert.equal(loaded.tree.active[0].tag, "1girl");
});

test("an empty envelope loads as an empty tree", () => {
    const loaded = save.unpack({ format: save.FORMAT, version: 1 });
    assert.deepEqual(loaded.tree, model.emptyTree());
});

test("anything that is not a save is refused", () => {
    // ワークフロー JSON を間違えて選んだときに、空のツリーで上書きしてしまわない
    const cases = [
        { nodes: [], links: [] },
        { 品質UP: { kind: "group", children: [] } },
        [1, 2, 3],
        "not json",
        "",
        null,
        42,
    ];
    for (const value of cases) {
        assert.equal(save.unpack(value), null, `expected null for ${JSON.stringify(value)}`);
    }
});

test("a future version is read as far as it can be", () => {
    const loaded = save.unpack({ format: save.FORMAT, version: 99, tree: { active: [], inactive: [] } });
    assert.equal(loaded.version, 99);
    assert.deepEqual(loaded.tree, model.emptyTree());
});

test("file names drop what a filesystem cannot take", () => {
    assert.equal(save.toFileName("夜景・ロング"), "夜景・ロング.json");
    // 空白とハイフンは名前の一部として残す
    assert.equal(save.toFileName("night city - long"), "night city - long.json");
    assert.equal(save.toFileName('a/b:c*d?e"f<g>h|i'), "a_b_c_d_e_f_g_h_i.json");
    assert.equal(save.toFileName("../../etc/passwd"), "_.._etc_passwd.json");
    assert.equal(save.toFileName(".hidden"), "hidden.json");
    assert.equal(save.toFileName("trailing. "), "trailing.json");
});

test("a name that leaves nothing behind has no file name", () => {
    for (const name of ["", "   ", "...", ". .", null, undefined, 42]) {
        assert.equal(save.toFileName(name), null, `expected null for ${JSON.stringify(name)}`);
    }
});

test("fromFileName is what the list shows", () => {
    assert.equal(save.fromFileName("夜景・ロング.json"), "夜景・ロング");
    assert.equal(save.fromFileName("Night.JSON"), "Night");
    assert.equal(save.fromFileName("danbooru-tag-composer/saves/a.json"), "a");
    // 拡張子が無くても名前としては読めるようにしておく
    assert.equal(save.fromFileName("plain"), "plain");
});

test("a name round-trips through the file name when it is already safe", () => {
    for (const name of ["夜景・ロング", "portrait v2", "a-b_c"]) {
        assert.equal(save.fromFileName(save.toFileName(name)), name);
    }
});

if (failures.length) {
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("save cases ok");
