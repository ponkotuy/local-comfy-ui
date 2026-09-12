// ツリーの描画。DOM の組み立てとイベントの取り付けだけを受け持ち、
// ツリーそのものの書き換えは model.js、落とし先の判定は dnd.js に任せる。

import * as model from "./model.js";
import { makeDraggable } from "./dnd.js";
import { formatWeight } from "./render.js";

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

    // 重みの付け外しは ⋯ メニューに寄せてある。ここは付いていることの表示だけ
    if (node.w !== 1.0) row.appendChild(el("span", "dtc-weight", `×${formatWeight(node.w)}`));

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
