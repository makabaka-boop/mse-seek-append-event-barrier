# WebM/VP8 分片播放器（单 SourceBuffer 串行协调）

纯浏览器 MSE 分片播放器：仓库自带**可复现生成**的短 WebM/VP8 初始化段与 6 个
关键帧起始媒体段，Compose 托管页面与这些本地资源。范围刻意收窄：**只处理这一
固定清单和单个视频 SourceBuffer**——不做音频、编码切换、DASH 或 MP4 解析。

## 目录结构

```
├── docker-compose.yml      # web（页面+媒体托管）/ media-gen（可复现生成）/ test（替身测试）
├── media/                  # 生成产物（已提交）：init.webm + seg-1..6.webm + manifest.json
│   └── media.sha256        # 复现校验和
├── public/
│   ├── index.html          # 播放器页面（可播放标记只读真实 video.buffered）
│   ├── player.js           # 页面胶水：MediaSource 生命周期、seeking/timeupdate 接线
│   ├── coordinator.js      # 核心：单 SourceBuffer 追加/删除串行协调器（浏览器/Node 共用）
│   └── test-mse.html       # 真实 MSE 场景自测页（加载→跳播→停止重建，标题给出 PASS/FAIL）
├── tests/
│   ├── mock-sourcebuffer.js    # SourceBuffer 替身：事件顺序完全由测试驱动
│   ├── coordinator.test.js     # node:test 十个交错场景
│   └── run-browser-mse.js      # Playwright 跑 test-mse.html + 主页面冒烟
└── tools/generate-media.sh # 固定 ffmpeg 7.0.2 静态构建（sha256 校验）+ 固定参数生成
```

## 快速开始

```bash
docker compose up web          # http://localhost:8080/        播放器
                               # http://localhost:8080/test-mse.html  真实 MSE 自测
docker compose run test        # SourceBuffer 替身测试（node --test）
docker compose run media-gen   # 重新生成 media/ 并与 media.sha256 比对（需联网）
```

无 Docker 时：`node --test tests/` 跑替身测试；在仓库根目录起任意静态服务器
（如 `python3 -m http.server 8080`）后打开 `/public/index.html`
（页面按 `media/...` 相对路径取媒体，需能以 `/media/...` 访问到 media/ 目录，
Compose 的 nginx 已按此布局挂载）。

## 媒体：可复现生成

`tools/generate-media.sh` 的复现保证：

- 固定 **ffmpeg 7.0.2 静态构建**（johnvansickle，amd64/arm64 分别固定 sha256）；
- 固定输入 `testsrc2=320x180@30, 6s`、固定编码参数、`-threads 1` 单线程；
- `-g 30 -keyint_min 30` 使关键帧精确落在整秒，`webm_chunk` 按关键帧切成
  6 个媒体段，**每段首帧即关键帧、时间戳为绝对时间**（`timestampOffset` 恒为 0）；
- `-bitexact` 消除 EBML 头部的随机 SegmentUID/TagUID；
- 生成后逐段 ffprobe 校验首帧关键帧与起始时间戳，再与 `media/media.sha256`
  做字节级比对。

## 协调器设计（对应问题清单）

`public/coordinator.js` 与 DOM 解耦（依赖全部注入），浏览器与 Node 测试共用：

1. **串行**：任一时刻至多一个原生 op 在飞；下一个 op 只能由上一个的
   `updateend` 驱动。append 与 remove 共用同一队列、同一泵。
2. **取消的追加不算成功**：`abort()` 后原生层仍会抛 `abort`+`updateend` 一对
   事件——它们只归属被取消的那个 op（op 上打了 `cancelled`/epoch 标记），
   绝不能被当成下一次追加的成功；新 op 在这对事件消化完之前不会启动。
3. **remove 在飞不得 abort 冒充已清理**：跳播时若在飞 op 是 remove，不调用
   `abort()`，等它真实的 `updateend`；remove 的物理生效与 epoch 无关，
   真实提交才更新账本。
4. **完成标记只随真实成功更新**：`appendedSeqs` 只在未取消、当前 epoch 的
   append `updateend` 分支里置位；remove 的 `clearSeqs` 也只在 remove 真实
   提交后清除。
5. **跳播**：撤销在飞请求（AbortController）与排队片段 → 等串行锁空闲后按
   **最新** buffered 清除目标段区间之外的旧数据（remove 插队首）→ 再接续
   目标段。清理判定推迟到锁释放，是因为被取消追加的残余数据要到其
   `updateend` 才落定。
6. **配额**：同一追加抛出 `QuotaExceededError` 时至多清理一次旧播放区间
   （`currentTime - keepBehindSec` 之前）并重试一次；再失败上报
   `{seq, stage: 'append-retry'}`，页面横幅显示具体段与阶段。
7. **停止/重建**：`stop()` 递增 epoch、移除全部监听器；旧 session 的事件
   （包括真实残留事件与合成事件）彻底失效。重建后账本清零重来。
8. **可播放标记 ⇔ 真实 buffered**：页面的“可播放”列只依据
   `video.buffered` 计算，与协调器账本分列对照；自测页断言二者一致。

## 测试

### SourceBuffer 替身（事件顺序可控）

`tests/mock-sourcebuffer.js` 不自动发事件：`appendBuffer/remove` 只置
`updating`，事件由测试用 `completePending()`/`fireStray()`/`fireStale()`
精确驱动。`node --test tests/` 覆盖：

- 追加与 remove 串行（remove 不得在 append 在飞时开始）；
- 被取消追加的 `abort/updateend` 不误报为下一片段成功（含迟到请求结果被丢弃）；
- remove 在飞时跳播不调用 `abort()`，remove 真实提交后才清完成标记；
- 配额：清理一次旧播放区间后重试成功 / 重试仍失败只清理一次并报
  `段5 @ append-retry`；
- 停止并重建后旧事件（含 `fireStale` 模拟的残留事件）彻底失效；
- 跳播撤销旧请求与排队片段、先清旧数据再接续目标段；
- 重复 `ensure` 去重、seek 到已缓冲段直接复用、初始化段走同一队列。

### 真实 MSE

`public/test-mse.html` 用真实 MediaSource 走一遍：加载段 1-2 → 以 150ms 人为
延迟制造在飞请求并立即跳播段 5 → 校验真实 buffered 区间与账本 → 实际播放 →
停止重建（含对旧 SourceBuffer 派发合成事件验证失效）→ 重新加载。结果写入
`document.title`（`MSE-TEST: PASS/FAIL`）。

```bash
npm i -D playwright && npx playwright install chromium
npm run test:browser     # 无头跑 test-mse.html + 主页面冒烟（跳播落点断言）
```

### 手动验证清单

1. `docker compose up web` 后打开 `http://localhost:8080/`；
2. 延迟填 `400`ms，点“开始加载”，立即点“段5 (4s)”：日志应显示撤销在飞请求、
   清理 `[0,…)` 旧数据后接续段 5；表格中“可播放”列只跟随真实 buffered；
3. 点“停止并重建 MediaSource”：日志显示旧 session 拆除，重新从段 1 加载；
4. 打开 `/test-mse.html`：标题变为 `MSE-TEST: PASS`。
