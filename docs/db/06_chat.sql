-- ==================== 对话功能模块 ====================
-- 模块编号：06
-- 版本：v1.0.0
-- 更新：2026-04-26

-- ==================== 表结构 ====================

-- 对话会话表
CREATE TABLE IF NOT EXISTS chat_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agent(id),
    creator_id UUID NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
    session_id TEXT,  -- Claude Session ID（用于 resume）
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 对话消息表
CREATE TABLE IF NOT EXISTS chat_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_session_id UUID NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    usage JSONB,  -- Token 用量
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== 索引 ====================

CREATE INDEX IF NOT EXISTS idx_chat_session_creator ON chat_session(creator_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_agent ON chat_session(agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_status ON chat_session(creator_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_session_session ON chat_session(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_session ON chat_message(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_created ON chat_message(chat_session_id, created_at);

-- ==================== 变更记录 ====================

-- v1.0.0 [2026-04-26] 初始版本
-- - 创建 chat_session 表
-- - 创建 chat_message 表

-- ==================== 测试数据清理 ====================

DELETE FROM chat_message WHERE chat_session_id IN (
    SELECT id FROM chat_session WHERE title LIKE 'test_%' OR title IS NULL
);
DELETE FROM chat_session WHERE title LIKE 'test_%' OR title IS NULL;
