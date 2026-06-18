---
name: pounding-ozon-assistant
description: |
  1688 → Ozon 全链路。跟卖、新上架、变体合并、翻新、选品找货源、制图。
---

# pounding-ozon-assistant

## 云端 Webhook 映射

每个 Worker 对应不同的云端 webhook，不要混用：

| Worker | 业务             | Webhook 路径                                          | 说明                                   |
| ------ | ---------------- | ----------------------------------------------------- | -------------------------------------- |
| A      | 1688→Ozon 新上架 | `pl-v3-304140`                                        | 完整 8 阶段管线（类目→属性→制图→上传） |
| B      | Ozon 跟卖        | `fs-v4-303992`                                        | import-by-sku                          |
| C      | Ozon 翻新        | `re-v2-304020` + `mx-bp2-377417`                      | Ozon update + 制图                     |
| D      | 多SKU变体        | `v2-ingest-292201` + `pl-v3-304140` + `mx-bp2-377417` | 类目匹配 + 管线 + 制图                 |
| E      | 智能选品         | 无（本地搜索后进入 Worker A）                         | 1688 搜索 → 用户选品 → Worker A        |

> **接口稳定约定**：云端更新工作流内部逻辑时，webhook 路径和信封格式保持不变，Skills 无需修改即可吃到更新。

## 配置

| 凭据               | 层级   | 来源                                                  | Worker 需要 |
| ------------------ | ------ | ----------------------------------------------------- | ----------- |
| `MXOU_TOKEN`       | 分发级 | `~/.pounding/config.json` → `api.key`（云端鉴权）     | A, B, C, D  |
| `MXOU_IMAGE_TOKEN` | 分发级 | `~/.pounding/config.json` → `api.key`（制图，同 key） | A, B, C, D  |
| `ALI_1688_AK`      | 用户级 | `.env` 或环境变量                                     | A, B        |
| `OZON_CLIENT_ID`   | 用户级 | `.env` 或环境变量                                     | A, B, C, D  |
| `OZON_API_KEY`     | 用户级 | `.env` 或环境变量                                     | A, B, C, D  |

- **分发级凭证**（`MXOU_TOKEN`、`MXOU_IMAGE_TOKEN`）都来自 `~/.pounding/config.json` 的 `api.key`——制图和鉴权用同一个 mxou API key，随 Skill 分发给用户，**绝不写入 `.env`**。
- **用户级凭证**（`ALI_1688_AK`、`OZON_CLIENT_ID`、`OZON_API_KEY`）由 AI 助手写入 `.env` 持久化，下次对话自动加载。
- 用户说"设置 XXX=yyy"→ 写入 `.env` → 告知"已保存到 .env ✅"。
- 用户说"查看配置"→ `check_config()` 列出缺失和已配置项。
- **严禁硬编码凭据。Step 1 缺任何一项立即停止，列出缺失项。**

## CDP 浏览器采集

1688 API 返回文字属性但**不返回图片URL、重量、尺寸**。用 `enrich_product_with_cdp()` 补齐——**一个函数搞定所有场景**（没装 Chrome、没登录、探针失败），绝不崩溃：

```python
from scripts.lib.ak_1688_client import enrich_product_with_cdp

enriched = enrich_product_with_cdp(detail_url=item['detailUrl'], api_data=d)
# 返回 {ok, degraded, degraded_reason, user_action, data: {images, weight_grams, ...}}
# data 永远不为空——degraded 时 images/weight_grams 为空列表/None
# user_action 不为 None 时直接告诉用户那句话即可
```

## 关键函数返回值速查

**必须按返回值类型调用，不要自己猜测嵌套结构！**

