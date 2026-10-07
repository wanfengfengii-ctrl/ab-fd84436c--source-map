# sourcemap-resolve-service

前端监控平台的 Source Map 堆栈还原服务：把压缩产物中的（生成行， 生成列）坐标还原为
原始源码位置。零运行时依赖，基于 Node.js 内置模块实现。

## 快速开始

```bash
# 构建并启动 API（宿主机端口由 HOST_PORT 环境变量控制，默认 8080）
HOST_PORT=8080 docker compose up --build app

# 一键验证：健康检查通过后运行 代码测试 + 生产构建校验 + 普通/分段映射冒烟，
# verify 是一次性服务，以退出码报告结果并自行退出
docker compose up --build --exit-code-from verify verify
echo $?   # 0 = 全部通过
```

本地开发（Node ≥ 18）：

```bash
npm start          # 启动 API，监听 PORT（默认 8080）
npm test           # 代码测试
npm run build      # 生产构建校验（语法/模块加载/自检 + dist 清单）
npm run smoke      # 冒烟（需 API 已在运行，API_URL 可配置）
npm run verify     # 上述全部
```

## API

### `POST /api/sourcemaps/resolve`

请求体（JSON）：

```json
{
  "sourceMap": { "version": 3, "sources": ["src/a.ts"], "names": [], "mappings": "AAAA" },
  "frames": [{ "id": "frame-1", "line": 1, "column": 0 }]
}
```

约束：

- `sourceMap`：Source Map v3 对象，序列化后不超过 **2 MiB**；支持普通 `mappings`
  与最多 **32 个内嵌 `map` 的有序 `sections`**（可嵌套，外部 `url` 分段不受支持）。
- `frames`：**1–500** 个堆栈帧；`id` 为字符串或数字且**唯一**；`line` 为**从 1 开始**
  的整数，`column` 为**从 0 开始**的整数。
- 整个请求体硬上限 3 MiB。

成功响应 `200`，结果**按请求原顺序**返回，每帧一条裁决：

```json
{
  "results": [
    { "id": "frame-1", "status": "mapped", "mapped": true,
      "source": "src/a.ts", "line": 1, "column": 0, "name": null },
    { "id": "frame-2", "status": "unmapped", "mapped": false,
      "source": null, "line": null, "column": null, "name": null }
  ]
}
```

- 裁决规则：先按分段 `offset` 换算坐标（分段首行同时换算列偏移，后续行只换算行
  偏移），再在同一生成行内选择**列号不大于目标列的最右映射段**；无候选或命中的
  是未映射段时返回 `unmapped`。
- 返回的原始 `line` 为 1 基，`column` 为 0 基；`name` 缺失时为 `null`。
- `sources` 条目按原样返回（不拼接 `sourceRoot`）。
- 服务无状态：同一合法请求重复调用返回**相同且顺序稳定**的结果。

### `GET /health`

返回 `200 {"status":"ok"}`，用于 Docker 健康检查。

## 错误响应

任何解析/校验失败都会**拒绝整个请求**（绝不返回部分结果），格式稳定：

```json
{
  "error": {
    "code": "INVALID_VLQ",
    "message": "invalid Base64 character \"!\" in VLQ sequence",
    "context": { "sectionPath": [1], "generatedLine": 3, "segmentIndex": 2 }
  }
}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_REQUEST` | 请求结构非法（含帧数量、行/列号非法），`context` 含 `frameIndex`/`id` |
| 400 | `DUPLICATE_FRAME_ID` | 帧编号重复，`context` 含 `frameIndex`/`id` |
| 404 | `NOT_FOUND` | 未知路由 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不允许 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 3 MiB |
| 413 | `SOURCE_MAP_TOO_LARGE` | `sourceMap` 超过 2 MiB |
| 422 | `INVALID_SOURCE_MAP` | 结构非法（版本、字段类型等） |
| 422 | `INVALID_VLQ` | 非法 Base64 VLQ（非法字符、截断、溢出） |
| 422 | `MALFORMED_SEGMENT` | 映射段字段数不是 1/4/5 |
| 422 | `INDEX_OUT_OF_BOUNDS` | source/name 索引或原始坐标越界 |
| 422 | `GENERATED_COLUMN_REGRESSION` | 同一行内生成列倒退（或为负） |
| 422 | `TOO_MANY_SECTIONS` | 分段数超过 32 |
| 422 | `UNSUPPORTED_SECTION_URL` | 分段使用外部 `url` 而非内嵌 `map` |
| 422 | `SECTION_OVERLAP` | 分段偏移未严格递增或生成行范围重叠 |
| 500 | `INTERNAL_ERROR` | 未预期错误 |

`context` 始终携带可定位信息：帧错误含 `frameIndex`/`id`；分段错误含
`sectionPath`（嵌套下标路径）；映射解码错误含 `generatedLine`/`segmentIndex`。

## 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `HOST_PORT` | 宿主机发布端口（compose） | `8080` |
| `PORT` | 容器/进程监听端口 | `8080` |
| `API_URL` | 冒烟/验证目标 API 地址 | `http://localhost:8080` |

## 项目结构

```
src/server.js      HTTP 层（路由、体积限制、错误序列化）
src/sourcemap.js   Source Map v3 解析（普通 + sections）、坐标裁决、请求校验
src/vlq.js         Base64 VLQ 编解码（安全整数范围保护）
src/errors.js      稳定错误码载体
test/              node:test 单元与 API 集成测试
scripts/build.js   生产构建校验（语法、模块加载、解析自检、dist 清单）
scripts/smoke.js   普通映射 + 分段映射冒烟（含确定性复查）
scripts/verify.js  一次性验证编排：测试 → 构建校验 → 冒烟，退出码报告结果
```
