"use strict";
/**
 * 运行时：装备变化 → 解析 lore → 授予/撤销药水效果。
 *
 * 三条铁律（和 nbt_tool 的血量加成同一套思路，都是线上踩出来的）：
 *   1. 值没变化就一个包都不发：已挂且等级没变、还没到续期时间 → 整段跳过。
 *   2. 玩家自己带着同名效果（喝药水/命令给的）时**不抢**：只在「本插件没挂过」
 *      且「玩家身上没有」时才首次授予。这样药水不会被装备顶掉。
 *   3. 状态丢了能自愈：效果时长是有限的（默认 12 秒）+ 到点前续期，
 *      插件崩了/被卸载，最坏多挂 12 秒就自己掉，不会永久粘在玩家身上。
 */
const { Config: Cfg } = require("plugins/lore_effect/src/config");
const { Effects } = require("plugins/lore_effect/src/effects");
const { Version } = require("plugins/lore_effect/src/version");
const { parseLine, mergeHits } = require("plugins/lore_effect/src/parse");

const CACHE_MAX = 512;
const DEBOUNCE_MS = 150;
/** 视觉类效果的时长绝对下限：200 刻 = 10 秒。低于它夜视/反胃会闪，代码里硬挡 */
const VISUAL_HARD_MIN = 200;
/** 判定「效果确实掉了」之前的冷却：避免 getAllEffects 抖动或刚挂上就误判成丢失 */
const MISSING_GRACE_MS = 2000;

class Runtime {
    constructor() {
        /** uuid → { granted: Map<effectId, {level, at}> } */
        this.state = new Map();
        this.pending = new Set();
        this.timer = null;
        this.busy = false;
        /** 引擎是否接受无限时长（-1）；跑起来才知道，见 ticksFor / grant */
        this.infiniteUnsupported = false;
        this.lineCache = new Map();
        this.itemCache = new Map();
    }

    // ---------------------------------------------------------------- 基础
    /** 稳定的玩家标识：uuid 优先，退 xuid */
    keyOf(player) {
        if (player == null) return null;
        try {
            if (player.uuid != null) return String(player.uuid);
        } catch (e) { }
        try {
            if (player.xuid != null) return String(player.xuid);
        } catch (e) { }
        return null;
    }

    nameOf(player) {
        try {
            return String(player.realName != null ? player.realName : player.name);
        } catch (e) {
            return '?';
        }
    }

    itemName(item) {
        try {
            const n = item.name != null ? String(item.name) : String(item.type);
            if (n.length > 0) return n;
        } catch (e) { }
        return '空';
    }

    playerOf(key) {
        try {
            const p = mc.getPlayer(key);
            if (p != null) return p;
        } catch (e) { }
        try {
            const list = mc.getOnlinePlayers() || [];
            for (let i = 0; i < list.length; i++) {
                const p = list[i];
                if (p == null) continue;
                try {
                    if (String(p.uuid) === key || String(p.xuid) === key) return p;
                } catch (e) { }
            }
        } catch (e) { }
        return null;
    }

    clearCaches() {
        this.lineCache.clear();
        this.itemCache.clear();
    }

    // ---------------------------------------------------------------- lore
    /**
     * 读物品的 lore 行。
     * 先用 it.lore（属性，直接给字符串数组），读不到再走 NBT 的 display.Lore。
     * 两条路都要留：不同 LSE 版本/不同物品上，其中一条会是空的。
     */
    readLore(item) {
        const out = [];
        try {
            const l = item.lore;
            if (l != null && typeof l.length === 'number') {
                for (let i = 0; i < l.length; i++) {
                    const one = l[i];
                    if (one == null) continue;
                    out.push(String(one));
                }
            }
        } catch (e) { }
        if (out.length > 0) return out;

        try {
            const nbt = item.getNbt();
            const tag = nbt == null ? null : nbt.getTag('tag');
            const display = tag == null ? null : tag.getTag('display');
            const lore = display == null ? null : display.getTag('Lore');
            if (lore == null) return out;
            let size = 0;
            try { size = Number(lore.getSize()); } catch (e) { size = 0; }
            if (!isFinite(size) || size <= 0) return out;
            for (let i = 0; i < size; i++) {
                let raw = null;
                try { raw = lore.getData(i); } catch (e) { raw = null; }
                if (raw == null) continue;
                if (typeof raw === 'string') out.push(raw);
                else if (typeof raw.get === 'function') {
                    try { out.push(String(raw.get())); } catch (e) { out.push(String(raw)); }
                }
                else out.push(String(raw));
            }
        } catch (e) { }
        return out;
    }

