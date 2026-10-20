# 00006 文件传输与 USB

基线：2026-10-20 / 0.12.0。两项能力均独立于运行上传；产品交互见 [产品方案](00001-product.html#transfer)。

## 1. 通用文件传输

支持本机 ↔ 单台 SSH / WSL 的普通文件、多选、递归目录、空目录和二进制文件。复制后两端独立，不是挂载或双向同步。不支持 Serial 通用文件传输、设备间直接复制、暂停续传、拖放或自动收集运行产物。

文件菜单、设备浏览入口、工作区右键进入中心文件传输面板。左右分别为本机和设备目录；逐条方向按钮传单项，勾选后显示上传/下载所选按钮。操作以另一侧已经成功打开的目录为目标，不能消费地址栏尚未提交的输入。窄面板上下排列。

后端生成不可修改的计划，预检后选择 `keep_both`（默认）、`skip`、`overwrite`。选择目录 `project` 会复制为 `<目标>/project/...`；同名目录合并且不删除目标额外文件。类型冲突逐项报错，不隐式递归替换。传输按磁盘已保存版本读取，源脏标签先处理；打开的目标文件受保护，外部变化与新草稿保留为冲突。

显示隐藏项只控制浏览；递归复制默认包含隐藏文件。可选择项目排除预设，范围包括版本库、`.venv`、`node_modules` 等；不自动套用运行上传排除根 `.runner` 的规则。

## 2. 任务与预算

| 项目 | 当前实现 |
| --- | --- |
| 单文件 / 单批内容 | 2 GiB / 10 GiB |
| 条目 / 深度 | 10,000 / 64 层 |
| 相对路径 | 4096 字节，组件最多 255 字节 |
| 数据块 | 32 KiB，有界流式 IO；文件内容不进 WebView |
| 并发 | 全局 2，单设备 1；队列 100 |
| 计划有效期 | 5 分钟 |
| 单步无进度超时 | 固定 60 秒 |
| 列表 / 详情 | 每页 100 项；摘要轮询，详情按需读取 |
| 普通历史 | 最近 100 项，普通记录超过 7 天启动清理；残留不随意淘汰 |

任务注册冻结源、目标、设备身份及配置，UI 后续切换不改变任务。进度以后端快照/sequence 为准。活动状态为 `queued / transferring / committing / canceling`；终态包含 `completed / partial / failed / canceled / interrupted`。`unknown` 是条目提交结果未确认，显示“待核对”，不自动重试。

关闭面板/隐藏到托盘继续任务。真正退出确认取消并等清理；活动传输阻止安装更新。扫描阶段没有完整的可取消进度 UI，不应承诺所有阶段同样响应取消。

## 3. 安全提交与恢复

Rust 验证根与相对路径、源/目标重叠和可识别的 Local↔WSL 别名；拒绝链接、重解析点和特殊文件。不可移植名称（Windows 保留名、尾点空格、非法字符）及目标大小写碰撞显式报错，不静默改名。

文件写入目标父目录内独占 `.rr-transfer-<任务ID>-<随机值>.part`，写完关闭并核对长度后提交；不转换编码/换行。保留两份使用不覆盖的硬链接发布，覆盖使用安全替换。SSH 协商 `hardlink@openssh.com` / `posix-rename@openssh.com`，能力不足拒绝相应策略，不能先删原文件。

源文件打开句柄的前后属性/长度检查及目标提交前复核可发现常见改动，但不构成整树原子快照、端到端 SHA-256 或跨进程条件写入。SFTP 多步路径检查仍有并发替换窗口。未实现空闲空间预检、mtime 保留；owner、ACL、xattr、特殊权限位不复制。可执行位仅在两端有可靠 POSIX mode 时按选项处理。

取消在每块及提交前检查，已提交文件和已创建目录保留。提交确认丢失标 `unknown`，先人工核对目的文件再重新选择；不能把它当成确定失败后覆盖重传。清理只按任务记录的准确临时名称，并重新校验端点身份，不通配删除 `.part`。

`transfers.json` 保存注册/终态；`transfer-journal/<id>.jsonl` 同步追加逐文件和提交检查点，启动回放较新 sequence，忽略已合并记录和不完整尾行。旧活动任务恢复为中断，不自动续传或恢复偏移。

重试只预检失败/未开始项，目录不重新展开成功后代。成功注册后建立 `retry_of / superseded_by` 双向链，取消预检不改变旧记录；旧记录实际结果保留。主列表只呈现当前尝试，旧残留或未知结果仍可见。成功任务短暂显示后折叠，折叠不删除历史。

实现：[TransferManager](../src-tauri/src/file_transfer/manager.rs)、[安全 Host](../src-tauri/src/file_transfer/host.rs)、[传输模型](../src-tauri/src/file_transfer/mod.rs)、[前端 API](../src/transferApi.ts)、[面板](../src/components/FileTransferPanel.tsx)。

## 4. Windows USB 共享：依赖和生命周期

USB 共享使用默认 Program Files 安装的 **usbipd-win 5.x**，不自带 USB/IP 驱动。依赖缺失时提供安装说明，不自动安装驱动或修改防火墙。入口为“文件 → USB 共享…”，支持 WSL2 或已保存的 SSH Linux 目标。

| 目标 | 要求 | 数据链路 |
| --- | --- | --- |
| 本机 WSL2 | WSL2、usbipd 服务，验证使用 Linux Python/sysfs | usbipd → WSL2 虚拟机；不是发行版隔离 |
| 远程 Linux | SSH、Python 3.8+、usbip、vhci_hcd、root 或具体命令的免密 sudo | Linux 主动连接 Windows IPv4 TCP 3240；SSH 只管理 |

连接期间 Windows 无法同时使用该 USB。WSL2 各发行版可访问连接到虚拟机的设备；发行版选择用于启动与验证。关闭弹框、退出应用、结束运行不会自动断开；断开保留共享配置，取消共享撤销持久配置。拔插/设备重置没有自动重连，不提供应用级 USB 使用租约。

界面支持刷新、依赖/连通性检查、连接、断开、取消共享和节点访问验证。USB 节点可见/可读写不保证业务驱动、串口 `/dev/tty*` 权限或刷写工具已就绪；同 VID:PID 多设备也不能仅靠型号确认物理身份。

## 5. 身份、权限与远程链路

- 从系统位置以绝对路径运行 usbipd，不从工作区/PATH 装载同名程序。状态读 JSON，不解析面向人的表格。
- 设备使用 InstanceId / PersistedGuid，BUSID 仅为当次地址；UAC 前后及实际操作前再次核对，避免拔插重用 BUSID。
- 仅 bind/unbind 按需提权：`--usb-elevated` 受限子进程在 Tauri/单实例初始化前处理，只接受固定操作及严格选择器。主应用普通权限。
- 操作串行；USB 转交与本应用任何串口租约互斥，不自动抢占外部程序或 force bind。IP 非空只表示某客户端占用，不能推断属于所选目标。
- 远端 helper 源码和 JSON 经 stdin，Shell 命令只含固定 bootstrap；实际 usbip/modprobe 使用结构化参数，`sudo -n` 不借用 SSH 密码。
- Linux 检查 TCP 3240 与 USB/IP 导出记录，核对 BUSID + VID:PID 后 attach；detach 精确匹配 Windows host + 3240 + BUSID 对应的一条虚拟端口，禁止 detach all。
- IPv4 可留空按路由推测，多网卡/NAT/VPN 应显式填写 Linux 可达的 Windows 地址。当前不提供 IPv6、SSH 隧道或传输加密，按可信网络/VPN 部署。
- 子进程有输出/时间预算、进程组清理；sudo root 后代未必能由普通用户终止，超时属于状态未确认，需要重查两端，不能直接断言失败后无副作用。

具体 sudo 授权应由目标管理员限定到 `usbip port / attach / detach`，按需允许 `modprobe vhci_hcd`；不要求以 root 执行任意 Python。Linux 工具在 `/usr/sbin /usr/bin /sbin /bin` 查找，安装路径不在此范围时会提示缺失。

## 6. 故障处理与验证

| 情况 | 下一步 |
| --- | --- |
| SSH 可用，USB 数据连接失败 | 核对 Linux → Windows IPv4 路由、TCP 3240、usbipd 服务及防火墙 |
| 有 sudo 但操作失败 | 确认具体命令、参数和路径有非交互授权，不能以找到 sudo 推断授权完成 |
| 已连接但所选目标不能验证 | 核对原目标、Windows 地址和虚拟端口，不抢占其他客户端 |
| 设备拔出/超时后遗留端口 | 在原 Linux 检查 `usbip port`，确认归属后按实际 Port 数字断开，再刷新 |
| 串口忙 | 先结束对应应用内串口会话及外部占用，再连接 USB |
| 传输待核对/待清理 | 核对目的文件和端点身份，再重选或清理准确临时文件 |

USB 实现：[Windows 管理](../src-tauri/src/usb/windows.rs)、[远程管理](../src-tauri/src/usb/remote.rs)、[Linux helper](../src-tauri/src/usb/remote_helper.py)、[USB 窗口](../src/components/UsbDialog.tsx)。

普通测试采用本机 SSH/SFTP 服务、Python helper 模拟和 WSL opt-in。它们不验证真实 USB bind/attach/UAC、udev 或跨机网络；2 GiB 文件边界、不同 SFTP 服务端与其他桌面平台仍需各自实测。测试命令见 [00008](00008-development-and-release.md)。
