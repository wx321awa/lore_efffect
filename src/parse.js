"use strict";
/**
 * Lore 解析：一行文本 → [{id, name, level}]
 *
 * 设计取向和 nbt_tool 的血量解析一致：**宁可多认几种写法，不要在「写法不对」上
 * 让服主自己猜**。可识别的写法（同一行里可以写多个效果）：
 *
 *   速度II            速度 II            速度III级
 *   速度2              速度2级            速度 等级2
 *   速度 Lv.2          速度 lv2           力量+2
 *   力量提升2          跳跃提升 3         抗性提升IV
 *   生命恢复2级 力量I   （一行两个）
 *   speed2  strength:2  （英文 id 也认）
 *
 * 不认的情况（故意的）：
 *   - 关键词后面紧跟百分号：`攻击速度+10%` 是在写属性，不是给药水效果，
 *     这种行会被跳过，否则全服装备的「攻击速度」条目都会变成速度药水。
 *   - 紧跟时长/次数单位（秒/分钟/小时/次/天/倍）：`夜视 15秒` 是在写描述，
 *     同样跳过 —— 否则 15 会被当等级再压到上限，等于白送满级夜视。
 *   - 没有关键词的行、没有数字也没有罗马数字的行（等级默认 I）。
 */
const { Effects } = require("plugins/lore_effect/src/effects");

const ROMAN_VALUE = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
/** 等级数字后面紧跟这些字，说明是在写「时长 / 次数 / 属性值」，不是等级 */
const UNIT_AFTER = '%‰秒次分天倍';
const ASCII_KW = /^[\x20-\x7e]+$/;

/** 去掉 § 颜色码 */
function stripColor(text) {
    const s = String(text == null ? '' : text);
    return s.indexOf('§') >= 0 ? s.replace(/§./g, '') : s;
}

/** 全角 → 半角（只处理全角 ASCII 区 + 全角空格） */
function toHalf(s) {
    if (!/[\uFF01-\uFF5E\u3000]/.test(s)) return s;
    return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ');
}

/** 罗马数字 → 整数，非法返回 0 */
function romanToInt(token) {
    const up = String(token).toLowerCase();
    if (!/^[ivxlcdm]+$/.test(up)) return 0;
    let total = 0;
    let prev = 0;
    for (let i = up.length - 1; i >= 0; i--) {
        const v = ROMAN_VALUE[up[i]] || 0;
        if (v < prev) total -= v;
        else {
            total += v;
            prev = v;
        }
    }
    return total;
}

/**
 * 关键词之后的等级写法：
 *   连接符（空白/冒号/等号/加减号）+ 可选前缀（等级/级别/Lv./level）+ 可选动词（加/增加/提升）
 *   + 数字或罗马数字
 */
const LEVEL_RE = new RegExp(
    '^[\\s:：=＝\\-+＋]*' +
    '(?:等级为|等级|级别|Lv\\.?|LV\\.?|lv\\.?|level)?' +
    '[\\s:：=＝\\-+＋]*' +
    '(?:增加|提升|加成|加|给)?' +
    '[\\s:：=＝\\-+＋]*' +
    '([IVXLCDivxlcd]+|\\d+)'
);

/**
 * 从 pos 开始读等级。
 * hasToken=false 表示「关键词后面根本没写等级数字」——默认这种行不生效
 * （写个「力量」就上 buff 太容易误触发，管理员的要求是必须写等级）。
 * @returns {{level:number, next:number, hasToken:boolean}|{skip:true, next:number}}
 */
function levelAt(s, pos, maxLevel) {
    const m = LEVEL_RE.exec(s.substring(pos));
    if (m == null) return { level: 1, next: pos, hasToken: false };
    const token = m[1];
    const end = pos + m[0].length;
    // 紧跟单位 → 描述行，当成「不是效果」跳过。
    //   %/‰        属性数值：攻击速度+10%
    //   秒/分/天…  时长描述：夜视 15秒、速度 20秒、跳跃提升 3秒
    // 不挡的话 15/20 会被当成等级、再被静默压到 max_level，玩家直接拿满级效果。
    const next2 = s.substr(end, 2);
    if (next2 === '小时' || next2 === '分钟') return { skip: true, next: end + 2 };
    // 注意：行尾时 charAt(end) 是空串，而 ''.indexOf('') === 0，会误判成「有单位」把
    // 所有正常行都跳掉 —— 必须先确认真的还有字。
    const unit = s.charAt(end);
    if (unit.length > 0 && UNIT_AFTER.indexOf(unit) >= 0) return { skip: true, next: end + 1 };
    let lv = /^\d+$/.test(token) ? parseInt(token, 10) : romanToInt(token);
    if (!isFinite(lv) || lv <= 0) lv = 1;
    const cap = (isFinite(Number(maxLevel)) && Number(maxLevel) > 0) ? Math.floor(Number(maxLevel)) : 10;
    if (lv > cap) lv = cap;
    return { level: lv, next: end, hasToken: true };
}

/**
 * 解析一行 lore。
 * @param {String} text 原始行（可以带 § 颜色码）
 * @param {{maxLevel?:number, requireLevel?:boolean}} [opts]
 *   requireLevel 默认 true：关键词后面必须跟等级（数字或罗马数字），
 *   只写「力量」不生效。设 false 可恢复旧行为（不写等级按 I 级算）。
 * @returns {Array<{id:number,name:string,level:number}>}
 */
function parseLine(text, opts) {
    const out = [];
    const maxLevel = (opts != null && opts.maxLevel != null) ? opts.maxLevel : 10;
    const requireLevel = (opts == null || opts.requireLevel !== false);
    const s = toHalf(stripColor(text));
    if (s.length === 0) return out;

    const keys = Effects.KEYS;
    let i = 0;
    while (i < s.length) {
        // 当前位置尝试匹配关键词，长关键词优先
        let found = null;
        for (let k = 0; k < keys.length; k++) {
            const kw = keys[k];
            if (kw.length === 0 || i + kw.length > s.length) continue;
            if (s.substr(i, kw.length).toLowerCase() !== kw) continue;
            // 英文 id 要词边界，免得 speedy 里的 speed 被当成关键词
            if (ASCII_KW.test(kw)) {
                const prev = i > 0 ? s.charAt(i - 1) : '';
                const next = i + kw.length < s.length ? s.charAt(i + kw.length) : '';
                if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) continue;
            }
            found = kw;
            break;
        }
        if (found == null) {
            i++;
            continue;
        }
        const eff = Effects.byKey(found);
        const afterKw = i + found.length;
        if (eff == null) {
            i = afterKw;
            continue;
        }
        const lv = levelAt(s, afterKw, maxLevel);
        if (lv.skip === true) {
            i = Math.max(lv.next, afterKw);
            continue;
        }
        // 只写了效果名没写等级 → 不算（避免「力量」两个字就触发 buff）
        if (requireLevel && lv.hasToken !== true) {
            i = Math.max(lv.next, afterKw);
            continue;
        }
        out.push({ id: eff.id, name: eff.name, level: lv.level });
        i = Math.max(lv.next, afterKw);
    }
    return out;
}

/**
 * 一行里的多个命中合并成「id → 最高等级」。
 * （药水效果等级不叠加，同一行重复写取高的那个）
 */
function mergeHits(hits) {
    const map = new Map();
    for (const h of hits || []) {
        const prev = map.get(h.id) || 0;
        if (h.level > prev) map.set(h.id, h.level);
    }
    return map;
}

exports.parseLine = parseLine;
exports.mergeHits = mergeHits;
exports.romanToInt = romanToInt;
exports.stripColor = stripColor;
