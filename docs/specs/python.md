> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

# Python 语言开发规范

> Kafka Web 管理工具 Python 开发规范

---

## 项目结构

```
backend/
├── app/                      # 应用主目录
│   ├── __init__.py          # 应用初始化
│   ├── main.py              # FastAPI 应用入口
│   ├── api/                 # API 路由
│   │   ├── __init__.py
│   │   └── v1/
│   │       ├── __init__.py
│   │       ├── data_source.py
│   │       └── topic.py
│   ├── core/                # 核心配置
│   │   ├── __init__.py
│   │   ├── config.py        # 配置管理
│   │   ├── security.py      # 安全认证
│   │   └── database.py      # 数据库连接
│   ├── models/              # 数据模型
│   │   ├── __init__.py
│   │   └── data_source.py
│   ├── schemas/             # Pydantic 模型
│   │   ├── __init__.py
│   │   └── data_source.py
│   ├── services/           # 业务逻辑层
│   │   ├── __init__.py
│   │   └── data_source_service.py
│   └── repositories/       # 数据访问层
│       ├── __init__.py
│       └── data_source_repo.py
├── tests/                   # 测试目录
│   ├── __init__.py
│   ├── api/
│   ├── services/
│   └── repositories/
├── alembic/                 # 数据库迁移
├── requirements.txt         # 依赖管理
├── pyproject.toml          # 项目配置
└── .env.example            # 环境变量示例
```

---

## 命名规范

### 文件命名
- 使用小写字母 + 下划线：如 `data_source_service.py`、`user_handler.py`
- 测试文件以 `test_` 开头：如 `test_data_source_service.py`
- 工具类以 `_util.py` 结尾：如 `string_util.py`

### 类命名
- 帕斯卡命名（PascalCase），如 `DataSourceService`、`UserRepository`
- 异常类以 `Error` 或 `Exception` 结尾

### 函数命名
- 函数名：小写字母 + 下划线，如 `get_user_by_id`、`create_data_source`
- 私有函数：单下划线开头，如 `_validate_input`
- 异步函数：使用 `async def`

### 变量命名
- 变量：蛇形命名（snake_case），如 `user_name`、`bootstrap_servers`
- 常量：全大写 + 下划线，如 `MAX_RETRY_COUNT`、`DEFAULT_TIMEOUT`
- 类实例：使用小写或驼峰，如 `user_service`、`config`

### 包命名
- 全小写，如 `app`、`api`、`services`
- 避免使用 `utils`、`common` 等通用名称

---

## 代码风格（PEP 8）

### 格式化
- 使用 Black 格式化代码
- 使用 isort 排序 import
- 使用 flake8 检查代码风格

### 缩进
- 使用 4 空格缩进
- 每级缩进 4 空格

### 行长度
- 单行长度不超过 88 个字符（Black 默认）
- 过长行使用换行缩进

### 空行
- 顶级定义之间空两行
- 类方法之间空一行
- import 块之间空一行

### 注释
- 每个函数/方法都必须添加中文注释，优先使用 docstring，说明函数作用、关键入参、返回值和必要的业务意图。
- 方法内只保留关键逻辑性的中文注释，重点标注分支判断、核心计算、异常处理等位置，避免逐行冗余注释。
- 行内注释在代码后空两格 + `#`
- 文档字符串建议使用 Google 或 NumPy 风格，内容保持中文

---

## 函数规范

### 函数长度
- 函数体不超过 50 行
- 单一职责，可拆分为原子函数

### 参数规范
- 参数数量不超过 5 个
- 超过 5 个参数使用 `*args` 或 `**kwargs`
- 优先使用默认参数

### 返回值规范
- 明确返回类型注解
- 不返回 None，使用空容器替代
- 使用 Union 类型处理多种返回值

```python
from typing import Optional, List

# 正确示例
def get_user_by_id(user_id: int) -> Optional[User]:
    if user_id <= 0:
        return None
    # ...
    return user

def list_users() -> List[User]:
    # ...
    return []  # 返回空列表而非 None
```

---

## 错误处理

### 异常定义
- 自定义异常继承 `Exception` 或 `HTTPException`
- 异常类名以 `Error` 结尾

```python
class DataSourceNotFoundError(Exception):
    pass

class ValidationError(Exception):
    pass
```

### 异常捕获
- 精确捕获具体异常
- 记录完整堆栈信息
- 向上传递错误

```python
try:
    result = await repository.get_by_id(id)
except Exception as e:
    logger.error(f"Failed to get data source: {e}", exc_info=True)
    raise
```

