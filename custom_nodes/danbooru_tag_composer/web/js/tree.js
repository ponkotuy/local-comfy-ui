// ツリーの描画。DOM の組み立てとイベントの取り付けだけを受け持ち、
// ツリーそのものの書き換えは model.js、落とし先の判定は dnd.js に任せる。

import * as model from "./model.js";
import { makeDraggable } from "./dnd.js";
import { formatWeight } from "./render.js";

// 重みの上下ドラッグの刻み。タグチップの上でのドラッグなので細かすぎると合わせにくい
const WEIGHT_STEP = 0.05;
// 1 刻み動かすのに必要なドラッグ量 (px)
const WEIGHT_PIXELS_PER_STEP = 6;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * 1 つのエリアを描く。
 *
 * ctx は panel.js が用意する {tree, translate(tag), onChange(), onCommit()} など。
 * 見た目を変えるだけの操作 (グループの開閉) は onChange、ツリーの中身が変わる操作は
 * onCommit を呼ぶ。onCommit はワークフローの widget へ書き戻すので、undo 履歴が
 * 1 操作につき 1 段になるよう「確定した瞬間」にだけ呼ぶこと。
 */
export function renderArea(container, ctx, area) {
    container.replaceChildren(renderList(ctx, ctx.tree[area] || [], area, null));
}

function renderList(ctx, nodes, area, parentId) {
    const list = el("div", "dtc-list");
    list.dataset.area = area;
    list.dataset.parent = parentId || "";
    for (const node of nodes) list.appendChild(renderItem(ctx, node, area));
    if (!nodes.length) list.appendChild(el("div", "dtc-empty", ctx.emptyText(area, parentId)));
    return list;
}

function renderItem(ctx, node, area) {
    const item = el("div", "dtc-item");
    item.dataset.id = node.id;
    item.dataset.kind = node.kind;
    item.appendChild(node.kind === "group" ? groupRow(ctx, node, area) : tagRow(ctx, node));

    if (node.kind === "group" && node.open) {
        const children = el("div", "dtc-children");
        children.appendChild(renderList(ctx, node.children, area, node.id));
        item.appendChild(children);
    }
    return item;
}

function commonRow(ctx, node, className) {
    const row = el("div", `dtc-row ${className}`);
    if (!node.on) row.classList.add("dtc-off");

    const grip = el("span", "dtc-grip", "⠿");
    grip.title = "ドラッグで移動";
    row.appendChild(grip);

    const toggle = el("button", "dtc-toggle");
    toggle.type = "button";
    toggle.textContent = node.on ? "◉" : "◯";
    toggle.title = node.on ? "適用中。クリックで外す" : "外してある。クリックで戻す";
    toggle.setAttribute("aria-pressed", String(node.on));
    toggle.addEventListener("click", () => {
        node.on = !node.on;
        ctx.onCommit();
    });
    row.appendChild(toggle);

    makeDraggable(row, () => ({ kind: "move", id: node.id }));
    return row;
}

function tagRow(ctx, node) {
    const row = commonRow(ctx, node, "dtc-tag");

    const name = el("span", "dtc-name", node.tag);
    name.title = node.tag;
    row.appendChild(name);

    const ja = ctx.translate(node) || {};
    // 対訳が文字列でないときは出さない。配列やオブジェクトをそのまま textContent に
    // 入れると「ソロ,0」「[object Object]」のような表示になる
    ja.text = typeof ja.text === "string" ? ja.text : "";
    const label = el("span", "dtc-ja", ja.text);
    if (!ja.text) {
        label.classList.add("dtc-ja-missing");
        label.title = "対訳が未登録。クリックで入力";
    } else if (ja.machine) {
        // 機械翻訳は誤訳がありうる (border -> 国境)。直せることが伝わるようにしておく
        label.classList.add("dtc-ja-machine");
        label.title = `対訳: ${ja.text}（機械翻訳。誤りがあればクリックで修正）`;
    } else {
        label.title = `対訳: ${ja.text} (クリックで編集)`;
    }
    label.addEventListener("click", () => ctx.editTranslation(node));
    row.appendChild(label);

    const weight = el("span", "dtc-weight", node.w === 1.0 ? "" : `×${formatWeight(node.w)}`);
    weight.title = "上下にドラッグで重みを調整 / ダブルクリックで 1.0 に戻す";
    installWeightDrag(ctx, node, weight, row);
    row.appendChild(weight);

    row.appendChild(menuButton(ctx, node));
    return row;
}

