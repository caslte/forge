# Go 单元测试模板

> 适用于 Go 项目（推荐 `testing` + `testify`）。

## 一、测试框架
- 标准库：`testing`
- 断言库：`github.com/stretchr/testify/assert`
- Mock（可选）：`github.com/stretchr/testify/mock`

## 二、测试文件组织
```text
<project-root>/internal/order/service_test.go
```

## 三、测试示例
```go
func TestCreateOrder_Success(t *testing.T) {
    repo := new(MockOrderRepo)
    svc := NewOrderService(repo)
    repo.On("Save", mock.Anything, mock.AnythingOfType("order.Order")).Return(Order{ID: 1, SKU: "A001", Quantity: 2}, nil)

    got, err := svc.Create(context.Background(), CreateOrderReq{SKU: "A001", Quantity: 2})

    assert.NoError(t, err)
    assert.Equal(t, int64(1), got.ID)
    repo.AssertExpectations(t)
}
```

## 四、注意事项
1. 避免依赖真实数据库和外部服务。
2. 测试应可重复执行，不依赖随机时间。
