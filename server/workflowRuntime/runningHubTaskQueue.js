// RunningHub 任务队列调度器
// 简单 FIFO 队列，控制并发数和排队长度。
// maxQueueLength = -1 表示无界队列；0 表示不排队，满了直接拒绝。

export class RunningHubTaskQueue {
  constructor({ maxConcurrent = 1, maxQueueLength = -1 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.maxQueueLength = Number(maxQueueLength);
    this.runningCount = 0;
    this.waitingQueue = []; // { taskId, resolve, reject }
    this.acquiredTasks = new Set();
  }

  get running() {
    return this.runningCount;
  }

  get queued() {
    return this.waitingQueue.length;
  }

  get status() {
    return {
      maxConcurrent: this.maxConcurrent,
      maxQueueLength: this.maxQueueLength,
      running: this.runningCount,
      queued: this.waitingQueue.length,
      available: Math.max(0, this.maxConcurrent - this.runningCount),
    };
  }

  updateConfig({ maxConcurrent, maxQueueLength }) {
    if (Number.isFinite(Number(maxConcurrent))) {
      this.maxConcurrent = Math.max(1, Math.round(Number(maxConcurrent)));
    }
    if (Number.isFinite(Number(maxQueueLength))) {
      this.maxQueueLength = Math.round(Number(maxQueueLength));
    }
    // 配置变化后尝试启动更多任务
    this._drain();
  }

  // 申请一个槽位，返回 Promise，resolve 时表示可以开始执行
  // 拿到后必须调 release(taskId) 释放
  acquire(taskId) {
    return new Promise((resolve, reject) => {
      // 队列满了直接拒绝
      if (
        this.maxQueueLength !== -1 &&
        this.runningCount >= this.maxConcurrent &&
        this.waitingQueue.length >= this.maxQueueLength
      ) {
        const error = new Error('RunningHub 队列已满，请稍后再试。');
        error.code = 'RUNNINGHUB_QUEUE_FULL';
        error.retryable = true;
        reject(error);
        return;
      }

      // 如果有空位，直接拿到槽位
      if (this.runningCount < this.maxConcurrent) {
        this.runningCount++;
        this.acquiredTasks.add(taskId);
        resolve();
        return;
      }

      // 否则排队等待
      this.waitingQueue.push({ taskId, resolve, reject });
    });
  }

  // 释放一个槽位
  release(taskId) {
    if (!this.acquiredTasks.has(taskId)) return;
    this.acquiredTasks.delete(taskId);
    this.runningCount = Math.max(0, this.runningCount - 1);
    this._drain();
  }

  _drain() {
    // 有空位且队列有等待任务，启动下一个
    while (this.runningCount < this.maxConcurrent && this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift();
      this.runningCount++;
      this.acquiredTasks.add(next.taskId);
      next.resolve();
    }
  }

  dispose() {
    // 清空队列，所有等待中的任务 reject
    for (const entry of this.waitingQueue) {
      const error = new Error('RunningHub 队列已关闭。');
      error.code = 'RUNNINGHUB_QUEUE_DISPOSED';
      error.retryable = false;
      entry.reject(error);
    }
    this.waitingQueue = [];
    this.runningCount = 0;
    this.acquiredTasks.clear();
  }
}