    /** 解析一行（带缓存，配置重载时清） */
    parseLineCached(text, maxLevel, requireLevel) {
        const hit = this.lineCache.get(text);
        if (hit !== undefined) return hit;
        const res = parseLine(text, { maxLevel: maxLevel, requireLevel: requireLevel });
        if (this.lineCache.size >= CACHE_MAX) this.lineCache.clear();
        this.lineCache.set(text, res);
        return res;
    }

    /**
     * 一件物品带来的效果：Map<id, level>；没有效果返回 null。
     * 整件物品按 lore 文本做缓存 —— 同款装备第二个人直接命中，正则一次都不跑。
     */
    readItemEffects(item, cfg) {
        if (item == null) return null;
        let lines = [];
        try { lines = this.readLore(item); } catch (e) { return null; }
        if (lines == null || lines.length === 0) return null;

        const key = lines.join('\u0001');
        const cached = this.itemCache.get(key);
        if (cached !== undefined) return cached;

        const bl = Array.isArray(cfg.blacklist_line_words) ? cfg.blacklist_line_words : [];
        const marker = String(cfg.require_marker == null ? '' : cfg.require_marker);
        let hits = [];
        for (let i = 0; i < lines.length; i++) {
            const line = String(lines[i]);
            if (marker.length > 0 && line.indexOf(marker) < 0) continue;
            let blocked = false;
            for (let b = 0; b < bl.length; b++) {
                if (String(bl[b]).length > 0 && line.indexOf(String(bl[b])) >= 0) { blocked = true; break; }
            }
            if (blocked) continue;
            const one = this.parseLineCached(line, cfg.max_level, cfg.require_level !== false);
            if (one.length > 0) hits = hits.concat(one);
        }
        let res = null;
        if (hits.length > 0) {
            const merged = mergeHits(hits);
            if (cfg.skip_instant === true) {
                for (const id of Array.from(merged.keys())) {
                    if (Effects.INSTANT.has(id)) merged.delete(id);
                }
            }
            if (merged.size > 0) res = merged;
        }
        if (this.itemCache.size >= CACHE_MAX) this.itemCache.clear();
        this.itemCache.set(key, res);
        return res;
    }

    // ---------------------------------------------------------------- 槽位
    slots(player, cfg) {
        const items = [];
        const take = (where, fn) => {
            let it = null;
            try { it = fn(); } catch (e) {
                if (cfg.debug) log('[lore_effect] ' + where + ' 读取失败: ' + e);
                return;
            }
            if (it == null) return;
            // 故意不用 isNull() 过滤：基岩版副手槽会出现「isNull 为真但 NBT 能读到 lore」
            // 的对象，信 isNull 会把副手装备整个漏掉（nbt_tool 线上踩过这个坑）。
            items.push({ where: where, item: it });
        };
        const on = (k) => (Array.isArray(cfg.slots) ? cfg.slots.indexOf(k) >= 0 : true);

        if (on('mainhand')) take('主手', () => player.getHand());
        if (on('offhand')) take('副手', () => player.getOffHand());
        if (on('armor')) {
            try {
                const armor = player.getArmor();
                if (armor != null && typeof armor.getAllItems === 'function') {
                    const list = armor.getAllItems() || [];
                    for (let i = 0; i < list.length; i++) {
                        const one = list[i];
                        take('盔甲' + (i + 1), () => one);
                    }
                }
            } catch (e) {
                if (cfg.debug) log('[lore_effect] 盔甲栏读取失败: ' + e);
            }
        }
        return items;
    }

