// タグツリーの正規化とプロンプト文字列の組み立て。
//
// tagtree.py の写し。プレビューをドラッグ中でも引っかからずに更新したいので JS 側にも
// 同じ規則を置いている。ワークフロー実行時に CLIP へ渡るのは常に Python 側の結果なので、
// 食い違うと「プレビューと生成結果が違う」という一番わかりにくい壊れ方をする。
// 規則を変えるときは tagtree.py と tests/fixtures/render_cases.json も必ず直すこと
// (このファイルと tagtree.py は同じ fixture でテストされる)。

export const SCHEMA_VERSION = 1;
export const AREAS = ["active", "inactive"];
export const MAX_DEPTH = 32;
export const MIN_WEIGHT = 0.0;
export const MAX_WEIGHT = 10.0;
export const DEFAULT_SEPARATOR = ", ";

export function emptyTree() {
    return { version: SCHEMA_VERSION, active: [], inactive: [] };
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function cleanId(value) {
    return typeof value === "string" && value ? value : "";
}

function cleanWeight(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return 1.0;
    return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, value));
}

function normalizeNodes(nodes, depth) {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return [];
    const out = [];
    for (const node of nodes) {
        const normalized = normalizeNode(node, depth);
        if (normalized) out.push(normalized);
    }
    return out;
}

function normalizeNode(node, depth) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;

    if (node.kind === "group") {
        return {
            id: cleanId(node.id),
            kind: "group",
            name: cleanText(node.name),
            on: node.on !== false,
            open: node.open !== false,
            children: normalizeNodes(node.children, depth + 1),
        };
    }

    // kind が無い/壊れている場合もタグとして扱う。タグ名が空なら捨てる
    const tag = cleanText(node.tag);
    if (!tag) return null;
    return {
        id: cleanId(node.id),
        kind: "tag",
        tag,
        on: node.on !== false,
        w: cleanWeight(node.w),
        ja: cleanText(node.ja) || null,
    };
}

export function normalize(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return emptyTree();
    const tree = { version: SCHEMA_VERSION };
    for (const area of AREAS) tree[area] = normalizeNodes(data[area], 0);
    return tree;
}

/** JSON 文字列・オブジェクトのどちらを渡しても正規化済みのツリーを返す。 */
export function loads(data) {
    if (typeof data === "string") {
        const text = data.trim();
        if (!text) return emptyTree();
        try {
            data = JSON.parse(text);
        } catch {
            return emptyTree();
        }
    }
    return normalize(data);
}

export function dumps(tree) {
    return JSON.stringify(tree);
}

function* walk(nodes, onlyEnabled) {
    for (const node of nodes) {
        if (onlyEnabled && node.on === false) continue;
        if (node.kind === "group") {
            yield* walk(node.children || [], onlyEnabled);
        } else {
            yield node;
        }
    }
}

export function* iterTags(tree, area = "active", onlyEnabled = true) {
    yield* walk(tree[area] || [], onlyEnabled);
}

/** (tag:1.2) の 1.2 の部分。小数第 2 位まで、末尾の 0 は落とす。 */
export function formatWeight(weight) {
    let text = weight.toFixed(2).replace(/0+$/, "");
    return text.endsWith(".") ? text + "0" : text;
}

// Danbooru には saber_(fate) のように括弧を含むタグがあり、そのまま出すと重み記法として
// 解釈される。本体 comfy/sd1_clip.py の escape_important() が見るのは \( と \) だけ
export function escapeTag(tag) {
    return tag.replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function render(data, options = {}) {
    const separator = options.separator ?? DEFAULT_SEPARATOR;
    const underscoreToSpace = options.underscoreToSpace ?? false;
    const tree = loads(data);

    const parts = [];
    const seen = new Set();
    for (const node of iterTags(tree, "active")) {
        let tag = node.tag;
        if (underscoreToSpace) tag = tag.replaceAll("_", " ");
        if (seen.has(tag)) continue;
        seen.add(tag);

        tag = escapeTag(tag);
        parts.push(node.w === 1.0 ? tag : `(${tag}:${formatWeight(node.w)})`);
    }
    return parts.join(separator);
}

export function countTags(data) {
    const tree = loads(data);
    let active = 0;
    let activeTotal = 0;
    let inactive = 0;
    for (const _ of iterTags(tree, "active", true)) active++;
    for (const _ of iterTags(tree, "active", false)) activeTotal++;
    for (const _ of iterTags(tree, "inactive", false)) inactive++;
    return { active, activeTotal, inactive };
}