| 函数                                    | 模块             | 返回值                          | 关键字段                                                                              |
| --------------------------------------- | ---------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| `check_config()`                        | `config_store`   | `dict`                          | `missing: list`, `present: list`, `by_tier: dict`                                     |
| `search_products(query, page_size=N)`   | `ak_1688_client` | `list[dict]` **← 直接是列表！** | 每个元素: `title`, `price`, `itemId`, `detailUrl`                                     |
| `get_product_details(item_ids)`         | `ak_1688_client` | `dict[str, dict]`               | `{item_id: {title, price, categories, sku_attributes, all_info}}`                     |
| `search_categories_locally(query, ...)` | `cloud_client`   | `list[dict]`                    | 每个元素: `description_category_id`, `type_id`, `category_name`, `type_name`, `score` |
| `build_envelope(...)`                   | `cloud_client`   | `dict`                          | `version, project_id, source, assets, draft, extensions`                              |
| `submit_envelope(envelope)`             | `cloud_client`   | `dict`                          | `task_id, status, category_resolution`                                                |
| `submit_task(envelope)`                 | `cloud_client`   | `dict`                          | `task_id, status, stages, final_summary`                                              |
| `generate_product_images(token, ...)`   | `cloud_client`   | `dict`                          | `{slot: url}`                                                                         |
| `follow_sell_cloud(sku=..., ...)`       | `cloud_client`   | `dict`                          | `path, ozon_task_id`                                                                  |
| `list_product_infos(...)`               | `cloud_client`   | `list[dict]`                    | 每个元素: `product_id`, `name`, `offer_id`, `price`                                   |

**示例 — 用 `search_products` 正确遍历结果：**

```python
items = search_products("保温杯", page_size=5)  # 返回 list
for item in items[:3]:
    print(f"¥{item.get('price')} {item.get('title')[:50]}")
```

**不要**写成 `results.get('data', {}).get('result', {}).get('resultList', [])` — `search_products` 返回的已经是列表！

**严禁自己拼 webhook URL** — 所有云端调用必须通过 `cloud_client.py` 的函数。URL 路径由 `path_registry.json` 管理，自己拼的 URL 会错（如旧版 typo `mx-bp2-417417` → 正确是 `mx-bp2-377417`）。制图用 `generate_product_images(token)`，不要自己发 HTTP 请求。

## CDP 探针注意事项（重要！避免 1688 限流）

`probe_1688_page(url)` **一次调用获取全部数据**（标题、价格、图片URL、重量、尺寸、SKU、包装信息都在一次页面探针中提取）。

- ✅ **只调一次** — 一个产品只调一次 `probe_1688_page()`，拿到结果直接用
- ❌ **不要**为图片调一次、为重量再调一次 — 一次调用全部返回
- ❌ **不要**手动 reload 页面 — 探针内置的重试已经处理了慢加载
- ⚠️ 1688 对你频繁刷新页面的行为很敏感，重复打开同一链接会被限流
- 💾 **1688 详情已缓存**：同一商品 24h 内重复请求直接走磁盘缓存，不再打开浏览器

## 生图缓存 + 单张重生

`generate_product_images(token)` 生成的 10 张图 URL 保存在云端任务记录（按 `task_id` 查询），用户随时可查看。

**用户想看之前的图**：查任务结果 → `result_json.images` → 展示给用户。

**用户想重新生成某一张**（如 `main_image` 不好看）：

```python
# 单张重生 — 直接调 image_gen webhook
token = _get_token()
body = {"slot": "main_image", "prompt": "新的提示词...", "token": token,
        "model": "gpt-image-2", "aspect_ratio": "1024x1024"}
resp = requests.post(f"{CLOUD_API_BASE}/webhook/mx-bp2-377417", json=body)
# → {"slot": "main_image", "ok": true, "url": "https://..."}
```

- ✅ 单张重生不影响其他已生成的图
- ✅ 重生后更新云端任务记录对应 slot 的 URL
- ✅ 管线任务提交后，10 张图全部生成完毕才标记完成，过程中可随时查进度

## 定价计算（云端管线自动完成）

定价由云端管线计算，**计算前必须先获取用户店铺的实际物流渠道**——不同用户用不同物流商（RETS/OYX/CEL/...），用错了白算。

**完整流程**：

```python
# 1. 先获取用户 Ozon 店铺的仓库和物流方式
ozon_client_id = "用户OzonClientID"
ozon_api_key = "用户OzonApiKey"
delivery_methods = requests.post(
    "https://api-seller.ozon.ru/v2/delivery-method/list",
    headers={"Client-Id": ozon_client_id, "Api-Key": ozon_api_key},
    json={"filter": {"status": "ACTIVE"}}
).json()

# 2. 从物流方式中提取 provider（如 RETS、OYX、CEL）
provider = delivery_methods["result"][0]["warehouse_name"]  # 或从 provider 字段提取

# 3. 用正确的 provider 计算价格
resp = requests.post(f"{base}/webhook/pricing-v1", json={
    "cost_cny": 1688采购价,
    "weight_g": 350,
    "depth_mm": 70, "width_mm": 70, "height_mm": 240,
    "provider": provider,      # ← 用户实际的物流商
    "service": "Express",      # 服务等级
    "margin_rate": 0.25,
})
```

