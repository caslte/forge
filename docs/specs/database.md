# 数据库设计文档

> Kafka Web 管理工具数据库设计

---

## 概述

本项目使用 SQLite 嵌入式数据库，用于存储 Kafka 数据源配置信息。

---

## 表设计

### 表：data_sources（数据源配置）

| 字段名 | 类型 | 约束 | 说明 |
|--------|------|------|------|
| id | INTEGER | PK, AUTO_INCREMENT | 主键 |
| name | VARCHAR(100) | NOT NULL, UNIQUE | 数据源名称 |
| bootstrap_servers | VARCHAR(500) | NOT NULL | Kafka 服务器地址，多个用逗号分隔 |
| security_protocol | VARCHAR(20) | NOT NULL, DEFAULT 'SASL_SSL' | 安全协议 |
| sasl_mechanism | VARCHAR(20) | DEFAULT 'PLAIN' | SASL 机制 |
| username | VARCHAR(100) | NULL | SASL 认证用户名 |
| password | VARCHAR(255) | NULL | SASL 认证密码（加密存储） |
| truststore_location | VARCHAR(500) | NULL | TrustStore 文件路径 |
| truststore_password | VARCHAR(255) | NULL | TrustStore 密码（加密存储） |
| description | VARCHAR(500) | NULL | 描述信息 |
| status | VARCHAR(20) | NOT NULL, DEFAULT 'ACTIVE' | 状态：ACTIVE, INACTIVE, ERROR, UNAUTHORIZED |
| created_at | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| updated_at | DATETIME | NOT NULL, DEFAULT CURRENT_TIMESTAMP | 更新时间 |

### 安全协议枚举值

| 值 | 说明 |
|----|------|
| PLAINTEXT | 无加密 |
| SASL_PLAINTEXT | SASL认证，无SSL |
| SASL_SSL | SASL认证 + SSL加密 |
| SSL | 仅SSL加密 |

### SASL机制枚举值

| 值 | 说明 |
|----|------|
| PLAIN | 明文认证 |
| SCRAM-SHA-256 | SCRAM SHA-256 认证 |
| SCRAM-SHA-512 | SCRAM SHA-512 认证 |

### 状态枚举值

| 值 | 说明 |
|----|------|
| ACTIVE | 活跃，连接正常 |
| INACTIVE | 未激活 |
| ERROR | 连接错误 |
| UNAUTHORIZED | 认证失败 |

---

## 索引设计

| 索引名 | 字段 | 类型 | 说明 |
|--------|------|------|------|
| idx_name | name | UNIQUE | 名称唯一索引 |
| idx_status | status | INDEX | 状态索引 |

---

## DDL 语句

```sql
-- 创建数据源表
CREATE TABLE IF NOT EXISTS data_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    bootstrap_servers VARCHAR(500) NOT NULL,
    security_protocol VARCHAR(20) NOT NULL DEFAULT 'SASL_SSL',
    sasl_mechanism VARCHAR(20) DEFAULT 'PLAIN',
    username VARCHAR(100),
    password VARCHAR(255),
    truststore_location VARCHAR(500),
    truststore_password VARCHAR(255),
    description VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_name ON data_sources(name);
CREATE INDEX IF NOT EXISTS idx_status ON data_sources(status);
```

---

## 初始化数据

```sql
-- 默认数据源（基于 application.yml 配置）
INSERT INTO data_sources (
    name,
    bootstrap_servers,
    security_protocol,
    sasl_mechanism,
    username,
    password,
    truststore_location,
    truststore_password,
    description,
    status
) VALUES (
    'Default Cluster',
    '172.18.128.14:9092',
    'SASL_SSL',
    'PLAIN',
    'consumer',
    'cons-sec@Gd~CTrH]-sV[g]h',
    'C:\client.truststore.jks',
    'kibo2020',
    '基于 application.yml 配置的默认 Kafka 集群',
    'ACTIVE'
);
```

---

