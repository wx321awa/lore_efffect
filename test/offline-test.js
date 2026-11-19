"use strict";
/**
 * 离线自测（不需要 BDS，纯 Node）：
 *
 *     node test/offline-test.js
 *
 * 它做两件事：
 *   1. 把 `plugins/lore_effect/src/xxx` 这种 LSE 路径映射到本机真实文件（下面那个 hook），
 *      这样同一份代码在 Node 里也能 require；
 *   2. 用桩替换 File / mc / log / ll，然后把解析器和授予逻辑全跑一遍断言。
 *
 * 改动 parse.js / runtime.js 之后先跑这个，再上服。目前 91 项断言。
 */
const path = require("path");

// ---------------------------------------------------------- LSE 路径 hook
const Module = require("module");
const originResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    const m = /^plugins\/lore_effect\/src\/([A-Za-z0-9_.\-]+)$/.exec(String(request));
    if (m != null) return path.join(__dirname, "..", "src", m[1] + ".js");
    return originResolve.call(this, request, parent, isMain, options);
};

// ---------------------------------------------------------- LSE 全局桩
const FAKE_FS = new Map();
global.File = {
    exists: (p) => FAKE_FS.has(p),
    readFrom: (p) => (FAKE_FS.has(p) ? FAKE_FS.get(p) : null),
    writeTo: (p, t) => { FAKE_FS.set(p, String(t)); return true; },
    delete: (p) => { FAKE_FS.delete(p); return true; },
    createDir: (p) => { FAKE_FS.set(p, ""); return true; },
    checkIsDir: (p) => FAKE_FS.has(p),
    getFilesList: () => [],
};
const ONLINE = [];
global.mc = {
    getOnlinePlayers: () => ONLINE,
    getPlayer: (k) => ONLINE.find((p) => p.uuid === k || p.xuid === k) || null,
};
global.log = () => { };
global.ll = { onUnload: () => { } };

const Parse = require("plugins/lore_effect/src/parse");
const { Config } = require("plugins/lore_effect/src/config");
const { Runtime } = require("plugins/lore_effect/src/runtime");
const { Version } = require("plugins/lore_effect/src/version");

let pass = 0;
let fail = 0;
function check(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) { pass++; return; }
    fail++;
    console.log("  ✗ " + label + "\n      实际 " + a + "\n      期望 " + b);
}

// ============================================================ 1. 解析器
console.log("[1] lore 解析");
const H = (text, maxLevel, requireLevel) => Parse.parseLine(text, { maxLevel: maxLevel || 10, requireLevel: requireLevel }).map((h) => h.id + ":" + h.level);

check(H("速度II"), ["1:2"], "速度II → 速度二级");
check(H("速度 II"), ["1:2"], "带空格");
check(H("速度2级"), ["1:2"], "阿拉伯数字 + 级");
check(H("速度 等级3"), ["1:3"], "等级3");
check(H("速度 Lv.2"), ["1:2"], "Lv.2");
check(H("速度 lv2"), ["1:2"], "lv2");
check(H("力量+2"), ["5:2"], "力量+2");
check(H("力量 提升 2"), ["5:2"], "提升 2");
check(H("抗性提升IV 生命恢复I"), ["11:4", "10:1"], "一行两个效果");
check(H("生命恢复2级"), ["10:2"], "生命恢复2级（长关键词优先）");
check(H("抗性提升II"), ["11:2"], "抗性提升II 不能被「抗性」截断");
check(H("speed2"), ["1:2"], "英文 id");
check(H("strength:2"), ["5:2"], "英文 id + 冒号");
check(H("跳跃提升 3"), ["8:3"], "跳跃提升 3");
check(H("速度"), [], "只写效果名、没写等级 → 不生效（1.0.3 起）");
check(H("力量"), [], "「力量」两个字单独出现不触发");
check(H("力量之剑"), [], "「力量之剑」这种词条也不触发");
check(H("抗性提升"), [], "其他效果同理：光写名字不生效");
check(H("生命恢复 II"), ["10:2"], "等级写在后面、中间带空格也行");
check(H("力量5"), ["5:5"], "写了数字就是对应等级");
check(H("速度", 10, false), ["1:1"], "require_level=false 时恢复旧行为（不写等级按 I 级）");
check(H("§c速度§r§l II"), ["1:2"], "带颜色码");
check(H("速度ＩＩ"), ["1:2"], "全角罗马数字");
check(H("速度99"), ["1:10"], "等级封顶到 max_level");
check(H("攻击速度+10%"), [], "属性百分比行不认（挡掉「攻击速度」误判）");
check(H("speedy"), [], "英文词边界");
check(H("这把剑很快"), [], "没有关键词");
check(H("速度II 力量II"), ["1:2", "5:2"], "两个效果同等级");
check(H("夜视 15秒"), [], "时长描述「15秒」不当等级（1.3.0）");
check(H("速度 20秒"), [], "「20秒」不当等级");
check(H("跳跃提升 3秒"), [], "「3秒」不当等级");
check(H("速度 20分钟"), [], "「分钟」不当等级");
check(H("抗性提升IV 速度 20秒"), ["11:4"], "一行里描述行被挡掉、真效果仍生效");
check(H("速度 3级"), ["1:3"], "「级」是等级后缀，不受影响");

