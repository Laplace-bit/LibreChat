# 中国模型供应与用户可见模型

## 产品决定

面向中国市场时，管理端的供应商目录以中国厂商为主。OpenAI 作为供应商保持可选；OpenAI 兼容协议继续作为接入协议保留，因为多家中国模型服务可通过该协议接入。端点模板只帮助管理员配置供应商，不会自动启用端点，也不会直接显示给普通用户。

服务端仍是供应商凭据、端点权限和模型白名单的唯一所有者。第一批提供 DeepSeek、阿里云百炼/Qwen、Moonshot/Kimi、智谱 GLM、火山方舟/豆包、百度千帆的配置模板。其他兼容服务继续使用空白 OpenAI 兼容端点；只有 API 协议与现有 OpenAI Chat Completions 或 Anthropic 兼容实现不符时，才增加专用适配器。

模板中的模型是少量起始选项，默认不抓取服务商的完整模型目录。管理员可以调整服务端允许的模型列表，避免把供应商的所有模型都堆给用户。

## 用户端可见范围

普通用户看到的是当前服务端为其提供的端点和模型，不是模板目录。`modelSelect` 开启且 `modelSpecs.addedEndpoints` 为空时，模型选择器会显示所有已服务的端点。中国优先部署可以按需移除 OpenAI、Google、Anthropic 等内置端点；例如设置 `ENDPOINTS=agents` 会关闭未列出的内置端点，自定义端点仍由 `endpoints.custom` 配置。

要让用户只看到管理员挑选的模型，在“配置 → 模型 → 用户如何选择模型”中选择“仅限规格”，再关闭“功能 → 界面 → 模型选择”。配置中需要至少一个 `modelSpecs.list` 项；`modelSpecs.enforce: true` 会让服务端拒绝不带有效规格的聊天请求。这样用户看到的是有名称、分组和默认模型的精选目录，而不是各供应商的原始模型列表。

示例：

```yaml
interface:
  modelSelect: false

modelSpecs:
  enforce: true
  list:
    - name: deepseek-fast
      label: DeepSeek 高速
      group: 中国模型
      default: true
      preset:
        endpoint: DeepSeek
        model: deepseek-flash
    - name: qwen-plus
      label: Qwen Plus
      group: 中国模型
      preset:
        endpoint: Qwen
        model: qwen3.7-plus
```

如果用户仍需直接选择部分端点模型，保持 `modelSelect: true`，并用 `modelSpecs.addedEndpoints` 只列出要公开的端点名。该设置控制端点范围；各端点下显示哪些模型由 `endpoints.custom[].models.default` 控制。

## 用户密钥与共享密钥

中国厂商模板默认使用 `apiKey: user_provided`，管理员不必在 Docker `.env` 或管理端填入真实密钥。用户在客户端首次使用该端点时按提示填写，也可以在设置里的供应商密钥页面添加；密钥会按用户账号加密保存在 LibreChat 服务端数据库，并由服务端在请求模型时读取。它不会只保存在当前桌面设备上。

企业若使用统一采购的共享密钥，可把端点的 `apiKey` 改为 `${PROVIDER_API_KEY}`，再将密钥配置到 API 服务的环境中。首批模板的密钥变量只允许出现在自定义端点的 `apiKey` 字段；百炼工作区 ID 只允许出现在自定义端点的 `baseURL` 字段。管理员环境状态只报告变量是否已设置，不返回值。未收录的环境变量仍可由运维人员配置到 `CONFIG_OVERRIDE_ENV_ALLOWLIST`，或直接在 `librechat.yaml` 中引用。

百炼模板默认使用中国（北京）兼容 API 域名，API Key 需要来自同一地域。企业部署可把 URL 换成工作区专属域名；此时工作区 ID 与 API Key 也必须属于同一区域。

## 方案取舍

- **采用供应商配置模板 + 现有兼容协议**：让常见国内模型立即复用端点、凭据加密、模型验证、工具调用和权限系统；避免每接一家厂商就复制一套聊天运行时。
- **暂不为每家供应商新增专用客户端**：只有其鉴权、请求/响应结构或关键能力与兼容协议不符时才做专用适配，并分别验证文本、推理、工具调用和多模态能力。
- **不全局删除 OpenAI 或默认暴露所有模型**：部署方可以禁用无用的内置供应商，管理端也可以按用户/角色发布精选目录；兼容协议与供应商品牌分开处理。

模型名称和供应商 API 可能更新。本文模板中的起始模型名应以对应服务商当前控制台和 API 文档为准；更新模板时优先校验官方文档。

## 官方文档

- [DeepSeek API](https://api-docs.deepseek.com/quick_start/agent_integrations/)
- [阿里云百炼模型目录](https://help.aliyun.com/en/model-studio/models) 和 [API 域名](https://help.aliyun.com/en/model-studio/base-url)
- [Moonshot/Kimi Chat Completions](https://platform.kimi.com/docs/api/chat)
- [智谱 OpenAI 兼容接口](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [火山方舟模型列表](https://docs.volcengine.com/docs/ark/model-list?lang=zh)
- [百度千帆模型列表](https://cloud.baidu.com/doc/qianfan-docs/s/7m95lyy43)
