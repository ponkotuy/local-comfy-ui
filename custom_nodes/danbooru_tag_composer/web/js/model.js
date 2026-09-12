// ツリーの中身をいじるための操作。描画も DOM も知らない純粋な関数だけを置く。
//
// 位置は {area, parentId, index} の 3 つ組で表す。parentId が null ならエリア直下、
// そうでなければそのグループの children の中。ドラッグ&ドロップの移動も、候補からの
// 追加も、プリセットの投入も、すべてこの 3 つ組への insert に落ちる。

import { loads, normalize, emptyTree, MAX_DEPTH } from "./render.js";

export { loads, normalize, emptyTree };

let idCounter = 0;

export function newId(prefix) {
    idCounter += 1;
    return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function makeTag(tag, extra = {}) {
    return { id: newId("t"), kind: "tag", tag, on: true, w: 1.0, ja: null, ...extra };
}

export function makeGroup(name = "", children = []) {
    return { id: newId("g"), kind: "group", name, on: true, open: true, children };
}

/** normalize() が id を落とした後などに、空の id を埋め直す。 */
export function ensureIds(tree) {
    forEachNode(tree, (node) => {
        if (!node.id) node.id = newId(node.kind === "group" ? "g" : "t");
    });
    return tree;
}

/** 読み込んだ JSON を、UI が触れる状態 (id 付き) にして返す。 */
export function hydrate(data) {
    return ensureIds(loads(data));
}

export function forEachNode(tree, fn) {
    for (const area of ["active", "inactive"]) {
        walk(tree[area] || [], null, area, fn);
    }
}

function walk(list, parentId, area, fn) {
    for (let index = 0; index < list.length; index++) {
        const node = list[index];
        fn(node, { area, parentId, index, list });
        if (node.kind === "group") walk(node.children, node.id, area, fn);
    }
}

/** id からノードと、その居場所を返す。 */
export function find(tree, id) {
    let found = null;
    forEachNode(tree, (node, where) => {
        if (!found && node.id === id) found = { node, ...where };
    });
    return found;
}

/** {area, parentId} が指す配列を返す。見つからなければ null。 */
export function listAt(tree, area, parentId) {
    if (!parentId) return tree[area] || null;
    const hit = find(tree, parentId);
    return hit && hit.node.kind === "group" ? hit.node.children : null;
}

/** ancestorId の部分木に id が含まれるか。自分自身も含む。 */
export function isWithin(tree, ancestorId, id) {
    if (ancestorId === id) return true;
    const hit = find(tree, ancestorId);
    if (!hit || hit.node.kind !== "group") return false;

    let found = false;
    walk(hit.node.children, hit.node.id, hit.area, (node) => {
        if (node.id === id) found = true;
    });
    return found;
}

/** そこへ入れたときのグループの深さ。MAX_DEPTH を超える移動を弾くのに使う。 */
export function depthAt(tree, parentId) {
    let depth = 0;
    let cursor = parentId;
    while (cursor) {
        const hit = find(tree, cursor);
        if (!hit) break;
        depth += 1;
        cursor = hit.parentId;
    }
    return depth;
}

function subtreeHeight(node) {
    if (node.kind !== "group") return 0;
    let height = 0;
    for (const child of node.children) height = Math.max(height, subtreeHeight(child) + 1);
    return height;
}

/** node をそこへ置いてよいか。循環と、深くなりすぎる入れ子を拒否する。 */
export function canDrop(tree, node, target) {
    if (!listAt(tree, target.area, target.parentId)) return false;
    // 自分自身の子孫の中へは入れられない (入れるとツリーが輪になる)
    if (target.parentId && isWithin(tree, node.id, target.parentId)) return false;
    return depthAt(tree, target.parentId) + subtreeHeight(node) < MAX_DEPTH;
}

/** id のノードを切り離して返す。見つからなければ null。 */
export function detach(tree, id) {
    const hit = find(tree, id);
    if (!hit) return null;
    hit.list.splice(hit.index, 1);
    return hit.node;
}

/** target の位置へ差し込む。index が範囲外なら末尾。 */
export function insert(tree, node, target) {
    const list = listAt(tree, target.area, target.parentId);
    if (!list) return false;
    const index = Math.max(0, Math.min(list.length, target.index ?? list.length));
    list.splice(index, 0, node);
    return true;
}

/**
 * id のノードを target へ動かす。
 *
 * 同じ配列の中で後ろへ動かすときは、先に取り除いた分だけ挿入位置がずれるので
 * 補正する。これを忘れると 1 つ手前に落ちる。
 */
export function move(tree, id, target) {
    const hit = find(tree, id);
    if (!hit || !canDrop(tree, hit.node, target)) return false;

    let index = target.index;
    if (hit.area === target.area && hit.parentId === target.parentId && index > hit.index) {
        index -= 1;
    }

    const node = detach(tree, id);
    if (!node) return false;
    return insert(tree, node, { ...target, index });
}

export function remove(tree, id) {
    return detach(tree, id) !== null;
}

/** 部分木を id 付きで複製する。プリセットの投入とノードの複製で使う。 */
export function clone(node) {
    if (node.kind === "group") {
        return {
            ...node,
            id: newId("g"),
            children: node.children.map(clone),
        };
    }
    return { ...node, id: newId("t") };
}

/** そのノードとその配下をまとめて on/off する。 */
export function setEnabled(tree, id, on) {
    const hit = find(tree, id);
    if (!hit) return false;
    hit.node.on = on;
    return true;
}

/** 選んだノードを新しいグループでくるむ。 */
export function wrapInGroup(tree, id, name = "") {
    const hit = find(tree, id);
    if (!hit) return null;
    const group = makeGroup(name, [hit.node]);
    hit.list.splice(hit.index, 1, group);
    return group;
}

/** 適用エリアにあるタグ名の集合。候補に「追加済み」の印を付けるのに使う。 */
export function tagNamesIn(tree, area) {
    const names = new Set();
    walk(tree[area] || [], null, area, (node) => {
        if (node.kind === "tag") names.add(node.tag);
    });
    return names;
}
