-- ==================== 任务执行模块 ====================
-- 模块编号：05
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 任务队列表
CREATE TABLE IF NOT EXISTS agent_task_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agent(id),
    runtime_id UUID NOT NULL,  -- Daemon/Runtime ID
    issue_id UUID NOT NULL REFERENCES issue(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
    dispatched_at TIMESTAMPTZ,  -- 分发时间
    started_at TIMESTAMPTZ,  -- 开始时间
    completed_at TIMESTAMPTZ,  -- 完成时间
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 防止重复领取同一任务
    UNIQUE (issue_id, status)  -- pending 状态只允许一条
);

-- 任务执行消息表
CREATE TABLE IF NOT EXISTS task_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
    type TEXT NOT NULL,  -- 消息类型: text/thinking/tool_use/tool_result/log
    content TEXT,  -- 消息内容
    tool TEXT,  -- 工具名称
    call_id TEXT,  -- 调用 ID
    session_id TEXT,  -- Claude Session ID
    usage JSONB,  -- Token 用量
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_task_queue_agent ON agent_task_queue(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_queue_runtime ON agent_task_queue(runtime_id);
CREATE INDEX IF NOT EXISTS idx_task_queue_status ON agent_task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON agent_task_queue(agent_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_task_queue_issue ON agent_task_queue(issue_id);
CREATE INDEX IF NOT EXISTS idx_task_message_task ON task_message(task_id);
CREATE INDEX IF NOT EXISTS idx_task_message_session ON task_message(session_id);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 agent_task_queue 表
-- - 创建 task_message 表

-- ==================== 测试数据清理 ====================

DELETE FROM task_message WHERE task_id IN (
    SELECT id FROM agent_task_queue WHERE issue_id IN (
        SELECT id FROM issue WHERE title LIKE 'test_%'
    )
);
DELETE FROM agent_task_queue WHERE issue_id IN (
    SELECT id FROM issue WHERE title LIKE 'test_%'
);