**单独请求定价**（不上架，只算价）：POST `/pricing-v1`

用户可自定义参数通过请求传入：

```json
{
  "cost_cny": 50,
  "weight_g": 350,
  "provider": "RETS",
  "service": "Express",
  "margin_rate": 0.25,
  "commission_rate": 0.1,
  "fx_buffer": 0.05
}
```

**不传 provider → 返回错误提示**：必须提供物流商，不能默认。

## 项目标识（project_id / subproject_id）

`build_envelope()` 需要这两个参数：

| 参数            | 默认值       | 说明                                         |
| --------------- | ------------ | -------------------------------------------- |
| `project_id`    | `"default"`  | 项目标识，一般用固定值 `"default"`           |
| `subproject_id` | 1688 商品 ID | 子项目标识，用 1688 的 `itemId` 或 `offerId` |

```python
envelope = build_envelope(
    project_id="default",          # 固定用 "default"
    subproject_id=item_id,         # 1688 商品 ID
    source={...}, assets={...}, draft={...}
)
```

---

### Worker A：1688 → Ozon 新上架（5 步）

| #   | 动作            | 函数                                                                                                                                                                                                     | 对用户说                                                                                                      |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | 检查配置        | `check_config()`                                                                                                                                                                                         | 全部就绪→（静默）；有缺失→按 AGENTS.md「首次配置引导」逐个问答填 `.env`                                       |
| 2   | 获取 1688 详情  | API `prod_detail` + CDP `probe_1688_page()`                                                                                                                                                              | "正在获取 1688 商品详情..." → "已获取详情（{N}张图，{M}个SKU）"                                               |
| 3   | 类目匹配        | **本地主导**：先 `property/lookup` → 云端查缓存；没命中 → 本地 `search_categories_locally()` → Ozon API 搜索；用户选 → `property/confirm` → 云端保存。**无论命中与否，数据都由本地传给云端。越用越快。** | 命中："已匹配类目：{类目名}（置信度 {X}%）"；未命中：列候选让用户选 → "已确认类目：{类目名}，已记录到云端 ✅" |
| 4   | 构建信封 + 提交 | `build_envelope()` → `submit_task(envelope)`                                                                                                                                                             | "已提交任务 {task_id}，云端后台处理中 ⏳ 通常 3-9 分钟完成，我会自动查进度"                                   |
| 5   | 轮询进度        | 每 30 秒查一次 `gateway_tasks`，直到 terminal=true                                                                                                                                                       | 进度更新 → 最终汇报                                                                                           |

> **重要**：`submit_envelope()` 走 `v2-ingest-292201` — 只用于类目匹配（property/lookup+confirm）。**上架提交必须用 `submit_task()` 走 `pl-v3-304140` 管线。**
> **异步处理**：管线提交后立即返回（~3秒），Agent 通过轮询 `gateway_tasks` 查进度，不用傻等。
> **Ozon API 版本**：类目接口用 `/v1/description-category/tree`（不是 v2）。用 `search_categories_locally()` 封装好的函数即可（Ozon API 已内联到 `ozon_api.py`，不需要额外 pip 安装）。

> **Step 4 提交后如果返回 `_next_action: "category_matching_required"`**：说明类目还没匹配。自动执行类目匹配（property/lookup → search_categories_locally → 用户选 → property/confirm），匹配完重新提交信封。

### Worker B：Ozon 跟卖（6 步）