    /**
     * 算出「这套装备应该给哪些效果」。
     * @returns {{want: Map<number,{level:number,where:string[]}>, detail: Array}}
     */
    wantFor(player, cfg) {
        const detail = [];
        const perId = new Map();  // id -> [{level, where}]

        const items = this.slots(player, cfg);
        for (let i = 0; i < items.length; i++) {
            const s = items[i];
            const got = this.readItemEffects(s.item, cfg);
            let text = '§8无';
            if (got != null && got.size > 0) {
                const parts = [];
                for (const [id, lv] of got) {
                    parts.push('§b' + Effects.nameOf(id) + Effects.roman(lv));
                    const arr = perId.get(id);
                    if (arr == null) perId.set(id, [{ level: lv, where: s.where }]);
                    else arr.push({ level: lv, where: s.where });
                }
                text = parts.join(' §8');
            }
            detail.push({ where: s.where, name: this.itemName(s.item), text: text });
        }

        const want = new Map();
        const cap = (isFinite(Number(cfg.max_level)) && Number(cfg.max_level) > 0) ? Math.floor(Number(cfg.max_level)) : 10;
        for (const [id, arr] of perId) {
            let level;
            if (String(cfg.stack) === 'sum') {
                level = 0;
                for (let i = 0; i < arr.length; i++) level += arr[i].level;
            } else {
                level = 0;
                for (let i = 0; i < arr.length; i++) if (arr[i].level > level) level = arr[i].level;
            }
            if (level > cap) level = cap;
            if (level < 1) level = 1;
            const where = [];
            // sum 模式下 level 是总和，比任何单件都大：用 >= level 过滤会永远为空
            // （之前 /lorefx status 的槽位标注会退回成只标第一件）。sum 就把所有来源都记上。
            const sumMode = String(cfg.stack) === 'sum';
            for (let i = 0; i < arr.length; i++) {
                if (where.indexOf(arr[i].where) >= 0) continue;
                if (!sumMode && arr[i].level < level) continue;
                where.push(arr[i].where);
            }
            want.set(id, { level: level, where: where.length > 0 ? where : [arr[0].where] });
        }
        return { want: want, detail: detail };
    }

    // ------------------------------------------------------------- 授予/撤销
    /** 等级 → addEffect 的 level 参数（可被 amplifier_offset 校准） */
    ampOf(level, cfg) {
        const off = Number(cfg.amplifier_offset);
        const v = Math.floor(level) - 1 + (isFinite(off) ? Math.floor(off) : 0);
        return v < 0 ? 0 : v;
    }

    /**
     * 这个效果该挂多久（游戏刻）。
     *
     * 视觉类效果（夜视/失明/反胃/潮涌能量/黑暗）在**快到期时**客户端会做亮度或
     * 画面过渡，时长太短就会「一闪一闪」——所以它们**锁定 visual_ticks**
     * （默认 300 刻 = 15 秒），不受 grant_ticks 影响；
     * 另有硬护栏 visual_min_ticks（默认 200 刻 = 10 秒），写低了会被抬回来。
     * 其余效果照 grant_ticks 走。
     */
    ticksFor(id, cfg) {
        const visual = Array.isArray(cfg.visual_effects) ? cfg.visual_effects : [];
        const isVisual = visual.indexOf(Number(id)) >= 0;

        if (!isVisual) {
            let ticks = Math.floor(Number(cfg.grant_ticks));
            return (!isFinite(ticks) || ticks === 0) ? 400 : ticks;
        }

        // visual_mode = infinite（默认）：直接挂无限时长，HUD 上没有倒计时，
        // 永远不会走到「快到期」那段过渡 —— 也就没有闪。
        // 引擎若不接受无限（addEffect 返回 false，或挂上后立刻被丢掉），
        // 会自动把 this.infiniteUnsupported 打开并回落到 refresh 模式。
        const mode = String(cfg.visual_mode == null ? 'infinite' : cfg.visual_mode).toLowerCase();
        if (mode === 'infinite' && this.infiniteUnsupported !== true) return -1;

        let ticks = Math.floor(Number(cfg.visual_ticks));
        if (ticks === -1) return -1;   // 显式永久（不建议）
        if (!isFinite(ticks) || ticks <= 0) ticks = 300;
        // 10 秒是**代码级绝对下限**：配置只能把它往上调，改不低。
        // 写在代码里而不是全靠配置，是因为「配置本身被写坏」也得挡住——
        // 低于 10 秒夜视就会闪，这种错不该靠人记得别改。
        let floor = Math.floor(Number(cfg.visual_min_ticks));
        if (!isFinite(floor) || floor < VISUAL_HARD_MIN) floor = VISUAL_HARD_MIN;
        return ticks < floor ? floor : ticks;
    }

