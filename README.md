# sourcemap-resolve

将前端压缩产物中的生产堆栈坐标（生成行/列）还原为源码位置的 HTTP 服务。
零运行时依赖，仅使用 Node.js 内置能力（`node:http`、`node:test`、全局 `fetch`），
严格实现 Source Map v3 的普通 `mappings` 与最多 32 个内嵌 `sections` 两种形态。

## 解析与裁决规则

- 目标生成行内，选择**生成列不大于目标列的最右映射段**（二分查找）。
- 1 字段段是显式“无映射”标记：命中它（或该行无任何段、目标列在首段之前）
  一律返回 `unmapped`，不会错误地回退到更早的段。
- 普通映射：原始行按规范为 0-based，对外以 **1-based** 返回；原始列保持 **0-based**。
- `sections`：按 `(offset.line, offset.column)` 字典序二分选中目标坐标所属分段，
  再把全局坐标换算为分段内局部坐标。
  - 分段首行：局部列 = 全局列 − `offset.column`；
  - 分段后续行：列不再平移（局部列从全局列 0 重新开始）。
- 解析在处理任何帧之前**整体完成**：任意非法内容都以稳定错误码拒绝整个请求，
  绝不返回部分结果。解析与裁决均为纯函数，重复调用结果逐字节一致。

## 快速开始（Docker Compose）

宿主机端口由环境变量 `HOST_PORT` 配置（默认 8080）：

```bash
cp .env.example .env          # 按需修改 HOST_PORT
docker compose up --build -d api
curl -s http://localhost:${HOST_PORT:-8080}/health
```

### 一次性 verify 服务

`verify` 服务等待 `api` 容器健康检查通过后，依次运行：

1. 单元/集成代码测试（`node --test`）
2. 生产构建校验（语法检查 + 生产模块端到端解析）
3. 普通映射与分段映射的 HTTP 冒烟测试（含幂等校验与错误拒绝校验）

并以自身退出码报告结果后退出：

```bash
docker compose up --build --abort-on-container-exit --exit-code-from verify
echo "verify exit code: $?"
```

## 本地开发

```bash
node --version        # 需要 Node.js >= 20（开发使用 22）

npm test              # 全部单元/HTTP 集成测试
node scripts/build-check.js   # 生产构建校验

# 终端 A
PORT=8080 npm start
# 终端 B
PORT=8080 node scripts/smoke.js
```

## API

### `GET /health`

返回 `200 {"status":"ok"}`，供容器健康检查与 `verify` 等待就绪使用。

### `POST /api/sourcemaps/resolve`

请求体为 JSON，整体不超过 **2 MiB**：

```json
{
  "sourceMap": { "version": 3, "sources": ["src/app.ts"], "names": ["bootstrap"],
                 "mappings": "AAAAA;AACA" },
  "frames": [
    { "id": "frame-1", "line": 1, "column": 0 }
  ]
}
```

- `frames` 数量：**1 ～ 500**；`id`（字符串或数字）在请求内唯一。
- `line`：**1-based** 生成行；`column`：**0-based** 生成列。

成功 `200`，结果按请求原顺序返回：

```json
{
  "results": [
    {
      "id": "frame-1",
      "frame": { "line": 1, "column": 0 },
      "status": "mapped",
      "result": { "source": "src/app.ts", "line": 12, "column": 9, "name": "bootstrap" }
    },
    {
      "id": "frame-2",
      "frame": { "line": 2, "column": 99 },
      "status": "unmapped"
    }
  ]
}
```

分段映射命中时额外带 `"section": <0-based 分段序号>`。`name` 字段仅在映射段
引用 `names` 时出现；`source` 为 `null` 表示该源在 `sources` 中是匿名条目。
设置了 `sourceRoot` 时，相对源路径会拼接前缀，绝对 URL / 根路径 / `//` 协议相对
路径保持原样。

### 错误响应

```json
{ "error": { "code": "VLQ_INVALID", "message": "Illegal Base64 VLQ character \"=\"",
             "context": { "section": 1, "generatedLine": 0, "segmentIndex": 1,
                          "character": "=", "offset": 5 } } }
```

`context` 给出可定位的帧（`frameIndex`/`id`/`field`）或分段
（`section`/`generatedLine`/`segmentIndex`）上下文。

| code | 含义 |
| --- | --- |
| `PAYLOAD_TOO_LARGE` | 请求体超过 2 MiB（HTTP 413） |
| `REQUEST_INVALID` | 非 JSON 对象、缺少 `sourceMap`、非法 JSON |
| `FRAMES_INVALID` | `frames` 非数组或数量不在 1～500 |
| `FRAME_INVALID` | 帧结构非法，或 `line < 1` / `column < 0` |
| `FRAME_DUPLICATE_ID` | 帧 `id` 重复 |
| `SOURCEMAP_INVALID` | 非 v3 对象、字段类型错误、同时含 `sections` 与 `mappings` 等 |
| `SOURCEMAP_VERSION_UNSUPPORTED` | `version` 不是 3 |
| `VLQ_INVALID` | 非法 Base64 字符、悬挂的续位、超出 32 位范围 |
| `SEGMENT_INVALID_LENGTH` | 段字段数不是 1/4/5 |
| `INDEX_OUT_OF_BOUNDS` | 累积后的 source/name 索引越界（`context.indexKind`） |
| `GENERATED_COLUMN_REGRESSED` | 负的列增量或同行生成列非严格递增（错误的 VLQ 累计值） |
| `ORIGINAL_COORDINATE_INVALID` | 累积后的原始行/列为负 |
| `SECTIONS_LIMIT_EXCEEDED` | 内嵌分段超过 32 个 |
| `SECTIONS_NOT_ORDERED` | 分段偏移未严格排序或分段重叠 |
| `SECTION_INVALID` | 分段结构/偏移非法、缺少内嵌 `map` |
| `EXTERNAL_SECTION_UNSUPPORTED` | 分段通过外部 `url` 引用（不支持） |
| `NESTED_SECTIONS_UNSUPPORTED` | 分段的内嵌 `map` 仍是 indexed map |
| `METHOD_NOT_ALLOWED` / `NOT_FOUND` | 路由错误（405/404） |

## 目录结构

```
src/
  errors.js    稳定错误码与错误响应
  vlq.js       严格 Base64 VLQ 解码
  parser.js    v3 解析：mappings / sections、全部合法性校验
  resolver.js  分段选择、坐标换算、最右段二分查找与裁决
  app.js       HTTP 路由、2 MiB 限制、帧校验
  server.js    启动入口（PORT 环境变量）
scripts/       生产构建校验、冒烟测试、VLQ 构造工具
test/          node:test 单元与 HTTP 集成测试
Dockerfile, docker-compose.yml, .env.example
```
