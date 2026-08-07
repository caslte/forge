
> This file extends [common/coding-style.md](../common/coding-style.md) with Java specific content.

请生成符合下面规范、可直接投入生产环境的高质量 Java 代码：
- 类名、文件名：帕斯卡命名（PascalCase），如 UserInfo
- 方法、变量、参数：驼峰命名（camelCase），如 getUser, userName
- 常量：全大写 + 下划线，如 MAX_COUNT，并用 final static 修饰
- 包名：全小写，如 com.ali.user.service
- 抽象类以 Abstract 或 Base 开头；
- 异常类以 Exception 结尾；测试类以 Test 结尾，方法名体现场景
- 构造方法 ≤3 个，参数多时用 Builder 模式
- 禁止返回 null 集合/数组，无数据时返回 Collections.emptyList() 或 new T[0]
- 方法参数 ≤5 个，超限时封装为 DTO
- 方法体 ≤80 行，单一职责，可拆分为原子方法
- 优先组合而非继承，继承需符合里氏替换原则
- 工具类构造私有化，方法全静态
- 初始化时指定容量（ArrayList、HashMap），HashMap 容量为 2 的幂
- 遍历时禁止在循环内增删元素，用 Iterator 或 Stream.filter
- 必须使用泛型，禁止原始类型（如 List 而非 List<String>）
- 多线程下禁用 ArrayList/HashMap，改用 CopyOnWriteArrayList/ConcurrentHashMap
- 不可对 Collections.emptyList() 执行 add 操作
- 线程池必须手动创建，指定核心线程数、最大线程数、队列容量（避免 Executors）
- 共享变量需保证可见性（volatile）和原子性（AtomicX 或 synchronized）
- synchronized 锁范围最小化，优先锁代码块而非整个方法
- finally 块中禁止修改返回值
- 捕获异常后必须记录日志（含异常栈），并合理封装抛出（如 BusinessException）
- 自定义异常继承 RuntimeException，避免 checked 异常
- Dto/Vo/Entity 等后缀明确语义
- 避免魔法值，用常量替代
- 对象的引用不要直接写在方法签名或注解里，比如 `@Validated(ExampleRequest.Action.class) ExampleRequest request`，应从文件顶部 import 后再使用
- MyBatis XML使用运算符时，需要用 CDATA 包裹，避免 XML 解析错误
- 引用类时，非特殊情况必须在文件顶部统一 import，不要在方法体、注解或表达式中直接写全限定类名；仅在类名冲突、静态常量或少数特殊场景下例外

## 注释规范
- 每个方法都必须写中文注释，方法级注释优先使用 Javadoc，说明方法作用、入参、返回值和必要的业务意图。
- 方法内只保留关键逻辑性的中文注释，重点标注分支判断、核心计算、异常处理等位置，避免逐行冗余注释。

## 日志规范
- 必须使用 SLF4J/Log4j2，禁止直接使用 System.out/err
- 日志级别：ERROR（错误）、WARN（警告）、INFO（信息）、DEBUG（调试）
- 日志内容统一使用英文，且建议带上方法名，格式为 `[方法名] 日志内容`
- 入口日志：方法开始时记录参数 `log.info("[createUser] param: {}", param)`
- 出口日志：方法正常返回时记录结果 `log.info("[createUser] result: {}", result)`
- 异常日志：捕获异常必须记录，含完整堆栈 `log.error("[createUser] error", e)`
- 敏感数据（密码、token）禁止记录日志
- 生产环境禁止使用 log.debug()

## Swagger/OpenAPI 规范
- Controller 类必须添加 @Tag(name = "模块名") 注解
- 接口方法必须添加 @Operation(summary = "接口描述") 注解
- 参数必须使用 @Parameter(description = "参数说明") 注解
- DTO 字段必须使用 @Schema(description = "字段说明") 注解
- 枚举类型必须使用 @Schema(description = "枚举说明") 标注各枚举值

## 测试规范
- 核心业务逻辑必须编写单元测试（JUnit 5 + AssertJ）
- Service 层测试覆盖率 ≥ 70%
- Controller 层测试覆盖率 ≥ 50%
- 测试类命名：XxxServiceTest、XxxControllerTest
- 测试方法命名：should_xxx_when_xxx 格式
- Mock 外部依赖（数据库、第三方API）
- 测试数据必须可重复构造（@BeforeEach）
- 禁止在测试中访问真实外部资源

## 安全编码规范
- 禁止 SQL 拼接，必须使用 #{} 参数化查询
- 禁止直接反射调用任意方法
- 文件上传必须校验文件类型（MIME + 扩展名）
- 文件路径禁止使用用户输入（防止路径遍历）
- 敏感操作（删、改）必须记录审计日志
- 禁止硬编码密钥，配置中心读取
- 接口必须做权限校验（Shiro/Spring Security）
- 跨域配置（Cors）禁止使用 `allowCredentials = true` + `allowedOrigins = "*"`

## MyBatis 规范
- Mapper 接口统一命名为 `XxxMapper.java`
- 对应 SQL 统一写在 `XxxMapper.xml`
- `XxxMapper.java` 与 `XxxMapper.xml` 一一对应，且尽量放在同目录
- SQL 语句必须有注释说明用途
- 批量操作使用 `<foreach>`，并设置 batchSize
- 禁止在 SQL 中使用 MyBatis 内置别名（如 `#{param1}`）
- 查询结果字段必须与实体类属性一一对应
- 分页查询统一使用 PageHelper 或物理分页

## 异常处理规范
- 统一异常码枚举：`ErrorCodeEnum`
- 业务异常使用 `BusinessException(ErrorCodeEnum.XXX)`
- 全局异常处理器 `@RestControllerAdvice` 捕获
- 禁止吞掉异常，必须记录或抛出
- 禁止在 finally 块中 return
- 异步方法禁止抛出受检异常