    grant(player, id, level, st, now, cfg) {
        const amp = this.ampOf(level, cfg);
        const ticks = this.ticksFor(id, cfg);
        let ok = false;
        try {
            ok = player.addEffect(id, ticks, amp, cfg.show_particles === true) !== false;
        } catch (e) {
            ok = false;
            log('[lore_effect] addEffect 抛错 ' + Effects.nameOf(id) + ': ' + e);
        }
        // 不接受无限时长 → 记住并立刻改用有限时长重挂一次（不会无限递归）
        if (ok !== true && ticks < 0) {
            this.infiniteUnsupported = true;
            log('[lore_effect] 该引擎版本不接受无限时长（' + Effects.nameOf(id) +
                ' 的 addEffect 返回 false），视觉类回落到 ' + ((Number(cfg.visual_ticks) || 300) / 20) + ' 秒续期模式');
            return this.grant(player, id, level, st, now, cfg);
        }
        if (ok) {
            st.granted.set(id, { level: level, at: now, ticks: ticks });
            st.grants = (st.grants || 0) + 1;
            if (cfg.log_changes) {
                log('[lore_effect] ' + this.nameOf(player) + ' 挂上 ' + Effects.nameOf(id) + Effects.roman(level) +
                    '（level 参数 ' + amp + '，' + (ticks > 0 ? (ticks / 20) + ' 秒' : '永久') + '）');
            }
        } else if (cfg.debug) {
            log('[lore_effect] addEffect 失败: ' + Effects.nameOf(id) + ' id=' + id + ' amp=' + amp);
        }
        return ok;
    }