## Go 模型定义

```go
package model

import "time"

// DataSource 数据源配置模型
type DataSource struct {
    ID                  uint      `json:"id" gorm:"primaryKey;autoIncrement"`
    Name                string    `json:"name" gorm:"size:100;not null;uniqueIndex"`
    BootstrapServers    string    `json:"bootstrapServers" gorm:"size:500;not null;column:bootstrap_servers"`
    SecurityProtocol    string    `json:"securityProtocol" gorm:"size:20;not null;default:SASL_SSL;column:security_protocol"`
    SaslMechanism       string    `json:"saslMechanism" gorm:"size:20;default:PLAIN;column:sasl_mechanism"`
    Username            string    `json:"username" gorm:"size:100"`
    Password            string    `json:"-" gorm:"size:255"` // 不在JSON中暴露
    TruststoreLocation  string    `json:"truststoreLocation" gorm:"size:500;column:truststore_location"`
    TruststorePassword  string    `json:"-" gorm:"size:255;column:truststore_password"` // 不在JSON中暴露
    Description         string    `json:"description" gorm:"size:500"`
    Status              string    `json:"status" gorm:"size:20;not null;default:ACTIVE"`
    CreatedAt           time.Time `json:"createdAt" gorm:"autoCreateTime;column:created_at"`
    UpdatedAt           time.Time `json:"updatedAt" gorm:"autoUpdateTime;column:updated_at"`
}

// TableName 指定表名
func (DataSource) TableName() string {
    return "data_sources"
}
```

---

## 字段验证规则

| 字段 | 验证规则 | 错误信息 |
|------|---------|---------|
| name | 必填，1-100字符，全局唯一 | "名称不能为空" / "名称长度不能超过100字符" / "名称已存在" |
| bootstrap_servers | 必填，格式 host:port | "Bootstrap Servers不能为空" / "格式不正确" |
| security_protocol | 枚举值验证 | "安全协议值无效" |
| sasl_mechanism | 枚举值验证 | "SASL机制值无效" |
| description | 最大500字符 | "描述长度不能超过500字符" |

---

## 安全设计

1. **密码加密存储**：
   - 使用 AES 加密存储敏感字段（password, truststore_password）
   - 加密密钥从环境变量读取

2. **API 响应脱敏**：
   - 密码字段在 JSON 返回时使用 `json:"-"` 标签隐藏
   - 如需显示，返回 `******` 占位符

3. **连接字符串**：
   - 不记录完整的连接字符串日志
   - 错误日志中脱敏敏感信息

---

## 数据迁移

### 迁移文件位置

```
backend/database/migrations/
├── 001_init.up.sql    -- 创建表
└── 001_init.down.sql  -- 回滚表
```

### 迁移脚本

**001_init.up.sql**:
```sql
CREATE TABLE IF NOT EXISTS data_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    bootstrap_servers VARCHAR(500) NOT NULL,
    security_protocol VARCHAR(20) NOT NULL DEFAULT 'SASL_SSL',
    sasl_mechanism VARCHAR(20) DEFAULT 'PLAIN',
    username VARCHAR(100),
    password VARCHAR(255),
    truststore_location VARCHAR(500),
    truststore_password VARCHAR(255),
    description VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_name ON data_sources(name);
CREATE INDEX IF NOT EXISTS idx_status ON data_sources(status);
```

**001_init.down.sql**:
```sql
DROP INDEX IF EXISTS idx_status;
DROP INDEX IF EXISTS idx_name;
DROP TABLE IF EXISTS data_sources;
```

---

## 注意事项

1. **Topic 和消息不存储**：Topic 列表和消息数据通过 Kafka API 实时获取，不存储到本地数据库

2. **SQLite 限制**：单文件数据库，适合单机部署；如需多实例部署，需切换到 PostgreSQL/MySQL

3. **并发写入**：SQLite 写操作会锁定整个数据库，高并发场景需考虑使用 WAL 模式