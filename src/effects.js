"use strict";
/**
 * 药水效果表：中文名 / 别名 / 英文 id → 数字 id。
 *
 * 数字 id 抄自 LSE 文档「为玩家添加一个药水效果」下面那张对照表，
 * 不要凭记忆改：id 一旦错位，戴装备就会挂上另一个效果，而且很难看出原因。
 */
const LIST = [
    { id: 1, name: '速度', alias: ['速度', '迅捷', '加速', 'speed'] },
    { id: 2, name: '缓慢', alias: ['缓慢', '迟钝', 'slowness'] },
    { id: 3, name: '急迫', alias: ['急迫', '挖掘加速', 'haste'] },
    { id: 4, name: '挖掘疲劳', alias: ['挖掘疲劳', 'mining_fatigue', 'fatigue'] },
    { id: 5, name: '力量', alias: ['力量', 'strength'] },
    { id: 6, name: '瞬间治疗', alias: ['瞬间治疗', 'instant_health', 'instanthealth'] },
    { id: 7, name: '瞬间伤害', alias: ['瞬间伤害', 'instant_damage', 'instantdamage'] },
    { id: 8, name: '跳跃提升', alias: ['跳跃提升', '跳跃增强', '跳跃', 'jump_boost', 'jump'] },
    { id: 9, name: '反胃', alias: ['反胃', 'nausea'] },
    { id: 10, name: '生命恢复', alias: ['生命恢复', '再生', 'regeneration', 'regen'] },
    { id: 11, name: '抗性提升', alias: ['抗性提升', '抗性', '抗性增加', 'resistance'] },
    { id: 12, name: '抗火', alias: ['抗火', '防火', '火焰抗性', 'fire_resistance'] },
    { id: 13, name: '水下呼吸', alias: ['水下呼吸', '水肺', 'water_breathing'] },
    { id: 14, name: '隐身', alias: ['隐身', 'invisibility'] },
    { id: 15, name: '失明', alias: ['失明', 'blindness'] },
    { id: 16, name: '夜视', alias: ['夜视', 'night_vision'] },
    { id: 17, name: '饥饿', alias: ['饥饿', 'hunger'] },
    { id: 18, name: '虚弱', alias: ['虚弱', 'weakness'] },
    { id: 19, name: '中毒', alias: ['中毒', 'poison'] },
    { id: 20, name: '凋零', alias: ['凋零', 'wither'] },
    { id: 21, name: '生命提升', alias: ['生命提升', 'health_boost'] },
    { id: 22, name: '伤害吸收', alias: ['伤害吸收', '吸收', 'absorption'] },
    { id: 23, name: '饱和', alias: ['饱和', 'saturation'] },
    { id: 24, name: '飘浮', alias: ['飘浮', '漂浮', 'levitation'] },
    { id: 25, name: '致命中毒', alias: ['致命中毒', '中毒致命', 'fatal_poison'] },
    { id: 26, name: '潮涌能量', alias: ['潮涌能量', 'conduit_power'] },
    { id: 27, name: '缓降', alias: ['缓降', '慢降', '缓慢降落', 'slow_falling'] },
    { id: 28, name: '不祥之兆', alias: ['不祥之兆', 'bad_omen'] },
    { id: 29, name: '村庄英雄', alias: ['村庄英雄', 'village_hero'] },
    { id: 30, name: '黑暗', alias: ['黑暗', 'darkness'] },
];

const BY_KEY = new Map();
const NAME_OF = new Map();

for (const e of LIST) {
    NAME_OF.set(e.id, e.name);
    BY_KEY.set(String(e.name).toLowerCase(), e);
    for (const a of e.alias) {
        const k = String(a).toLowerCase();
        if (!BY_KEY.has(k)) BY_KEY.set(k, e);
    }
}

/** 关键词按长度倒序：「抗性提升」必须先于「抗性」被尝试 */
const KEYS = Array.from(BY_KEY.keys()).sort((a, b) => b.length - a.length);

/**
 * 瞬间类效果不适合「持续挂」：每秒续一次等于每秒治疗/伤害一次，
 * 会造成无限刷血或无限掉血。默认跳过（配置 skip_instant 可改）。
 */
const INSTANT = new Set([6, 7]);

/** 和别的插件/机制冲突的效果，状态页会提示 */
const CONFLICT = new Map([
    [21, '生命提升会直接改最大生命，和 nbt_tool 的「生命上限加成」会互相覆盖'],
]);

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const Effects = {
    LIST: LIST,
    KEYS: KEYS,
    INSTANT: INSTANT,
    CONFLICT: CONFLICT,
    /** 按 中文名/别名/英文 id 找效果，找不到返回 null */
    byKey: function (key) {
        if (key == null) return null;
        return BY_KEY.get(String(key).trim().toLowerCase()) || null;
    },
    /** id → 中文名 */
    nameOf: function (id) {
        return NAME_OF.get(Number(id)) || ('未知效果' + id);
    },
    /** 等级 → 罗马数字（1..10），超出范围就显示阿拉伯数字 */
    roman: function (level) {
        const n = Number(level);
        return ROMAN[n] != null && n > 0 ? ROMAN[n] : String(level);
    },
};

exports.Effects = Effects;
