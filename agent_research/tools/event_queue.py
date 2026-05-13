"""
事件队列管理器

使用线程安全的 queue.Queue，支持在同步线程（AgentScope）
和异步协程（FastAPI SSE）之间传递状态更新事件。
"""
import queue
import time
import json
from typing import Dict, Any
from dataclasses import dataclass, field


@dataclass
class EventQueueManager:
    """管理每个 run_id 的事件队列（线程安全）"""
    queues: Dict[str, queue.Queue] = field(default_factory=dict)

    def get_queue(self, run_id: str) -> queue.Queue:
        """获取或创建指定 run_id 的事件队列"""
        if run_id not in self.queues:
            self.queues[run_id] = queue.Queue()
        return self.queues[run_id]

    def push_event(self, run_id: str, event: Any):
        """向指定 run_id 的队列推送事件（线程安全）"""
        q = self.get_queue(run_id)
        q.put(event)

    def push_state_snapshot(self, run_id: str, state_dict: dict):
        """推送状态快照事件"""
        event = {
            "type": "STATE_SNAPSHOT",
            "snapshot": state_dict,
            "timestamp": int(time.time() * 1000),
        }
        self.push_event(run_id, event)

    def remove_queue(self, run_id: str):
        """移除指定 run_id 的队列"""
        if run_id in self.queues:
            del self.queues[run_id]


# 全局事件队列管理器
event_manager = EventQueueManager()