// ============================================================ 2. 运行时
console.log("[2] 运行时（授予 / 撤销 / 不抢药水）");
Config.load();
const rt = new Runtime();

function resetCfg() {
    const D = Config.defaults;
    for (const k of Object.keys(D)) {
        Config.current[k] = Array.isArray(D[k]) ? D[k].slice() : D[k];
    }
    // 引擎能力/状态是跨用例的全局量，必须一起复位，否则前一个用例的「无限不支持」会污染后面
    rt.infiniteUnsupported = false;
    rt.state.clear();
}

let seq = 0;
function mkItem(lines, name) {
    return { name: name || "测试剑", lore: lines };
}

function mkPlayer(opts) {
    const o = opts || {};
    const calls = [];
    const durations = [];
    const present = new Set(o.present || []);
    const p = {
        uuid: o.uuid || ("uuid-" + (++seq)),
        realName: "Steve",
        isPlayer: () => true,
        getHand: () => (o.hand === undefined ? mkItem(o.lore || []) : o.hand),
        getOffHand: () => (o.offhand === undefined ? null : o.offhand),
        getArmor: () => ({ getAllItems: () => o.armor || [] }),
        getAllEffects: () => Array.from(present),
        addEffect: (id, ticks, amp) => {
            if (o.rejectInfinite === true && ticks < 0) { calls.push("reject:" + id); return false; }
            calls.push("add:" + id + ":" + amp);
            durations.push(ticks);
            present.add(id);
            return true;
        },
        removeEffect: (id) => { calls.push("rm:" + id); present.delete(id); return true; },
    };
    return { player: p, calls: calls, durations: durations, present: present };
}

// --- 2.1 戴上就挂、重复扫不重复发包
resetCfg();
{
    const t = mkPlayer({ lore: ["速度II", "力量2级"] });
    rt.applyTo(t.player);
    check(t.calls.slice().sort(), ["add:1:1", "add:5:1"], "首次扫：挂速度II(amp1) + 力量II(amp1)");
    const before = t.calls.length;
    rt.applyTo(t.player);
    rt.applyTo(t.player);
    check(t.calls.length, before, "效果已在身上、未到续期时间 → 一个包都不发");
}

// --- 2.2 脱装备就撤销
{
    const t = mkPlayer({ lore: ["速度II"] });
    rt.applyTo(t.player);
    t.player.getHand = () => null;
    rt.applyTo(t.player);
    check(t.calls.slice(), ["add:1:1", "rm:1"], "脱下 → 撤销");
}

// --- 2.3 玩家自己带着药水 → 不抢
{
    resetCfg();
    const t = mkPlayer({ lore: ["速度II"], present: [1] });
    rt.applyTo(t.player);
    check(t.calls, [], "身上已有速度（药水）→ 本插件不覆盖");
    t.present.delete(1);
    rt.applyTo(t.player);
    check(t.calls, ["add:1:1"], "药水掉落后，下一轮接管");
}

// --- 2.4 多件装备同一效果：max / sum
{
    resetCfg();
    const t = mkPlayer({ hand: mkItem(["速度I"]), armor: [mkItem(["速度I"])] });
    Config.current.stack = "max";
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:1:0"], "max 模式：两件速度I → 仍是 I 级");
    t.player.removeEffect(1);
    rt.state.clear();
    t.calls.length = 0;
    Config.current.stack = "sum";
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:1:1"], "sum 模式：两件速度I → 二级");
}

