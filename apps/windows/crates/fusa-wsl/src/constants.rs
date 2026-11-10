/// 默认专用 WSL2 发行版名称（独立于用户自己的 Ubuntu 实例）。
pub const FUSA_DISTRO_NAME: &str = "Fusa";

/// 发行版内日常运行守护进程与 Worker 的非特权 Linux 用户名。
pub const FUSA_LINUX_USER: &str = "fusa";

/// 仅用于首次系统初始化阶段的 Linux root 用户名。
pub const FUSA_ROOT_USER: &str = "root";

/// Windows 宿主侧 WSL 可执行文件名。
pub const WSL_EXE: &str = "wsl.exe";

/// 发行版内 root 拥有（0755）的准备与自检脚本固定安装目录。
pub const GUEST_SCRIPT_WSL_DIR: &str = "/usr/local/libexec/fusa";

/// 发行版内准备与自检脚本固定绝对路径。
pub const GUEST_SCRIPT_WSL_PATH: &str = "/usr/local/libexec/fusa/wsl-provision-guest.sh";

/// 发行版内锁定的 Node 24 可执行文件绝对路径。
pub const FUSA_NODE_WSL_PATH: &str = "/home/fusa/.local/share/fusa/node/bin/node";

/// 发行版内锁定的 pnpm 可执行文件绝对路径。
pub const FUSA_PNPM_WSL_PATH: &str = "/home/fusa/.local/bin/pnpm";

/// 发行版内守护进程 UI 认证令牌路径（仅供宿主侧内存读取兑换 Cookie）。
pub const FUSA_UI_TOKEN_WSL_PATH: &str = "/home/fusa/.agent-hub/state/ui-token";

/// 发行版内用户项目主目录。
pub const FUSA_PROJECTS_WSL_DIR: &str = "/home/fusa/projects";

/// 发行版内后台版本包存放目录。
pub const FUSA_RELEASES_WSL_DIR: &str = "/home/fusa/.local/share/fusa/releases";

/// 本地应用数据目录下的准备阶段状态标记文件名。
pub const PROVISION_STATE_FILENAME: &str = "wsl-provision-state.json";

/// 本地应用数据目录下存放发行版 ext4.vhdx 的子目录名。
pub const DISTRO_INSTALL_SUBDIR: &str = "distro";

/// 本地应用数据目录下缓存已校验 rootfs 镜像的子目录名。
pub const ROOTFS_CACHE_SUBDIR: &str = "cache";

/// 编译期内嵌的发行版内幂等初始化与隔离自检脚本（单一事实来源）。
pub const EMBEDDED_GUEST_SCRIPT: &str =
    include_str!("../../../../../scripts/wsl-provision-guest.sh");

/// 锁定的官方 Ubuntu 24.04 LTS WSL2 rootfs 镜像元数据。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedRootfsImage {
    pub version: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub license: &'static str,
}

/// 首发锁定的 Canonical 官方 Ubuntu 24.04.5 LTS (Noble Numbat) amd64 WSL 镜像。
/// 校验值取自 https://releases.ubuntu.com/24.04.5/SHA256SUMS。
pub const PINNED_UBUNTU_2404_ROOTFS: PinnedRootfsImage = PinnedRootfsImage {
    version: "24.04.5",
    filename: "ubuntu-24.04.5-wsl-amd64.wsl",
    url: "https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl",
    sha256: "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e",
    license: "Canonical Ubuntu Intellectual Property Policy & Open Source Package Licenses (https://ubuntu.com/legal/intellectual-property-policy)",
};
