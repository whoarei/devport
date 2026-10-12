# Windows USB 共享到远程 Linux

## 目标

在已有 USB → WSL2 管理功能上增加远程 Linux 目标。选择已保存的 SSH 设备配置，复用凭据和 known_hosts 检查，通过 SSH 执行管理 helper；USB/IP 数据由 Linux 直接连接 Windows IPv4 的 TCP 3240，不经过 SSH 隧道。

## 使用方法

以下示例中，USB 插在 Windows 上，Windows 地址为 `192.168.1.50`，目标 Linux 地址为 `192.168.1.70`，SSH 用户为 `rruser`。请替换成实际地址和账号。两台机器应处于可信局域网或 VPN，且 Linux 能主动访问 Windows 的 TCP 3240；仅能从 Windows SSH 登录 Linux，还不足以保证 USB 连接可用。

### 1. 准备 Windows

安装 usbipd-win **5.x**，保留默认 Program Files 安装位置。可以从 [usbipd-win 发布页](https://github.com/dorssel/usbipd-win/releases)选择 5.x 安装包，也可以在 PowerShell 执行：

```powershell
winget install --interactive --exact dorssel.usbipd-win
```

安装后重新打开 PowerShell，检查版本、服务和设备列表：

```powershell
usbipd --version
Get-Service usbipd
usbipd list
ipconfig
```

确认版本为 5.x、`usbipd` 服务为 `Running`，设备列表中能看到要转交的 USB。若服务未运行，可在 Windows「服务」中启动「USBIP Device Host」。从 `ipconfig` 中找到 Linux 能访问的网卡 IPv4，本例为 `192.168.1.50`。

安装程序会创建允许本地子网访问的防火墙规则。跨网段或使用第三方防火墙时，需要允许选定 Linux / VPN 网段访问 Windows TCP 3240；访问范围按实际网络配置。安装行为参见 [Microsoft 安装说明](https://learn.microsoft.com/en-us/windows/wsl/connect-usb#install-the-usbipd-win-project)。

Remote Runner 可以以普通用户启动；首次共享和取消共享会按需弹出 UAC。如果当前开发程序在接入远程 Linux 功能前已启动，需要先重新启动程序以加载新增后端命令。

### 2. 准备 Linux

目标需要 SSH、Python 3.8+、发行版提供的 `usbip` 客户端，以及内核的 `vhci_hcd` 支持。先在 Remote Runner 中新增并保存该 Linux 的 **SSH 设备**，确认连接配置可用，再在 Linux 终端准备依赖。

Ubuntu 使用与当前运行内核对应的工具包，例如：

```bash
sudo apt update
sudo apt install python3 usbutils linux-tools-common "linux-tools-$(uname -r)"
```

Ubuntu 的工具包随内核版本和类型变化，参见 [Ubuntu 内核工具包目录](https://packages.ubuntu.com/en/linux-tools-generic)。如果仓库中没有当前内核对应的包，尤其是开发板或自定义内核，应按该内核/发行版的说明安装匹配工具和模块；不能把另一内核版本的工具安装成功视为环境已就绪。

Debian 可以安装 [usbip 软件包](https://packages.debian.org/stable/usbip)：

```bash
sudo apt update
sudo apt install python3 usbutils usbip
```

安装后检查并加载模块：

```bash
python3 --version
usbip --version
sudo modprobe vhci_hcd
test -d /sys/module/vhci_hcd && echo "vhci_hcd ready"
```

Debian 普通用户的 PATH 可能不包含 `/usr/sbin`，此时使用 `/usr/sbin/usbip --version` 检查。应用会依次在 `/usr/sbin`、`/usr/bin`、`/sbin`、`/bin` 查找工具。`modprobe` 报模块不存在时，需要先准备支持 USB/IP 虚拟主控制器的内核/模块；「接入时加载」只表示发现了 `modprobe`，不保证模块实际存在。

### 3. 准备 Linux 操作权限

SSH 账号为 root 时可直接操作。普通账号需要管理员配置无需密码的 sudo，覆盖 `usbip port`、`usbip attach`、`usbip detach`；需要应用加载模块时，还要允许 `modprobe vhci_hcd`。Remote Runner 调用 `sudo -n`，无法弹出 sudo 密码输入框。

下面给出 Debian 风格路径的单设备授权示例，参数与应用实际调用一致。将 `rruser`、Windows IPv4、Windows BUSID `1-2` 和可执行文件绝对路径替换为实际值；Ubuntu 的 `usbip` 通常位于 `/usr/bin/usbip`。BUSID 可从 Windows 的 `usbipd list` 或 USB 对话框中读取，换 USB 插口后可能变化。

由管理员执行：

```bash
sudo visudo -f /etc/sudoers.d/remote-runner-usb
```

写入以下规则；其中端口参数正则要求 **sudo 1.9.10+**，旧版本需要由管理员为实际端口编写明确的参数规则：

```sudoers
rruser ALL=(root) NOPASSWD: /usr/sbin/usbip port
rruser ALL=(root) NOPASSWD: /usr/sbin/usbip attach --remote 192.168.1.50 --busid 1-2
rruser ALL=(root) NOPASSWD: /usr/sbin/usbip ^detach --port [0-9]+$
rruser ALL=(root) NOPASSWD: /usr/sbin/modprobe vhci_hcd
```

接入规则限定 Windows 地址和 BUSID；断开规则允许该账号操作此 Linux 上任意数字编号的 USB/IP 虚拟端口，共用机器应由管理员进一步收紧授权。参数匹配方式参见 [sudoers 官方手册](https://www.sudo.ws/docs/man/1.9.14/sudoers.man.pdf)。

保存后由管理员运行 `sudo visudo -c` 检查配置。再以 **SSH 配置中的普通用户**执行：

```bash
sudo -k -n -- /usr/sbin/usbip port
sudo -k -n -- /usr/sbin/modprobe vhci_hcd
```

两条命令应无需输入密码即成功；`-k` 让检查不依赖此前缓存的 sudo 密码。这只能确认列出端口和加载模块的授权，接入/断开仍会在实际操作时确认。若系统策略要求 TTY，也需要管理员为这些命令调整策略。界面显示「sudo（操作时确认授权）」表示找到了 sudo，不能代替上述授权配置。

### 4. 在 Remote Runner 中连接和使用

1. 将 USB 插入 Windows，结束正在使用它的串口会话、刷写或其他任务。若设备已连接到 WSL 或另一 Linux，先在原目标断开。
2. 打开「文件 → USB 共享…」，在「连接目标」选择「远程 Linux」。
3. 在「SSH 设备」中选择已保存的目标 Linux。本例 SSH 配置的主机为 `192.168.1.70`。
4. 在「Linux 可访问的 Windows IPv4」填写 **`192.168.1.50`**。这里填 USB 所在的 Windows 地址。留空会按本机到 SSH 目标的路由自动选择；多网卡、NAT、SSH 代理场景应手动指定。
5. 点击「检查连接」，确认 Python / Linux 检查通过、usbip 已安装、TCP 3240 可访问。`vhci_hcd` 可以预先加载，也可以在已授权的情况下接入时加载。
6. 在要使用的 USB 行中点击「连接到 Linux」。首次共享时接受 Windows UAC；应用完成共享、远程接入和身份核对后刷新状态。状态为「客户端已连接」时，可点击「验证」检查所选 Linux 的对应设备节点。
7. 在 Linux 终端用 `lsusb` 查看设备，然后照常运行对应程序。也可以在 Remote Runner 中选择该 SSH 设备执行工作区任务，例如串口程序使用 Linux 的 `/dev/ttyUSB*` 或 `/dev/ttyACM*`，而不是 Windows 的 COM 名称。

「验证」检查的是 SSH 用户对对应 `/dev/bus/usb/...` 节点的读写权限。设备可见但没有权限时，需要按设备类型配置 udev 规则或用户组；串口节点、驱动和应用自己的访问要求仍需单独确认。接入期间 Windows 无法同时使用该 USB，USB 转交也不会自动启动 Linux 上的工作区任务。

### 5. 断开、取消共享和异常清理

正常结束时，先停止 Linux 上的刷写、文件写入或其他设备操作。在 USB 对话框中选择原 SSH 设备和连接时使用的 Windows IPv4，点击该设备的「断开连接」。应用核对对应虚拟端口后断开，Windows 可以重新使用设备；「已共享」状态会保留，以便下次接入。

需要撤销网络共享时，在断开后点击「取消共享」并接受 UAC。设备已拔出时，可展开「已共享但未插入」删除对应共享记录。共享设置会跨重启保留；关闭窗口、退出应用或结束工作区任务不会自动断开，设备重置、拔插或重启后也不会自动重连。这与 [usbipd-win 的共享和连接生命周期](https://github.com/dorssel/usbipd-win#how-to-use)一致。

若设备拔出后 Linux 仍残留虚拟端口，或一次操作超时，先在 Linux 手动查看：

```bash
sudo usbip port
```

找到指向 `usbip://192.168.1.50:3240/1-2` 的记录，确认它就是要清理的连接，再按输出中的 **Port 数字**执行，例如：

```bash
sudo usbip detach --port 3
sudo usbip port
```

这里的 `3` 是示例 Linux 虚拟端口号，与 Windows BUSID `1-2` 不同；按实际输出替换。最后回到应用点击「刷新」。超时表示状态未确认，应先检查两端状态再重试。

### 6. 常见问题

| 现象 | 处理方法 |
| --- | --- |
| SSH 能连接，但 TCP 3240 无法访问 | 确认填写的是 Windows 可达 IPv4，`usbipd` 服务正在运行；检查 Linux → Windows 的路由、Windows 防火墙、第三方防火墙和 VPN。SSH 连接与 USB/IP 数据连接是两条独立链路。 |
| 缺少 usbip，或 Ubuntu 提示当前内核没有工具 | 安装发行版客户端和当前内核对应的工具包；开发板/自定义内核按其供应商说明准备。只安装到 `/usr/local/bin` 的工具不会被本版发现。 |
| 显示「接入时加载」，接入却失败 | 在 Linux 运行 `sudo modprobe vhci_hcd` 查看原因，确认模块存在且账号有加载权限。 |
| `sudo_required`、需要密码或 TTY | 为 SSH 配置里的同一账号配置这些具体命令的非交互授权，核对绝对路径、Windows IPv4 和 BUSID；SSH 登录密码不会作为 sudo 密码使用。 |
| 「客户端已连接」，但所选 Linux 验证/断开失败 | 核对所选 SSH 设备和 Windows IPv4 是否与原连接一致；该状态可能属于 WSL 或另一台 Linux。到原目标确认连接，应用不会自动抢占。 |
| 串口占用导致连接被拒绝 | 先停止 Remote Runner 中使用该串口的会话/任务，再结束其他占用设备的 Windows 程序。 |
| Linux 看到了 USB，业务程序仍无法使用 | 检查该设备的 Linux 驱动、udev 规则、用户组和实际节点权限；USB 接入成功不保证业务程序权限已配置。 |
| 拔插后不能恢复，或操作超时 | 查看 Windows 列表与 Linux `usbip port`，核对后清理残留端口、刷新并重新连接；BUSID 变化时同步调整授权规则。 |
| 开发界面调用新增命令失败 | 重新启动当前 Tauri 开发程序，前端热更新不会加载新增 Rust 命令。 |

其他错误可展开「查看诊断详情」，保留错误码和两端状态用于排查。

## 交互

USB 对话框的连接目标增加 WSL2 / 远程 Linux 切换。远程模式选择 SSH 设备，填写「Linux 可访问的 Windows IPv4」；留空按 SSH 目标的本机路由推测，检查后显示实际地址。NAT、多网卡、SSH 代理环境应手动填写从目标可达的地址。

「检查连接」检查 Python3、Linux、usbip、vhci_hcd、root / sudo 可用性以及目标 → Windows USB/IP 协议连通性。缺少客户端或内核支持时提供准备说明，不自动安装软件或修改防火墙。内核模块可在接入时用 root / sudo -n modprobe vhci_hcd 加载。

连接前完成远程预检，再按需 Windows UAC bind。UAC 后复核设备身份，Linux 查询 USB/IP 导出列表核对 BUSID + VID:PID，然后使用结构化 argv 执行 usbip attach。状态改变后重新读本机 JSON。

断开在所选 Linux 上调用 usbip detach，仅接受 usbip port 输出中 host + TCP 3240 + BUSID 精确匹配的一条记录；不猜端口，不执行 detach all，不自动抢占。验证通过这条记录的 Linux 本地 busid 查询 sysfs 与设备节点权限。Windows 侧客户端 IP 非空不代表属于选中的 Linux。

## 权限与生命周期

- 默认以 SSH 配置中的用户操作。root 直接执行；普通用户调用 sudo -n，只支持已有无需密码的授权。无密码授权须覆盖 usbip port / attach / detach，按需覆盖 modprobe vhci_hcd。不会复用 SSH 密码作 sudo 密码，不要求允许任意 Python 以 root 运行。
- Python helper 以普通 SSH 用户运行。源码与 JSON 请求通过 stdin 交付，SSH 命令行只包含固定引导程序；用户地址、BUSID、路径不插入 shell 文本。
- Rust 校验目标必须为 SSH，IPv4 为非回环、非 unspecified、非 multicast 地址，设备选择器复用已有身份复核。只在连接操作期间与应用内串口 lease 互斥。
- helper 子命令以新进程组启动，有输出限制和超时清理；普通 SSH 用户未必能终止 sudo 的 root 后代，清理也有等待上限，超时必须视为状态未确认并重新检查。SSH channel 必须同时有明确 JSON 完成消息与退出码，EOF / 连接断开 / 不完整消息视为失败。
- 关闭 SSH 管理连接、窗口或 Remote Runner 不自动断开已导入的 USB；内核连接继续存在。设备重置/拔插暂不自动重连。
- 本地实例操作串行化；目标端通过当前用户的专用 flock 防止同一账号的并发 helper 操作。外部工具仍可能改变状态，每次操作必须重新核对。

## 边界

Windows 端继续依赖默认 Program Files 安装目录的 usbipd-win 5.x。远端依赖 Linux + Python3.8+、usbip、vhci_hcd。首版为 IPv4 固定 TCP 3240 直连，不提供 SSH 隧道、sudo 密码交互、自动安装、自动修改防火墙或自动重连。网络与权限问题通过检查和稳定错误码报告。

root / sudo 检查表示账号或工具可用，具体 sudo 授权在操作时确认。设备拔出后可能残留 Linux 虚拟端口；无当前 BUSID 时不猜测对应端口，需在 Linux 用 `usbip port` 查看后显式 `usbip detach --port <port>` 清理。

USB/IP 直连无 SSH 加密隔离，只用于可信局域网/VPN。usbipd-win 默认防火墙允许本地子网；跨网段必须由用户配置适当的网络和防火墙访问范围。

## 验证

使用模拟 SSH server 验证固定引导命令、stdin payload、分块输出、退出码、异常 EOF、错误和超时；Python 自动化模拟 USB/IP 导出协议、usbip port、多设备端口核对、sudo argv 与 sysfs，不依赖实际 USB 或远程硬件。运行前端测试/build、Rust 格式与全量测试、git diff --check。真实网络 USB 转交另需选定的开发设备联调。

## 参考

- https://github.com/dorssel/usbipd-win
- https://github.com/torvalds/linux/tree/master/tools/usb/usbip

## 实施状态

第一版已接入：USB 窗口目标切换、保存的 SSH 设备选择、Windows IPv4 自动路由推测及显式覆盖、依赖与 USB/IP 协议检查、UAC 后身份复核、Linux 接入/精确断开/对应节点权限验证，以及中英文状态和诊断提示。

验证结果（2026-10-12）：

- 前端 `npm test`：118 项通过，包含远程目标切换竞态、地址校验、实际连接地址保留、操作分发和界面渲染。
- `npm run build` 和 `cargo fmt --all -- --check` 通过。
- Rust 全量测试：184 项单元测试、8 项 SSH 集成测试通过，12 项环境相关测试默认忽略。运行中的开发程序锁定默认目录的可执行文件，因此完整验证使用独立目录：`cargo test --offline --all-targets --target-dir target/usb-remote-validation`。
- 指定 Ubuntu-24.04 执行 `usb::remote` 的 7 项测试通过，含 Linux Python helper 的 11 项无硬件模拟用例（USB/IP 分块协议、精确端口匹配、sudo argv、变更拒绝、权限和进程输出/超时）。
- 无头浏览器检查中文桌面和英文窄窗口模拟状态；不调用真实 USB 后端。
- `git diff --check` 通过。

真实远程 Linux + 开发 USB 的 bind/attach/detach、实际 sudo 策略与跨机网络尚待硬件联调。当前运行的开发程序需重新启动，才能加载新增 Rust 命令。

Linux helper 模拟命令（从 `src-tauri` 执行，不操作真实 USB）：

```powershell
$env:REMOTE_RUNNER_TEST_WSL = 'Ubuntu-24.04'
cargo test --offline --lib usb::remote -- --include-ignored
```
