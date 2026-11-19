"use strict";
/**
 * 配置读写：config/lore_effect/config.json
 *
 * 两个原则：
 *   1. 缺键用默认值兜底，并把**补全后的完整配置**写回文件 —— 否则服主在
 *      config.json 里根本看不到新加的开关，只能靠文档猜。
 *   2. 文件坏了不崩插件：备份成 .broken，按默认值继续跑。
 */
const DIR = 'config/lore_effect/';
const PATH = DIR + 'config.json';

const DEFAULTS = {
    /** 总开关 */
    enabled: true,
    /** 生效槽位：mainhand 主手 / offhand 副手 / armor 盔甲栏（背包里的不算） */
    slots: ['mainhand', 'offhand', 'armor'],
    /** 轮询间隔（毫秒）。切换快捷栏格子不触发任何事件，只能定时对一遍 */
    scan_interval_ms: 1000,
    /**
     * 普通效果的时长（游戏刻，20 刻 = 1 秒）。400 = 20 秒。
     * 视觉类效果（夜视/反胃等）**不走这个值**，固定按 visual_ticks 给 15 秒。
     *
     * 为什么不用 -1（永久）：插件被卸载/崩了以后永久效果会一直挂在玩家身上，
     * 没人能撤。用有限时长 + 到点前续期，最坏情况就是多挂一会儿自己掉。
     */
    grant_ticks: 400,
    /** 提前多少毫秒续期（默认 3000，躲开客户端的「效果即将结束」过渡） */
    refresh_ahead_ms: 3000,
    /**
     * 视觉类效果的挂法：
     *   'infinite' —— 直接挂无限时长（默认）。HUD 上没有倒计时，永远走不到
     *                「快到期」的亮度过渡，也就不会闪。脱下装备时移除。
     *                引擎若不吃无限，插件会自己发现并回落到 'refresh'。
     *   'refresh'  —— 挂 visual_ticks（15 秒），提前 refresh_ahead_ms 续期。
     *                续期用「先删再挂」，因为同等级重复 addEffect 在部分 BDS
     *                版本上是空操作（不会延长时长，现象就是倒计时跑完再重挂）。
     */
    visual_mode: 'infinite',
    /**
     * 视觉类效果的时长（游戏刻）—— 只在 visual_mode = 'refresh' 时生效，
     * 默认 15 秒（300 刻）。夜视/失明/反胃这类效果在快到期时客户端会做亮度或
     * 画面过渡（夜视最明显：到期前约 1 秒亮度开始回落），时长太短就会「一闪一闪」。
     */
    visual_ticks: 300,
    /**
     * 视觉类效果的绝对下限（游戏刻）。200 = 10 秒 —— 不建议低于 10 秒，
     * 低于它无论 visual_ticks 写多少都会被抬到 200 刻。
     * （要改视觉类时长就改 visual_ticks，这个键是兜底护栏）
     */
    visual_min_ticks: 200,
    /**
     * 哪些效果属于「快到期的过渡会看得见」——默认：反胃9 / 失明15 / 夜视16 /
     * 潮涌能量26 / 黑暗30。只影响时长下限，不影响能否生效。
     */
    visual_effects: [9, 15, 16, 26, 30],
    /** 是否显示药水粒子 */
    show_particles: false,
    /** 等级上限（写超过就按这个封顶） */
    max_level: 10,
    /**
     * 等级偏移。lore 里写 II 就是二级；如果你的 LSE 版本语义不同
     * （游戏里显示成 III），把它改成 -1；显示成 I 就改成 1。
     * 用 /lorefx test 速度 现场校准，别猜。
     */
    amplifier_offset: 0,
    /** 多件装备给同一个效果时怎么算：max（取最高，默认）/ sum（相加后封顶） */
    stack: 'max',
    /** 瞬间治疗/瞬间伤害每轮续期会无限刷血/掉血，默认跳过 */
    skip_instant: true,
    /**
     * 关键词后面**必须**跟等级（默认 true）。
     * true  —— 只写「力量」「速度」不生效，必须写「力量II」「力量2级」「力量+2」。
     *          避免装备 lore 里随便出现一个效果名就莫名其妙上 buff（= 误触发）。
     * false —— 旧行为：不写等级按 I 级算。
     */
    require_level: true,
    /**
     * 是否相信 getAllEffects()（默认 true）。
     * true  —— 用它判断「效果还在不在」：掉了才补挂，玩家自己喝药水时不抢。
     * false —— 完全不看它，只按时间表挂/续期。万一某个 LSE 版本的 getAllEffects
     *          返回值不可靠（比如永远空数组），把它关掉，行为就变成纯定时驱动。
     *          /lorefx diag 最后一行会打印实际返回值，先看那个再决定。
     */
    trust_effect_list: true,
    /** 整行比赛名单：命中任一词就整行不解析（默认挡掉「上限」类属性行和概率类） */
    blacklist_line_words: ['上限', '概率', '几率'],
    /**
     * 只解析含这个符号的行，例如填 '⬥' 就只认「⬥ 速度II」。
     * 留空 = 不限制（任何行都解析）。装备多、lore 文案杂时建议设一个标记。
     */
    require_marker: '',
    /** 每次授予/撤销写一条日志（调试期开，线上建议关） */
    log_changes: false,
    /** 打印解析明细 */
    debug: false,
};

const Config = {
    current: null,
    DIR: DIR,
    PATH: PATH,
    defaults: DEFAULTS,
};

/** 逐层建目录：File.createDir 对已存在的目录可能直接崩，必须先 exists */
Config.ensureDir = function () {
    if (typeof File === 'undefined' || File == null) return;
    const parts = DIR.split('/').filter((s) => s.length > 0);
    let cur = '';
    for (const part of parts) {
        cur += part + '/';
        try {
            if (!File.exists(cur)) File.createDir(cur);
        } catch (e) { }
    }
};

Config.load = function () {
    let obj = null;
    let hadFile = false;
    let broken = false;
    try {
        if (typeof File !== 'undefined' && File != null && File.exists(PATH)) {
            hadFile = true;
            const raw = File.readFrom(PATH);
            if (raw != null && String(raw).length > 0) obj = JSON.parse(String(raw));
        }
    } catch (e) {
        broken = true;
        obj = null;
        try {
            File.writeTo(PATH + '.broken', File.readFrom(PATH));
            File.delete(PATH);
        } catch (e2) { }
        log('[lore_effect] 配置解析失败，已备份成 config.json.broken，本次按默认值运行: ' + e);
    }

    const conf = {};
    for (const k of Object.keys(DEFAULTS)) conf[k] = DEFAULTS[k];
    if (obj != null && typeof obj === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) conf[k] = obj[k];
        }
    }
    Config.current = conf;

    // 首次生成 / 坏文件 / 缺键 → 把完整配置写回，让服主在文件里看得到所有开关
    const missing = (obj == null)
        ? Object.keys(DEFAULTS)
        : Object.keys(DEFAULTS).filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
    if (missing.length > 0) {
        Config.ensureDir();
        try {
            File.writeTo(PATH, JSON.stringify(conf, null, 2));
            if (hadFile && !broken) log('[lore_effect] 配置已补齐新键: ' + missing.join(', '));
        } catch (e) {
            log('[lore_effect] 配置写入失败: ' + e);
        }
    }
    return conf;
};

Config.get = function () {
    if (Config.current == null) Config.load();
    return Config.current;
};

exports.Config = Config;