    applyTo(player) {
        const cfg = Cfg.get();
        if (cfg.enabled !== true) return null;
        if (player == null) return null;
        try {
            if (typeof player.isPlayer === 'function' && !player.isPlayer()) return null;
        } catch (e) { }

        const key = this.keyOf(player);
        if (key == null) return null;

        const now = Date.now();
        const w = this.wantFor(player, cfg);
        let st = this.state.get(key);
        if (st == null) {
            st = { granted: new Map(), grants: 0, removes: 0 };
            this.state.set(key, st);
        }

        // 当前身上已有的效果 id 快照（读不到就当空集合，按时间续期兜底）
        const present = new Set();
        let readable = true;
        try {
            const list = player.getAllEffects() || [];
            for (let i = 0; i < list.length; i++) present.add(Number(list[i]));
        } catch (e) {
            readable = false;
        }

        // 1) 撤销：本插件挂过、现在不该再有的
        for (const [id, g] of Array.from(st.granted.entries())) {
            if (w.want.has(id)) continue;
            try { player.removeEffect(id); } catch (e) { }
            st.granted.delete(id);
            if (cfg.log_changes) {
                log('[lore_effect] ' + this.nameOf(player) + ' 撤销 ' + Effects.nameOf(id) + Effects.roman(g.level));
            }
        }

        // 2) 授予 / 续期
        // 续期时间点按**每个效果自己的时长**算，不按全局 grant_ticks。
        const ahead = Math.max(0, Number(cfg.refresh_ahead_ms) || 0);
        const trustList = cfg.trust_effect_list !== false;

        for (const [id, want] of w.want) {
            const holdTicks = this.ticksFor(id, cfg);
            const holdMs = holdTicks > 0 ? holdTicks * 50 : -1;
            const dueMs = holdMs > 0 ? Math.max(500, holdMs - ahead) : -1;
            const g = st.granted.get(id);
            const listed = readable && present.has(Number(id));
            // 只有「信列表」且「真的读到了列表」时才用它判断在不在。
            // 读不到（getAllEffects 抛错）时必须当它一直在：否则每轮都判定成
            // 「被清掉了」→ 先删再挂，实测 6 秒内就把视觉类误判成「引擎不支持
            // 无限时长」，夜视回落成 15 秒续期又开始闪。
            const trusted = trustList && readable;
            // 「现在还在不在」：不信列表时就当它一直在（不做补挂）
            const has = trusted ? listed : true;
            // 「首次授予前要不要让位给药水」：不信列表时就当它不在（该挂就挂）
            const occupied = trusted ? listed : false;

            if (g == null) {
                // 玩家自己带着这个效果（药水/命令）→ 不抢，等它自然掉，之后下一轮再挂
                if (occupied) continue;
                this.grant(player, id, want.level, st, now, cfg);
                continue;
            }

            const age = now - g.at;

            if (Math.floor(g.level) !== Math.floor(want.level)) {
                // 等级变了：先删再挂，保证真的换成新等级
                this.reapply(player, id, want.level, st, now, cfg);
                continue;
            }

            if (g.ticks < 0) {
                // 无限时长：正常情况下什么都不用做。
                // 只有「挂上 2 秒后还是没有」才怀疑：被牛奶清了，或引擎不支持无限。
                // 连续两次都这样 → 判定引擎不支持，回落成有限时长续期。
                if (has) {
                    st.infMiss = 0;
                    continue;
                }
                if (age > MISSING_GRACE_MS) {
                    st.infMiss = (st.infMiss || 0) + 1;
                    if (st.infMiss >= 2) {
                        this.infiniteUnsupported = true;
                        log('[lore_effect] 无限时长连续两次挂不住（' + Effects.nameOf(id) +
                            '），引擎不支持 → 视觉类回落到 ' + ((Number(cfg.visual_ticks) || 300) / 20) + ' 秒续期模式');
                        this.reapply(player, id, want.level, st, now, cfg);
                    } else {
                        this.grant(player, id, want.level, st, now, cfg);
                    }
                }
                continue;
            }

            if (!has && age > MISSING_GRACE_MS) {
                // 被牛奶/死亡清掉了 → 补挂（先删再挂，避免空操作）
                this.reapply(player, id, want.level, st, now, cfg);
                continue;
            }
            if (dueMs > 0 && age >= dueMs) {
                // 关键：同等级再 addEffect 在部分 BDS 版本上是**空操作**，不会延长时长
                //（线上现象正是「15 秒倒计时跑完再重挂」，看着像循环）。
                // 所以续期必须先删再挂，保证计时器真的重置。
                this.reapply(player, id, want.level, st, now, cfg);
            }
        }
        return w;
    }

    // ------------------------------------------------------------- 调度
    scan() {
        if (this.busy) return;
        this.busy = true;
        try {
            const players = mc.getOnlinePlayers() || [];
            for (let i = 0; i < players.length; i++) {
                try {
                    this.applyTo(players[i]);
                } catch (e) {
                    if (Cfg.get().debug) log('[lore_effect] 处理玩家失败: ' + e);
                }
            }
        } catch (e) {
            log('[lore_effect] 轮询异常: ' + e);
        } finally {
            this.busy = false;
        }
    }

    /** 事件触发的即时重算（150ms 防抖，避免背包连点时反复算） */
    touch(player) {
        const key = this.keyOf(player);
        if (key == null) return;
        if (this.pending.has(key)) return;
        this.pending.add(key);
        setTimeout(() => {
            this.pending.delete(key);
            try {
                const p = this.playerOf(key);
                if (p != null) this.applyTo(p);
            } catch (e) { }
        }, DEBOUNCE_MS);
    }

    forget(player) {
        const key = this.keyOf(player);
        if (key != null) this.state.delete(key);
    }

    start() {
        this.stop();
        const cfg = Cfg.get();
        if (cfg.enabled !== true) {
            log('[lore_effect] 配置里已关闭，不启动');
            return;
        }
        const ms = Number(cfg.scan_interval_ms);
        if (!isFinite(ms) || ms <= 0) {
            log('[lore_effect] 轮询已关闭（scan_interval_ms<=0），只靠事件触发');
            return;
        }
        const period = Math.max(200, Math.floor(ms));
        this.timer = setInterval(() => this.scan(), period);
        log('[lore_effect] 轮询开启，间隔 ' + period + 'ms；槽位 ' +
            (Array.isArray(cfg.slots) ? cfg.slots.join('/') : '全部'));
    }

