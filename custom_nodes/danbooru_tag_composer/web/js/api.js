// バックエンドと ComfyUI の userdata へのアクセス。
//
// 辞書そのものはブラウザに持ってこない。3 万件を毎回送るとタグが増えるたびに重くなる
// ので、検索と引き当てはサーバー側の api.py に任せて候補だけ受け取る。
//
// 逆にユーザーが登録した対訳の上書きとプリセットは ComfyUI の /userdata に置く。
// マルチユーザー対応・パストラバーサル対策・アトミック書き込みが付いてくるうえ、
// 保存先の data/user はホストにマウントされているのでコンテナを作り直しても残る。

import { api } from "/scripts/api.js";

const PREFIX = "/danbooru-tag-composer";

// 対訳の出どころ。glossary.py と対応している。機械翻訳には border -> 国境 のような
// 直訳の誤りが混ざるので、UI 側で暫定と分かるようにするために使う
export const SOURCE_MACHINE = 3;
const OVERRIDES_FILE = "danbooru-tag-composer/overrides.json";
const PRESETS_FILE = "danbooru-tag-composer/presets.json";

async function getJson(path) {
    const response = await api.fetchApi(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
}

async function postJson(path, body) {
    const response = await api.fetchApi(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
}

/** 辞書が読めているか。{tags, generated} を返す。 */
export function status() {
    return getJson(`${PREFIX}/status`);
}

/** タグ名または日本語の読みから候補を引く。 */
export async function suggest(query, limit = 30) {
    if (!query.trim()) return [];
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const { items } = await getJson(`${PREFIX}/suggest?${params}`);
    return items;
}

/** タグの配列から {タグ: [対訳, 出どころ]} を引く。対訳が無いタグはキーごと返らない。 */
export async function translate(tags) {
    if (!tags.length) return {};
    const { translations } = await postJson(`${PREFIX}/translate`, { tags });
    return translations;
}

// --- userdata ---------------------------------------------------------------

async function loadUserJson(file, fallback) {
    try {
        const response = await api.getUserData(file);
        if (response.status === 404) return fallback;
        if (!response.ok) throw new Error(`${file}: ${response.status}`);
        return await response.json();
    } catch (error) {
        // 読めなくても編集そのものは続けられるので、握りつぶして既定値で動かす
        console.warn(`[Tag Composer] failed to read ${file}`, error);
        return fallback;
    }
}

function saveUserJson(file, data) {
    return api.storeUserData(file, data, { overwrite: true, stringify: true, throwOnError: true });
}

/** ユーザーが上書きした対訳 {タグ: 対訳}。 */
export function loadOverrides() {
    return loadUserJson(OVERRIDES_FILE, {});
}

export function saveOverrides(overrides) {
    return saveUserJson(OVERRIDES_FILE, overrides);
}

/** 名前付きで保存したグループ {名前: グループノード}。 */
export function loadPresets() {
    return loadUserJson(PRESETS_FILE, {});
}

export function savePresets(presets) {
    return saveUserJson(PRESETS_FILE, presets);
}
