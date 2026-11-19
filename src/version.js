"use strict";
/**
 * 品牌与版本号。
 *
 * 版本从 plugins/lore_effect/manifest.json 读，读不到就回退到代码里的号 ——
 * 这样改了 manifest 不用改代码，改代码忘了同步也不会显示成空。
 * 品牌串跟着 nbt_tool 的写法走（XiYing定制版），控制台横幅、/lorefx 状态页、
 * 插件信息都从这里取，避免三个地方各写一份。
 */
const MANIFEST = 'plugins/lore_effect/manifest.json';
const BRAND = 'XiYing定制版';
const FALLBACK = '1.3.0';

const Version = {
    BRAND: BRAND,
    manifestPath: MANIFEST,

    /** 当前版本号（manifest 优先） */
    current: function (fallback) {
        const fb = (fallback == null) ? FALLBACK : String(fallback);
        try {
            if (typeof File === 'undefined' || File == null) return fb;
            if (!File.exists(MANIFEST)) return fb;
            const raw = File.readFrom(MANIFEST);
            if (raw == null || String(raw).length === 0) return fb;
            const obj = JSON.parse(String(raw));
            if (obj != null && typeof obj.version === 'string' && obj.version.length > 0) {
                return obj.version;
            }
        } catch (e) { }
        return fb;
    },

    /**
     * 版本号 → [major, minor, patch]，给 ll.registerPlugin 用。
     * 解析不出来就回退 [1, 3, 0]，不能返回 undefined（registerPlugin 会抛）。
     */
    tuple: function (fallback) {
        const s = Version.current(fallback);
        const parts = String(s).split('.');
        const out = [];
        for (let i = 0; i < 3; i++) {
            const n = parseInt(parts[i], 10);
            out.push(isFinite(n) && n >= 0 ? n : 0);
        }
        return out;
    },

    /** 「XiYing定制版 v1.3.0」 */
    display: function (fallback) {
        return BRAND + ' v' + Version.current(fallback);
    },
};

exports.Version = Version;