    stop() {
        if (this.timer != null) {
            try { clearInterval(this.timer); } catch (e) { }
            this.timer = null;
        }
    }

    /** 配置重载后：清缓存、丢状态、按新配置重启轮询 */
    restart() {
        this.stop();
        this.clearCaches();
        this.state.clear();
        this.infiniteUnsupported = false;   // 重新学一次引擎能力
        this.start();
    }

    // ------------------------------------------------------------- 查询
    status(player) {
        const cfg = Cfg.get();
        if (cfg.enabled !== true) return '§c[lore_effect] 已在 config/lore_effect/config.json 里关闭';
        const w = this.wantFor(player, cfg);
        const key = this.keyOf(player);
        const st = key == null ? null : this.state.get(key);
        const lines = ['§l§dLore 药水效果 §8' + Version.BRAND];

        for (let i = 0; i < w.detail.length; i++) {
            const d = w.detail[i];
            lines.push('§7' + d.where + ' §f' + d.name + ' §8→ ' + d.text);
        }
        if (w.want.size === 0) {
            lines.push('§e当前装备没有解析到任何效果');
            lines.push('§8检查：lore 里有没有关键词+等级；会不会被 blacklist_line_words 挡了');
        } else {
            const parts = [];
            for (const [id, one] of w.want) {
                parts.push('§b' + Effects.nameOf(id) + Effects.roman(one.level) + ' §8[' + one.where.join('/') + ']');
            }
            lines.push('§7应生效: ' + parts.join('，'));
        }
        if (st != null && st.granted.size > 0) {
            const got = [];
            for (const [id, g] of st.granted) got.push(Effects.nameOf(id) + Effects.roman(g.level));
            lines.push('§7本插件已挂: §a' + got.join('，'));
        } else {
            lines.push('§7本插件已挂: §8无（或效果是别的来源给的，本插件不抢）');
        }
        const conflicts = [];
        for (const [id] of w.want) {
            const c = Effects.CONFLICT.get(Number(id));
            if (c != null) conflicts.push(c);
        }
        if (conflicts.length > 0) lines.push('§c⚠ ' + conflicts.join('；'));
        const hold = Math.floor(Number(cfg.grant_ticks));
        const sample = (Array.isArray(cfg.visual_effects) && cfg.visual_effects.length > 0) ? cfg.visual_effects[0] : 16;
        const vticks = this.ticksFor(sample, cfg);
        lines.push('§8写法: 「速度II」「力量2级」「抗性提升IV 生命恢复I」');
        lines.push('§8' + Version.display() + ' §8| 时长 ' + (hold < 0 ? '永久' : (hold / 20) + 's') +
            '，视觉类 ' + (vticks > 0 ? (vticks / 20) + 's' : '无限（无倒计时）'));
        return lines.join('\n');
    }

    /** 重挂一个已有条目：先删再挂，保证计时器真的重置（同等级重复 add 可能是空操作） */
    reapply(player, id, level, st, now, cfg) {
        try { player.removeEffect(id); } catch (e) { }
        st.removes = (st.removes || 0) + 1;
        return this.grant(player, id, level, st, now, cfg);
    }

