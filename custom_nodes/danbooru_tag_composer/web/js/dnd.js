// ドラッグ&ドロップ。
//
// サイドバーはキャンバスの CSS transform の外にあるので、HTML5 のネイティブ D&D が
// そのまま使える。ノード内に同じ UI を置くとキャンバスのズーム倍率でドロップ座標が
// ずれるうえ LiteGraph 側のポインタ処理とも競合するため、編集 UI はここに出している。
//
// 並べ替えも、グループへの投入も、適用エリアと非適用エリアの行き来も、候補からの新規追加も、
// すべて「{area, parentId, index} を決めて insert する」という一つの形に落としてある。
//
// tree.js が用意する DOM の約束:
//   .dtc-list[data-area][data-parent]  … 子ノードを並べる入れ物。data-parent が空ならエリア直下
//   .dtc-item[data-id]                 … .dtc-list の直接の子。中に .dtc-row と .dtc-children を持つ
//   .dtc-row                           … 行そのもの。当たり判定はこの矩形で取る

// グループ行の上下端からこの割合までを「前/後ろに入れる」、残りの真ん中を
// 「このグループの中に入れる」とみなす
const GROUP_EDGE_RATIO = 0.3;

const DROP_CLASSES = ["dtc-drop-before", "dtc-drop-after", "dtc-drop-into"];

// dataTransfer は dragover 中に読めないブラウザがあるため、実体はここに置く。
// dataTransfer 側には Firefox でドラッグを開始させるためのダミーを入れておく
let payload = null;

export function beginDrag(event, data) {
    payload = data;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", data.kind === "move" ? data.id : "");
}

export function endDrag() {
    payload = null;
    clearIndicator();
}

export function currentDrag() {
    return payload;
}

let marked = null;

function clearIndicator() {
    if (marked) marked.classList.remove(...DROP_CLASSES);
    marked = null;
}

function mark(el, className) {
    if (marked !== el) clearIndicator();
    marked = el;
    el.classList.remove(...DROP_CLASSES);
    el.classList.add(className);
}

function listTarget(list, index) {
    return {
        area: list.dataset.area,
        parentId: list.dataset.parent || null,
        index,
    };
}

function indexOfItem(item) {
    let index = 0;
    for (let sibling = item.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.classList.contains("dtc-item")) index += 1;
    }
    return index;
}

/**
 * ポインタの位置から落とし先を決め、目印を出す。
 *
 * 行の上半分なら手前、下半分なら後ろ。グループ行は真ん中を広く取り、そこへ落とすと
 * グループの中 (先頭) に入る。行の上でなければ、その入れ物の末尾。
 */
export function resolveTarget(event) {
    const row = event.target.closest?.(".dtc-row");
    const item = row?.closest(".dtc-item");

    if (item) {
        const list = item.parentElement.closest(".dtc-list");
        const rect = row.getBoundingClientRect();
        const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
        const isGroup = item.dataset.kind === "group";

        if (isGroup && ratio > GROUP_EDGE_RATIO && ratio < 1 - GROUP_EDGE_RATIO) {
            mark(row, "dtc-drop-into");
            return { area: list.dataset.area, parentId: item.dataset.id, index: 0 };
        }

        const after = ratio >= 0.5;
        mark(row, after ? "dtc-drop-after" : "dtc-drop-before");
        return listTarget(list, indexOfItem(item) + (after ? 1 : 0));
    }

    const list = event.target.closest?.(".dtc-list");
    if (list) {
        mark(list, "dtc-drop-into");
        return listTarget(list, list.querySelectorAll(":scope > .dtc-item").length);
    }

    clearIndicator();
    return null;
}

/**
 * 落とし先になれる要素に配線する。
 *
 * onDrop は落とし先を受け取り、実際に動かせたかどうかを返す。
 */
export function installDropZone(root, onDrop) {
    root.addEventListener("dragover", (event) => {
        if (!payload) return;
        // preventDefault しないとブラウザがドロップを受け付けない
        event.preventDefault();
        event.dataTransfer.dropEffect = payload.kind === "move" ? "move" : "copy";
        resolveTarget(event);
    });

    root.addEventListener("dragleave", (event) => {
        // 子要素へ移っただけの dragleave は無視する
        if (!root.contains(event.relatedTarget)) clearIndicator();
    });

    root.addEventListener("drop", (event) => {
        if (!payload) return;
        event.preventDefault();
        const target = resolveTarget(event);
        const data = payload;
        endDrag();
        if (target) onDrop(data, target);
    });
}

/** 行をつかんで動かせるようにする。 */
export function makeDraggable(el, getPayload) {
    el.draggable = true;
    el.addEventListener("dragstart", (event) => {
        const data = getPayload();
        if (!data) {
            event.preventDefault();
            return;
        }
        el.classList.add("dtc-dragging");
        beginDrag(event, data);
    });
    el.addEventListener("dragend", () => {
        el.classList.remove("dtc-dragging");
        endDrag();
    });
}
