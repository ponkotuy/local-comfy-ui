// ノード (LGraphNode) との読み書き。
//
// ツリーの保存先は Python 側で宣言した tree ウィジェットの値 (JSON 文字列) 一本に
// 絞ってある。こうしておくとワークフローの保存・読込・API 実行のすべてに自動で乗り、
// undo も ComfyUI の changeTracker がそのまま面倒を見てくれる。

import { app } from "/scripts/app.js";
import * as model from "./model.js";
import { dumps, DEFAULT_SEPARATOR } from "./render.js";

export const NODE_TYPE = "DanbooruTagComposer";
export const TREE_WIDGET = "tree";

export function isComposer(node) {
    return node?.type === NODE_TYPE || node?.comfyClass === NODE_TYPE;
}

function widget(node, name) {
    return node?.widgets?.find((w) => w.name === name) ?? null;
}

export function treeWidget(node) {
    return widget(node, TREE_WIDGET);
}

/** ノードの現在のツリーを、UI が触れる状態 (id 付き) にして返す。 */
export function readTree(node) {
    return model.hydrate(treeWidget(node)?.value);
}

/** ツリーをノードへ書き戻す。ワークフローに載るのはこの瞬間だけ。 */
export function writeTree(node, tree) {
    const w = treeWidget(node);
    if (!w) return false;

    const next = dumps(tree);
    if (w.value === next) return false;
    w.value = next;
    // ウィジェットに callback を付けている拡張があるかもしれないので通しておく
    w.callback?.(next);
    app.graph?.setDirtyCanvas(true, true);
    emit(node);
    return true;
}

/** プレビューと出力に効く設定をノードから読む。 */
export function readOptions(node) {
    return {
        separator: widget(node, "separator")?.value ?? DEFAULT_SEPARATOR,
        underscoreToSpace: widget(node, "underscore_to_space")?.value === true,
    };
}

// --- 変更の通知 -------------------------------------------------------------
// サイドバーで編集した結果をノード上のサマリ表示へ反映するための、拡張内だけの配線。

const listeners = new Set();

export function onTreeChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function emit(node) {
    for (const listener of listeners) {
        try {
            listener(node);
        } catch (error) {
            console.error("[Tag Composer] listener failed", error);
        }
    }
}

/** グラフ上の Composer ノードを一覧する。 */
export function allComposers() {
    return (app.graph?.nodes ?? []).filter(isComposer);
}

/** いま選択されている Composer ノード。無ければ null。 */
export function selectedComposer() {
    const selected = Object.values(app.canvas?.selected_nodes ?? {});
    return selected.find(isComposer) ?? null;
}
