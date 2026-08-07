# Java 单元测试模板

> 用于指导 Agent 生成可编译、可维护、可回归的单元测试。

---

## 一、适用范围

- 后端：Java（JUnit 5 + Mockito + AssertJ）
- 前端：Vue（Vitest + @vue/test-utils）

默认以后端 Java 为主，前端按项目技术栈选用。

---

## 二、测试目录规范（Java）

```text
<project-root>/
├── src/main/java/
└── src/test/java/
    └── com/example/app/
        ├── service/
        ├── controller/
        └── util/
```

---

## 三、测试编写规范

1. 命名：`should_xxx_when_xxx`
2. 结构：Given / When / Then
3. 覆盖：正常路径 + 异常路径 + 边界条件
4. 依赖：只 Mock 外部依赖，不 Mock 被测对象本身
5. 断言：默认使用 AssertJ，异常可配合 JUnit `assertThrows`

---

## 四、Service 层示例（Java）

```java
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    @Mock
    private OrderRepository orderRepository;

    @InjectMocks
    private OrderService orderService;

    @Test
    void should_create_order_when_request_valid() {
        CreateOrderRequest request = new CreateOrderRequest("A001", 2);
        Order saved = new Order(1L, "A001", 2);
        when(orderRepository.save(any(Order.class))).thenReturn(saved);

        Order result = orderService.create(request);

        assertThat(result)
            .isNotNull()
            .extracting(Order::getId, Order::getSku, Order::getQuantity)
            .containsExactly(1L, "A001", 2);
        verify(orderRepository).save(any(Order.class));
    }

    @Test
    void should_throw_exception_when_quantity_invalid() {
        CreateOrderRequest request = new CreateOrderRequest("A001", 0);

        BusinessException ex = assertThrows(BusinessException.class,
            () -> orderService.create(request));

        assertThat(ex.getMessage()).contains("quantity");
        verify(orderRepository, never()).save(any(Order.class));
    }
}
```

---

## 五、场景表模板（通用）

| 场景 | 输入 | 预期输出 | 断言建议 |
|------|------|----------|----------|
| 正常创建 | 合法参数 | 返回对象并持久化 | `assertThat(result).isNotNull()` + `verify(repo).save(...)` |
| 参数为空 | 关键字段为空 | 抛出业务异常 | `assertThrows(...)` + 校验异常消息 |
| 边界值 | 最大/最小值 | 按规则处理 | 精确断言返回值或状态 |
| 外部依赖异常 | repository 抛错 | 服务层按约定转换异常 | 校验异常类型与消息 |

---

## 六、Mock 规范（Java）

```java
@Mock
private OrderRepository orderRepository;

when(orderRepository.findById(1L)).thenReturn(Optional.of(order));
verify(orderRepository).findById(1L);
verify(orderRepository, never()).deleteById(anyLong());
```

静态方法仅在无法重构依赖时使用：

```java
try (MockedStatic<IdGenerator> mocked = Mockito.mockStatic(IdGenerator.class)) {
    mocked.when(IdGenerator::next).thenReturn("ID-001");
    // test...
}
```

---

## 七、覆盖率建议

| 层级 | 最低覆盖率 |
|------|------------|
| Service 层 | >= 80% |
| Util 层 | >= 90% |
| Controller 层 | >= 60% |

---

## 八、运行测试命令（Maven 项目）

```bash
# 生产打包（默认跳过测试）
mvn clean package

# 运行测试（必须显式指定 -Dmaven.test.skip=false）
mvn test -pl <模块名> -Dmaven.test.skip=false

# 运行特定测试类
mvn test -pl <模块名> -Dtest=*Test -Dmaven.test.skip=false

# 生成覆盖率报告
mvn test jacoco:report -pl <模块名> -Dmaven.test.skip=false
```

**说明**：
- `<模块名>` 替换为实际模块名称
- 项目默认配置为跳过测试（`skipTests=true`），这是**生产构建安全**的配置
- **不要修改 pom.xml 来启用测试**，只需在命令中添加 `-Dmaven.test.skip=false` 参数

---

## 九、注意事项

1. 测试代码必须可编译，不使用伪代码式断言（如 `result.status`、`result.size`）。
2. `verify` 写法必须为 `verify(mock).method(...)`。
3. 避免业务域强绑定示例，优先用可复用的通用示例。
4. 时间相关测试优先使用可注入时钟或固定时间，避免随机失败。