    /**
     * 诊断输出（/lorefx diag）。
     * 排「效果不生效 / 一直闪」这类问题时，就靠这几行：
     *   解析到了吗 → 挂上了吗 → 引擎还认不认这个效果（getAllEffects 里有没有）。
     */
    diag(player) {
        const cfg = Cfg.get();
        const w = this.wantFor(player, cfg);
        const key = this.keyOf(player);
        const st = key == null ? null : this.state.get(key);
        let present = '';
        try {
            const list = player.getAllEffects() || [];
            present = list.join(',');
        } catch (e) {
            present = '抛错: ' + e;
        }
        const lines = ['§l§d诊断 §8' + Version.display()];
        lines.push('§7开关 §f' + cfg.enabled + ' §7轮询 §f' + cfg.scan_interval_ms + 'ms §7槽位 §f' +
            (Array.isArray(cfg.slots) ? cfg.slots.join('/') : '?') + ' §7定时器 §f' + (this.timer != null ? '运行中' : '未启动'));
        const vticks = this.ticksFor((Array.isArray(cfg.visual_effects) && cfg.visual_effects[0]) || 16, cfg);
        lines.push('§7时长 §f普通 ' + ((Number(cfg.grant_ticks) || 400) / 20) + 's §7视觉 §f' +
            (vticks < 0 ? '无限' : (vticks / 20) + 's') + ' §8(mode=' + String(cfg.visual_mode) +
            ', 无限' + (this.infiniteUnsupported ? '不支持→已回落' : '未测/可用') + ')');
        for (let i = 0; i < w.detail.length; i++) {
            lines.push('§7' + w.detail[i].where + ' §f' + w.detail[i].name + ' §8→ ' + w.detail[i].text);
        }
        if (st == null) {
            lines.push('§7状态 §8这个玩家还没被处理过');
        } else {
            const got = [];
            for (const [id, g] of st.granted) {
                got.push(Effects.nameOf(id) + Effects.roman(g.level) +
                    (g.ticks < 0 ? '∞' : (g.ticks / 20) + 's') +
                    '（' + Math.round((Date.now() - g.at) / 1000) + 's 前）');
            }
            lines.push('§7已挂 §a' + (got.length > 0 ? got.join('，') : '无'));
            lines.push('§7计数 §f授予 ' + (st.grants || 0) + ' 次 / 撤销 ' + (st.removes || 0) + ' 次');
        }
        lines.push('§7getAllEffects §f[' + present + ']');
        lines.push('§8把这五行发我，就能判断是「没解析到 / 没挂上 / 被引擎丢掉 / 反复撤销」哪一种');
        return lines.join('\n');
    }

    /** 现场校准等级语义：挂一个等级 I 的短效果让服主看显示几级 */    test(player, keyword) {
        const eff = Effects.byKey(keyword == null || String(keyword).length === 0 ? '速度' : String(keyword).trim());
        if (eff == null) {
            return '§c认不出「' + keyword + '」，写中文名/英文 id 都行（speed / strength / resistance…），' +
                '完整表见 /lorefx list';
        }
        const cfg = Cfg.get();
        const amp = this.ampOf(1, cfg);
        // 视觉类效果测试时也用它的时长下限，否则测试那 5 秒一结束就闪一下，
        // 容易让人误以为「插件坏了」而不是「效果到头了」
        const visual = Array.isArray(cfg.visual_effects) && cfg.visual_effects.indexOf(Number(eff.id)) >= 0;
        const testTicks = visual ? Math.max(100, Math.floor(Number(cfg.visual_min_ticks)) || 320) : 100;
        try { player.removeEffect(eff.id); } catch (e) { }
        let ok = false;
        try { ok = player.addEffect(eff.id, testTicks, amp, true) !== false; } catch (e) { ok = false; }
        if (!ok) return '§caddEffect 失败：' + eff.name + '（id ' + eff.id + '，level 参数 ' + amp + '）';
        const key = this.keyOf(player);
        if (key != null) {
            const st = this.state.get(key);
            // 测试效果不算「本插件挂的」，否则下一轮会被撤销逻辑当成装备效果处理
            if (st != null) st.granted.delete(eff.id);
        }
        return '§a已试挂 ' + eff.name + '（id ' + eff.id + '，level 参数 ' + amp + '，' + (testTicks / 20) + ' 秒）\n' +
            '§7看左下角显示的是 §fI §7还是 §fII §7：\n' +
            '§7  · 显示 I  → 语义正确，amplifier_offset 保持 ' + (isFinite(Number(cfg.amplifier_offset)) ? cfg.amplifier_offset : 0) + '\n' +
            '§7  · 显示 II → 比预期高一级，把 amplifier_offset 改成 ' + (this.ampOffsetGuess(-1)) + '\n' +
            '§7改完执行 /lorefx reload';
    }

    ampOffsetGuess(delta) {
        const cur = Number(Cfg.get().amplifier_offset);
        return (isFinite(cur) ? cur : 0) + delta;
    }

    /** 关键词表（给 /lorefx list 用） */
    keywordList() {
        const out = [];
        for (const e of Effects.LIST) {
            out.push('§f' + e.name + ' §8(id ' + e.id + ') §7' + e.alias.join(' / '));
        }
        return out;
    }
}

exports.Runtime = Runtime;
