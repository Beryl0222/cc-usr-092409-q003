/**
 * 演出负荷护照的领域常量与额度规则。
 *
 * 负荷以“点”计，覆盖四个维度：
 * - light       强光暴露（灯照累计）
 * - tension     牵拉/操纵负荷
 * - transport   运输（装卸、颠簸）
 * - environment 环境暴露（温湿度等，含运输途中暴露）
 */

export const LOAD_DIMENSIONS = ["light", "tension", "transport", "environment"];

/** 脆弱等级：1 稳定 / 2 脆弱 / 3 极脆弱。等级来自每次检查结论。 */
export const VULNERABILITY_LEVELS = [1, 2, 3];

/** 一个检查周期内各维度的基础额度（脆弱等级 1）。 */
export const BASE_QUOTA = Object.freeze({
  light: 120,
  tension: 100,
  transport: 80,
  environment: 80,
});

/**
 * 按脆弱等级折算额度：等级 2 减半，等级 3 取三分之一。
 * 额度总是绑定到具体“检查版本”，修复后按新检查结果恢复，而不是清空历史。
 */
export function quotaForLevel(level) {
  if (!VULNERABILITY_LEVELS.includes(level)) {
    throw new Error(`未知脆弱等级：${level}`);
  }
  const result = {};
  for (const dim of LOAD_DIMENSIONS) {
    result[dim] = Math.round(BASE_QUOTA[dim] / level);
  }
  return result;
}

/**
 * 两次使用之间为让古件恢复所需的最短间隔（小时）。
 * 间隔短于该值时，按“连续使用”追加疲劳消耗。
 */
export const RECOVERY_GAP_HOURS = 20;

/** 修复双人签认后的观察期（小时）。观察期内排练与演出同等受限，不得绕过。 */
export const OBSERVATION_HOURS = 48;

/** 观察期内原件/局部原件使用的额度上限比例。 */
export const OBSERVATION_QUOTA_RATIO = 0.5;

/** 负荷估算系数（见 estimateUsage）。 */
export const FACTORS = Object.freeze({
  lightPerMinute: 0.6,
  tensionPerMinute: 0.5,
  environmentPerMinute: 0.3,
  transportPerKm: 0.8,
  environmentTransportPerKm: 0.1,
  transportLegFixed: 4,
  /** 局部原件使用时，整体按 70% 计负荷，其余部件以替身承担。 */
  partialModeRatio: 0.7,
  /** 每缺少一小时恢复期，对强光与牵拉各追加的疲劳点数。 */
  fatiguePerMissingHour: 1.5,
});

/** 灯光强度档位系数。 */
export const LIGHT_FACTOR = Object.freeze({ rehearsal: 0.5, normal: 1, strong: 1.5 });

/** 使用方式。 */
export const DECISIONS = Object.freeze({
  ORIGINAL: "original", // 使用原件
  SUBSTITUTE: "substitute", // 整件复制替身
  PARTIAL: "partial", // 原件 + 局部替换
  REJECTED: "rejected", // 本轮不使用原件
});
