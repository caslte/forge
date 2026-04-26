-- ==================== 工作空间模块 ====================
-- 模块编号：01
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 工作空间表
CREATE TABLE IF NOT EXISTS workspace (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    repos JSONB NOT NULL DEFAULT '[]',  -- 仓库配置数组
    settings JSONB NOT NULL DEFAULT '{}',  -- 工作空间设置
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_workspace_name ON workspace(name);

-- ==================== repos JSONB 结构 ====================
-- repos 字段结构示例：
-- [
--   {
--     "id": "uuid",
--     "url": "https://github.com/user/repo.git",
--     "local_path": "~/projects/myrepo",
--     "branch": "main",
--     "status": "active"
--   }
-- ]

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 workspace 表

-- ==================== 测试数据清理 ====================

DELETE FROM workspace WHERE name LIKE 'test_%';