// --- 2.5 瞬间效果默认跳过
{
    resetCfg();
    const t = mkPlayer({ lore: ["瞬间治疗II"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, [], "skip_instant：瞬间治疗不挂");
    Config.current.skip_instant = false;
    const t2 = mkPlayer({ lore: ["瞬间治疗III"] });
    rt.clearCaches();
    rt.applyTo(t2.player);
    check(t2.calls, ["add:6:2"], "skip_instant=false：允许挂");
}

// --- 2.6 黑名单
{
    resetCfg();
    const t = mkPlayer({ lore: ["生命上限: +5", "暴击概率: 20%"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, [], "黑名单把「上限」「概率」行挡掉");
}

// --- 2.7 等级改了要重新挂
{
    resetCfg();
    const t = mkPlayer({ lore: ["速度II"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    t.player.getHand = () => mkItem(["速度III"]);
    rt.applyTo(t.player);
    check(t.calls, ["add:1:1", "rm:1", "add:1:2"], "II → III 重新授予（先删再挂，amp 1 → 2）");
}

// --- 2.8 amplifier_offset 校准
{
    resetCfg();
    Config.current.amplifier_offset = -1;
    const t = mkPlayer({ lore: ["速度II"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:1:0"], "amplifier_offset=-1：写 II 传 amp 0");
    Config.current.amplifier_offset = 0;
}

// --- 2.9 require_marker 只认带标记的行
{
    resetCfg();
    Config.current.require_marker = "⬥";
    const t = mkPlayer({ lore: ["速度II", "⬥ 力量I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:5:0"], "require_marker：只解析带 ⬥ 的行");
    Config.current.require_marker = "";
}

// --- 2.10 效果被牛奶清掉 → 自动补挂
{
    // 用非视觉效果测补挂：判定丢失前有 2 秒冷却（防抖），所以要把「挂上多久」调老
    resetCfg();
    const t = mkPlayer({ lore: ["抗火I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    t.present.clear();                                   // 喝牛奶
    rt.state.get(t.player.uuid).granted.get(12).at = Date.now() - 3000;
    rt.applyTo(t.player);
    check(t.calls, ["add:12:0", "rm:12", "add:12:0"], "效果被清掉 → 先删再挂补回来");
}

// --- 2.11 配置关掉后不动玩家
{
    resetCfg();
    Config.current.enabled = false;
    const t = mkPlayer({ lore: ["速度II"] });
    rt.applyTo(t.player);
    check(t.calls, [], "enabled=false 时完全不动");
    Config.current.enabled = true;
}

// --- 2.12 副手槽 / 盔甲栏都算，背包不算
{
    resetCfg();
    const t = mkPlayer({ hand: null, offhand: mkItem(["抗火I"]), armor: [mkItem(["夜视I"])] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls.slice().sort(), ["add:12:0", "add:16:0"], "主手空、副手抗火 + 盔甲夜视 都生效");
}

// --- 2.13 槽位配置能关掉副手
{
    resetCfg();
    Config.current.slots = ["mainhand", "armor"];
    const t = mkPlayer({ hand: null, offhand: mkItem(["抗火I"]) });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, [], "slots 不含 offhand → 副手不生效");
    Config.current.slots = ["mainhand", "offhand", "armor"];
}

// --- 2.14 必须带等级（1.0.3 起）
{
    resetCfg();
    const t = mkPlayer({ lore: ["力量", "速度II"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:1:1"], "只有带等级的「速度II」生效，光写「力量」被忽略");
}
{
    resetCfg();
    Config.current.require_level = false;
    const t = mkPlayer({ lore: ["力量"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.calls, ["add:5:0"], "require_level=false：光写「力量」按 I 级生效");
}

// ============================================================ 3. 时长与挂法
console.log("[3] 效果时长 / 无限时长 / 续期");
{
    resetCfg();
    const t = mkPlayer({ lore: ["速度I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.durations, [400], "普通效果按 grant_ticks=400（20 秒）");
}
{
    // 默认 visual_mode=infinite：视觉类直接挂无限时长（-1），HUD 无倒计时、不会走到到期过渡
    resetCfg();
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.durations, [-1], "夜视默认挂无限时长（-1）");
}
{
    resetCfg();
    const all = Config.current.visual_effects.map((id) => rt.ticksFor(id, Config.current));
    check(all, [-1, -1, -1, -1, -1], "5 个视觉类效果默认都是无限时长");
}
{
    // 无限时长不需要续期：放了 60 秒也只有一个包
    resetCfg();
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    const st = rt.state.get(t.player.uuid);
    st.granted.get(16).at = Date.now() - 60000;
    rt.applyTo(t.player);
    check(t.durations.length, 1, "无限时长过了 60 秒也不重挂（没有倒计时就没有到期闪烁）");
}
{
    // 无限时长连续两次挂不住 → 自动发现并回落成 15 秒续期
    resetCfg();
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.durations, [-1], "先尝试无限");
    t.present.delete(16);                               // 引擎把无限效果丢了
    const st = rt.state.get(t.player.uuid);
    st.granted.get(16).at = Date.now() - 5000;
    rt.applyTo(t.player);                               // 第 1 次：重试无限
    check(t.durations, [-1, -1], "第 1 次没挂住 → 再试一次无限（可能是被牛奶清了）");
    check(rt.infiniteUnsupported, false, "还不下结论");
    t.present.delete(16);                               // 重试后引擎仍然把它丢了
    st.granted.get(16).at = Date.now() - 5000;
    rt.applyTo(t.player);                               // 第 2 次：判定不支持
    check(rt.infiniteUnsupported, true, "连续两次 → 判定引擎不支持无限");
    check(t.durations, [-1, -1, 300], "回落成 300 刻（15 秒）续期");
}
{
    // trust_effect_list=false：不看 getAllEffects，无限效果不会因为读不到而被误判/误补挂
    resetCfg();
    Config.current.trust_effect_list = false;
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    t.present.delete(16);                               // getAllEffects 读不到（不可靠版本）
    const st = rt.state.get(t.player.uuid);
    st.granted.get(16).at = Date.now() - 5000;
    rt.applyTo(t.player);
    rt.applyTo(t.player);
    check(t.durations, [-1], "关掉信任后：不会误补挂、也不会误回落");
    check(rt.infiniteUnsupported, false, "关掉信任后：不会误判无限不支持");
}
{
    // addEffect 直接拒绝 -1（返回 false）→ 立刻回落
    resetCfg();
    const t = mkPlayer({ lore: ["夜视I"], rejectInfinite: true });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(rt.infiniteUnsupported, true, "addEffect 拒绝 -1 → 打上回落标记");
    check(t.durations, [300], "直接改用 300 刻重挂");
}
{
    // visual_mode=refresh：按 15 秒挂，续期必须「先删再挂」（同等级重复 add 是空操作）
    resetCfg();
    Config.current.visual_mode = "refresh";
    Config.current.refresh_ahead_ms = 3000;
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    check(t.durations, [300], "refresh 模式首次挂 300 刻");
    const st = rt.state.get(t.player.uuid);
    st.granted.get(16).at = Date.now() - 5000;
    rt.applyTo(t.player);
    check(t.calls, ["add:16:0"], "只过 5 秒 → 不动");
    st.granted.get(16).at = Date.now() - 13000;
    rt.applyTo(t.player);
    check(t.calls, ["add:16:0", "rm:16", "add:16:0"], "过了 12 秒 → 先删再挂（保证计时器重置）");
}
{
    // 非视觉效果的续期同样是先删再挂（否则 20 秒一到会有 1 秒空档）
    resetCfg();
    Config.current.grant_ticks = 200;   // 10 秒，8 秒后续期
    const t = mkPlayer({ lore: ["速度I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    const st = rt.state.get(t.player.uuid);
    st.granted.get(1).at = Date.now() - 9000;
    rt.applyTo(t.player);
    check(t.calls, ["add:1:0", "rm:1", "add:1:0"], "普通效果续期也是先删再挂");
    Config.current.grant_ticks = 400;
}
{
    // 护栏：visual_ticks 写低了会被抬到 10 秒（200 刻）
    resetCfg();
    Config.current.visual_mode = "refresh";
    Config.current.visual_ticks = 100;
    check(rt.ticksFor(16, Config.current), 200, "visual_ticks=100 → 被 10 秒护栏抬到 200 刻");
}
{
    resetCfg();
    Config.current.visual_mode = "refresh";
    Config.current.visual_ticks = 100;
    Config.current.visual_min_ticks = 40;
    check(rt.ticksFor(16, Config.current), 200, "护栏值写坏也回退到 200 刻（10 秒）");
}
{
    resetCfg();
    Config.current.visual_mode = "refresh";
    Config.current.visual_min_ticks = 400;
    check(rt.ticksFor(16, Config.current), 400, "visual_min_ticks=400 → 视觉类被抬到 20 秒");
    Config.current.visual_min_ticks = 200;
}

// ============================================================ 3b. 诊断输出
console.log("[3b] /lorefx diag 输出");
{
    resetCfg();
    const t = mkPlayer({ lore: ["夜视I"] });
    rt.clearCaches();
    rt.applyTo(t.player);
    const text = rt.diag(t.player);
    check(text.indexOf("getAllEffects") >= 0, true, "diag 里有 getAllEffects 实际返回值");
    check(text.indexOf("已挂") >= 0, true, "diag 里有已挂列表");
    check(text.indexOf("夜视") >= 0, true, "diag 里有解析到的效果名");
    check(rt.status(t.player).indexOf("XiYing定制版") >= 0, true, "status 带品牌");
}

// ============================================================ 4. 品牌
console.log("[4] 品牌与版本");
{
    FAKE_FS.set("plugins/lore_effect/manifest.json", JSON.stringify({ version: "1.2.0" }));
    check(Version.BRAND, "XiYing定制版", "BRAND 常量");
    check(Version.display(), "XiYing定制版 v1.2.0", "display() 带定制版品牌");
    FAKE_FS.set("plugins/lore_effect/manifest.json", JSON.stringify({ version: "2.3.4" }));
    check(Version.display(), "XiYing定制版 v2.3.4", "版本号跟着 manifest 走");
    FAKE_FS.delete("plugins/lore_effect/manifest.json");
    check(Version.display(), "XiYing定制版 v1.3.0", "manifest 缺失时回退到 1.3.0");
    check(Version.tuple(), [1, 3, 0], "tuple() 给 registerPlugin 用");
    FAKE_FS.set("plugins/lore_effect/manifest.json", JSON.stringify({ version: "2.3.4" }));
    check(Version.tuple(), [2, 3, 4], "tuple() 跟着 manifest 走");
}

// ============================================================ 3c. 读不到效果列表
console.log("[3c] getAllEffects 不可用时不能疯狂重挂");
{
    resetCfg();
    let adds = 0;
    let rms = 0;
    const p = {
        uuid: "uuid-unreadable",
        realName: "Steve",
        isPlayer: () => true,
        getHand: () => mkItem(["速度II"]),
        getOffHand: () => null,
        getArmor: () => ({ getAllItems: () => [] }),
        getAllEffects: () => { throw new Error("boom"); },
        addEffect: () => { adds++; return true; },
        removeEffect: () => { rms++; return true; },
    };
    rt.clearCaches();
    rt.applyTo(p);
    const st = rt.state.get("uuid-unreadable");
    st.granted.get(1).at = Date.now() - 3000;   // 超过 2 秒「丢失」宽限
    rt.applyTo(p);
    rt.applyTo(p);
    check([adds, rms], [1, 0], "读不到列表时不许「先删再挂」（1.3.0）");
}
{
    resetCfg();
    const p = {
        uuid: "uuid-visual-unreadable",
        realName: "Steve",
        isPlayer: () => true,
        getHand: () => mkItem(["夜视II"]),
        getOffHand: () => null,
        getArmor: () => ({ getAllItems: () => [] }),
        getAllEffects: () => { throw new Error("boom"); },
        addEffect: () => true,
        removeEffect: () => true,
    };
    rt.clearCaches();
    rt.applyTo(p);
    const st = rt.state.get("uuid-visual-unreadable");
    for (let round = 0; round < 3; round++) {
        st.granted.get(16).at = Date.now() - 3000;
        rt.applyTo(p);
    }
    check(rt.infiniteUnsupported, false, "读不到列表时不能误判「引擎不支持无限」");
}

// ============================================================ 3d. stack=sum 的槽位标注
console.log("[3d] stack=sum 的 /lorefx status 槽位标注");
{
    resetCfg();
    Config.current.stack = "sum";
    rt.clearCaches();
    const t = mkPlayer({ hand: mkItem(["力量2"]), offhand: mkItem(["力量3"]) });
    const w = rt.wantFor(t.player, Config.current);
    check(w.want.get(5).level, 5, "sum：2+3 级 = 5 级");
    check(w.want.get(5).where, ["主手", "副手"], "sum：两件都要标出来（1.3.0 之前只标第一件）");
    Config.current.stack = "max";
    rt.clearCaches();
    const w2 = rt.wantFor(t.player, Config.current);
    check(w2.want.get(5).where, ["副手"], "max 模式仍只标贡献最高等级的那件");
}

// ============================================================ 3e. 配置类型纠正
console.log("[3e] 配置类型自动纠正");
{
    FAKE_FS.set("config/lore_effect/config.json", JSON.stringify({
        visual_effects: ["9", "16"], slots: "mainhand,offhand", enabled: "false",
        max_level: "8", stack: "SUM", grant_ticks: "600.7",
    }));
    const c = Config.load();
    check(c.slots, ["mainhand", "offhand"], "slots 写成字符串 → 拆成数组");
    check(c.visual_effects, [9, 16], "visual_effects 字符串 id → 数字");
    check([c.enabled, c.max_level, c.stack, c.grant_ticks], [false, 8, "sum", 600], "布尔 / 整数 / 枚举类型纠正");
    FAKE_FS.delete("config/lore_effect/config.json");
    resetCfg();
}

// ============================================================ 汇总
console.log("");
console.log(fail === 0 ? "✅ 全部通过：" + pass + " 项" : "❌ 失败 " + fail + " / " + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
