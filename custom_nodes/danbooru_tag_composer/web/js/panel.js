// サイドバーの Tag Composer パネル。
//
// 文字入力はタグの検索欄と、対訳・グループ名の入力だけ。タグやグループの位置と所属は
// すべてドラッグ&ドロップで変え、適用/非適用の切り替えはワンクリックで済ませる。

import { app } from "/scripts/app.js";
import * as api from "./api.js";
import * as model from "./model.js";
import * as nodeio from "./nodeio.js";
import { installDropZone } from "./dnd.js";
import { renderArea, makeChip } from "./tree.js";
import { render as renderPrompt } from "./render.js";

const AREA_LABELS = { active: "適用エリア", inactive: "非適用エリア" };
// メニューから付け外しできる強調の重み。実際に使うのはこの 1 段だけなので、
// 任意の値を入れる UI は置いていない
const EMPHASIS_WEIGHT = 1.3;
const SUGGEST_DEBOUNCE_MS = 120;
const SUGGEST_LIMIT = 24;

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
        this.suggestTimer = null;
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

            section.appendChild(header);
            const body = el("div", "dtc-area-body");
            section.appendChild(body);
            panel.appendChild(section);

            this.areaBoxes[area] = { body, counter };
            installDropZone(body, (payload, target) => this.handleDrop(payload, target));
        }

        panel.appendChild(this.buildPresets());
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
        this.targetLabel.textContent = this.node
            ? `編集中: ${this.node.title || "Danbooru Tag Composer"} (#${this.node.id})`
            : "キャンバスで Danbooru Tag Composer ノードを選んでください";
        this.targetLabel.classList.toggle("dtc-target-empty", !this.node);

        const ctx = this.context();
        for (const area of ["active", "inactive"]) {
            renderArea(this.areaBoxes[area].body, ctx, area);
        }
        this.updateCounts();
        this.updatePreview();
        this.renderPresets();
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

        const used = model.tagNamesIn(this.tree, "active");
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
            chip.classList.add(`dtc-cat-${item.categoryName}`);
            if (used.has(item.tag)) chip.classList.add("dtc-chip-used");
            if (!override && entry.machine) {
                chip.classList.add("dtc-chip-machine");
            }
            this.suggestBox.appendChild(chip);
        }
        if (!items.length && query.trim()) {
            const free = model.makeTag(query.trim());
            this.suggestBox.appendChild(
                makeChip(query.trim(), "辞書にないタグ", () => model.clone(free), (node) =>
                    this.appendNode("active", node),
                ),
            );
        }
    }

    appendNode(area, node) {
        if (!this.requireNode()) return;
        model.insert(this.tree, node, { area, parentId: null, index: Infinity });
        this.commit();
        this.runSuggest();
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

    requireNode() {
        if (this.node) return true;
        this.targetLabel.classList.add("dtc-target-warn");
        setTimeout(() => this.targetLabel.classList.remove("dtc-target-warn"), 600);
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
        [this.overrides, this.presets] = await Promise.all([
            api.loadOverrides(),
            api.loadPresets(),
        ]);
        this.refresh();
    }

    async savePreset(group) {
        const name = await ask("プリセット名", group.name || "");
        if (!name) return;
        this.presets[name.trim()] = model.clone(group);
        try {
            await api.savePresets(this.presets);
        } catch (error) {
            console.warn("[Tag Composer] failed to save presets", error);
        }
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

    destroy() {
        clearTimeout(this.suggestTimer);
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
