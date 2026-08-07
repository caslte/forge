> This file extends [common/coding-style.md](../common/coding-style.md) with Go specific content.

# Go 语言开发规范

> Kafka Web 管理工具 Go 语言开发规范

---

## 项目结构

```
backend/
├── cmd/                      # 应用入口
│   └── server/
│       └── main.go          # 主程序入口
├── internal/                 # 内部包（不可被外部导入）
│   ├── config/              # 配置管理
│   ├── handler/             # HTTP 处理器
│   ├── middleware/          # 中间件
│   ├── model/               # 数据模型
│   ├── repository/          # 数据访问层
│   ├── service/             # 业务逻辑层
│   └── router/              # 路由定义
├── pkg/                     # 可被外部导入的包
│   ├── utils/               # 工具函数
│   └── errors/              # 错误定义
├── migrations/              # 数据库迁移
├── config.yaml              # 配置文件
└── go.mod                   # 依赖管理
```

---

## 命名规范

### 文件命名
- 使用小写字母 + 下划线：如 `user_service.go`、`data_source_handler.go`
- 测试文件以 `_test.go` 结尾：如 `user_service_test.go`
- 工具类以 `_util.go` 结尾：如 `string_util.go`

### 函数命名
- 公开函数（导出）：帕斯卡命名（PascalCase），如 `GetUserByID`、`CreateDataSource`
- 私有函数（非导出）：小写字母开头 + 驼峰，如 `getUserByID`、`createDataSource`

### 变量命名
- 变量：驼峰命名，如 `userName`、`bootstrapServers`
- 常量：全大写 + 下划线，如 `MAX_RETRY_COUNT`、`DEFAULT_TIMEOUT`
- 枚举：全大写 + 下划线，如 `StatusActive`、`ProtocolSASL`

### 包命名
- 全小写，如 `config`、`handler`、`repository`
- 简洁明了，避免使用 `utils`、`common` 等通用名称

---

## 代码风格

### 格式化
- 必须使用 `go fmt` 或 `gofmt` 格式化代码
- 推荐使用 `goimports` 自动管理 import

### 缩进和空格
- 使用 Tab 缩进
- 函数之间空一行
- import 块之间空一行

### 行长度
- 单行长度不超过 100 个字符
- 过长行使用换行缩进

### 注释
- 每个函数/方法都必须添加中文注释，说明函数功能、关键入参、返回值和必要的业务意图。
- 方法内只保留关键逻辑性的中文注释，重点标注分支判断、核心计算、异常处理等位置，避免逐行冗余注释。
- 注释内容尽量以被注释对象的名称开头，便于检索和维护。
- 示例：`// GetUserByID 根据用户ID获取用户信息`

---

## 函数规范

### 函数长度
- 函数体不超过 50 行
- 单一职责，可拆分为原子方法

### 参数规范
- 参数数量不超过 5 个
- 超过 5 个参数封装为结构体
- 优先使用结构体指针传递

### 返回值规范
- 有多个返回值时，必须命名返回值
- 错误必须作为最后一个返回值
- 不返回 nil 切片/映射，返回空切片 `[]T{}` 或空映射 `map[K]V{}`

```go
// 正确示例
func GetUserByID(id uint) (*User, error) {
    if id == 0 {
        return nil, errors.New("invalid id")
    }
    // ...
    return &user, nil
}

// 错误示例
func GetUserByID(id uint) (*User, error) {
    // ...
    return nil, nil // 不要返回 nil 错误
}
```

---

## 错误处理

### 错误返回
- 错误必须返回给调用者
- 使用自定义错误类型封装业务错误

```go
// 定义错误
var (
    ErrUserNotFound    = errors.New("user not found")
    ErrInvalidPassword = errors.New("invalid password")
)

// 使用 fmt.Errorf 添加上下文
if err != nil {
    return nil, fmt.Errorf("get user by id %d: %w", id, err)
}
```

