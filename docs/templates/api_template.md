# API 接口文档模板

> 每个 API 接口文档应包含以下部分

---

## 接口名称

```
METHOD /api/v1/xxx
```

**说明**：接口用途描述

**认证**：需要/不需要

---

## 请求参数

### 路径参数
| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| param1 | number | 是 | 参数说明 |

### Query 参数
| 参数名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| page | number | 否 | 1 | 页码 |
| limit | number | 否 | 20 | 每页条数 |

---

## 请求体

（若无请求体则省略此节）

```json
{
  "field1": "值1",
  "field2": 123
}
```

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| field1 | string | 是 | 字段说明 |
| field2 | number | 否 | 字段说明 |

---

## 响应

### 成功响应

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "name": "示例"
  }
}
```

### 错误响应

```json
{
  "code": 400,
  "message": "错误说明",
  "data": null
}
```

---

## 类型定义

```typescript
interface ResponseData {
  id: number;
  name: string;
}
```

---

## 错误码

| code | 说明 |
|------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未登录 |
| 404 | 资源不存在 |

---

## 注意事项

1. 所有接口统一响应格式参考 `docs/api/common.md`
2. 分页接口统一使用 `page` 和 `limit` 参数
3. 认证方式：`Authorization: Bearer <token>`
4. 日期格式：`YYYY-MM-DD`，日期时间格式：`YYYY-MM-DDTHH:mm:ssZ`
