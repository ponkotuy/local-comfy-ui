// セーブファイルの形式。
//
// ワークフローに載るツリー (tagtree.py の形) を、名前と日時とノードの設定で包んだだけの
// JSON。中身は封筒に入れ替えただけなので、ロードすれば適用/非適用・グループ・重み・
// 対訳・グループの開閉まで、保存した瞬間とそのままの状態に戻る。
//
//   {
//     "format": "danbooru-tag-composer.save",
//     "version": 1,                      ← この封筒の版。tree.version とは別物
//     "name": "夜景・ロング",
//     "saved_at": "2026-09-14T05:12:33.123Z",
//     "options": {"separator": ", ", "underscore_to_space": false},
//     "tree": {"version": 1, "active": [...], "inactive": [...]}
//   }
//
// tree はノードの tags ウィジェットに入るものと同じ形をそのまま入れる。別の形に
// 詰め替えると、ツリーの形を変えたときに直す場所が 2 つに増えるため。
//
// options のキーはノードのウィジェット名 (snake_case) に合わせてある。ファイルを
// 見ながらノードの設定を手で合わせられるほうが、JS 側の命名 (underscoreToSpace) に
// 揃えるより役に立つ。options が無いセーブも受け付け、そのときはノードの設定を触らない。
//
// この形式を読み書きするのはブラウザ側だけ。ワークフローの実行に要るのはノードの
// tags ウィジェットの値だけなので、バックエンドはセーブファイルを知らなくてよい。

import { loads, emptyTree, DEFAULT_SEPARATOR } from "./render.js";

export const FORMAT = "danbooru-tag-composer.save";
export const FORMAT_VERSION = 1;

export const EXTENSION = ".json";

// ファイル名に使えない文字。ComfyUI の /userdata がパストラバーサルは弾いてくれるが、
// : や ? は Windows では単に書き込みが失敗するので、こちら側でも潰しておく
const UNSAFE_IN_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

// セーブ名の長さの上限。ファイル名に使うので、拡張子を足しても収まる範囲にしておく
const MAX_NAME_LENGTH = 80;

function cleanName(name) {
    return typeof name === "string" ? name.trim().slice(0, MAX_NAME_LENGTH) : "";
}

function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 現在のツリーと設定をセーブの形にする。 */
export function pack(tree, { name = "", options = null, savedAt = new Date() } = {}) {
    return {
        format: FORMAT,
        version: FORMAT_VERSION,
        name: cleanName(name),
        saved_at: savedAt.toISOString(),
        options: {
            separator:
                typeof options?.separator === "string" ? options.separator : DEFAULT_SEPARATOR,
            underscore_to_space: options?.underscoreToSpace === true,
        },
        tree: loads(tree),
    };
}

/**
 * 読み込んだ JSON をセーブとして解釈する。セーブに見えなければ null。
 *
 * 封筒に入っていない「ツリーそのもの」も受け付ける。ノードの tags ウィジェットの値を
 * そのままコピーしてくるのは一番やりそうなことで、受けられない理由がない。逆に
 * ワークフロー JSON のような別物は active も inactive も持たないので弾かれる。
 */
export function unpack(data) {
    if (typeof data === "string") {
        try {
            data = JSON.parse(data);
        } catch {
            return null;
        }
    }
    if (!isObject(data)) return null;

    const tree = treeOf(data);
    if (!tree) return null;

    return {
        name: cleanName(data.name),
        savedAt: typeof data.saved_at === "string" ? data.saved_at : "",
        // 未知の版でも読めるところまでは読む。形が変わっていた分は normalize が落とす
        version: Number.isFinite(data.version) ? data.version : FORMAT_VERSION,
        options: readOptions(data.options),
        tree: loads(tree),
    };
}

function looksLikeTree(value) {
    return isObject(value) && (Array.isArray(value.active) || Array.isArray(value.inactive));
}

function treeOf(data) {
    // 印の付いた封筒。tree が欠けていても「空のセーブ」として通す
    if (data.format === FORMAT) return isObject(data.tree) ? data.tree : emptyTree();
    if (looksLikeTree(data.tree)) return data.tree;
    if (looksLikeTree(data)) return data;
    return null;
}

/** ファイルの options をノードへ書ける形にする。読める値が無ければ null。 */
function readOptions(raw) {
    if (!isObject(raw)) return null;
    const options = {};
    if (typeof raw.separator === "string") options.separator = raw.separator;
    if (typeof raw.underscore_to_space === "boolean") {
        options.underscoreToSpace = raw.underscore_to_space;
    }
    return Object.keys(options).length ? options : null;
}

/** セーブ名からファイル名を作る。名前として何も残らないなら null。 */
export function toFileName(name) {
    const stem = cleanName(name)
        .replace(UNSAFE_IN_FILENAME, "_")
        // 先頭の . は隠しファイルになり、末尾の . と空白は Windows が落とす
        .replace(/^\.+/, "")
        .replace(/[. ]+$/, "")
        .trim();
    return stem ? stem + EXTENSION : null;
}

/** ファイル名をセーブ名に戻す。一覧に出る名前はこれ。 */
export function fromFileName(file) {
    const stem = String(file ?? "").replace(/^.*\//, "");
    return stem.toLowerCase().endsWith(EXTENSION) ? stem.slice(0, -EXTENSION.length) : stem;
}
