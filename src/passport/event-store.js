import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * 追加式事件存储：所有领域事实只追加、不改写。
 *
 * - 一个 JSONL 文件保存全部事件，每行一个信封。
 * - 写盘采用“临时文件 + rename”批量提交：一批事件要么全部可见，要么不可见，
 *   用于跨多个聚合的原子占用。
 * - 进程重启后重新读取整个日志即可还原全部状态。
 */
export class EventStore {
  constructor(file) {
    this.file = file;
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  }

  load() {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行无法解析：${error.message}`);
      }
    });
  }

  /**
   * 原子追加一批事件。调用方负责在这之前完成全部业务校验。
   * 每个聚合按已落盘事件数维护递增 version。
   */
  appendBatch(records, { getNextVersion }) {
    const stamped = records.map((record) => ({
      ...record,
      event_id: record.event_id || `evt-${randomUUID()}`,
      version: getNextVersion(record.aggregate_type, record.aggregate_id),
    }));
    const body = stamped.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const tmp = `${this.file}.tmp-${process.pid}-${stamped[0]?.event_id ?? randomUUID()}`;
    // 先把新批次写入临时文件，再与原日志拼接后整体 rename，保证读侧不会看到半截批次。
    const previous = existsSync(this.file) ? readFileSync(this.file) : Buffer.alloc(0);
    appendFileSync(tmp, previous);
    appendFileSync(tmp, body);
    renameSync(tmp, this.file);
    return stamped;
  }
}
