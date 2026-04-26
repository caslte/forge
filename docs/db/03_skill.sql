-- ==================== 技能管理模块 ====================
-- 模块编号：03
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 技能表
CREATE TABLE IF NOT EXISTS skill (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    content TEXT NOT NULL,  -- SKILL.md 内容
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 技能附件文件表
CREATE TABLE IF NOT EXISTS skill_file (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    path TEXT NOT NULL,  -- 相对于技能目录的路径
    content TEXT NOT NULL,  -- 文件内容
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (skill_id, path)  -- 同一技能下路径唯一
);

-- ==================== 索引 ====================

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_name ON skill(name);
CREATE INDEX IF NOT EXISTS idx_skill_file_skill ON skill_file(skill_id);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 skill 表
-- - 创建 skill_file 表

-- ==================== 测试数据清理 ====================

DELETE FROM skill_file WHERE skill_id IN (
    SELECT id FROM skill WHERE name LIKE 'test_%'
);
DELETE FROM skill WHERE name LIKE 'test_%';