### 日志记录
- 使用 `logging` 模块
- 日志内容统一使用英文，且建议带上方法名，格式为 `[方法名] 日志内容`
- 示例：`logger.info("[create_user] user created successfully")`
- 记录错误时包含堆栈信息
- 敏感信息（密码、token）禁止记录日志

---

## 并发规范

### 异步编程
- 使用 `async/await` 处理 I/O 密集操作
- 使用 `aiohttp` 或 `httpx` 进行异步 HTTP 请求
- 使用 `asyncio` 创建和管理协程

### 异步与同步
- 异步函数必须使用 `async def`
- 同步代码调用异步代码使用 `run_in_executor`
- 数据库操作使用异步驱动（如 `asyncpg`、`aiomysql`）

### 并发安全
- 使用 `asyncio.Lock` 保护共享资源
- 避免全局可变状态
- 使用线程池处理 CPU 密集型任务

---

## 数据库操作

### ORM 使用
- 使用 SQLAlchemy（同步或异步）
- 使用 Pydantic 模型验证数据

### SQL 安全
- 禁止 SQL 拼接，必须使用参数化查询
- 使用 ORM 的查询构建器

### 连接管理
- 使用连接池
- 异步操作使用异步连接

---

## 测试规范

### 测试框架
- 使用 `pytest`
- 使用 `pytest-asyncio` 测试异步代码
- 使用 `httpx` 进行 API 测试

### 测试命名
- 测试文件以 `test_` 开头
- 测试函数以 `test_` 开头
- 命名格式：`test_function_scenario`

```python
def test_get_user_by_id_success():
    # ...
    pass

@pytest.mark.asyncio
async def test_create_data_source():
    # ...
    pass
```

### Mock 使用
- 使用 `unittest.mock`
- 使用 `pytest-mock`
- Mock 外部依赖

### 覆盖率
- Service 层测试覆盖率 ≥ 70%
- 关键路径必须有测试覆盖

---

## API 规范

### 框架
- 使用 FastAPI
- 使用 OpenAPI 自动生成文档

### 路由定义
- 使用 RESTful 风格
- 路由使用小写字母 + 连字符

```python
@router.get("/data-sources", response_model=List[DataSourceSchema])
async def list_data_sources():
    # ...

@router.post("/data-sources", response_model=DataSourceSchema)
async def create_data_source(schema: DataSourceCreateSchema):
    # ...
```

### 请求验证
- 使用 Pydantic 模型验证请求参数
- 定义清晰的错误消息

### 响应格式
```python
from typing import Generic, TypeVar

T = TypeVar("T")

class Response(BaseModel, Generic[T]):
    code: int
    message: str
    data: Optional[T] = None
```

---

## 依赖管理

### requirements.txt
```
fastapi==0.104.1
uvicorn==0.24.0
sqlalchemy==2.0.23
pydantic==2.5.0
# ... 其他依赖
```

### pyproject.toml
```toml
[tool.poetry]
name = "kafka-tools-backend"
version = "0.1.0"
description = "Kafka Web Management Tool"

[tool.poetry.dependencies]
python = "^3.10"
fastapi = "^0.104.1"
# ...
```

### 环境管理
- 使用 virtualenv 或 venv
- 使用 Poetry 或 Pipenv 管理依赖

---

## 安全规范

### 认证授权
- 接口必须做权限校验
- 使用 JWT 或 OAuth2
- 敏感操作记录审计日志

### 密码存储
- 密码必须哈希存储
- 使用 bcrypt 或 argon2

### 输入验证
- 验证所有用户输入
- 防止 SQL 注入（使用 ORM）
- 防止 XSS（Pydantic 自动转义）

---

## 配置管理

### 配置文件
- 使用 YAML 或 .env 文件
- 敏感配置使用环境变量
- 使用 Pydantic Settings

### 环境变量
```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    secret_key: str

    class Config:
        env_file = ".env"
```

---

## 日志规范

### 日志配置
- 使用结构化日志
- 配置合适的日志级别
- 使用 JSON 格式便于分析

### 记录时机
- 入口日志：方法开始记录参数
- 出口日志：方法正常返回记录结果
- 异常日志：捕获异常必须记录，含完整堆栈

---

## 类型注解

### 类型提示
- 必须使用类型注解
- 使用 `Optional`、`List`、`Dict` 等
- 复杂类型使用 TypeVar

```python
from typing import Optional, List, Dict, TypeVar

T = TypeVar("T")

def process_items(items: List[T]) -> Dict[str, T]:
    # ...
```

---

## 性能优化

### 缓存
- 合理使用缓存
- 设置缓存过期时间
- 使用 Redis

### 数据库优化
- 使用索引优化查询
- 批量操作减少数据库往返
- 使用预编译语句

### 异步
- I/O 密集操作使用异步
- 避免阻塞事件循环
