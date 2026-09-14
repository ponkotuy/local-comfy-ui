// サイドバーの Tag Composer パネル。
//
// 文字入力はタグの検索欄と、対訳・グループ名の入力だけ。タグやグループの位置と所属は
// すべてドラッグ&ドロップで変え、適用/非適用の切り替えはワンクリックで済ませる。

import { app } from "/scripts/app.js";
import * as api from "./api.js";
import * as model from "./model.js";
import * as nodeio from "./nodeio.js";
import * as save from "./save.js";
import { installDropZone } from "./dnd.js";
import { renderArea, makeChip } from "./tree.js";
import { render as renderPrompt, countTags } from "./render.js";

const AREA_LABELS = { active: "適用エリア", inactive: "非適用エリア" };
// メニューから付け外しできる強調の重み。実際に使うのはこの 1 段だけなので、
// 任意の値を入れる UI は置いていない
const EMPHASIS_WEIGHT = 1.3;
const SUGGEST_DEBOUNCE_MS = 120;
const SUGGEST_LIMIT = 24;
// 編集対象の行に出した一時的な知らせを消すまで
const NOTICE_MS = 2400;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * サーバーから来た対訳を {ja, machine} の形に揃える。
 *
 * /translate の戻り値を「対訳の文字列」から [対訳, 出どころ] に変えたとき、開いた
 * ままのタブが古い JS で新しい応答を受け取り、配列がそのまま textContent に入って
 * 「ソロ,0」と表示された。応答の形が変わっても表示が壊れないよう、受け取り口を
 * ここ一箇所にまとめて、文字列以外は対訳なしとして扱う。
 */
function readTranslation(value) {
    if (Array.isArray(value)) {
        const [ja, source] = value;
        return { ja: typeof ja === "string" ? ja : "", machine: source === api.SOURCE_MACHINE };
    }
    if (value && typeof value === "object") {
        return {
            ja: typeof value.ja === "string" ? value.ja : "",
            machine: value.machine === true || value.source === api.SOURCE_MACHINE,
        };
    }
    return { ja: typeof value === "string" ? value : "", machine: false };
}

async function ask(title, value = "") {
    const dialog = app.extensionManager?.dialog;
    if (dialog?.prompt) {
        return dialog.prompt({ title, message: title, defaultValue: value });
    }
    return window.prompt(title, value);
}

/** 取り返しの付かない操作の確認。ダイアログが無い環境では素の confirm に落とす。 */
async function confirmAction(title, message, type = "default") {
    const dialog = app.extensionManager?.dialog;
    // dialog.confirm は閉じられたときに null を返すので、true だけを承諾とみなす
    if (dialog?.confirm) return (await dialog.confirm({ title, message, type })) === true;
    return window.confirm(`${title}\n\n${message}`);
}

