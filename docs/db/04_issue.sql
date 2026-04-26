-- ==================== 任务管理模块 ====================
-- 模块编号：04
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 任务表
CREATE TABLE IF NOT EXISTS issue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
    assignee_type TEXT CHECK (assignee_type IN ('agent', 'member')),
    assignee_id UUID,
    creator_type TEXT NOT NULL DEFAULT 'member' CHECK (creator_type IN ('agent', 'member')),
    creator_id UUID NOT NULL,
    parent_issue_id UUID REFERENCES issue(id) ON DELETE SET NULL,  -- 父任务 ID（子任务）
    position FLOAT NOT NULL DEFAULT 0,  -- 排序位置
    due_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 任务依赖表
CREATE TABLE IF NOT EXISTS issue_dependency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    depends_on_issue_id UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks', 'blocked_by', 'related')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 防止自依赖
    CHECK (issue_id != depends_on_issue_id),
    -- 防止重复依赖
    UNIQUE (issue_id, depends_on_issue_id)
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_issue_workspace ON issue(workspace_id);
CREATE INDEX IF NOT EXISTS idx_issue_assignee ON issue(assignee_type, assignee_id);
CREATE INDEX IF NOT EXISTS idx_issue_status ON issue(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_issue_priority ON issue(workspace_id, priority);
CREATE INDEX IF NOT EXISTS idx_issue_parent ON issue(parent_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_due_date ON issue(due_date);
CREATE INDEX IF NOT EXISTS idx_issue_creator ON issue(creator_id);
CREATE INDEX IF NOT EXISTS idx_dependency_issue ON issue_dependency(issue_id);
CREATE INDEX IF NOT EXISTS idx_dependency_depends ON issue_dependency(depends_on_issue_id);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 issue 表
-- - 创建 issue_dependency 表

-- ==================== 测试数据清理 ====================

DELETE FROM issue_dependency WHERE issue_id IN (
    SELECT id FROM issue WHERE title LIKE 'test_%'
);
DELETE FROM issue WHERE title LIKE 'test_%';
