# Python 单元测试模板

> 适用于 Python 项目（推荐 `pytest` + `unittest.mock`）。

## 一、测试框架
- 测试框架：`pytest`
- Mock：`unittest.mock` 或 `pytest-mock`
- 覆盖率：`pytest-cov`

## 二、测试文件组织
```text
<project-root>/tests/services/test_order_service.py
```

## 三、测试示例
```python
import pytest
from unittest.mock import Mock


def test_create_order_success():
    repo = Mock()
    repo.save.return_value = {"id": 1, "sku": "A001", "quantity": 2}
    service = OrderService(repo)

    result = service.create(CreateOrderReq(sku="A001", quantity=2))

    assert result["id"] == 1
    repo.save.assert_called_once()


def test_create_order_invalid_quantity():
    repo = Mock()
    service = OrderService(repo)

    with pytest.raises(ValueError, match="quantity"):
        service.create(CreateOrderReq(sku="A001", quantity=0))
```

## 四、注意事项
1. 使用 fixture 复用测试数据。
2. 单测不访问真实外部系统。
