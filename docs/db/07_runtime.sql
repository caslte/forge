-- ==================== Daemon 运行时模块 ====================
-- 模块编号：07
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- Daemon 运行时注册表
CREATE TABLE IF NOT EXISTS runtime (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    daemon_id UUID NOT NULL UNIQUE,  -- Daemon 唯一标识
    legacy_daemon_ids TEXT[] NOT NULL DEFAULT '{}',  -- 历史 daemon_id 列表（用于合并）
    device_name TEXT NOT NULL,
    runtime_name TEXT NOT NULL DEFAULT 'Local Agent',
    cli_version TEXT,  -- multica CLI 版本
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'error')),
    agents JSONB NOT NULL DEFAULT '{}',  -- 可用代理配置
    last_heartbeat_at TIMESTAMPTZ,
    active_tasks JSONB NOT NULL DEFAULT '[]',  -- 当前活跃任务
    workspaces UUID[] NOT NULL DEFAULT '{}',  -- 关联的工作空间
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_runtime_daemon_id ON runtime(daemon_id);
CREATE INDEX IF NOT EXISTS idx_runtime_status ON runtime(status);
CREATE INDEX IF NOT EXISTS idx_runtime_device ON runtime(device_name);
CREATE INDEX IF NOT EXISTS idx_runtime_heartbeat ON runtime(last_heartbeat_at);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 runtime 表

-- ==================== 测试数据清理 ====================

DELETE FROM runtime WHERE device_name LIKE 'test_%';
