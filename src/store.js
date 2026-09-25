/**
 * JSONL 事件存储：追加写、原子刷盘、进程内互斥与乐观版本校验。
 * 服务重启时从日志完整重放，观察期、候补替换和未完成通知全部延续。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import { ModelError, foldEvents } from "./model.js";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.db = null;
    this.chainHead = "GENESIS";
    this.loaded = false;
    this.tail = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim());
      let head = "GENESIS";
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record.prev_hash !== head) {
          throw new ModelError(
            "LOG_DIVERGED",
            `事件日志哈希链在 ${record.event_id} 处断裂，拒绝继续加载`,
          );
        }
        head = record.hash;
        this.events.push(record);
      }
      this.chainHead = head;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    this.db = foldEvents(this.events.map(stripRecord));
    this.loaded = true;
  }

  /**
   * 追加一批事件：
   * - batch_id 相同的提交幂等（重放/重试直接返回既有结果，不重复扣减负荷）；
   * - expected_seq 提供调用方期望的护照版本，防止并发覆盖；
   * - 先在内存副本上折叠整批，任一事件失败则整批不写入（原子占用）。
   */
  async append(events, { batchId = null, expectedSeq = null, passportId = null } = {}) {
    if (!this.loaded) await this.load();
    return this.#enqueue(() => this.#commit(events, batchId, expectedSeq, passportId));
  }

  #enqueue(task) {
    const run = this.tail.then(task, task);
    // 队列即使上一批失败也继续可用。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #commit(events, batchId, expectedSeq, passportId) {
    if (!events.length) throw new ModelError("EMPTY_BATCH", "不能提交空事件批");

    if (batchId) {
      const existing = this.events.find((e) => e.batch_id === batchId);
      if (existing) {
        const sameSet =
          this.events.filter((e) => e.batch_id === batchId).length === events.length &&
          events.every((ev) => this.events.some((e) => e.batch_id === batchId && e.event_id === ev.event_id));
        if (!sameSet) {
          throw new ModelError("BATCH_COLLISION", `批次编号 ${batchId} 已用于另一组事件，编号不能复用`);
        }
        return { duplicated: true, events: this.events.filter((e) => e.batch_id === batchId) };
      }
    }
    if (expectedSeq !== null && passportId) {
      const current = this.db.passports.get(passportId)?.seq ?? 0;
      if (current !== expectedSeq) {
        throw new ModelError("SEQ_CONFLICT", `护照 ${passportId} 版本已变化：期望 ${expectedSeq}，当前 ${current}`);
      }
    }

    // 试算：整批通过才落盘。
    const draft = foldEvents([...this.events.map(stripRecord), ...events]);

    const records = [];
    let head = this.chainHead;
    for (const event of events) {
      const record = {
        ...event,
        batch_id: batchId,
        prev_hash: head,
        hash: "",
        stored_at: new Date().toISOString(),
      };
      record.hash = sha256(
        JSON.stringify({
          event_id: record.event_id,
          event_type: record.event_type,
          aggregate_type: record.aggregate_type,
          aggregate_id: record.aggregate_id,
          occurred_at: record.occurred_at,
          version: record.version,
          payload: record.payload,
          batch_id: record.batch_id,
          prev_hash: record.prev_hash,
        }),
      );
      head = record.hash;
      records.push(record);
    }

    await this.#flush(records);
    this.events.push(...records);
    this.chainHead = head;
    this.db = draft;
    return { duplicated: false, events: records };
  }

  async #flush(records) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    // O_APPEND 打开目标文件整体追加；单容器内由串行队列保证不会交错。
    // 哈希链在 load() 时校验，半截写入会被发现并拒绝启动，不会静默错账。
    const { open } = await import("node:fs/promises");
    const fh = await open(this.filePath, "a");
    try {
      await fh.appendFile(text);
    } finally {
      await fh.close();
    }
  }

  state() {
    if (!this.loaded) throw new ModelError("STORE_NOT_LOADED", "事件存储尚未加载");
    return this.db;
  }

  allEvents() {
    return this.events.map(stripRecord);
  }
}

function stripRecord(record) {
  const event = { ...record };
  delete event.prev_hash;
  delete event.hash;
  delete event.stored_at;
  return event;
}
