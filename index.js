"use strict";
/**
 * lore_effect —— 按装备 Lore 给予药水效果（独立插件，和 nbt_tool 无依赖）。
 *
 * 生效位置：主手 / 副手 / 盔甲栏（背包里的不算）。脱下即撤销。
 * Lore 写法见 README.md，示例：
 *      速度II
 *      力量2级
 *      抗性提升IV 生命恢复I        ← 一行可以写多个
 *      speed:2                    ← 英文 id 也认
 *
 * 命令（默认所有人可用，reload/test 只有 OP 能用）：
 *      /lorefx            看自己当前装备解析出什么、挂了什么
 *      /lorefx list       关键词表
 *      /lorefx test 速度   现场校准等级语义（挂一个 5 秒的 I 级效果）
 *      /lorefx reload     重载 config/lore_effect/config.json
 */
const { Config: Cfg } = require("plugins/lore_effect/src/config");
const { Runtime } = require("plugins/lore_effect/src/runtime");
const { Version } = require("plugins/lore_effect/src/version");

// Yoyo 规范的头注册：包一层 try/catch，注册失败最多丢一条元信息，不影响本体
try {
    // 版本号从 manifest.json 读（Version.tuple()），别再写死 —— 1.2.0 那次就是
    // 代码里死在 [1,2,0]，改了 manifest 插件信息还显示旧号。
    ll.registerPlugin('lore_effect', '按装备Lore给药水效果（' + Version.BRAND + '）', Version.tuple(), {
        author: 'xxhh.',
    });
} catch (e) {
    log('[lore_effect] ll.registerPlugin 跳过: ' + e);
}

// 顶层先加载一次配置：热重载后 LSE 不重发 onServerStarted。
// 配置只依赖 File，不需要等服务端起来，所以放这里最稳。
Cfg.load();

const rt = new Runtime();

const isOP = (p) => {
    try {
        return p != null && typeof p.isOP === 'function' && p.isOP() === true;
    } catch (e) {
        return false;
    }
};

const sendLines = (output, text) => {
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) output.success(lines[i]);
};

// ------------------------------------------------------------------ 命令
try {
    const cmd = mc.newCommand('lorefx', 'Lore药水效果 ' + Version.BRAND + ' —— 状态 / 诊断 / 关键词 / 校准 / 重载', PermType.Any);
    cmd.setEnum('e_fx', ['status', 'diag', 'list', 'test', 'reload']);
    // 注意：多个枚举参数重名时必须靠枚举名在 overload 里区分（LSE 文档明确写了这点）
    // pfx 必须 optional：mandatory 的枚举 + 没有空重载，裸 /lorefx 会被 BDS 判成
    // 用法错误，回调里 res.pfx == null 的默认 status 分支永远走不到。
    // 空重载单独 try：个别 LSE 版本对 0 参数 overload 抛错，不能把后面两个一起带走。
    cmd.optional('pfx', ParamType.Enum, 'e_fx');
    cmd.optional('arg', ParamType.String);
    try { cmd.overload([]); } catch (e0) { log('[lore_effect] 空重载注册失败: ' + e0); }
    try { cmd.overload(['e_fx']); } catch (e1) { log('[lore_effect] 单参重载注册失败: ' + e1); }
    try { cmd.overload(['e_fx', 'arg']); } catch (e2) { log('[lore_effect] 双参重载注册失败: ' + e2); }
    cmd.setCallback((_cmd, origin, output, res) => {
        const action = String(res.pfx == null ? 'status' : res.pfx);
        const player = origin.player;

        if (action === 'reload') {
            if (player != null && !isOP(player)) {
                output.error('只有 OP 能重载配置');
                return;
            }
            Cfg.load();
            rt.restart();
            output.success('配置已重载，轮询按新配置重启');
            return;
        }

        if (action === 'diag') {
            if (player == null) {
                output.error('/lorefx diag 需要在游戏里由玩家执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能做诊断');
                return;
            }
            sendLines(output, rt.diag(player));
            return;
        }

        if (action === 'list') {
            output.success('§l§d可识别的效果关键词（中文名或英文 id 都行）');
            const lines = rt.keywordList();
            for (let i = 0; i < lines.length; i++) output.success(lines[i]);
            return;
        }

        if (action === 'test') {
            if (player == null) {
                output.error('/lorefx test 需要在游戏里由玩家执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能校准');
                return;
            }
            sendLines(output, rt.test(player, res.arg));
            return;
        }

        // 默认 status
        if (player == null) {
            output.error('/lorefx status 需要在游戏里由玩家执行');
            return;
        }
        sendLines(output, rt.status(player));
    });
    cmd.setup();
} catch (e) {
    log('[lore_effect] 命令注册失败: ' + e);
}

// ------------------------------------------------------------- 事件与轮询
mc.listen('onServerStarted', () => {
    log('§b[lore_effect] ' + Version.display() + ' §7已启用 §8(/lorefx 看状态)');
    rt.start();
});

// 顶层也起一次：热重载不会重发 onServerStarted，不在这里起就永远不轮询。
// start() 自己会先 stop()，重复调用只是重启定时器，无副作用。
rt.start();

const safeListen = (event, cb) => {
    try {
        mc.listen(event, cb);
    } catch (e) {
        log('[lore_effect] 监听 ' + event + ' 失败: ' + e);
    }
};

safeListen('onJoin', (player) => rt.touch(player));
safeListen('onLeft', (player) => rt.forget(player));
// 切快捷栏格子（拿在手上 ↔ 收回背包）不触发任何事件，只能靠 1 秒轮询兜底；
// 下面这两个事件能覆盖大部分换装动作，把响应时间压到 150ms。
safeListen('onInventoryChange', (player) => rt.touch(player));
safeListen('onSetArmor', (player) => rt.touch(player));

try {
    ll.onUnload(() => rt.stop());
} catch (e) { }