| #   | 动作             | 函数                                | 对用户说                                               |
| --- | ---------------- | ----------------------------------- | ------------------------------------------------------ |
| 1   | 检查配置         | `check_config()`                    | （静默，失败时："缺少配置：{keys}"）                   |
| 2   | 解析 Ozon 商品   | `analyze_ozon_product(url)`         | "正在分析 Ozon 商品..." → "已解析：{product_name}"     |
| 3   | CDP 收集原图     | CDP 打开 Ozon 页                    | "正在收集商品图片..."                                  |
| 4   | 1688 找同款      | `search_products()` → 比价 → 问用户 | "找到 {N} 个同款，比价：\n1. ¥{X} ...\n跟卖还是新建？" |
| 5   | 跟卖             | `follow_sell_cloud(sku=product_id)` | "正在跟卖..."                                          |
| 6   | 制图 → 写入 Ozon | 同 Worker A Step 7-8                | 同 Worker A                                            |

如果复制被拒（`fallback_new_product`）→ 走 Worker A Step 2-9。

### Worker C：翻新（3 步）

| #   | 动作         | 函数                                    | 对用户说              |
| --- | ------------ | --------------------------------------- | --------------------- |
| 1   | 获取现存产品 | `list_product_infos(product_ids=[...])` | "正在获取产品信息..." |
| 2   | 制图         | `generate_product_images(token)`        | "制图中..."           |
| 3   | 写入 Ozon    | `update_followed_product`               | "正在更新到 Ozon..."  |

### Worker D：多 SKU 变体（3 步）

| #   | 动作         | 函数                                     | 对用户说          |
| --- | ------------ | ---------------------------------------- | ----------------- |
| 1   | 构建变体信封 | `build_variant_envelope(variants=[...])` | （静默）          |
| 2   | 提交         | `submit_envelope` → `submit_task`        | "已提交变体任务"  |
| 3   | 制图 → 更新  | `generate_product_images` → `update`     | "制图并更新中..." |

### Worker E：智能选品（无具体商品时，6 步）

触发条件：用户没有指定 1688 商品链接，说"帮我上架蓝海产品/有利润的产品/好卖的产品"

| #   | 动作          | 函数                                                         | 对用户说                                                                                                                                    |
| --- | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 确认偏好      | 问用户或查店铺                                               | "好的，帮你找{蓝海/有利润}的产品 ⏳ 先确认——你店铺主要做哪个类目？还是我帮你看看店铺现有品类分布？"                                         |
| 2   | 分析店铺      | `ozon_client.list_products()`                                | "正在分析你 Ozon 店铺的品类分布..."                                                                                                         |
| 3   | 1688 选品     | `1688-shopkeeper trend/opportunities` 或 `search_products()` | "正在 1688 搜索{类目}热销品..."                                                                                                             |
| 4   | 利润/蓝海分析 | 1688 价格 vs Ozon 售价对比                                   | "正在计算预估利润..." → 过滤低利润/高竞争品                                                                                                 |
| 5   | 呈现候选      | —                                                            | "帮你筛选了 {N} 个候选（按利润率排序）：\n1. **{商品名}** — 成本 ¥{X} Ozon 约 ₽{Y} 利润率 ~{Z}% 竞争{低/中/高}\n2. ...\n\n选哪个？或'全上'" |
| 6   | 进入 Worker A | 用户选定后                                                   | "收到，开始上架【{商品名}】⏳" → 进入 Worker A Step 2                                                                                       |

降级方案：如果 1688-shopkeeper trend/opportunities 不可用 → 让用户指定类目关键词 → 1688 search → 人工筛选 → 呈现候选。

---

## 返回结果

| status           | 对用户说                                    |
| ---------------- | ------------------------------------------- |
| `accepted`       | "已提交，云端处理中（{task_id}）"           |
| `succeeded`      | "✅ 上架成功！Ozon 任务 ID: {ozon_task_id}" |
| `blocked`        | "⛔ 被阻断：{原因}。{建议}"                 |
| `failed`         | "❌ 失败了：{错误}。可以重试或检查配置"     |
| `partial_failed` | "⚠️ 部分完成：{详情}"                       |

跟卖: `copy_and_update` → "跟卖成功 ✅" | `fallback_new_product` → "禁止复制，走新建上架"

---

## 严格禁止

- ❌ 跳过 Worker 步骤（尤其是 Worker A Step 3 类目匹配——跳过会导致上架被阻断）
- ❌ 跳过 CDP 浏览器采集（1688 API 不返回图片/重量/尺寸）
- ❌ "已提交" = "上架成功"
- ❌ 缺配置继续执行
- ❌ 硬编码凭据
- ❌ 编造未返回的数据
