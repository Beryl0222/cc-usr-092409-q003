import {
  FACTORS,
  LIGHT_FACTOR,
  LOAD_DIMENSIONS,
  RECOVERY_GAP_HOURS,
} from "./constants.js";

/**
 * 根据场次方案估算一次使用在各维度上的消耗（排期阶段使用，尚未签认）。
 *
 * @param {object} plan 场次方案
 * @param {number} plan.lightMinutes   强光照射分钟数
 * @param {number} plan.tensionMinutes 牵拉/操纵分钟数
 * @param {number} plan.environmentMinutes 现场环境暴露分钟数
 * @param {number} plan.transportKm    单程运输公里
 * @param {number} [plan.transportLegs=1] 运输段数（往返为 2）
 * @param {"rehearsal"|"normal"|"strong"} [plan.lightMode] 灯光档位
 * @param {"original"|"substitute"|"partial"} [plan.mode] 使用方式
 * @param {Date|string} [plan.startsAt] 场次开始时间
 * @param {Date|string} [previousEndsAt] 同一古件上一场结束时间，用于连续使用判定
 */
export function estimateUsage(plan, previousEndsAt) {
  const mode = plan.mode ?? "original";
  if (mode === "substitute") {
    // 整件复制替身不占用古件额度；替身自身另有台账，不计入古件护照。
    return zeroLoad();
  }

  const lightFactor = LIGHT_FACTOR[plan.lightMode ?? "normal"] ?? 1;
  let load = {
    light: round1(plan.lightMinutes * FACTORS.lightPerMinute * lightFactor),
    tension: round1(plan.tensionMinutes * FACTORS.tensionPerMinute),
    transport: round1(
      (plan.transportKm * FACTORS.transportPerKm +
        (plan.transportLegs ?? 1) * FACTORS.transportLegFixed)
    ),
    environment: round1(
      plan.environmentMinutes * FACTORS.environmentPerMinute +
        plan.transportKm * FACTORS.environmentTransportPerKm
    ),
  };

  // 连续使用：与上一场间隔不足恢复期时，强光与牵拉追加疲劳消耗。
  const gap = plan.startsAt && previousEndsAt
    ? hoursBetween(previousEndsAt, plan.startsAt)
    : null;
  load = { ...load };
  if (gap !== null && gap < RECOVERY_GAP_HOURS) {
    const fatigue = round1((RECOVERY_GAP_HOURS - gap) * FACTORS.fatiguePerMissingHour);
    load.light = round1(load.light + fatigue);
    load.tension = round1(load.tension + fatigue);
    load._fatigue = fatigue;
    load._recoveryGapHours = round1(gap);
  }

  if (mode === "partial") {
    for (const dim of LOAD_DIMENSIONS) {
      load[dim] = round1(load[dim] * FACTORS.partialModeRatio);
    }
  }
  return load;
}

/** 实际回执负荷：优先采用现场读数，缺失维度回退到估算值。 */
export function reconcileActual(estimated, actual = {}) {
  const result = {};
  for (const dim of LOAD_DIMENSIONS) {
    result[dim] = round1(actual[dim] ?? estimated[dim] ?? 0);
  }
  return result;
}

export function zeroLoad() {
  return { light: 0, tension: 0, transport: 0, environment: 0 };
}

export function addLoad(a, b) {
  const result = {};
  for (const dim of LOAD_DIMENSIONS) result[dim] = round1((a[dim] ?? 0) + (b[dim] ?? 0));
  return result;
}

export function withinQuota(used, quota) {
  return LOAD_DIMENSIONS.every((dim) => (used[dim] ?? 0) + 0.000001 <= (quota[dim] ?? 0));
}

export function overshoot(used, quota) {
  const result = {};
  for (const dim of LOAD_DIMENSIONS) {
    const over = round1((used[dim] ?? 0) - (quota[dim] ?? 0));
    if (over > 0) result[dim] = over;
  }
  return result;
}

function hoursBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
