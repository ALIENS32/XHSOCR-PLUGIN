# XHSOCR

一个运行在浏览器中的 Tampermonkey 用户脚本，用于提取小红书图文笔记，并将笔记信息和图片 OCR 结果整理为 Markdown。

适合将教程、知识卡片、清单、聊天截图等图文笔记保存到 Obsidian、Notion、知识库或本地 Markdown 文件中。

## 功能特点

- 提取笔记标题、作者、发布时间、正文、标签、互动数据和原链接
- 按笔记中的原始顺序识别所有图片
- 每张图片独立并发处理，减少多图笔记的等待时间
- 自动跳过普通照片、自拍、风景、商品图等非文字主体图片
- 支持 OpenAI Responses API 及兼容接口
- 支持自定义模型和 API Base URL
- 单张图片失败不会丢失其他图片的成功结果
- 支持一键重试失败图片
- 可直接复制或下载生成的 Markdown
- API Key 仅保存在本机 Tampermonkey 存储中

## 核心思路

脚本的处理流程如下：

```text
当前小红书笔记
       ↓
提取笔记元数据和有序图片列表
       ↓
每张图片独立执行：下载 → 必要时缩放 → OCR
       ↓                  （所有图片并发）
按原始图片顺序合并结果
       ↓
生成、复制或下载 Markdown
```

OCR 前会要求模型先判断图片是否以文字传递信息。文档、海报、信息图、聊天记录和文字截图会正常识别；普通照片、插画以及仅含水印、Logo、用户名等零散文字的图片会返回空结果，从而减少无意义的文字生成。

项目按职责拆分为页面提取、OCR Provider、Markdown 渲染、设置存储和界面模块。OCR 服务通过 `OcrProvider` 接口接入，不与小红书页面解析逻辑耦合。

## 使用前准备

你需要：

1. Chrome、Edge、Firefox 等支持用户脚本扩展的浏览器
2. [Tampermonkey](https://www.tampermonkey.net/) 扩展
3. 一个支持图片输入和 Responses API 的模型服务
4. 对应服务的 API Key

默认配置为：

```text
Base URL: https://api.openai.com/v1
模型: gpt-5-mini
```

也可以使用兼容 OpenAI Responses API 的服务。Base URL 可填写 API 根地址，也可直接填写以 `/responses` 结尾的完整地址。

## 安装用户脚本

### 方法一：从 GitHub 安装

1. 先在浏览器中安装并启用 Tampermonkey。
2. 在本仓库打开 `dist/xhsocr.user.js`。
3. 点击 GitHub 文件页面右上方的 **Raw**。
4. Tampermonkey 会自动打开安装页面，点击“安装”。
5. 安装完成后刷新已经打开的小红书页面。

如果点击 Raw 后浏览器只显示源码，可以使用下面的手动安装方法。

### 方法二：在 Tampermonkey 中手动安装

1. 打开 `dist/xhsocr.user.js`，复制文件的全部内容。
2. 点击浏览器工具栏中的 Tampermonkey 图标。
3. 选择“管理面板”，再点击“添加新脚本”。
4. 删除编辑器中的默认内容，粘贴刚才复制的脚本。
5. 按 `Ctrl+S`（macOS 为 `Command+S`）保存。

请始终安装 `dist/xhsocr.user.js`，不要直接使用 `src/` 目录中的 TypeScript 源码。

## 使用方法

1. 打开一篇小红书图文笔记详情页，并等待图片加载完成。
2. 点击页面右下角的“OCR 导出”按钮。
3. 填写 API Key、Base URL 和模型名称。
4. 点击“保存设置”，再点击“解析并 OCR”。
5. 等待所有图片处理完成。
6. 点击“复制”将 Markdown 复制到剪贴板，或点击“下载 Markdown”保存文件。

如果部分图片处理失败，可点击“重试失败图片”。已经成功的 OCR 结果会保留，不会被重新请求或丢弃。

也可以点击 Tampermonkey 菜单中的“打开小红书 OCR”打开操作面板。

## Markdown 输出

生成内容包含可提取到的笔记元数据、原始正文以及按图片顺序排列的 OCR 文字，例如：

```markdown
# 笔记标题

- 作者: 示例作者
- 发布时间: 2026-01-01T12:00:00.000Z
- 笔记 ID: example-id
- 原链接: https://www.xiaohongshu.com/explore/example-id
- 标签: #教程 #效率

笔记正文……

<!-- image: 1 -->

第一张图片中的文字……

<!-- image: 2 -->

第二张图片中的文字……
```

没有文字主体的图片会保留图片顺序标记，但不会生成无意义的描述。OCR 失败时，Markdown 中会记录对应错误，便于后续重试或排查。

## 隐私与安全

- API Key 保存在本机 Tampermonkey 存储中，不会写入导出的 Markdown。
- 图片只会在用户主动点击“解析并 OCR”后发送到所配置的 API 地址。
- 这是纯浏览器脚本，无法提供服务端级别的密钥隔离。请勿在不受信任的电脑或浏览器环境中保存 API Key。
- 为支持自定义 API 地址，用户脚本具有跨域请求权限。请确认你填写的 Base URL 来自可信服务商。
- 图片内容会由所选模型服务处理，使用前请确认其隐私政策、数据保留规则和费用标准。

## 已知限制

- 仅支持小红书图文笔记，不适用于视频笔记。
- 小红书页面结构变化后，页面提取逻辑可能需要更新。
- OCR 速度取决于图片数量、图片大小、所选模型、网络情况以及 API 服务的并发限制。
- 模型可能漏字、错字或误判非文字图片，重要内容请人工核对。
- 某些 OpenAI 兼容服务并未完整实现 Responses API 或结构化输出，可能无法直接使用。

## 本地开发

需要 Node.js 和 npm。

```bash
npm install
npm run check
```

常用命令：

```bash
npm run dev        # 监听源码并持续构建
npm run typecheck  # TypeScript 类型检查
npm test           # 运行单元测试
npm run build      # 构建 dist/xhsocr.user.js
npm run check      # 类型检查、测试和生产构建
```

目录结构：

```text
src/
├── xiaohongshu-extractor.ts  # 小红书页面和状态提取
├── openai-provider.ts        # 图片准备、并发调度和 OCR 请求
├── markdown.ts               # Markdown 渲染
├── settings.ts               # Tampermonkey 设置存储
├── ui.ts                     # 操作界面
└── types.ts                  # 公共类型和接口
tests/                        # 单元测试
dist/xhsocr.user.js           # 可直接安装的生产脚本
```

不要手动编辑 `dist/xhsocr.user.js`。修改 `src/` 后运行 `npm run build` 重新生成。

## 参与贡献

欢迎提交 Issue 和 Pull Request。修改页面提取、OCR 调度或 Markdown 输出时，请同步补充测试，并确保以下命令通过：

```bash
npm run check
```

接入新的 OCR 服务时，请实现 `OcrProvider`，不要将服务特有逻辑放入页面提取器或 UI。