function groupRow(ctx, node, area) {
    const row = commonRow(ctx, node, "dtc-group");

    const twisty = el("button", "dtc-twisty", node.open ? "▾" : "▸");
    twisty.type = "button";
    twisty.title = node.open ? "折りたたむ" : "開く";
    twisty.addEventListener("click", () => {
        node.open = !node.open;
        // 開閉は見た目だけの話なので、ワークフローへ書き戻して undo 履歴を汚さない
        ctx.onChange();
    });
    row.insertBefore(twisty, row.children[1]);

    const name = el("span", "dtc-name dtc-group-name", node.name || "(名前なし)");
    if (!node.name) name.classList.add("dtc-ja-missing");
    name.title = "クリックで名前を変更";
    name.addEventListener("click", () => ctx.renameGroup(node));
    row.appendChild(name);

    const count = countTags(node);
    row.appendChild(el("span", "dtc-count", `${count.on}/${count.total}`));
    row.appendChild(menuButton(ctx, node, area));
    return row;
}

function countTags(group) {
    let on = 0;
    let total = 0;
    const visit = (nodes, enabled) => {
        for (const node of nodes) {
            const live = enabled && node.on !== false;
            if (node.kind === "group") {
                visit(node.children, live);
            } else {
                total += 1;
                if (live) on += 1;
            }
        }
    };
    visit(group.children, true);
    return { on, total };
}

function menuButton(ctx, node) {
    const button = el("button", "dtc-menu", "⋯");
    button.type = "button";
    button.title = "メニュー";
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        ctx.openMenu(node, button);
    });
    return button;
}

/**
 * 重みの上下ドラッグ。
 *
 * ポインタを掴んでいる間は表示だけを更新し、離した時点で一度だけ確定させる。
 * 毎フレーム書き戻すと undo 履歴がドラッグの回数だけ積まれて使い物にならなくなる。
 */
function installWeightDrag(ctx, node, label, row) {
    label.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // ドラッグ中は行そのものの D&D を止める。両方生きていると HTML5 の
        // ドラッグが先に走って重みを合わせられない
        row.draggable = false;
        label.setPointerCapture(event.pointerId);

        const startY = event.clientY;
        const startWeight = node.w;

        const onMove = (moveEvent) => {
            const steps = Math.round((startY - moveEvent.clientY) / WEIGHT_PIXELS_PER_STEP);
            const next = Math.max(0, Math.min(10, startWeight + steps * WEIGHT_STEP));
            node.w = Math.round(next * 100) / 100;
            label.textContent = node.w === 1.0 ? "" : `×${formatWeight(node.w)}`;
            ctx.onPreview();
        };

        const onUp = () => {
            label.removeEventListener("pointermove", onMove);
            label.removeEventListener("pointerup", onUp);
            label.removeEventListener("pointercancel", onUp);
            row.draggable = true;
            if (node.w !== startWeight) ctx.onCommit();
        };

        label.addEventListener("pointermove", onMove);
        label.addEventListener("pointerup", onUp);
        label.addEventListener("pointercancel", onUp);
    });

    label.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (node.w === 1.0) return;
        node.w = 1.0;
        ctx.onCommit();
    });
}

/** 候補やプリセットのチップ。掴んでエリアへ落とせる。 */
export function makeChip(label, sub, buildNode, onActivate) {
    const chip = el("div", "dtc-chip");
    chip.appendChild(el("span", "dtc-chip-name", label));
    if (sub) chip.appendChild(el("span", "dtc-chip-sub", sub));
    chip.title = "ドラッグしてエリアへ / クリックで適用エリアの末尾に追加";
    makeDraggable(chip, () => ({ kind: "new", node: buildNode() }));
    chip.addEventListener("click", () => onActivate(buildNode()));
    return chip;
}

export { model };