### 错误检查
- 必须检查所有错误
- 禁止忽略错误（使用 `_` 变量除外）

```go
// 正确
result, err := doSomething()
if err != nil {
    return err
}

// 错误
result, _ := doSomething() // 不要忽略错误
```

### 日志记录
- 使用结构化日志，如 `zerolog`、`zap`
- 日志内容统一使用英文，且建议带上方法名，格式为 `[方法名] 日志内容`
- 示例：`log.Infof("[CreateUser] user created successfully")`
- 记录错误时包含堆栈信息
- 敏感信息（密码、token）禁止记录日志

---

## 并发规范

### 协程管理
- 协程必须有明确的退出机制
- 使用 `context` 传递取消信号
- 避免协程泄漏

```go
func worker(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            return // 优雅退出
        case job := <-jobs:
            process(job)
        }
    }
}
```

### 共享数据
- 使用通道（Channel）进行协程间通信
- 使用 `sync.Mutex` 保护共享数据
- 优先使用原子操作（sync/atomic）

### 线程安全
- 线程安全类型：使用 `sync.Map`、`sync.RWMutex`
- 禁止在读写之间存在空窗

---

## 数据库操作

### ORM 使用
- 使用 GORM 或其他 ORM 框架
- 使用结构体标签定义字段映射
- 使用事务确保数据一致性

### SQL 安全
- 禁止 SQL 拼接，必须使用参数化查询
- 使用 ORM 的 `Where` 方法而非原生 SQL

### 连接池
- 配置合理的连接池大小
- 设置连接超时

---

## 测试规范

### 单元测试
- 核心业务逻辑必须编写单元测试
- 测试文件与被测试文件同目录
- 使用 `testing` 包

### 测试命名
- 测试函数以 `Test` 开头
- 命名格式：`Test函数名_场景`

```go
func TestGetUserByID_Success(t *testing.T) {
    // ...
}

func TestGetUserByID_NotFound(t *testing.T) {
    // ...
}
```

### Mock 使用
- 使用接口 + mock 实现依赖注入
- 使用 `testify/mock` 或 `golang/mock`

### 覆盖率
- Service 层测试覆盖率 ≥ 70%
- 关键路径必须有测试覆盖

---

## API 规范

### 路由定义
- 使用 RESTful 风格
- 路由使用小写字母 + 连字符

```go
router.GET("/api/v1/data-sources", handler.ListDataSources)
router.POST("/api/v1/data-sources", handler.CreateDataSource)
```

### 请求处理
- 使用结构体绑定请求参数
- 验证必填字段
- 返回统一的 JSON 响应格式

### 响应格式
```go
type Response struct {
    Code    int         `json:"code"`
    Message string      `json:"message"`
    Data    interface{} `json:"data,omitempty"`
}
```

---

## 配置管理

### 配置文件
- 使用 YAML 格式配置文件
- 敏感配置使用环境变量
- 提供配置默认值

### 环境变量
- 必填配置在启动时检查
- 环境变量命名：`项目名_配置项`

---

## 安全规范

### 认证授权
- 接口必须做权限校验
- 使用
- 敏感 JWT 或 Session操作记录审计日志

### 加密存储
- 密码等敏感信息必须加密存储
- 使用 AES 加密

### 输入验证
- 验证所有用户输入
- 防止 SQL 注入、XSS

---

## 依赖管理

### go.mod
- 使用 `go mod` 管理依赖
- 定期更新依赖
- 禁止使用 `go get` 直接修改 go.mod

### 依赖版本
- 使用语义化版本
- 锁定关键依赖版本

---

## 性能优化

### 内存优化
- 预分配切片容量
- 使用对象池（sync.Pool）

### 数据库优化
- 使用索引优化查询
- 批量操作减少数据库往返
- 使用预编译语句

### 缓存
- 合理使用缓存
- 设置缓存过期时间
