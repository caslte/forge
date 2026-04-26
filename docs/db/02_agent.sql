-- ==================== 助手配置模块 ====================
-- 模块编号：02
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 助手表
CREATE TABLE IF NOT EXISTS agent (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',  -- 单人版固定 workspace
    name TEXT NOT NULL UNIQUE,
    instructions TEXT,  -- 角色设定/系统提示词
    runtime_mode TEXT NOT NULL DEFAULT 'default' CHECK (runtime_mode IN ('bypassPermissions', 'clippings', 'default')),
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'error', 'offline')),
    max_concurrent_tasks INT NOT NULL DEFAULT 1,
    model TEXT,  -- 指定模型，空则使用 Claude Code 默认
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 助手-技能关联表
CREATE TABLE IF NOT EXISTS agent_skill (
    agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    position INT NOT NULL DEFAULT 0,  -- 排序位置
    PRIMARY KEY (agent_id, skill_id)
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_agent_workspace ON agent(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent(status);
CREATE INDEX IF NOT EXISTS idx_agent_skill_agent ON agent_skill(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_skill_skill ON agent_skill(skill_id);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 agent 表
-- - 创建 agent_skill 表

-- ==================== 测试数据清理 ====================

DELETE FROM agent_skill WHERE agent_id IN (
    SELECT id FROM agent WHERE name LIKE 'test_%'
);
DELETE FROM agent WHERE name LIKE 'test_%';
