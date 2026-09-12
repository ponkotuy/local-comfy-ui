// 拡張の入口。副作用を持つのはこのファイルだけ。
//
// WEB_DIRECTORY 配下の .js はすべて自動で読み込まれるので、他のモジュールは
// 定義を export するだけに留めてある。

import { app } from "/scripts/app.js";
import * as nodeio from "./nodeio.js";
import { mountPanel } from "./panel.js";
import { render as renderPrompt, countTags } from "./render.js";

const EXTENSION = "ponkotuy.danbooru-tag-composer";
const SIDEBAR_TAB_ID = "danbooru-tag-composer";
const CSS_URL = "/extensions/danbooru_tag_composer/css/composer.css";

// ノード上のサマリに出すプレビューの長さ。ノードは狭いので雰囲気が分かれば十分
const NODE_PREVIEW_CHARS = 160;

function loadStyles() {
    if (document.querySelector(`link[href="${CSS_URL}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_URL;
    document.head.appendChild(link);
}

function openSidebar() {
    const sidebar = app.extensionManager?.sidebarTab;
    if (!sidebar) return;
    if (sidebar.activeSidebarTabId === SIDEBAR_TAB_ID) return;
    // 公開 API 名は版によってぶれるので、無ければ素直に諦める
    // (ユーザーがサイドバーのアイコンを押せば同じところに辿り着ける)
    if (typeof sidebar.toggleSidebarTab === "function") sidebar.toggleSidebarTab(SIDEBAR_TAB_ID);
    else if ("activeSidebarTabId" in sidebar) sidebar.activeSidebarTabId = SIDEBAR_TAB_ID;
}

/**
 * ノード本体のサマリ表示。
 *
 * ここに編集 UI は置かない。Nodes 2.0 (Vue 描画) と従来のキャンバス描画のどちらでも
 * 確実に出るのは、この程度の素朴な DOM に限られる。
 */
function attachSummaryWidget(node) {
    const treeWidget = nodeio.treeWidget(node);
    if (!treeWidget) return;

    // 値の保持とシリアライズは引き続きこのウィジェットが担う。隠すだけ
    treeWidget.options = treeWidget.options || {};
    treeWidget.options.hidden = true;

    const root = document.createElement("div");
    root.className = "dtc-node";

    const summary = document.createElement("div");
    summary.className = "dtc-node-summary";
    root.appendChild(summary);

    const preview = document.createElement("div");
    preview.className = "dtc-node-preview";
    root.appendChild(preview);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "dtc-node-edit";
    edit.textContent = "タグを編集";
    edit.addEventListener("click", () => {
        app.canvas?.selectNode?.(node);
        openSidebar();
    });
    root.appendChild(edit);

    const update = () => {
        const value = treeWidget.value;
        const counts = countTags(value);
        summary.textContent = `適用 ${counts.active} / ${counts.activeTotal} タグ・控え ${counts.inactive}`;
        const prompt = renderPrompt(value, nodeio.readOptions(node));
        preview.textContent =
            prompt.length > NODE_PREVIEW_CHARS
                ? `${prompt.slice(0, NODE_PREVIEW_CHARS)}…`
                : prompt || "(出力なし)";
        preview.classList.toggle("dtc-node-preview-empty", !prompt);
    };

    // DOM widget は最後に足す。通常のウィジェットを後から足すと Nodes 2.0 で
    // レイアウトが崩れる既知の不具合がある
    node.addDOMWidget("summary", "dtc_summary", root, {
        // 状態は tree ウィジェット側の一本に絞る。ここで保存すると二重になる
        serialize: false,
        getMinHeight: () => 96,
        hideOnZoom: true,
    });

    update();
    // element は「状態を持たない描画先」として扱う。Vue 描画ではノードが画面外に
    // 出ると unmount されうるので、実体は常に tree ウィジェットの値から作り直す
    node.__dtcRefresh = update;
}

app.registerExtension({
    name: EXTENSION,

    async setup() {
        loadStyles();

        if (typeof app.extensionManager?.registerSidebarTab !== "function") {
            console.warn(
                "[Tag Composer] registerSidebarTab が無いため編集パネルを開けません。" +
                    "ComfyUI のフロントエンドを更新してください。",
            );
            return;
        }

        app.extensionManager.registerSidebarTab({
            id: SIDEBAR_TAB_ID,
            icon: "pi pi-tags",
            title: "Tag Composer",
            tooltip: "Danbooru Tag Composer",
            type: "custom",
            // render が返す関数はタブが閉じられるときの後始末に使われる
            render: (element) => mountPanel(element),
        });

        nodeio.onTreeChanged((node) => node.__dtcRefresh?.());
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== nodeio.NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = onNodeCreated?.apply(this, args);
            attachSummaryWidget(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            // ワークフローから読み込んだ値でサマリを描き直す
            this.__dtcRefresh?.();
            return result;
        };
    },
});