/** テキストをファイルとしてダウンロードさせる。 */
function download(fileName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    // 文書に入っていない <a> の click() を無視するブラウザがあるので、一度ぶら下げる
    document.body.appendChild(link);
    link.click();
    link.remove();
    // click() が実際にダウンロードを始めるまで URL を生かしておく
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** セーブの一覧に出す日時。年は要らないので月日と時刻だけ。 */
function formatTimestamp(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function mountPanel(root) {
    const panel = new ComposerPanel(root);
    return () => panel.destroy();
}

class ComposerPanel {
    constructor(root) {
        this.root = root;
        this.node = null;
        this.tree = model.emptyTree();
        this.options = { separator: ", ", underscoreToSpace: false };
        // タグ -> {ja, machine}。サーバーから引いた分をここに溜める
        this.glossary = new Map();
        this.overrides = {};
        this.presets = {};
        // 保存済みのセーブ {file, modified}。中身は読み込むときに初めて取りに行く
        this.saves = [];
        this.suggestTimer = null;
        // 編集対象の行に出している一時的な知らせ。出ていなければ null
        this.notice = null;
        this.noticeTimer = null;
        this.suggestSeq = 0;
        // commit 中に来た自分宛ての変更通知を無視するための印
        this.committing = false;

        this.build();
        this.installCanvasHooks();
        this.loadUserData();
        this.retarget(nodeio.selectedComposer());
    }

    // --- 組み立て -----------------------------------------------------------

    build() {
        this.root.classList.add("dtc-root");
        const panel = el("div", "dtc-panel");

        this.targetLabel = el("div", "dtc-target");
        panel.appendChild(this.targetLabel);

        panel.appendChild(this.buildSearch());

        this.areaBoxes = {};
        for (const area of ["active", "inactive"]) {
            const section = el("section", `dtc-area dtc-area-${area}`);
            const header = el("header", "dtc-area-header");
            header.appendChild(el("h3", null, AREA_LABELS[area]));

            const counter = el("span", "dtc-area-count");
            header.appendChild(counter);

            const addGroup = el("button", "dtc-btn", "＋グループ");
            addGroup.type = "button";
            addGroup.title = "このエリアの末尾に空のグループを作る";
            addGroup.addEventListener("click", () => this.addGroup(area));
            header.appendChild(addGroup);

            const clear = el("button", "dtc-btn dtc-btn-danger", "クリア");
            clear.type = "button";
            clear.title = "このエリアのタグとグループをすべて捨てる";
            clear.addEventListener("click", () => this.clearArea(area));
            header.appendChild(clear);

            section.appendChild(header);
            const body = el("div", "dtc-area-body");
            section.appendChild(body);
            panel.appendChild(section);

            this.areaBoxes[area] = { body, counter };
            // ヘッダーも含めたエリアの枠ごと落とし先にする
            installDropZone(section, (payload, target) => this.handleDrop(payload, target));
        }

        panel.appendChild(this.buildPresets());
        panel.appendChild(this.buildSaves());
        panel.appendChild(this.buildPreview());

        this.root.replaceChildren(panel);
        this.menu = null;
        this.onDocumentPointerDown = (event) => {
            if (this.menu && !this.menu.contains(event.target)) this.closeMenu();
        };
        document.addEventListener("pointerdown", this.onDocumentPointerDown);
    }

    buildSearch() {
        const box = el("div", "dtc-search");
        this.searchInput = el("input", "dtc-search-input");
        this.searchInput.type = "search";
        this.searchInput.placeholder = "タグを検索 (英語 / 日本語)";
        this.searchInput.addEventListener("input", () => this.scheduleSuggest());
        this.searchInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            const first = this.suggestBox.querySelector(".dtc-chip");
            if (first) first.click();
        });
        box.appendChild(this.searchInput);

        this.suggestBox = el("div", "dtc-suggest");
        box.appendChild(this.suggestBox);
        return box;
    }

    buildPresets() {
        const box = el("section", "dtc-area dtc-presets");
        const header = el("header", "dtc-area-header");
        header.appendChild(el("h3", null, "プリセット"));
        this.presetHint = el("span", "dtc-area-count");
        header.appendChild(this.presetHint);
        box.appendChild(header);

        this.presetBox = el("div", "dtc-suggest");
        box.appendChild(this.presetBox);
        return box;
    }

    /**
     * セーブ。プリセットが「グループ 1 つ」なのに対し、こちらは両エリアまるごと。
     *
     * 保存先は 2 つある。名前を付けて残すときは ComfyUI の userdata で、こちらは
     * 一覧から選んで読み戻せる。書き出し / 取り込みは手元の .json ファイルで、
     * ワークフローとは別にタグ構成だけを人に渡したり控えを取ったりするのに使う。
     * どちらも中身は同じ形式 (save.js) なので、書き出したものはそのまま取り込める。
     */
    buildSaves() {
        const box = el("section", "dtc-area dtc-saves");
        const header = el("header", "dtc-area-header");
        header.appendChild(el("h3", null, "セーブ"));
        this.saveHint = el("span", "dtc-area-count");
        header.appendChild(this.saveHint);

        const exportButton = el("button", "dtc-btn", "書き出し");
        exportButton.type = "button";
        exportButton.title = "いまの内容を .json ファイルとしてダウンロードする";
        exportButton.addEventListener("click", () => this.exportFile());
        header.appendChild(exportButton);

        const importButton = el("button", "dtc-btn", "取り込み");
        importButton.type = "button";
        importButton.title = "セーブファイル (.json) を開いて、いま編集中のノードに読み込む";
        importButton.addEventListener("click", () => this.filePicker.click());
        header.appendChild(importButton);
        box.appendChild(header);

        const bar = el("div", "dtc-save-bar");
        this.saveNameInput = el("input", "dtc-search-input dtc-save-name");
        this.saveNameInput.type = "text";
        this.saveNameInput.placeholder = "セーブ名";
        this.saveNameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") this.runSave();
        });
        bar.appendChild(this.saveNameInput);

        const saveButton = el("button", "dtc-btn", "保存");
        saveButton.type = "button";
        saveButton.title = "この名前で、適用エリアと非適用エリアの中身をまるごと保存する";
        saveButton.addEventListener("click", () => this.runSave());
        bar.appendChild(saveButton);
        box.appendChild(bar);

        this.filePicker = el("input", "dtc-file-picker");
        this.filePicker.type = "file";
        this.filePicker.accept = ".json,application/json";
        this.filePicker.addEventListener("change", () => {
            const [file] = this.filePicker.files ?? [];
            // 同じファイルを続けて選んでも change が飛ぶように、毎回空へ戻す
            this.filePicker.value = "";
            if (file) this.importFile(file);
        });
        box.appendChild(this.filePicker);

        this.saveBox = el("div", "dtc-suggest");
        box.appendChild(this.saveBox);
        return box;
    }

    buildPreview() {
        const box = el("section", "dtc-preview");
        const header = el("header", "dtc-area-header");
        header.appendChild(el("h3", null, "プロンプト"));

        const copy = el("button", "dtc-btn", "コピー");
        copy.type = "button";
        copy.addEventListener("click", () => {
            navigator.clipboard?.writeText(this.previewText.textContent ?? "");
        });
        header.appendChild(copy);
        box.appendChild(header);

        this.previewText = el("pre", "dtc-preview-text");
        box.appendChild(this.previewText);
        return box;
    }

    // --- 編集対象の切り替え -------------------------------------------------

    installCanvasHooks() {
        const canvas = app.canvas;
        this.restoreSelectionHook = null;
        if (canvas) {
            const previous = canvas.onSelectionChange;
            canvas.onSelectionChange = (...args) => {
                previous?.apply(canvas, args);
                const node = nodeio.selectedComposer();
                if (node) this.retarget(node);
            };
            this.restoreSelectionHook = () => {
                canvas.onSelectionChange = previous;
            };
        }

        // ワークフローを切り替えるとノードごと入れ替わるので、対象が生きているか見直す
        this.onGraphChanged = () => {
            if (this.node && !nodeio.allComposers().includes(this.node)) this.retarget(null);
        };
        app.api?.addEventListener("graphChanged", this.onGraphChanged);

        this.offTreeChanged = nodeio.onTreeChanged((node) => {
            // 自分の commit で戻ってきた通知は無視する (再描画すると編集中の入力が飛ぶ)
            if (node === this.node && !this.committing) this.reload();
        });
    }

    retarget(node) {
        this.node = node ?? null;
        this.closeMenu();
        // 前の対象に対して出した知らせは、対象が変わった時点で用済み
        clearTimeout(this.noticeTimer);
        this.notice = null;
        this.reload();
    }

    reload() {
        if (this.node) {
            this.tree = nodeio.readTree(this.node);
            this.options = nodeio.readOptions(this.node);
        } else {
            this.tree = model.emptyTree();
        }
        this.refresh();
        this.fetchTranslations();
    }

    // --- 描画 ---------------------------------------------------------------

    /** 見た目だけを作り直す。ワークフローには触らない。 */
    refresh() {
        this.targetLabel.textContent =
            this.notice ??
            (this.node
                ? `編集中: ${this.node.title || "Danbooru Tag Composer"} (#${this.node.id})`
                : "キャンバスで Danbooru Tag Composer ノードを選んでください");
        this.targetLabel.classList.toggle("dtc-target-empty", !this.notice && !this.node);
        this.targetLabel.classList.toggle("dtc-target-warn", this.notice !== null);

        const ctx = this.context();
        for (const area of ["active", "inactive"]) {
            renderArea(this.areaBoxes[area].body, ctx, area);
        }
        this.updateCounts();
        this.updatePreview();
        this.renderPresets();
        this.renderSaves();
        this.markUsedSuggestions();
    }

    /**
     * 編集対象の行に一時的な知らせを出す。
     *
     * 保存できた・読めなかった程度の話でダイアログを開くと、続けて操作するときに
     * 邪魔になる。refresh() を通しても消えないよう notice に持たせてあり、
     * 時間が経つと元の「編集中: …」へ戻る。
     */
    notify(message) {
        this.notice = message;
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => {
            this.notice = null;
            this.refresh();
        }, NOTICE_MS);
        this.refresh();
    }

    context() {
        return {
            tree: this.tree,
            translate: (node) => this.translationOf(node),
            emptyText: (area, parentId) =>
                parentId
                    ? "ここへドラッグ"
                    : area === "active"
                      ? "ここへタグをドラッグすると出力に入る"
                      : "外しておきたいタグをここへ",
            onChange: () => this.refresh(),
            onCommit: () => this.commit(),
            openMenu: (node, anchor) => this.openMenu(node, anchor),
            renameGroup: (node) => this.renameGroup(node),
            editTranslation: (node) => this.editTranslation(node),
        };
    }

    updateCounts() {
        for (const area of ["active", "inactive"]) {
            let on = 0;
            let total = 0;
            const visit = (nodes, enabled) => {
                for (const node of nodes) {
                    const live = enabled && node.on !== false;
                    if (node.kind === "group") visit(node.children, live);
                    else {
                        total += 1;
                        if (live) on += 1;
                    }
                }
            };
            visit(this.tree[area] || [], true);
            this.areaBoxes[area].counter.textContent =
                area === "active" ? `${on} / ${total} タグ` : `${total} タグ`;
        }
    }

    updatePreview() {
        const prompt = renderPrompt(this.tree, this.options);
        this.previewText.textContent = prompt;
        this.previewText.classList.toggle("dtc-preview-empty", !prompt);
        if (!prompt) this.previewText.textContent = "(出力なし)";
    }

    // --- 保存 ---------------------------------------------------------------

    /**
     * ツリーをノードへ書き戻す。
     *
     * ドラッグ中や重みの調整中は呼ばない。undo 履歴が 1 操作につき 1 段になるよう、
     * 操作が確定した瞬間にだけ通す。
     */
    commit() {
        if (this.node) {
            this.committing = true;
            try {
                nodeio.writeTree(this.node, this.tree);
            } finally {
                this.committing = false;
            }
        }
        this.refresh();
    }

    // --- タグの検索と追加 ---------------------------------------------------

    scheduleSuggest() {
        clearTimeout(this.suggestTimer);
        this.suggestTimer = setTimeout(() => this.runSuggest(), SUGGEST_DEBOUNCE_MS);
    }

    async runSuggest() {
        const query = this.searchInput.value;
        const seq = ++this.suggestSeq;
        let items = [];
        try {
            items = await api.suggest(query, SUGGEST_LIMIT);
        } catch (error) {
            console.warn("[Tag Composer] suggest failed", error);
        }
        // 打鍵が速いと応答が前後するので、最後に投げたものだけを描く
        if (seq !== this.suggestSeq) return;

        this.suggestBox.replaceChildren();
        for (const item of items) {
            const entry = readTranslation(item);
            if (entry.ja) this.glossary.set(item.tag, entry);
            const override = this.overrides[item.tag];
            const chip = makeChip(
                item.tag,
                (typeof override === "string" ? override : "") || entry.ja,
                () => model.makeTag(item.tag),
                (node) => this.appendNode("active", node),
            );
            chip.dataset.tag = item.tag;
            chip.classList.add(`dtc-cat-${item.categoryName}`);
            if (!override && entry.machine) {
                chip.classList.add("dtc-chip-machine");
            }
            this.suggestBox.appendChild(chip);
        }
        if (!items.length && query.trim()) {
            const free = model.makeTag(query.trim());
            const chip = makeChip(query.trim(), "辞書にないタグ", () => model.clone(free), (node) =>
                this.appendNode("active", node),
            );
            chip.dataset.tag = free.tag;
            this.suggestBox.appendChild(chip);
        }
        this.markUsedSuggestions();
    }

    /**
     * 候補チップに「もう適用エリアに入っている」印を付け直す。
     *
     * 候補を引き直さずに済ませたいので、チップは消さずにクラスだけ塗り替える。
     * ドラッグで落としたときも、クリックで足したときも、これで印が追い付く。
     */
    markUsedSuggestions() {
        const used = model.tagNamesIn(this.tree, "active");
        for (const chip of this.suggestBox.querySelectorAll(".dtc-chip[data-tag]")) {
            chip.classList.toggle("dtc-chip-used", used.has(chip.dataset.tag));
        }
    }

    appendNode(area, node) {
        if (!this.requireNode()) return;
        model.insert(this.tree, node, { area, parentId: null, index: Infinity });
        this.commit();
    }

    addGroup(area) {
        if (!this.requireNode()) return;
        model.insert(this.tree, model.makeGroup("新しいグループ"), {
            area,
            parentId: null,
            index: Infinity,
        });
        this.commit();
    }

    /**
     * エリアを空にする。
     *
     * セーブしてから作り直す、という使い方の出口。消えるのはワークフローの widget の
     * 中身だけなので Ctrl+Z で戻せるが、タグを何十個も積んだ後だと押し間違いの損が
     * 大きいので確認を挟む。
     */
    async clearArea(area) {
        if (!this.requireNode()) return;

        const nodes = this.tree[area];
        if (!nodes.length) {
            this.notify(`${AREA_LABELS[area]}はもう空です`);
            return;
        }

        const counts = countTags(this.tree);
        const total = area === "active" ? counts.activeTotal : counts.inactive;
        const ok = await confirmAction(
            `${AREA_LABELS[area]}を空にしますか`,
            `${total} タグをグループごと捨てます。Ctrl+Z で戻せます。`,
            "delete",
        );
        if (!ok) return;

        model.clearArea(this.tree, area);
        this.commit();
        this.notify(`${AREA_LABELS[area]}を空にしました`);
    }

    requireNode() {
        if (this.node) return true;
        this.notify("キャンバスで Danbooru Tag Composer ノードを選んでください");
        return false;
    }

    // --- ドロップ -----------------------------------------------------------

    handleDrop(payload, target) {
        if (!this.requireNode()) return;
        const ok =
            payload.kind === "move"
                ? model.move(this.tree, payload.id, target)
                : // プリセットは深い部分木を持ちうるので、新規追加でも入れ子の深さを見る
                  model.canDrop(this.tree, payload.node, target) &&
                  model.insert(this.tree, payload.node, target);
        if (ok) this.commit();
        // 弾かれたときも目印を消すために描き直す
        else this.refresh();
    }

    // --- 対訳 ---------------------------------------------------------------

    /** 表示する対訳と、それが機械翻訳かどうか。手で直したものは常に信頼できる。 */
    translationOf(node) {
        if (node.kind !== "tag") return { text: "", machine: false };
        const mine = node.ja || this.overrides[node.tag];
        if (typeof mine === "string" && mine) return { text: mine, machine: false };
        const entry = readTranslation(this.glossary.get(node.tag));
        return { text: entry.ja, machine: entry.machine };
    }

    async fetchTranslations() {
        const wanted = [];
        for (const area of ["active", "inactive"]) {
            const visit = (nodes) => {
                for (const node of nodes) {
                    if (node.kind === "group") visit(node.children);
                    else if (!this.glossary.has(node.tag)) wanted.push(node.tag);
                }
            };
            visit(this.tree[area] || []);
        }
        if (!wanted.length) return;

        try {
            const translations = await api.translate([...new Set(wanted)]);
            // 対訳が無かったタグも記録しておく。しないと毎回問い合わせ直すことになる
            for (const tag of wanted) this.glossary.set(tag, readTranslation(translations[tag]));
            this.refresh();
        } catch (error) {
            console.warn("[Tag Composer] translate failed", error);
        }
    }

    /**
     * 対訳を書き換える。
     *
     * ワークフロー側 (node.ja) と手元の辞書 (overrides) の両方に入れる。前者があると
     * ワークフローを渡した相手にも対訳が見え、後者があると次に同じタグを使うときにも
     * 出る。片方だけだとどちらかが毎回抜けるので、まとめて入れている。
     */
    async editTranslation(node) {
        const current = this.translationOf(node).text;
        const value = await ask(`${node.tag} の対訳`, current);
        if (value === null || value === undefined) return;

        const text = value.trim();
        node.ja = text || null;
        if (text) this.overrides[node.tag] = text;
        else delete this.overrides[node.tag];

        api.saveOverrides(this.overrides).catch((error) =>
            console.warn("[Tag Composer] failed to save overrides", error),
        );
        this.commit();
    }

    async renameGroup(node) {
        const value = await ask("グループ名", node.name);
        if (value === null || value === undefined) return;
        node.name = value.trim();
        this.commit();
    }

    // --- 行メニュー ---------------------------------------------------------

    closeMenu() {
        this.menu?.remove();
        this.menu = null;
    }

    openMenu(node, anchor) {
        this.closeMenu();
        const menu = el("div", "dtc-popup");
        const item = (label, handler) => {
            const button = el("button", "dtc-popup-item", label);
            button.type = "button";
            button.addEventListener("click", () => {
                this.closeMenu();
                handler();
            });
            menu.appendChild(button);
        };

        const where = model.find(this.tree, node.id);
        if (!where) return;
        const other = where.area === "active" ? "inactive" : "active";

        item(other === "inactive" ? "非適用エリアへ送る" : "適用エリアへ戻す", () => {
            model.move(this.tree, node.id, { area: other, parentId: null, index: Infinity });
            this.commit();
        });
        if (node.kind !== "group") {
            const emphasized = node.w === EMPHASIS_WEIGHT;
            item(emphasized ? `重み ${EMPHASIS_WEIGHT} を外す` : `重み ${EMPHASIS_WEIGHT} を付ける`, () => {
                node.w = emphasized ? 1.0 : EMPHASIS_WEIGHT;
                this.commit();
            });
        }
        item("グループでくるむ", () => {
            model.wrapInGroup(this.tree, node.id, "新しいグループ");
            this.commit();
        });
        item("複製", () => {
            model.insert(this.tree, model.clone(node), {
                area: where.area,
                parentId: where.parentId,
                index: where.index + 1,
            });
            this.commit();
        });
        if (node.kind === "group") {
            item("プリセットとして保存", () => this.savePreset(node));
            item("グループを解体 (中身は残す)", () => {
                const hit = model.find(this.tree, node.id);
                hit.list.splice(hit.index, 1, ...node.children);
                this.commit();
            });
        }
        item("削除", () => {
            model.remove(this.tree, node.id);
            this.commit();
        });

        const rect = anchor.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 2}px`;
        document.body.appendChild(menu);
        this.menu = menu;
    }

    // --- プリセット ---------------------------------------------------------

    async loadUserData() {
        [this.overrides, this.presets, this.saves] = await Promise.all([
            api.loadOverrides(),
            api.loadPresets(),
            api.listSaves(),
        ]);
        this.refresh();
    }

    // 名前はグループ名をそのまま使う。付け直したいときはグループ名を変えて保存し直す
    savePreset(group) {
        const name = group.name.trim() || "プリセット";
        this.presets[name] = model.clone(group);
        api.savePresets(this.presets).catch((error) => {
            console.warn("[Tag Composer] failed to save presets", error);
        });
        this.renderPresets();
    }

    renderPresets() {
        const names = Object.keys(this.presets).sort();
        this.presetHint.textContent = names.length
            ? `${names.length} 件`
            : "グループのメニューから保存できます";

        this.presetBox.replaceChildren();
        for (const name of names) {
            const preset = this.presets[name];
            const chip = makeChip(
                name,
                `${countLeaves(preset)} タグ`,
                () => model.clone(preset),
                (node) => this.appendNode("active", node),
            );
            chip.classList.add("dtc-chip-preset");
            chip.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                delete this.presets[name];
                api.savePresets(this.presets).catch(() => {});
                this.renderPresets();
            });
            chip.title += " / 右クリックで削除";
            this.presetBox.appendChild(chip);
        }
    }

    // --- セーブ / ロード ----------------------------------------------------

    renderSaves() {
        this.saveHint.textContent = this.saves.length
            ? `${this.saves.length} 件`
            : "名前を付けて丸ごと残せます";

        this.saveBox.replaceChildren();
        for (const entry of this.saves) {
            const name = save.fromFileName(entry.file);
            const chip = el("div", "dtc-chip dtc-chip-save");
            chip.appendChild(el("span", "dtc-chip-name", name));
            chip.appendChild(el("span", "dtc-chip-sub", formatTimestamp(entry.modified)));
            chip.title = "クリックで読み込む (いまの内容は置き換わる) / 右クリックで削除";
            chip.addEventListener("click", () => this.loadSave(entry.file));
            chip.addEventListener("contextmenu", (event) => {
                event.preventDefault();
                this.deleteSave(entry.file);
            });
            this.saveBox.appendChild(chip);
        }
    }

    async reloadSaves() {
        this.saves = await api.listSaves();
        this.renderSaves();
    }

    async runSave() {
        if (!this.requireNode()) return;

        const name = this.saveNameInput.value.trim();
        const file = save.toFileName(name);
        if (!file) {
            this.saveNameInput.focus();
            this.notify("セーブ名を入れてください");
            return;
        }

        if (this.saves.some((entry) => entry.file === file)) {
            const ok = await confirmAction(
                "セーブを上書きしますか",
                `「${save.fromFileName(file)}」はすでにあります。前の内容は消えます。`,
                "overwrite",
            );
            if (!ok) return;
        }

        try {
            await api.storeSave(file, save.pack(this.tree, { name, options: this.options }));
        } catch (error) {
            console.warn("[Tag Composer] failed to save", error);
            this.notify(`「${name}」を保存できませんでした`);
            return;
        }

        await this.reloadSaves();
        this.notify(`「${save.fromFileName(file)}」に保存しました`);
    }

    async loadSave(file) {
        if (!this.requireNode()) return;
        const name = save.fromFileName(file);
        if (!(await this.confirmReplace(name))) return;

        const loaded = save.unpack(await api.loadSave(file));
        if (!loaded) {
            this.notify(`「${name}」を読めませんでした`);
            await this.reloadSaves();
            return;
        }

        this.applyLoaded(loaded);
        this.saveNameInput.value = name;
        this.notify(`「${name}」を読み込みました`);
    }

    async deleteSave(file) {
        const name = save.fromFileName(file);
        const ok = await confirmAction(
            "セーブを削除しますか",
            `「${name}」を消します。元には戻せません。`,
            "delete",
        );
        if (!ok) return;

        try {
            await api.deleteSave(file);
        } catch (error) {
            console.warn("[Tag Composer] failed to delete the save", error);
            this.notify(`「${name}」を消せませんでした`);
            return;
        }
        await this.reloadSaves();
    }

    exportFile() {
        if (!this.requireNode()) return;
        const name = this.saveNameInput.value.trim() || this.node.title || "tags";
        const payload = save.pack(this.tree, { name, options: this.options });
        // 人が開いて中を見るファイルなので整形して書く。タグ数百でも数十 KB に収まる
        download(save.toFileName(name) ?? `tags${save.EXTENSION}`, JSON.stringify(payload, null, 2));
    }

    /** 選んだファイルを、いま編集中のノードへ読み込む。セーブ一覧には足さない。 */
    async importFile(file) {
        if (!this.requireNode()) return;

        let loaded = null;
        try {
            loaded = save.unpack(await file.text());
        } catch (error) {
            console.warn("[Tag Composer] failed to read the file", error);
        }
        if (!loaded) {
            this.notify(`${file.name} はセーブファイルとして読めませんでした`);
            return;
        }

        const name = loaded.name || save.fromFileName(file.name);
        if (!(await this.confirmReplace(name))) return;

        this.applyLoaded(loaded);
        // 続けて「保存」を押せば、そのまま手元のセーブ一覧にも入る
        this.saveNameInput.value = name;
        this.notify(`${file.name} を読み込みました`);
    }

    /** いまの内容を捨ててよいか訊く。空なら訊かない。 */
    confirmReplace(name) {
        if (!this.tree.active.length && !this.tree.inactive.length) return Promise.resolve(true);
        return confirmAction(
            "読み込みますか",
            `いまの適用エリアと非適用エリアの中身をすべて捨てて、「${name}」の内容に置き換えます。`,
        );
    }

    /**
     * 読み込んだセーブをノードへ流し込む。
     *
     * ツリーと設定を 1 回の committing で書くので、自分の書き込みで飛んでくる
     * 変更通知を reload() として拾い直すことがない。ワークフローの widget を
     * 書き換えるだけなので、間違えて読み込んでも ctrl+Z で戻せる。
     */
    applyLoaded(loaded) {
        this.tree = model.ensureIds(loaded.tree);
        this.committing = true;
        try {
            // options を持たないセーブでは、いまのノードの設定に手を付けない
            if (loaded.options) nodeio.writeOptions(this.node, loaded.options);
            nodeio.writeTree(this.node, this.tree);
        } finally {
            this.committing = false;
        }
        this.options = nodeio.readOptions(this.node);
        this.refresh();
        this.fetchTranslations();
    }

    destroy() {
        clearTimeout(this.suggestTimer);
        clearTimeout(this.noticeTimer);
        this.closeMenu();
        document.removeEventListener("pointerdown", this.onDocumentPointerDown);
        app.api?.removeEventListener("graphChanged", this.onGraphChanged);
        this.restoreSelectionHook?.();
        this.offTreeChanged?.();
    }
}

function countLeaves(node) {
    if (node.kind !== "group") return 1;
    return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}
